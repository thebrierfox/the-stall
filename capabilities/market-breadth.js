// market-breadth.js
//
// US stock market breadth dashboard via ETF-ratio breadth proxies.
//
// Breadth measures HOW MANY stocks are participating in a market move, not
// just which direction the index points. A rally led by 5 mega-caps while
// the average stock falls is a warning signal; broad participation confirms
// a sustainable trend. This cap quantifies participation using institutional
// breadth-proxy pairs — available anytime (not just during market hours).
//
// Breadth proxies (all Yahoo Finance, free, no API key):
//
//   Equal-weight vs cap-weight divergence (RSP / SPY):
//     RSP = Invesco S&P 500 Equal Weight ETF — all 500 stocks weighted equally
//     SPY = SPDR S&P 500 — dominated by AAPL, MSFT, NVDA, AMZN, META
//     When RSP outperforms SPY → the average stock is rising → BROAD breadth
//     When SPY outperforms RSP → only mega-caps are driving → NARROW breadth
//
//   Small-cap participation (IWM / SPY):
//     IWM = iShares Russell 2000 (small caps)
//     Small caps lead in healthy bull markets; lag when growth concerns dominate
//
//   Risk appetite (SPHB / SPLV):
//     SPHB = S&P 500 High Beta (most volatile stocks)
//     SPLV = S&P 500 Low Volatility (defensive leaders)
//     SPHB > SPLV = risk-on; SPLV > SPHB = defensive / risk-off
//
//   Mid-cap participation (MDY / SPY):
//     MDY = S&P MidCap 400 ETF — the "middle market" bellwether
//
// Signals computed per pair over the last 21 trading days:
//   - ratio_current: today's ETF ratio (A/B price)
//   - ratio_20d_avg: 20-day moving average of the ratio
//   - divergence_pct: how much current ratio deviates from 20d avg (%)
//   - momentum_5d_pct: 5-day trend in the ratio (positive = improving breadth)
//   - signal: OUTPERFORMING | NEUTRAL | UNDERPERFORMING
//
// Composite:
//   breadth_score   — -100 (extreme narrowing) to +100 (extreme breadth expansion)
//   breadth_regime  — STRONGLY_BULLISH | BULLISH | NEUTRAL | BEARISH | STRONGLY_BEARISH
//   breadth_summary — one-line interpretation
//
// Seam: equity-research and systematic-trading agents that need to know whether
// to size up (broad breadth) or reduce (narrow breadth). Natural complement to
// sector-rotation (sector-level allocation) and volatility-brief (VIX regime).
//
// Price: $0.010/call — parallel fetch of 5 ETFs × 1-month daily history.

const YF_BASE = "https://query2.finance.yahoo.com/v8/finance/chart";
const UA      = "Mozilla/5.0 (compatible; the-stall/5.0; +https://intuitek.ai)";
const TMO     = 16_000;

const r4 = n => n != null ? Math.round(n * 10000) / 10000 : null;
const r2 = n => n != null ? Math.round(n * 100) / 100 : null;

async function fetchCloses(ticker) {
  const url  = `${YF_BASE}/${encodeURIComponent(ticker)}?range=1mo&interval=1d`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal:  AbortSignal.timeout(TMO),
  });
  if (!resp.ok) throw new Error(`YF ${ticker} HTTP ${resp.status}`);
  const data   = await resp.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`YF ${ticker}: no result`);
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const valid  = closes.filter(v => v != null && !isNaN(v));
  const price  = result.meta?.regularMarketPrice ?? valid[valid.length - 1];
  return { ticker, closes: valid, price };
}

function computeRatioPair(aCloses, bCloses) {
  // Align to shortest series
  const n   = Math.min(aCloses.length, bCloses.length);
  if (n < 5) return null;

  const ratios = [];
  for (let i = aCloses.length - n; i < aCloses.length; i++) {
    const bi = i - (aCloses.length - n) + (bCloses.length - n);
    const b  = bCloses[bi];
    if (b && b !== 0) ratios.push(aCloses[i] / b);
  }

  if (ratios.length < 5) return null;

  const current    = ratios[ratios.length - 1];
  const avg20      = ratios.reduce((s, v) => s + v, 0) / ratios.length;
  const mom5       = ratios.length >= 5
    ? (current - ratios[ratios.length - 5]) / ratios[ratios.length - 5] * 100
    : null;
  const divergence = (current - avg20) / avg20 * 100;

  const signal =
    divergence > 0.3  ? "OUTPERFORMING" :
    divergence < -0.3 ? "UNDERPERFORMING" :
    "NEUTRAL";

  return {
    ratio_current:    r4(current),
    ratio_20d_avg:    r4(avg20),
    divergence_pct:   r2(divergence),
    momentum_5d_pct:  r2(mom5),
    signal,
  };
}

function breadthScore(equalWeightPair, smallCapPair, riskAppPair, midCapPair) {
  const pairs = [equalWeightPair, smallCapPair, riskAppPair, midCapPair];

  // Equal-weight vs cap-weight is the PRIMARY breadth signal (weighted 40%)
  // Small cap and risk appetite share 25% each, mid cap gets 10%
  const weights = [40, 25, 25, 10];

  let score = 0;
  let wtTotal = 0;

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (!p) continue;
    wtTotal += weights[i];
    // divergence_pct → score contribution capped at ±1 standard deviation (~0.8%)
    const contrib = Math.max(-1, Math.min(1, p.divergence_pct / 0.8)) * weights[i];
    score += contrib;
  }

  if (wtTotal === 0) return 0;
  return Math.round((score / wtTotal) * 100);
}

function regimeLabel(score) {
  if (score >= 40)  return "STRONGLY_BULLISH";
  if (score >= 15)  return "BULLISH";
  if (score >= -15) return "NEUTRAL";
  if (score >= -40) return "BEARISH";
  return "STRONGLY_BEARISH";
}

function breadthSummary(ewPair, scPair, raPair, mcPair, regime) {
  const signals = [];
  if (ewPair) signals.push(`equal-weight ${ewPair.signal.toLowerCase()} (RSP/SPY div ${ewPair.divergence_pct > 0 ? "+" : ""}${ewPair.divergence_pct?.toFixed(1)}%)`);
  if (scPair) signals.push(`small-caps ${scPair.signal.toLowerCase()} (IWM/SPY div ${scPair.divergence_pct > 0 ? "+" : ""}${scPair.divergence_pct?.toFixed(1)}%)`);
  if (raPair) signals.push(`risk-appetite ${raPair.signal.toLowerCase()}`);
  return `${regime}: ${signals.slice(0,2).join("; ")}`;
}

export default {
  name:  "market-breadth",
  price: "$0.010",
  description:
    "US stock market breadth dashboard via institutional ETF-ratio breadth proxies. Measures participation across equal-weight (RSP/SPY divergence), small-caps (IWM/SPY), risk appetite (SPHB/SPLV), and mid-caps (MDY/SPY). Returns per-pair ratios, 20-day average, divergence%, 5-day momentum, and OUTPERFORMING/NEUTRAL/UNDERPERFORMING signal for each. Composite breadth_score (−100..+100) and breadth_regime (STRONGLY_BULLISH → STRONGLY_BEARISH). Use to confirm whether a market rally has broad participation or is driven by narrow mega-cap leadership. Complements sector-rotation (sector allocation) and volatility-brief (VIX regime). No API key required.",

  inputSchema: {
    type:                 "object",
    properties:           {},
    required:             [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      equal_weight: {
        type:        ["object", "null"],
        description: "RSP vs SPY — equal-weight vs cap-weight breadth. Positive divergence = broad participation.",
        properties: {
          ratio_current:   { type: "number" },
          ratio_20d_avg:   { type: "number" },
          divergence_pct:  { type: "number", description: "Current ratio vs 20-day avg (%). Positive = RSP outperforming SPY." },
          momentum_5d_pct: { type: "number", description: "5-day ratio trend (%). Positive = breadth improving." },
          signal:          { type: "string", enum: ["OUTPERFORMING", "NEUTRAL", "UNDERPERFORMING"] },
        },
      },
      small_cap: {
        type:        ["object", "null"],
        description: "IWM vs SPY — small-cap vs large-cap participation. IWM outperforming = healthy risk-on breadth.",
        properties: {
          ratio_current:   { type: "number" },
          ratio_20d_avg:   { type: "number" },
          divergence_pct:  { type: "number" },
          momentum_5d_pct: { type: "number" },
          signal:          { type: "string", enum: ["OUTPERFORMING", "NEUTRAL", "UNDERPERFORMING"] },
        },
      },
      risk_appetite: {
        type:        ["object", "null"],
        description: "SPHB vs SPLV — high-beta vs low-volatility. SPHB outperforming = risk-on market posture.",
        properties: {
          ratio_current:   { type: "number" },
          ratio_20d_avg:   { type: "number" },
          divergence_pct:  { type: "number" },
          momentum_5d_pct: { type: "number" },
          signal:          { type: "string", enum: ["OUTPERFORMING", "NEUTRAL", "UNDERPERFORMING"] },
        },
      },
      mid_cap: {
        type:        ["object", "null"],
        description: "MDY vs SPY — mid-cap vs large-cap participation. MDY outperforming = broad market lift.",
        properties: {
          ratio_current:   { type: "number" },
          ratio_20d_avg:   { type: "number" },
          divergence_pct:  { type: "number" },
          momentum_5d_pct: { type: "number" },
          signal:          { type: "string", enum: ["OUTPERFORMING", "NEUTRAL", "UNDERPERFORMING"] },
        },
      },
      breadth_score:   { type: "integer", description: "Composite breadth score: −100 (extreme narrowing) to +100 (extreme breadth expansion)." },
      breadth_regime:  { type: "string",  description: "Breadth regime: STRONGLY_BULLISH | BULLISH | NEUTRAL | BEARISH | STRONGLY_BEARISH" },
      breadth_summary: { type: "string",  description: "One-line interpretation of the current breadth signal." },
      spy_price:       { type: ["number", "null"], description: "Current SPY price." },
      pairs_computed:  { type: "integer", description: "Number of ratio pairs successfully computed (of 4 attempted)." },
      ts:              { type: "string",  description: "ISO 8601 timestamp." },
    },
  },

  async handler() {
    const TICKERS = ["SPY", "RSP", "IWM", "SPHB", "SPLV", "MDY"];
    const settled = await Promise.allSettled(TICKERS.map(t => fetchCloses(t)));

    const Q = {};
    TICKERS.forEach((t, i) => {
      Q[t] = settled[i].status === "fulfilled" ? settled[i].value : null;
    });

    const SPY = Q["SPY"]?.closes;
    const RSP = Q["RSP"]?.closes;
    const IWM = Q["IWM"]?.closes;
    const SPHB = Q["SPHB"]?.closes;
    const SPLV = Q["SPLV"]?.closes;
    const MDY  = Q["MDY"]?.closes;

    const ewPair = (RSP  && SPY) ? computeRatioPair(RSP,  SPY)  : null;
    const scPair = (IWM  && SPY) ? computeRatioPair(IWM,  SPY)  : null;
    const raPair = (SPHB && SPLV) ? computeRatioPair(SPHB, SPLV) : null;
    const mcPair = (MDY  && SPY) ? computeRatioPair(MDY,  SPY)  : null;

    const pairs = [ewPair, scPair, raPair, mcPair];
    const computed = pairs.filter(Boolean).length;

    const score  = breadthScore(ewPair, scPair, raPair, mcPair);
    const regime = regimeLabel(score);
    const summary = breadthSummary(ewPair, scPair, raPair, mcPair, regime);

    return {
      equal_weight:    ewPair,
      small_cap:       scPair,
      risk_appetite:   raPair,
      mid_cap:         mcPair,
      breadth_score:   score,
      breadth_regime:  regime,
      breadth_summary: summary,
      spy_price:       Q["SPY"]?.price ? r2(Q["SPY"].price) : null,
      pairs_computed:  computed,
      ts:              new Date().toISOString(),
    };
  },
};
