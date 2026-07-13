// energy-brief.js
//
// AI-synthesized US energy market intelligence briefing.
//
// Gathers 9 real-time signals from Yahoo Finance (free, no key), then uses
// gpt-4o-mini to produce a structured ~200-word energy market assessment.
// One call replaces manual assembly of 9 live tickers + LLM synthesis.
//
// Signals assembled:
//   1. WTI crude futures    (CL=F) — real-time price + 52-week range
//   2. Brent crude futures  (BZ=F) — Brent/WTI spread indicator
//   3. Natural gas futures  (NG=F) — Henry Hub proxy, real-time
//   4. Energy sector ETF   (XLE)  — broad energy equity performance
//   5. Oil services ETF    (OIH)  — rig/activity proxy (no Baker Hughes key needed)
//   6. ExxonMobil          (XOM)  — integrated major bellwether
//   7. Chevron             (CVX)  — second integrated major
//   8. Marathon Petroleum  (MPC)  — downstream/refining spread signal
//   9. Baker Hughes        (BKR)  — oilfield services / activity proxy
//
// Derived: Brent/WTI spread, WTI vs 52-week range, market regime classification.
//
// Seam: crownblock.lonestaroracle.xyz/report — $1.00/call, ~40 settlements/wk,
// 2 payers (energy/trading agents). STALL prices at $0.65 — 35% undercut,
// real-time data (not monthly FRED averages), broader equity coverage.
//
// Upstreams: Yahoo Finance v8 chart (free, no auth) + gpt-4o-mini (OPENAI_API_KEY).

const YF_BASE    = "https://query1.finance.yahoo.com/v8/finance/chart";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL      = "gpt-4o-mini";
const UA         = "Mozilla/5.0 (compatible; the-stall/4.59; +https://intuitek.ai)";
const YF_TMO     = 12_000;
const GPT_TMO    = 38_000;

const r2  = n => Math.round(n * 100) / 100;
const pct = (a, b) => b ? r2(((a - b) / b) * 100) : null;

async function fetchQuote(symbol) {
  const url  = `${YF_BASE}/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(YF_TMO),
  });
  if (!resp.ok) throw new Error(`YF ${symbol} HTTP ${resp.status}`);
  const data   = await resp.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`YF ${symbol}: no result`);

  const meta    = result.meta || {};
  const closes  = result.indicators?.quote?.[0]?.close || [];
  const validC  = closes.filter(v => v != null && !isNaN(v));
  const price   = meta.regularMarketPrice ?? validC[validC.length - 1];
  const prev    = meta.previousClose ?? meta.chartPreviousClose;
  const w52Hi   = meta.fiftyTwoWeekHigh ?? (validC.length ? Math.max(...validC) : null);
  const w52Lo   = meta.fiftyTwoWeekLow  ?? (validC.length ? Math.min(...validC) : null);

  return {
    symbol,
    price:              price ? r2(price) : null,
    change_pct:         pct(price, prev),
    week_52_high:       w52Hi ? r2(w52Hi) : null,
    week_52_low:        w52Lo ? r2(w52Lo) : null,
    pct_from_52w_high:  (price && w52Hi) ? pct(price, w52Hi) : null,
    pct_from_52w_low:   (price && w52Lo) ? pct(price, w52Lo) : null,
  };
}

async function gatherSignals() {
  const SYMS    = ["CL=F", "BZ=F", "NG=F", "XLE", "OIH", "XOM", "CVX", "MPC", "BKR"];
  const results = await Promise.allSettled(SYMS.map(s => fetchQuote(s)));
  const Q       = {};
  SYMS.forEach((s, i) => { Q[s] = results[i].status === "fulfilled" ? results[i].value : null; });

  const wti   = Q["CL=F"];
  const brent = Q["BZ=F"];
  const ng    = Q["NG=F"];

  return {
    wti_crude:        wti,
    brent_crude:      brent,
    natural_gas:      ng,
    energy_etf_xle:   Q["XLE"],
    oil_services_oih: Q["OIH"],
    exxon_mobil:      Q["XOM"],
    chevron:          Q["CVX"],
    marathon_petro:   Q["MPC"],
    baker_hughes:     Q["BKR"],
    derived: {
      brent_wti_spread:   (wti?.price && brent?.price) ? r2(brent.price - wti.price) : null,
      brent_premium:      (wti?.price && brent?.price) ? (brent.price > wti.price ? "Brent premium" : "WTI premium") : null,
    },
  };
}

function interpretSignals(s) {
  const wti = s.wti_crude;
  const ng  = s.natural_gas;

  const oil_regime =
    !wti            ? "unknown"
    : wti.price > 120 ? "shock"
    : wti.price > 90  ? "elevated"
    : wti.price > 60  ? "normal"
    :                   "low";

  const natgas_regime =
    !ng             ? "unknown"
    : ng.price > 5.0 ? "tight"
    : ng.price > 3.0 ? "normal"
    :                  "glut";

  return { oil_regime, natgas_regime };
}

async function synthesize(signals, interp, style) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const wti   = signals.wti_crude;
  const brent = signals.brent_crude;
  const ng    = signals.natural_gas;
  const xle   = signals.energy_etf_xle;
  const oih   = signals.oil_services_oih;
  const d     = signals.derived;

  const block = [
    `WTI crude futures: $${wti?.price ?? "N/A"}/bbl (${wti?.change_pct ?? "N/A"}% today, ${wti?.pct_from_52w_high ?? "N/A"}% from 52w high) — regime: ${interp.oil_regime}`,
    `Brent crude: $${brent?.price ?? "N/A"}/bbl (spread vs WTI: ${d.brent_wti_spread ?? "N/A"} — ${d.brent_premium ?? "N/A"})`,
    `Natural gas (Henry Hub proxy): $${ng?.price ?? "N/A"}/MMBtu (${ng?.change_pct ?? "N/A"}% today) — regime: ${interp.natgas_regime}`,
    `Energy sector (XLE): ${xle?.change_pct ?? "N/A"}% today | Oil services (OIH): ${oih?.change_pct ?? "N/A"}% today`,
    `ExxonMobil: ${signals.exxon_mobil?.change_pct ?? "N/A"}% | Chevron: ${signals.chevron?.change_pct ?? "N/A"}% | Marathon: ${signals.marathon_petro?.change_pct ?? "N/A"}%`,
    `Baker Hughes (activity proxy): ${signals.baker_hughes?.change_pct ?? "N/A"}%`,
  ].join("\n");

  const toneClause = style === "concise"
    ? "Write concisely — 100-130 words maximum."
    : "Write clearly — 180-220 words.";

  const prompt = `You are a senior energy market analyst writing a daily situation briefing for AI agents. Synthesize the energy signal data below into a coherent, actionable assessment of current US energy market conditions.

CURRENT SIGNAL DATA (Yahoo Finance real-time):
${block}

${toneClause} Focus on: (1) the overall energy market regime and what is driving it, (2) the single most important risk for agents relying on energy-sensitive assumptions, and (3) one concrete implication for agent decision-making (especially macro, inflation, commodities, or equity agents).

Write in plain professional prose. Do not use bullet points. Do not repeat raw numbers unless critical for context. Do not start with "Based on".

Respond ONLY with a JSON object (no markdown, no text outside JSON):
{
  "situation": "one sentence: the core energy market regime in plain language",
  "dominant_risk": "one sentence: the single biggest risk the combined signals imply",
  "agent_implication": "one sentence: concrete action relevance for AI agents",
  "narrative": "the full briefing paragraph",
  "energy_regime": "energy_shock" | "elevated" | "normal" | "energy_glut" | "uncertain",
  "confidence": 0.0 to 1.0
}`;

  const resp = await fetch(OPENAI_URL, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model:       MODEL,
      max_tokens:  600,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(GPT_TMO),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${err.slice(0, 120)}`);
  }

  const data  = await resp.json();
  const raw   = data.choices?.[0]?.message?.content || "";
  const clean = raw.replace(/```json\n?|\n?```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Export ──────────────────────────────────────────────────────────────────

export default {
  name:  "energy-brief",
  price: "$0.990",

  description:
    "AI-synthesized US energy market intelligence brief. Assembles 9 real-time signals from Yahoo Finance: WTI crude futures, Brent crude (with spread), natural gas (Henry Hub proxy), energy sector ETF (XLE), oil services ETF (OIH), ExxonMobil, Chevron, Marathon Petroleum, and Baker Hughes. Returns 52-week context, Brent/WTI spread, market-regime classification, and a 200-word GPT-4o-mini narrative covering oil regime, dominant risk, and agent decision implications. Seam: crownblock upstream $1.00/call — STALL at $0.65 with real-time futures data vs monthly averages.",

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
      energy_regime:     { type: "string", description: "energy_shock | elevated | normal | energy_glut | uncertain" },
      situation:         { type: "string", description: "One-sentence energy market summary." },
      dominant_risk:     { type: "string", description: "Most important risk implied by the signals." },
      agent_implication: { type: "string", description: "Concrete action relevance for AI agents." },
      narrative:         { type: "string", description: "Full ~200-word briefing narrative." },
      confidence:        { type: "number", description: "Synthesis confidence 0–1." },
      prices: {
        type: "object",
        description: "Real-time commodity futures prices.",
        properties: {
          wti_crude_bbl:     { type: "object" },
          brent_crude_bbl:   { type: "object" },
          natural_gas_mmbtu: { type: "object" },
        },
      },
      sector: {
        type: "object",
        description: "Energy equity performance signals.",
        properties: {
          xle_energy:        { type: "object" },
          oih_oil_services:  { type: "object" },
          xom_exxon:         { type: "object" },
          cvx_chevron:       { type: "object" },
          mpc_marathon:      { type: "object" },
          bkr_baker_hughes:  { type: "object" },
        },
      },
      generated_at: { type: "string" },
    },
  },

  async handler(query) {
    const style = query.style || "standard";

    const raw    = await gatherSignals();
    const signalCount = Object.values(raw).filter(v => v && typeof v === "object" && v.price != null).length;
    if (signalCount === 0) {
      throw Object.assign(new Error("Yahoo Finance rate-limited (HTTP 429) — all energy signals unavailable. Please retry in 5 minutes."), { status: 503 });
    }
    const interp = interpretSignals(raw);
    const synth  = await synthesize(raw, interp, style);

    return {
      ...synth,
      prices: {
        wti_crude_bbl:    raw.wti_crude     ? { price: raw.wti_crude.price,    change_pct: raw.wti_crude.change_pct,    week_52_high: raw.wti_crude.week_52_high,    week_52_low: raw.wti_crude.week_52_low,    pct_from_52w_high: raw.wti_crude.pct_from_52w_high    } : null,
        brent_crude_bbl:  raw.brent_crude   ? { price: raw.brent_crude.price,  change_pct: raw.brent_crude.change_pct,  spread_vs_wti: raw.derived.brent_wti_spread, spread_type: raw.derived.brent_premium } : null,
        natural_gas_mmbtu: raw.natural_gas  ? { price: raw.natural_gas.price,  change_pct: raw.natural_gas.change_pct,  week_52_high: raw.natural_gas.week_52_high,  regime: interp.natgas_regime              } : null,
      },
      sector: {
        xle_energy:       raw.energy_etf_xle  ? { price: raw.energy_etf_xle.price,  change_pct: raw.energy_etf_xle.change_pct  } : null,
        oih_oil_services: raw.oil_services_oih ? { price: raw.oil_services_oih.price, change_pct: raw.oil_services_oih.change_pct } : null,
        xom_exxon:        raw.exxon_mobil  ? { price: raw.exxon_mobil.price,  change_pct: raw.exxon_mobil.change_pct  } : null,
        cvx_chevron:      raw.chevron      ? { price: raw.chevron.price,      change_pct: raw.chevron.change_pct      } : null,
        mpc_marathon:     raw.marathon_petro ? { price: raw.marathon_petro.price, change_pct: raw.marathon_petro.change_pct } : null,
        bkr_baker_hughes: raw.baker_hughes ? { price: raw.baker_hughes.price, change_pct: raw.baker_hughes.change_pct } : null,
      },
      generated_at: new Date().toISOString(),
    };
  },
};
