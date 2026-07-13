// bonds-brief.js
//
// AI-synthesized fixed-income market intelligence brief.
//
// Assembles 9 signals across three free data sources, then uses gpt-4o-mini
// to produce a structured ~200-word rate environment assessment. One call
// replaces manual assembly of yield curve + real yields + credit spreads + LLM.
//
// Signals assembled:
//   Yahoo Finance (CBOE rate indices — real-time, no API key):
//     1. 3M T-Bill yield    (^IRX) — front-end anchor / Fed policy proxy
//     2. 5Y Treasury yield  (^FVX) — medium-term rate expectations
//     3. 10Y Treasury yield (^TNX) — primary risk-free rate; DCF anchor
//     4. 30Y Treasury yield (^TYX) — long-end inflation/fiscal risk premium
//
//   FRED CSV (ICE BofA indices — daily, no API key):
//     5. 2Y Treasury yield      (DGS2)          — key inversion leg vs 10Y
//     6. 10Y TIPS real yield    (DFII10)         — real rate environment
//     7. 10Y breakeven inflation (T10YIE)        — market inflation expectations
//     8. HY OAS                 (BAMLH0A0HYM2)  — credit stress signal
//     9. IG OAS                 (BAMLC0A0CM)    — investment-grade spread
//
// Derived metrics:
//   - 2Y-10Y spread (bp) — primary inversion/recession signal
//   - 10Y-3M spread (bp) — recession timing signal (Estrella/Mishkin model)
//   - Real rate = 10Y nominal − 10Y breakeven (basis points)
//   - HY-IG differential (pure sub-IG premium)
//   - curve_shape: INVERTED | FLAT | NORMAL | STEEP
//   - credit_regime: TIGHT | NORMAL | WIDE | STRESS
//   - rate_environment: composite signal for AI agent decision context
//
// Seam: Bloomberg Terminal charges $2,000+/mo for structured rate data.
//       STALL delivers real-time multi-source fixed-income intelligence at $0.40/call.
//
// Upstreams: Yahoo Finance v8 chart (free) + FRED CSV (free) + gpt-4o-mini (OPENAI_API_KEY).

const YF_BASE    = "https://query1.finance.yahoo.com/v8/finance/chart";
const FRED_BASE  = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL      = "gpt-4o-mini";
const UA         = "Mozilla/5.0 (compatible; the-stall/4.64; +https://intuitek.ai)";
const YF_TMO     = 12_000;
const FRED_TMO   = 15_000;
const GPT_TMO    = 38_000;

const r3 = n => Math.round(n * 1000) / 1000;
const r2 = n => Math.round(n * 100) / 100;
const bp = (a, b) => (a != null && b != null) ? r2((a - b) * 100) : null;

// ── Yahoo Finance yield fetch ────────────────────────────────────────────────

async function fetchYFYield(symbol) {
  const url  = `${YF_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(YF_TMO),
  });
  if (!resp.ok) throw new Error(`YF ${symbol} HTTP ${resp.status}`);
  const data   = await resp.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`YF ${symbol}: no result`);
  const meta = result.meta || {};
  return {
    value: meta.regularMarketPrice ?? null,
    ts:    meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
}

// ── FRED CSV fetch ───────────────────────────────────────────────────────────

async function fetchFRED(series) {
  const url  = `${FRED_BASE}?id=${series}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(FRED_TMO),
  });
  if (!resp.ok) throw new Error(`FRED ${series} HTTP ${resp.status}`);
  const text  = await resp.text();
  const lines = text.trim().split("\n").filter(l => !l.startsWith("DATE") && l.includes(","));
  for (let i = lines.length - 1; i >= 0; i--) {
    const [date, val] = lines[i].split(",");
    if (val && val.trim() !== "." && val.trim() !== "") {
      return { date: date.trim(), value: parseFloat(val.trim()) };
    }
  }
  throw new Error(`FRED ${series}: no valid observation`);
}

// ── Signal assembly ──────────────────────────────────────────────────────────

async function gatherSignals() {
  const [yfResults, fredResults] = await Promise.all([
    Promise.allSettled([
      fetchYFYield("^IRX"),  // 3M
      fetchYFYield("^FVX"),  // 5Y
      fetchYFYield("^TNX"),  // 10Y
      fetchYFYield("^TYX"),  // 30Y
    ]),
    Promise.allSettled([
      fetchFRED("DGS2"),          // 2Y treasury
      fetchFRED("DFII10"),        // 10Y TIPS real yield
      fetchFRED("T10YIE"),        // 10Y breakeven inflation
      fetchFRED("BAMLH0A0HYM2"), // HY OAS
      fetchFRED("BAMLC0A0CM"),   // IG OAS
    ]),
  ]);

  const [r3m, r5y, r10y, r30y] = yfResults.map(r =>
    r.status === "fulfilled" ? r.value : null
  );
  const [r2y, rTips, rBe, rHy, rIg] = fredResults.map(r =>
    r.status === "fulfilled" ? r.value : null
  );

  const y3m  = r3m?.value ?? null;
  const y5y  = r5y?.value ?? null;
  const y10y = r10y?.value ?? null;
  const y30y = r30y?.value ?? null;
  const y2y  = r2y?.value ?? null;

  const tips_real_yield_10y     = rTips?.value ?? null;
  const breakeven_inflation_10y = rBe?.value ?? null;
  const hy_oas                  = rHy?.value ?? null;
  const ig_oas                  = rIg?.value ?? null;

  // Spreads (basis points)
  const spread_2y_10y  = bp(y2y,  y10y);  // negative = inverted (primary signal)
  const spread_10y_3m  = bp(y10y, y3m);   // negative = inverted (Estrella timing)
  const spread_30y_10y = bp(y30y, y10y);  // long-end steepness
  const real_rate_10y  = (y10y != null && breakeven_inflation_10y != null)
    ? r2(y10y - breakeven_inflation_10y) : null;  // actual % (positive = tight money)
  const hy_ig_diff     = (hy_oas != null && ig_oas != null)
    ? r3(hy_oas - ig_oas) : null;

  // Yield curve shape (primary: 2Y-10Y; fallback: 10Y-3M)
  const curveSpread = spread_2y_10y ?? spread_10y_3m;
  let curve_shape;
  if (curveSpread == null)          curve_shape = "unknown";
  else if (curveSpread < -10)       curve_shape = "INVERTED";
  else if (Math.abs(curveSpread) <= 25) curve_shape = "FLAT";
  else if (curveSpread < 100)       curve_shape = "NORMAL";
  else                              curve_shape = "STEEP";

  // Credit regime (HY OAS in FRED % units; 1% = 100bp)
  let credit_regime;
  if (hy_oas == null)               credit_regime = "unknown";
  else if (hy_oas < 3.0)            credit_regime = "TIGHT";   // < 300bp
  else if (hy_oas < 5.0)            credit_regime = "NORMAL";  // 300-500bp
  else if (hy_oas < 7.0)            credit_regime = "WIDE";    // 500-700bp
  else                              credit_regime = "STRESS";  // > 700bp

  // Real rate environment
  let real_rate_env;
  if (real_rate_10y == null)          real_rate_env = "unknown";
  else if (real_rate_10y < -1.0)      real_rate_env = "DEEPLY_NEGATIVE";
  else if (real_rate_10y < 0)         real_rate_env = "NEGATIVE";
  else if (real_rate_10y < 0.5)       real_rate_env = "NEAR_ZERO";
  else                                real_rate_env = "POSITIVE";

  // Composite rate environment
  let rate_environment;
  if (curve_shape === "INVERTED" && credit_regime === "STRESS") {
    rate_environment = "RECESSION_RISK_HIGH";
  } else if (curve_shape === "INVERTED" && credit_regime !== "STRESS") {
    rate_environment = "INVERTED_CURVE_NORMAL_CREDIT";
  } else if (curve_shape === "STEEP" && real_rate_env === "NEGATIVE") {
    rate_environment = "STEEPENING_EASY_MONEY";
  } else if (curve_shape === "NORMAL" && credit_regime === "TIGHT" && real_rate_env === "POSITIVE") {
    rate_environment = "TIGHT_FINANCIAL_CONDITIONS";
  } else if (credit_regime === "STRESS") {
    rate_environment = "CREDIT_STRESS";
  } else if (real_rate_env === "DEEPLY_NEGATIVE" || real_rate_env === "NEGATIVE") {
    rate_environment = "ACCOMMODATIVE";
  } else {
    rate_environment = "NEUTRAL";
  }

  return {
    yields: {
      y3m:  y3m  ? r3(y3m)  : null,
      y2y:  y2y  ? r3(y2y)  : null,
      y5y:  y5y  ? r3(y5y)  : null,
      y10y: y10y ? r3(y10y) : null,
      y30y: y30y ? r3(y30y) : null,
      data_ts: r10y?.ts ?? null,
      fred_date_2y: r2y?.date ?? null,
    },
    real_rates: {
      tips_real_yield_10y:     tips_real_yield_10y != null ? r3(tips_real_yield_10y) : null,
      breakeven_inflation_10y: breakeven_inflation_10y != null ? r3(breakeven_inflation_10y) : null,
      real_rate_10y:           real_rate_10y,
      fred_date_tips:          rTips?.date ?? null,
    },
    credit: {
      hy_oas:    hy_oas != null ? r3(hy_oas) : null,
      ig_oas:    ig_oas != null ? r3(ig_oas) : null,
      hy_ig_diff: hy_ig_diff,
      hy_bp:     hy_oas != null ? r2(hy_oas * 100) : null,
      ig_bp:     ig_oas != null ? r2(ig_oas * 100) : null,
      fred_date_credit: rHy?.date ?? null,
    },
    derived: {
      spread_2y_10y,
      spread_10y_3m,
      spread_30y_10y,
      curve_shape,
      credit_regime,
      real_rate_env,
      rate_environment,
    },
  };
}

// ── LLM synthesis ────────────────────────────────────────────────────────────

async function synthesize(raw, style) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const wordTarget = style === "concise" ? 100 : 200;
  const d = raw.derived;

  const prompt = `You are a fixed-income market intelligence analyst. Given real-time yield curve, real rate, and credit spread data, produce a structured JSON briefing for AI agents managing equity, bond, or macro portfolios.

LIVE DATA:
${JSON.stringify(raw, null, 2)}

KEY CONTEXT:
- curve_shape: ${d.curve_shape} (spread_2y_10y=${d.spread_2y_10y}bp, spread_10y_3m=${d.spread_10y_3m}bp)
- credit_regime: ${d.credit_regime} (HY OAS=${raw.credit.hy_bp}bp, IG OAS=${raw.credit.ig_bp}bp)
- real_rate_env: ${d.real_rate_env} (10Y real rate=${raw.real_rates.real_rate_10y}%, breakeven=${raw.real_rates.breakeven_inflation_10y}%)
- rate_environment: ${d.rate_environment}

RESPOND WITH VALID JSON ONLY (no markdown fences):
{
  "rate_environment": "${d.rate_environment}",
  "situation": "<one-sentence rate environment summary>",
  "dominant_driver": "<main force shaping the rate environment — Fed policy, inflation expectations, credit conditions, fiscal supply, etc.>",
  "agent_implication": "<concrete relevance for AI agents — discount rate adjustments, equity valuation impact, portfolio positioning, credit risk>",
  "narrative": "<${wordTarget}-word briefing covering yield curve shape, real rate implications, credit stress level, and what the combined signal means for risk assets>",
  "confidence": <0.0–1.0>
}`;

  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 700,
    }),
    signal: AbortSignal.timeout(GPT_TMO),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${err.slice(0, 120)}`);
  }

  const data  = await resp.json();
  const raw2  = data.choices?.[0]?.message?.content || "";
  const clean = raw2.replace(/```json\n?|\n?```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Export ──────────────────────────────────────────────────────────────────

export default {
  name:  "bonds-brief",
  price: "$0.40",

  description:
    "AI-synthesized bond and fixed-income market brief. Assembles 9 signals: Treasury yield curve (3M/5Y/10Y/30Y from Yahoo Finance CBOE indices), 2Y yield + 10Y TIPS real yield + 10Y breakeven inflation (FRED), and HY/IG credit spreads (FRED ICE BofA). Returns 2Y-10Y inversion signal, real rate environment, credit regime, composite rate_environment classification (RECESSION_RISK_HIGH/INVERTED_CURVE_NORMAL_CREDIT/TIGHT_FINANCIAL_CONDITIONS/ACCOMMODATIVE/NEUTRAL/etc.), and ~200-word GPT-4o-mini briefing covering discount rate implications and AI agent portfolio positioning.",

  inputSchema: {
    type: "object",
    properties: {
      style: {
        type: "string",
        enum: ["standard", "concise"],
        description: "Output length. 'standard' = 200-word narrative (default). 'concise' = 100-word summary.",
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      rate_environment:  { type: "string", description: "RECESSION_RISK_HIGH | INVERTED_CURVE_NORMAL_CREDIT | TIGHT_FINANCIAL_CONDITIONS | ACCOMMODATIVE | STEEPENING_EASY_MONEY | CREDIT_STRESS | NEUTRAL" },
      situation:         { type: "string", description: "One-sentence rate environment summary." },
      dominant_driver:   { type: "string", description: "Main force shaping rates today." },
      agent_implication: { type: "string", description: "Concrete action relevance for AI agents." },
      narrative:         { type: "string", description: "Full ~200-word briefing narrative." },
      confidence:        { type: "number", description: "Synthesis confidence 0–1." },
      yield_curve: {
        type: "object",
        description: "Treasury yield curve snapshot.",
        properties: {
          y3m:           { type: "number", description: "3-Month T-Bill yield (%)." },
          y2y:           { type: "number", description: "2-Year Treasury yield (%)." },
          y5y:           { type: "number", description: "5-Year Treasury yield (%)." },
          y10y:          { type: "number", description: "10-Year Treasury yield (%). Primary DCF anchor." },
          y30y:          { type: "number", description: "30-Year Treasury yield (%)." },
          spread_2y_10y: { type: "number", description: "2Y-10Y spread (bp). Negative = inverted curve (recession signal)." },
          spread_10y_3m: { type: "number", description: "10Y-3M spread (bp). Estrella-Mishkin recession model input." },
          curve_shape:   { type: "string", description: "INVERTED | FLAT | NORMAL | STEEP" },
        },
      },
      real_rates: {
        type: "object",
        description: "Inflation-adjusted rate environment.",
        properties: {
          tips_real_yield_10y:     { type: "number", description: "10Y TIPS real yield (%). Positive = tight real money." },
          breakeven_inflation_10y: { type: "number", description: "10Y breakeven inflation rate (%). Market inflation expectation." },
          real_rate_10y:           { type: "number", description: "Nominal 10Y minus breakeven (%). Positive = restrictive." },
          real_rate_env:           { type: "string", description: "DEEPLY_NEGATIVE | NEGATIVE | NEAR_ZERO | POSITIVE" },
        },
      },
      credit: {
        type: "object",
        description: "Corporate credit spread environment.",
        properties: {
          hy_oas:        { type: "number", description: "High Yield OAS (%). Multiply by 100 for basis points." },
          ig_oas:        { type: "number", description: "Investment Grade OAS (%)." },
          hy_bp:         { type: "number", description: "HY OAS in basis points." },
          ig_bp:         { type: "number", description: "IG OAS in basis points." },
          hy_ig_diff:    { type: "number", description: "HY-IG differential (pure sub-IG premium, %)." },
          credit_regime: { type: "string", description: "TIGHT | NORMAL | WIDE | STRESS" },
        },
      },
      generated_at: { type: "string" },
    },
  },

  async handler(query) {
    const style = query.style || "standard";

    const raw = await gatherSignals();

    // Require at least 10Y yield and one of credit or real-rate signals
    const hasCore = raw.yields.y10y != null;
    const hasSupporting = raw.credit.hy_oas != null || raw.real_rates.tips_real_yield_10y != null;
    if (!hasCore || !hasSupporting) {
      throw Object.assign(
        new Error("Rate data temporarily unavailable — Yahoo Finance and/or FRED unreachable. Retry in 5 minutes."),
        { status: 503 },
      );
    }

    const synth = await synthesize(raw, style);

    return {
      ...synth,
      yield_curve: {
        y3m:           raw.yields.y3m,
        y2y:           raw.yields.y2y,
        y5y:           raw.yields.y5y,
        y10y:          raw.yields.y10y,
        y30y:          raw.yields.y30y,
        spread_2y_10y: raw.derived.spread_2y_10y,
        spread_10y_3m: raw.derived.spread_10y_3m,
        curve_shape:   raw.derived.curve_shape,
      },
      real_rates: {
        tips_real_yield_10y:     raw.real_rates.tips_real_yield_10y,
        breakeven_inflation_10y: raw.real_rates.breakeven_inflation_10y,
        real_rate_10y:           raw.real_rates.real_rate_10y,
        real_rate_env:           raw.derived.real_rate_env,
      },
      credit: {
        hy_oas:        raw.credit.hy_oas,
        ig_oas:        raw.credit.ig_oas,
        hy_bp:         raw.credit.hy_bp,
        ig_bp:         raw.credit.ig_bp,
        hy_ig_diff:    raw.credit.hy_ig_diff,
        credit_regime: raw.derived.credit_regime,
      },
      generated_at: new Date().toISOString(),
    };
  },
};
