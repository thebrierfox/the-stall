// volatility-brief.js
//
// US equity volatility regime snapshot — VIX term structure, vol-of-vol, and skew.
//
// Assembles 4 CBOE volatility indices into a unified vol dashboard:
//   VIX  (30-day implied vol — the "fear gauge")
//   VXMT (93-day implied vol — medium-term vol expectations)
//   VVIX (volatility of VIX — uncertainty about vol itself)
//   SKEW (tail-risk demand — implied probability of >2σ SPX move)
//
// Derived signals:
//   - VIX 1-year percentile rank (vs trailing 252-day history)
//   - Term structure: CONTANGO (VIX < VXMT) / FLAT / BACKWARDATION
//   - Vol regime: CALM (<15) / MODERATE (15-20) / ELEVATED (20-30) / CRISIS (≥30)
//   - VVIX signal: UNCERTAINTY (>110) / ELEVATED (90-110) / CALM (<90)
//   - SKEW signal: HIGH_TAIL_DEMAND (>145) / MODERATE (130-145) / LOW (<130)
//   - Composite: RISK_OFF / CAUTION / NEUTRAL / COMPLACENCY
//
// Seam: systematic trading / risk management agents check vol regime before
// entering positions; options traders assess vol surface shape before sizing.
// market-regime-intel uses VIX as 1 of 5 signals; this provides vol-specialist depth.
//
// Data: CBOE delayed historical endpoint (free, no auth, ~15-min delay).
// Price: $0.020/call

"use strict";

const CBOE_HIST = "https://cdn.cboe.com/api/global/delayed_quotes/charts/historical";
const UA        = "Mozilla/5.0 (compatible; the-stall/5.0; +https://intuitek.ai)";
const TIMEOUT   = 14_000;

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }

async function fetchCBOE(ticker) {
  const url = `${CBOE_HIST}/${ticker}.json`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) throw new Error(`CBOE ${ticker} HTTP ${resp.status}`);
  const body = await resp.json();
  const rows = body?.data;
  if (!rows?.length) throw new Error(`No CBOE data for ${ticker}`);
  return rows;
}

function percentileRank(series, value) {
  const sorted = [...series].sort((a, b) => a - b);
  const below  = sorted.filter(v => v < value).length;
  return r2((below / sorted.length) * 100);
}

function termStructureLabel(vix, vxmt) {
  const spread = vxmt - vix;
  if (spread > 1.5)  return "CONTANGO";
  if (spread < -1.5) return "BACKWARDATION";
  return "FLAT";
}

function volRegime(vix) {
  if (vix >= 30) return "CRISIS";
  if (vix >= 20) return "ELEVATED";
  if (vix >= 15) return "MODERATE";
  return "CALM";
}

function vvixSignal(vvix) {
  if (vvix > 110) return "UNCERTAINTY";
  if (vvix >= 90) return "ELEVATED";
  return "CALM";
}

function skewSignal(skew) {
  if (skew > 145) return "HIGH_TAIL_DEMAND";
  if (skew >= 130) return "MODERATE";
  return "LOW";
}

function compositeSignal(vix, termStructure, vvixSig, skewSig) {
  let riskScore = 0;
  if (vix >= 30) riskScore += 3;
  else if (vix >= 20) riskScore += 2;
  else if (vix >= 15) riskScore += 1;
  if (termStructure === "BACKWARDATION") riskScore += 2;
  if (vvixSig === "UNCERTAINTY") riskScore += 2;
  else if (vvixSig === "ELEVATED") riskScore += 1;
  if (skewSig === "HIGH_TAIL_DEMAND") riskScore += 1;

  if (riskScore >= 5) return "RISK_OFF";
  if (riskScore >= 3) return "CAUTION";
  if (vix < 14 && termStructure === "CONTANGO" && skewSig === "LOW") return "COMPLACENCY";
  return "NEUTRAL";
}

export default {
  name: "volatility-brief",
  price: "$0.059",
  description:
    "US stock market volatility brief — VIX (30-day), VXMT (93-day), VVIX (vol-of-vol), and SKEW index assembled into a single vol dashboard. Outputs term structure (CONTANGO/FLAT/BACKWARDATION), VIX percentile rank, vol regime (CALM/MODERATE/ELEVATED/CRISIS), and composite signal (RISK_OFF/CAUTION/NEUTRAL/COMPLACENCY). Free CBOE delayed data, no API key. Use with market-regime-intel for full macro context.",

  inputSchema: {
    type: "object",
    properties: {
      history_days: {
        type: "integer",
        minimum: 20,
        maximum: 252,
        description:
          "Trading days of VIX history to use for percentile rank. Default 252 (1 year).",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      vix:                   { type: "number",  description: "Current VIX (30-day implied vol)." },
      vxmt:                  { type: "number",  description: "Current VXMT (93-day implied vol)." },
      vvix:                  { type: "number",  description: "Current VVIX (vol-of-vol)." },
      skew:                  { type: "number",  description: "Current CBOE SKEW index." },
      vix_percentile_1yr:    { type: "number",  description: "VIX percentile vs trailing 252-day history (0–100). Higher = more stress than usual." },
      spread_vxmt_minus_vix: { type: "number",  description: "VXMT minus VIX in raw vol points. Positive = contango." },
      term_structure:        { type: "string",  description: "CONTANGO | FLAT | BACKWARDATION (VIX vs VXMT)." },
      vol_regime:            { type: "string",  description: "CALM (<15) | MODERATE (15-20) | ELEVATED (20-30) | CRISIS (≥30)." },
      vvix_signal:           { type: "string",  description: "UNCERTAINTY (>110) | ELEVATED (90-110) | CALM (<90). High VVIX = hedging demand surging." },
      skew_signal:           { type: "string",  description: "HIGH_TAIL_DEMAND (>145) | MODERATE (130-145) | LOW (<130). Measures tail-risk put demand." },
      composite_signal:      { type: "string",  description: "RISK_OFF | CAUTION | NEUTRAL | COMPLACENCY. Synthesizes all 4 signals." },
      as_of:                 { type: "string",  description: "Date of the most recent data point." },
      note:                  { type: "string",  description: "Context note when data is unavailable or degraded." },
    },
    required: ["vix", "term_structure", "vol_regime", "composite_signal", "as_of"],
    additionalProperties: false,
  },

  async handler({ history_days = 252 } = {}) {
    const [vixRows, vxmtRows, vvixRows, skewRows] = await Promise.all([
      fetchCBOE("_VIX"),
      fetchCBOE("_VXMT").catch(() => null),
      fetchCBOE("_VVIX").catch(() => null),
      fetchCBOE("_SKEW").catch(() => null),
    ]);

    const parse  = (rows, n = 1) => rows.slice(-n).map(r => parseFloat(r.close)).filter(v => !isNaN(v));
    const last   = arr => arr?.[arr.length - 1] ?? null;

    const vixSeries = parse(vixRows, Math.max(history_days, 252));
    const currentVIX = last(vixSeries);
    if (currentVIX == null) throw new Error("VIX data unavailable");

    const hDays = Math.min(history_days, vixSeries.length);
    const vixHistory = vixSeries.slice(-hDays);

    const currentVXMT = vxmtRows ? last(parse(vxmtRows)) : null;
    const currentVVIX = vvixRows ? last(parse(vvixRows)) : null;
    const currentSKEW = skewRows ? last(parse(skewRows)) : null;

    const asOf = vixRows.at(-1)?.date ?? new Date().toISOString().slice(0, 10);

    const termStruct = currentVXMT != null
      ? termStructureLabel(currentVIX, currentVXMT)
      : "UNAVAILABLE";

    const regime   = volRegime(currentVIX);
    const vvixSig  = currentVVIX != null ? vvixSignal(currentVVIX)  : null;
    const skewSig  = currentSKEW != null ? skewSignal(currentSKEW)  : null;
    const composite = compositeSignal(
      currentVIX,
      termStruct === "UNAVAILABLE" ? "FLAT" : termStruct,
      vvixSig ?? "CALM",
      skewSig ?? "MODERATE"
    );

    const out = {
      vix:                   r2(currentVIX),
      vxmt:                  r2(currentVXMT),
      vvix:                  r2(currentVVIX),
      skew:                  r2(currentSKEW),
      vix_percentile_1yr:    percentileRank(vixHistory, currentVIX),
      spread_vxmt_minus_vix: currentVXMT != null ? r2(currentVXMT - currentVIX) : null,
      term_structure:        termStruct,
      vol_regime:            regime,
      vvix_signal:           vvixSig,
      skew_signal:           skewSig,
      composite_signal:      composite,
      as_of:                 asOf,
    };

    if (currentVXMT == null || currentVVIX == null || currentSKEW == null) {
      out.note = [
        currentVXMT == null ? "VXMT unavailable (CBOE endpoint may be delayed)" : null,
        currentVVIX == null ? "VVIX unavailable" : null,
        currentSKEW == null ? "SKEW unavailable" : null,
      ].filter(Boolean).join("; ");
    }

    return out;
  },
};
