// price-target-consensus.js
//
// Analyst price target consensus for any US public company.
// Returns current price vs consensus target, buy/hold/sell distribution,
// target high/low/mean/median, number of covering analysts, and 12-month
// implied upside — in one call.
//
// Seam: equity-research agents chain dcf-valuation + peer-benchmarking but
// lack the analyst-consensus sanity check. The next question after "is my
// DCF reasonable?" is always "what do analysts think the stock is worth?"
// This cap closes that gap without requiring a paid data provider.
//
// Upstream: Yahoo Finance quoteSummary (financialData, recommendationSummary,
// defaultKeyStatistics) — free, crumb-auth.
//
// Price: $0.010

const UA           = "Mozilla/5.0 (compatible; the-stall/5.0; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const MODULES      = "financialData,recommendationSummary,defaultKeyStatistics,summaryDetail";
const TMO          = 12_000;
const CRUMB_TTL    = 30 * 60 * 1000;

let _crumbCache = null;

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }
function rawVal(f) {
  if (f == null) return null;
  if (typeof f === "number") return f;
  return f?.raw ?? null;
}

async function refreshCrumb() {
  const seed = await fetch(YF_CRUMB_SRC, {
    headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(TMO),
  });
  const cookies = (seed.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
  const cr = await fetch(YF_CRUMB_URL, {
    headers: { "User-Agent": UA, "Cookie": cookies }, signal: AbortSignal.timeout(TMO),
  });
  if (!cr.ok) throw new Error(`crumb fetch ${cr.status}`);
  const crumb = (await cr.text()).trim();
  if (!crumb) throw new Error("empty crumb");
  _crumbCache = { crumb, cookies, ts: Date.now() };
  return _crumbCache;
}

async function getCrumb() {
  if (_crumbCache && (Date.now() - _crumbCache.ts) < CRUMB_TTL) return _crumbCache;
  return refreshCrumb();
}

async function fetchData(ticker, retry = true) {
  const { crumb, cookies } = await getCrumb();
  const url = `${YF_SUMMARY}/${encodeURIComponent(ticker)}?modules=${MODULES}&crumb=${encodeURIComponent(crumb)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
    signal: AbortSignal.timeout(TMO),
  });
  if (resp.status === 401 && retry) { _crumbCache = null; return fetchData(ticker, false); }
  if (!resp.ok) throw new Error(`YF quoteSummary ${resp.status}`);
  return resp.json();
}

export default {
  name:  "price-target-consensus",
  price: "$0.031",

  description:
    "Analyst price target consensus for any US public company: current price, 12-month consensus target (mean, median, high, low), buy/hold/sell analyst count, implied upside %, and recommendation trend. Pulled from Yahoo Finance — no API key required.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker (e.g. AAPL, NVDA, MSFT). Case-insensitive.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:             { type: "string" },
      name:               { type: "string" },
      current_price_usd:  { type: "number" },
      consensus: {
        type: "object",
        properties: {
          target_mean_usd:   { type: "number", description: "Mean analyst 12-month price target." },
          target_median_usd: { type: "number", description: "Median analyst 12-month price target." },
          target_high_usd:   { type: "number", description: "Highest analyst price target." },
          target_low_usd:    { type: "number", description: "Lowest analyst price target." },
          implied_upside_pct: { type: "number", description: "Implied upside from current price to mean target in %." },
          analyst_count:     { type: "integer", description: "Number of analysts covering this stock." },
          recommendation:    { type: "string", description: "Text label from Yahoo: strongBuy | buy | hold | underperform | sell." },
          recommendation_mean: { type: "number", description: "Mean recommendation score (1=strong buy, 5=sell)." },
        },
      },
      rating_distribution: {
        type: "object",
        description: "Analyst rating breakdown.",
        properties: {
          strong_buy: { type: "integer" },
          buy:        { type: "integer" },
          hold:       { type: "integer" },
          underperform: { type: "integer" },
          sell:       { type: "integer" },
          total:      { type: "integer" },
          pct_bullish: { type: "number", description: "% of analysts with buy or strong buy rating." },
        },
      },
      valuation_context: {
        type: "object",
        description: "Key valuation multiples for context alongside the price target.",
        properties: {
          pe_forward:     { type: "number" },
          pe_trailing:    { type: "number" },
          price_to_book:  { type: "number" },
          ev_to_ebitda:   { type: "number" },
          market_cap_usd: { type: "number" },
        },
      },
      notes: { type: "array", items: { type: "string" } },
      ts:    { type: "string" },
    },
  },

  async handler(query) {
    const rawTicker = (query.ticker || "AAPL").trim().toUpperCase().replace(/[^A-Z0-9.\-^]/g, "");
    if (!rawTicker) throw new Error("invalid ticker");
    const notes = [];

    const summaryData = await fetchData(rawTicker);
    const r = summaryData?.quoteSummary?.result?.[0];
    if (!r) throw new Error(`No data for "${rawTicker}"`);

    const fd = r.financialData         || {};
    const rs = r.recommendationSummary || {};
    const ks = r.defaultKeyStatistics  || {};
    const sd = r.summaryDetail         || {};
    const qi = r.quoteType             || {};

    const name  = qi.longName || qi.shortName || rawTicker;
    const price = rawVal(fd.currentPrice) ?? rawVal(sd.previousClose);
    if (!price) throw new Error(`No current price for "${rawTicker}"`);

    const targetMean   = rawVal(fd.targetMeanPrice);
    const targetMedian = rawVal(fd.targetMedianPrice);
    const targetHigh   = rawVal(fd.targetHighPrice);
    const targetLow    = rawVal(fd.targetLowPrice);
    const numAnalysts  = rawVal(fd.numberOfAnalystOpinions) ?? 0;
    const recText      = fd.recommendationKey ?? null;
    const recMean      = rawVal(fd.recommendationMean);

    const impliedUpside = targetMean != null ? r2(((targetMean - price) / price) * 100) : null;

    if (!targetMean) notes.push("No analyst price targets available for this ticker.");

    // Rating distribution from recommendationSummary (recent periods)
    let strongBuy = 0, buy = 0, hold = 0, underperform = 0, sell = 0;
    const trend = rs.recommendationTrend ?? [];
    const latestPeriod = trend.find(t => t.period === "0m") ?? trend[0];
    if (latestPeriod) {
      strongBuy    = latestPeriod.strongBuy    ?? 0;
      buy          = latestPeriod.buy          ?? 0;
      hold         = latestPeriod.hold         ?? 0;
      underperform = latestPeriod.underperform ?? 0;
      sell         = latestPeriod.sell         ?? 0;
    }
    const total      = strongBuy + buy + hold + underperform + sell;
    const pctBullish = total > 0 ? r2(((strongBuy + buy) / total) * 100) : null;

    const pe_forward   = rawVal(ks.forwardPE)   ?? rawVal(sd.forwardPE);
    const pe_trailing  = rawVal(ks.trailingPE)  ?? rawVal(sd.trailingPE);
    const pb           = rawVal(ks.priceToBook) ?? rawVal(sd.priceToBook);
    const evEbitda     = rawVal(ks.enterpriseToEbitda);
    const marketCap    = rawVal(ks.marketCap)   ?? rawVal(sd.marketCap);

    return {
      ticker: rawTicker,
      name,
      current_price_usd: r2(price),
      consensus: {
        target_mean_usd:    targetMean   != null ? r2(targetMean)   : null,
        target_median_usd:  targetMedian != null ? r2(targetMedian) : null,
        target_high_usd:    targetHigh   != null ? r2(targetHigh)   : null,
        target_low_usd:     targetLow    != null ? r2(targetLow)    : null,
        implied_upside_pct: impliedUpside,
        analyst_count:      numAnalysts,
        recommendation:     recText,
        recommendation_mean: recMean != null ? r2(recMean) : null,
      },
      rating_distribution: {
        strong_buy:   strongBuy,
        buy,
        hold,
        underperform,
        sell,
        total,
        pct_bullish:  pctBullish,
      },
      valuation_context: {
        pe_forward:    pe_forward   != null ? r2(pe_forward)  : null,
        pe_trailing:   pe_trailing  != null ? r2(pe_trailing) : null,
        price_to_book: pb           != null ? r2(pb)          : null,
        ev_to_ebitda:  evEbitda     != null ? r2(evEbitda)    : null,
        market_cap_usd: marketCap,
      },
      notes,
      ts: new Date().toISOString(),
    };
  },
};
