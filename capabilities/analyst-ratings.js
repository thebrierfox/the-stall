// analyst-ratings.js
//
// Wall Street analyst consensus and price targets for any US equity.
// Sourced from Yahoo Finance quoteSummary (free, crumb-auth, no API key).
// Returns buy/hold/sell breakdown, mean consensus score, and price target range.
//
// Fills the gap between us-stock-price (current price) and equity-brief
// (AI synthesis): raw analyst data agents need for valuation models,
// buy-side screening, and conviction scoring without paying for synthesis.
//
// Seam: equity-research agents building automated stock screeners need
// analyst consensus as a signal layer. Currently they chain us-stock-price
// (price) + equity-technicals (momentum) without analyst view — this cap
// closes that gap at $0.010.

const UA          = "Mozilla/5.0 (compatible; the-stall/0.4; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const TMO          = 10_000;
const CRUMB_TTL    = 30 * 60 * 1000; // 30 min

let _crumbCache = null; // { crumb, cookies, ts }

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }

function rawVal(field) {
  if (field === null || field === undefined) return null;
  if (typeof field === "number") return field;
  return field?.raw ?? null;
}

async function refreshCrumb() {
  // Step 1: hit fc.yahoo.com to get session cookie
  const seedResp = await fetch(YF_CRUMB_SRC, {
    headers: { "User-Agent": UA },
    redirect: "follow",
    signal: AbortSignal.timeout(TMO),
  });
  const setCookies = seedResp.headers.getSetCookie?.() ?? [];
  const cookies = setCookies.map(c => c.split(";")[0]).join("; ");

  // Step 2: exchange cookie for crumb
  const crumbResp = await fetch(YF_CRUMB_URL, {
    headers: { "User-Agent": UA, "Cookie": cookies },
    signal: AbortSignal.timeout(TMO),
  });
  if (!crumbResp.ok) throw new Error(`crumb fetch failed: ${crumbResp.status}`);
  const crumb = (await crumbResp.text()).trim();
  if (!crumb) throw new Error("empty crumb returned");

  _crumbCache = { crumb, cookies, ts: Date.now() };
  return _crumbCache;
}

async function getCrumb() {
  if (_crumbCache && (Date.now() - _crumbCache.ts) < CRUMB_TTL) {
    return _crumbCache;
  }
  return refreshCrumb();
}

async function fetchQuoteSummary(ticker, modules, retry = true) {
  const { crumb, cookies } = await getCrumb();
  const url = `${YF_SUMMARY}/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
    signal: AbortSignal.timeout(TMO),
  });
  if (resp.status === 401 && retry) {
    _crumbCache = null; // force refresh
    return fetchQuoteSummary(ticker, modules, false);
  }
  if (!resp.ok) throw new Error(`Yahoo Finance returned ${resp.status}`);
  return resp.json();
}

const CONSENSUS_LABELS = {
  strongbuy:  "Strong Buy",
  buy:        "Buy",
  hold:       "Hold",
  sell:       "Sell",
  strongsell: "Strong Sell",
};

function normalizeKey(k) {
  return (k || "").toLowerCase().replace(/_/g, "");
}

export default {
  name: "analyst-ratings",
  price: "$0.295",

  description:
    "Wall Street analyst consensus and price targets for any US equity. Returns buy/hold/sell breakdown, mean recommendation score (1=Strong Buy, 5=Strong Sell), analyst count, and price target range (low/mean/median/high) with upside-to-target. Free Yahoo Finance data, no API key. Complements us-stock-price and equity-technicals with the analyst conviction layer.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker symbol (e.g. AAPL, NVDA, MSFT). Case-insensitive.",
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:            { type: "string",  description: "Canonical ticker symbol." },
      name:              { type: "string",  description: "Company name." },
      consensus:         { type: "string",  description: "Analyst consensus label: Strong Buy, Buy, Hold, Sell, or Strong Sell." },
      consensus_score:   { type: "number",  description: "Mean recommendation score (1=Strong Buy, 3=Hold, 5=Strong Sell)." },
      analyst_count:     { type: "integer", description: "Number of analysts providing coverage." },
      price_current:     { type: "number",  description: "Current stock price in USD." },
      target_mean:       { type: "number",  description: "Mean analyst price target (USD)." },
      target_median:     { type: "number",  description: "Median analyst price target (USD)." },
      target_high:       { type: "number",  description: "Highest analyst price target (USD)." },
      target_low:        { type: "number",  description: "Lowest analyst price target (USD)." },
      upside_pct:        { type: "number",  description: "Upside to mean target from current price (%)." },
      trend: {
        type: "array",
        description: "Rating distribution for current and prior 3 months (period 0m=current, -1m, -2m, -3m).",
        items: {
          type: "object",
          properties: {
            period:      { type: "string" },
            strong_buy:  { type: "integer" },
            buy:         { type: "integer" },
            hold:        { type: "integer" },
            sell:        { type: "integer" },
            strong_sell: { type: "integer" },
            total:       { type: "integer" },
          },
        },
      },
      ts: { type: "string", description: "ISO-8601 timestamp of this response." },
    },
  },

  async handler(query) {
    const rawTicker = (query.ticker || "AAPL").trim();

    const ticker = rawTicker.toUpperCase().replace(/[^A-Z0-9.\-^]/g, "");
    if (!ticker) throw new Error("invalid ticker symbol");

    let data;
    try {
      data = await fetchQuoteSummary(ticker, "financialData,recommendationTrend,quoteType");
    } catch (err) {
      throw new Error(`upstream fetch failed: ${err.message}`);
    }

    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      const errMsg = data?.quoteSummary?.error?.description || "no data";
      throw new Error(`no analyst data for "${ticker}": ${errMsg}`);
    }

    const fd = result.financialData       || {};
    const rt = result.recommendationTrend || {};
    const qt = result.quoteType           || {};

    const consensusKey   = fd.recommendationKey || null;
    const consensusScore = r2(rawVal(fd.recommendationMean));
    const analystCount   = rawVal(fd.numberOfAnalystOpinions);
    const currentPrice   = r2(rawVal(fd.currentPrice));
    const targetMean     = r2(rawVal(fd.targetMeanPrice));
    const targetMedian   = r2(rawVal(fd.targetMedianPrice));
    const targetHigh     = r2(rawVal(fd.targetHighPrice));
    const targetLow      = r2(rawVal(fd.targetLowPrice));

    const upside = (currentPrice && targetMean)
      ? r2(((targetMean - currentPrice) / currentPrice) * 100)
      : null;

    const trend = (rt.trend || []).map(t => ({
      period:      t.period,
      strong_buy:  t.strongBuy  ?? 0,
      buy:         t.buy         ?? 0,
      hold:        t.hold        ?? 0,
      sell:        t.sell        ?? 0,
      strong_sell: t.strongSell ?? 0,
      total: (t.strongBuy ?? 0) + (t.buy ?? 0) + (t.hold ?? 0)
           + (t.sell ?? 0)      + (t.strongSell ?? 0),
    }));

    if (!consensusScore && !analystCount && !targetMean) {
      throw new Error(`no analyst coverage found for "${ticker}"`);
    }

    return {
      ticker,
      name:            qt.longName || qt.shortName || null,
      consensus:       CONSENSUS_LABELS[normalizeKey(consensusKey)] || consensusKey || null,
      consensus_score: consensusScore,
      analyst_count:   analystCount,
      price_current:   currentPrice,
      target_mean:     targetMean,
      target_median:   targetMedian,
      target_high:     targetHigh,
      target_low:      targetLow,
      upside_pct:      upside,
      trend,
      ts: new Date().toISOString(),
    };
  },
};
