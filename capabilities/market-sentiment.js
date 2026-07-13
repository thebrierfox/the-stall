// market-sentiment.js
//
// Crypto market sentiment: Fear & Greed Index (alternative.me) + BTC/ETH
// implied volatility from Deribit options market. Both free, no keys.
//
// Agents use sentiment + IV together: Fear & Greed tells you what the crowd
// feels; IV tells you what options traders are PAYING to hedge. When FGI is
// extreme (< 20 or > 80) and IV is elevated, it's a regime signal — not just
// noise. Price: $0.015/call for the combined signal.

const FGI_URL    = "https://api.alternative.me/fng/?limit=30";
const DERIBIT    = "https://www.deribit.com/api/v2/public/get_volatility_index_data";
const UA         = "Mozilla/5.0 (compatible; the-stall/1.8; +https://intuitek.ai)";
const TIMEOUT_MS = 10000;

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...options,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return resp.json();
}

async function getDeribitIV(currency) {
  const now      = Date.now();
  const start    = now - 7 * 24 * 3600 * 1000; // 7 days back
  const url      = `${DERIBIT}?currency=${currency}&start_timestamp=${start}&end_timestamp=${now}&resolution=3600`;
  const body     = await fetchJson(url);
  const pts      = (body.result?.data || []);
  if (!pts.length) return null;
  // Last point is current IV
  const last     = pts[pts.length - 1];
  const wkAgo    = pts[0];
  return {
    current:      Math.round(last[4] * 100) / 100,   // close IV
    week_ago:     Math.round(wkAgo[4] * 100) / 100,
    week_high:    Math.round(Math.max(...pts.map(p => p[2])) * 100) / 100,
    week_low:     Math.round(Math.min(...pts.map(p => p[3])) * 100) / 100,
    trend:        last[4] > wkAgo[4] ? "RISING" : last[4] < wkAgo[4] ? "FALLING" : "FLAT",
  };
}

function fgiRegime(value) {
  if (value <= 20)  return "EXTREME_FEAR";
  if (value <= 40)  return "FEAR";
  if (value <= 60)  return "NEUTRAL";
  if (value <= 80)  return "GREED";
  return "EXTREME_GREED";
}

function compositeSignal(fgi, btcIv) {
  // High IV + Extreme Fear = historically a contrarian buy setup
  // High IV + Extreme Greed = overheated, risk of sharp correction
  // Low IV + Neutral/Greed = complacency (often precedes volatility event)
  if (!btcIv) return "INSUFFICIENT_DATA";
  const iv = btcIv.current;
  if (fgi <= 20 && iv >= 70)     return "CAPITULATION_ZONE";  // panic + high hedging
  if (fgi <= 20 && iv < 40)      return "QUIET_DREAD";        // fear without options demand
  if (fgi >= 80 && iv >= 60)     return "OVERHEATED";         // euphoria + expensive hedges
  if (fgi >= 80 && iv < 40)      return "COMPLACENT_GREED";   // euphoria without hedging
  if (fgi >= 40 && fgi <= 60 && iv < 30) return "CALM_MARKET"; // boring = vol event loading
  return "NEUTRAL_REGIME";
}

export default {
  name:  "market-sentiment",
  price: "$0.040",

  description:
    "Combined crypto market sentiment signal: Crypto Fear & Greed Index (alternative.me, 0–100, 30-day trend) plus BTC and ETH Implied Volatility from Deribit options market (annualized %). Free upstream sources, no keys. Returns current FGI value, classification (Extreme Fear to Extreme Greed), 7-day FGI trend, IV trend (RISING/FALLING/FLAT), and a composite regime label (CAPITULATION_ZONE, OVERHEATED, COMPLACENT_GREED, CALM_MARKET, etc.). Use before making large DeFi positions, calibrating yield farming risk, or routing agent spend in volatile conditions.",

  inputSchema: {
    type: "object",
    properties: {
      history_days: {
        type: "integer",
        description: "Number of past daily FGI readings to include in response (1–30). Default 7.",
        default: 7,
        minimum: 1,
        maximum: 30,
      },
      include_iv: {
        type: "boolean",
        description: "Whether to fetch Deribit BTC/ETH implied volatility (adds ~500ms). Default true.",
        default: true,
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      fgi: {
        type: "object",
        properties: {
          value:           { type: "integer", description: "Current Fear & Greed score 0 (max fear) to 100 (max greed)." },
          classification:  { type: "string",  description: "EXTREME_FEAR | FEAR | NEUTRAL | GREED | EXTREME_GREED" },
          yesterday:       { type: "integer" },
          last_week:       { type: "integer" },
          trend_7d:        { type: "string",  description: "IMPROVING | DETERIORATING | STABLE" },
          history:         { type: "array",   description: "Daily FGI readings (newest first)." },
        },
      },
      implied_volatility: {
        type: "object",
        properties: {
          btc: { type: ["object", "null"] },
          eth: { type: ["object", "null"] },
          note: { type: "string" },
        },
      },
      composite_signal: {
        type: "string",
        description: "Regime label combining FGI + IV: CAPITULATION_ZONE | OVERHEATED | COMPLACENT_GREED | QUIET_DREAD | CALM_MARKET | NEUTRAL_REGIME | INSUFFICIENT_DATA",
      },
      ts: { type: "string" },
    },
  },

  async handler(query) {
    const histDays = Math.min(Math.max(1, query.history_days || 7), 30);
    const inclIv   = query.include_iv !== false;

    // Parallel fetches
    const [fgiRaw, btcIv, ethIv] = await Promise.all([
      fetchJson(`https://api.alternative.me/fng/?limit=${histDays}`),
      inclIv ? getDeribitIV("BTC").catch(() => null) : Promise.resolve(null),
      inclIv ? getDeribitIV("ETH").catch(() => null) : Promise.resolve(null),
    ]);

    const data   = fgiRaw.data || [];
    const latest = data[0] || {};
    const fgiNow = parseInt(latest.value || "50", 10);

    const history = data.map((d) => ({
      date:           new Date(parseInt(d.timestamp, 10) * 1000).toISOString().split("T")[0],
      value:          parseInt(d.value, 10),
      classification: fgiRegime(parseInt(d.value, 10)),
    }));

    const yesterday = data[1] ? parseInt(data[1].value, 10) : null;
    const lastWeek  = data[6] ? parseInt(data[6].value, 10) : null;
    let trend7d = "STABLE";
    if (lastWeek !== null) {
      if (fgiNow > lastWeek + 5)  trend7d = "IMPROVING";
      if (fgiNow < lastWeek - 5)  trend7d = "DETERIORATING";
    }

    return {
      fgi: {
        value:          fgiNow,
        classification: fgiRegime(fgiNow),
        yesterday,
        last_week: lastWeek,
        trend_7d:  trend7d,
        history,
      },
      implied_volatility: {
        btc:  btcIv,
        eth:  ethIv,
        note: "Deribit DVOL annualized implied volatility (%). Based on 25-delta risk reversal from listed options.",
      },
      composite_signal: compositeSignal(fgiNow, btcIv),
      ts: new Date().toISOString(),
    };
  },
};
