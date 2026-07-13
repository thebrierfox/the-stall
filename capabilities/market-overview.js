// market-overview.js
//
// Returns a cross-asset market snapshot in a single call: major equity ETFs
// (SPY/QQQ/IWM/DIA), VIX, 10-year yield, and a composite risk posture signal
// derived from VIX level and breadth divergence. Uses the same Yahoo Finance
// public chart API as us-stock-price — no API key, no crumb required.

const YF_BASE = "https://query2.finance.yahoo.com/v8/finance/chart";
const UA      = "Mozilla/5.0 (compatible; the-stall/0.5; +https://intuitek.ai)";

const INSTRUMENTS = ["SPY", "QQQ", "IWM", "DIA", "^VIX", "^TNX"];

async function fetchInstrument(ticker) {
  const url = `${YF_BASE}/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(8000),
  });
  const data = await resp.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const prev  = meta.chartPreviousClose ?? meta.regularMarketPrice;
  const price = meta.regularMarketPrice;
  const diff  = price - prev;
  const pct   = prev !== 0 ? (diff / prev) * 100 : 0;
  return {
    ticker:     meta.symbol,
    price:      Math.round(price * 10000) / 10000,
    change_pct: Math.round(pct   * 10000) / 10000,
    change_usd: Math.round(diff  * 10000) / 10000,
  };
}

function riskPosture(vix, spyPct, qqpPct, iwmPct) {
  if (vix === null) return "UNKNOWN";
  // Breadth: count how many of SPY/QQQ/IWM are positive
  const advances = [spyPct, qqpPct, iwmPct].filter((p) => p !== null && p > 0).length;
  if (vix < 15 && advances >= 2) return "RISK_ON";
  if (vix > 25) return "RISK_OFF_ELEVATED";
  if (vix > 20) return "RISK_OFF";
  if (advances === 0 && vix > 18) return "RISK_OFF";
  return "NEUTRAL";
}

export default {
  name: "market-overview",
  price: "$0.100",

  description:
    "Single-call market snapshot: SPY, QQQ, IWM, and DIA price + intraday % change, VIX fear gauge, 10-year Treasury yield (^TNX), and a derived risk-posture signal (RISK_ON / NEUTRAL / RISK_OFF / RISK_OFF_ELEVATED). Replaces 5–6 individual price calls with one structured payload useful for position-sizing, regime detection, or pre-trade context. Sourced from Yahoo Finance public data — live during market hours.",

  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      spy:  {
        type: "object",
        description: "S&P 500 ETF (SPY): price, change_pct, change_usd.",
        properties: { ticker:{type:"string"}, price:{type:"number"}, change_pct:{type:"number"}, change_usd:{type:"number"} },
      },
      qqq:  {
        type: "object",
        description: "NASDAQ-100 ETF (QQQ): price, change_pct, change_usd.",
        properties: { ticker:{type:"string"}, price:{type:"number"}, change_pct:{type:"number"}, change_usd:{type:"number"} },
      },
      iwm:  {
        type: "object",
        description: "Russell 2000 ETF (IWM): price, change_pct, change_usd.",
        properties: { ticker:{type:"string"}, price:{type:"number"}, change_pct:{type:"number"}, change_usd:{type:"number"} },
      },
      dia:  {
        type: "object",
        description: "Dow Jones ETF (DIA): price, change_pct, change_usd.",
        properties: { ticker:{type:"string"}, price:{type:"number"}, change_pct:{type:"number"}, change_usd:{type:"number"} },
      },
      vix:  {
        type: "object",
        description: "CBOE Volatility Index (VIX): current level and intraday change.",
        properties: { ticker:{type:"string"}, price:{type:"number"}, change_pct:{type:"number"}, change_usd:{type:"number"} },
      },
      yield_10y: {
        type: "object",
        description: "US 10-Year Treasury Yield (^TNX): current yield and intraday change.",
        properties: { ticker:{type:"string"}, price:{type:"number"}, change_pct:{type:"number"}, change_usd:{type:"number"} },
      },
      risk_posture: {
        type: "string",
        enum: ["RISK_ON", "NEUTRAL", "RISK_OFF", "RISK_OFF_ELEVATED", "UNKNOWN"],
        description: "Composite signal derived from VIX level and equity breadth. RISK_ON = VIX <15 and ≥2 indices advancing. RISK_OFF_ELEVATED = VIX >25. Use as a regime filter, not a trading signal.",
      },
      ts: { type: "string", description: "ISO-8601 timestamp of this response." },
    },
  },

  async handler(_query) {
    const results = await Promise.allSettled(INSTRUMENTS.map((t) => fetchInstrument(t)));

    const byTicker = {};
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        byTicker[r.value.ticker] = r.value;
      }
    }

    const spy = byTicker["SPY"]  || null;
    const qqq = byTicker["QQQ"]  || null;
    const iwm = byTicker["IWM"]  || null;
    const dia = byTicker["DIA"]  || null;
    const vix = byTicker["^VIX"] || null;
    const tnx = byTicker["^TNX"] || null;

    return {
      spy,
      qqq,
      iwm,
      dia,
      vix,
      yield_10y: tnx,
      risk_posture: riskPosture(
        vix?.price ?? null,
        spy?.change_pct ?? null,
        qqq?.change_pct ?? null,
        iwm?.change_pct ?? null,
      ),
      ts: new Date().toISOString(),
    };
  },
};
