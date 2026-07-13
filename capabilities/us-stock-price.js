// us-stock-price.js
//
// Returns current US equity price + intraday metrics from Yahoo Finance public
// chart API (no API key required). Priced at $0.059.
//
// Data source: Yahoo Finance v8/finance/chart (public, no auth, no crumb).
// Updates on each call — live market data during trading hours, last-close
// after hours.

const YF_BASE = "https://query2.finance.yahoo.com/v8/finance/chart";
const UA      = "Mozilla/5.0 (compatible; the-stall/0.4; +https://intuitek.ai)";

export default {
  name: "us-stock-price",
  price: "$0.295",

  description:
    "Returns current US stock price and intraday metrics (change %, volume, day high/low, 52-week range) for any NYSE/NASDAQ stock ticker. Sourced from Yahoo Finance public data — no API key, live during market hours.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker symbol (e.g. AMD, AAPL, NVDA). Case-insensitive.",
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:        { type: "string",  description: "Canonical ticker as reported by the exchange." },
      name:          { type: "string",  description: "Company full name." },
      price_usd:     { type: "number",  description: "Current market price in USD." },
      change_pct:    { type: "number",  description: "Percentage change from previous close (negative = down)." },
      change_usd:    { type: "number",  description: "Absolute change in USD from previous close." },
      volume:        { type: "integer", description: "Intraday volume (shares traded)." },
      day_high:      { type: "number",  description: "Intraday high." },
      day_low:       { type: "number",  description: "Intraday low." },
      week_52_high:  { type: "number",  description: "52-week high." },
      week_52_low:   { type: "number",  description: "52-week low." },
      exchange:      { type: "string",  description: "Exchange name (e.g. NasdaqGS, NYSE)." },
      currency:      { type: "string",  description: "Quote currency (almost always USD for US equities)." },
      market_time:   { type: "string",  description: "ISO-8601 timestamp of the last market price." },
      ts:            { type: "string",  description: "ISO-8601 timestamp of this response." },
    },
  },

  async handler(query) {
    const raw = (query.ticker?.trim() || "AAPL");

    const ticker = raw.toUpperCase().replace(/[^A-Z0-9.\-^]/g, "");
    if (!ticker) throw new Error("invalid ticker symbol");

    const url = `${YF_BASE}/${encodeURIComponent(ticker)}?interval=1d&range=1d`;

    let data;
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(8000),
      });
      data = await resp.json();
    } catch (err) {
      throw new Error(`upstream fetch failed: ${err.message}`);
    }

    const result = data?.chart?.result?.[0];
    if (!result) {
      const errCode = data?.chart?.error?.code || "not_found";
      throw new Error(`no data for ticker "${ticker}" (${errCode})`);
    }

    const meta = result.meta;
    const prev  = meta.chartPreviousClose ?? meta.regularMarketPrice;
    const price = meta.regularMarketPrice;
    const diff  = price - prev;
    const pct   = prev !== 0 ? (diff / prev) * 100 : 0;

    return {
      ticker:       meta.symbol,
      name:         meta.longName || meta.shortName || null,
      price_usd:    Math.round(price * 10000) / 10000,
      change_pct:   Math.round(pct   * 10000) / 10000,
      change_usd:   Math.round(diff  * 10000) / 10000,
      volume:       meta.regularMarketVolume ?? null,
      day_high:     meta.regularMarketDayHigh ?? null,
      day_low:      meta.regularMarketDayLow  ?? null,
      week_52_high: meta.fiftyTwoWeekHigh     ?? null,
      week_52_low:  meta.fiftyTwoWeekLow      ?? null,
      exchange:     meta.fullExchangeName     ?? meta.exchangeName ?? null,
      currency:     meta.currency             ?? "USD",
      market_time:  meta.regularMarketTime
                      ? new Date(meta.regularMarketTime * 1000).toISOString()
                      : null,
      ts:           new Date().toISOString(),
    };
  },
};
