// us-stock-price.js
//
// Returns current US equity price + intraday metrics from Yahoo Finance public
// chart API (no API key required). Priced at $0.005.
//
// Data source: Yahoo Finance v8/finance/chart (public, no auth, no crumb).
// Updates on each call — live market data during trading hours, last-close
// after hours.

const YF_BASE = "https://query2.finance.yahoo.com/v8/finance/chart";
const UA      = "Mozilla/5.0 (compatible; the-stall/0.4; +https://intuitek.ai)";

export default {
  name: "us-stock-price",
  price: "$0.005",
  tags: ["stocks", "market-data", "trading", "price"],

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
    required: ["ticker"],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:        { type: "string",  description: "Canonical ticker as reported by the exchange." },
      name:          { type: ["string", "null"],  description: "Company full name when supplied upstream." },
      price_usd:     { type: "number",  description: "Current market price in USD." },
      change_pct:    { type: "number",  description: "Percentage change from previous close (negative = down)." },
      change_usd:    { type: "number",  description: "Absolute change in USD from previous close." },
      volume:        { type: ["integer", "null"], description: "Intraday volume (shares traded), when supplied upstream." },
      day_high:      { type: ["number", "null"],  description: "Intraday high, when supplied upstream." },
      day_low:       { type: ["number", "null"],  description: "Intraday low, when supplied upstream." },
      week_52_high:  { type: ["number", "null"],  description: "52-week high, when supplied upstream." },
      week_52_low:   { type: ["number", "null"],  description: "52-week low, when supplied upstream." },
      exchange:      { type: ["string", "null"],  description: "Exchange name (e.g. NasdaqGS, NYSE), when supplied upstream." },
      currency:      { type: "string",  description: "Quote currency (almost always USD for US equities)." },
      market_time:   { type: ["string", "null"],  description: "ISO-8601 timestamp of the last market price, when supplied upstream." },
      ts:            { type: "string",  description: "ISO-8601 timestamp of this response." },
    },
  },

  async handler(query) {
    const ticker = String(query?.ticker || "").trim().toUpperCase();
    if (!/^[A-Z0-9.\-^]{1,15}$/.test(ticker)) {
      throw Object.assign(new Error("invalid ticker symbol"), { status: 400 });
    }

    const url = `${YF_BASE}/${encodeURIComponent(ticker)}?interval=1d&range=1d`;

    let resp;
    try {
      resp = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      throw Object.assign(new Error(`upstream fetch failed: ${err.message}`), { status: 503 });
    }
    if (!resp.ok) {
      const status = resp.status === 404 ? 400 : 503;
      throw Object.assign(new Error(`upstream returned HTTP ${resp.status}`), { status });
    }

    let data;
    try {
      data = await resp.json();
    } catch {
      throw Object.assign(new Error("upstream returned invalid JSON"), { status: 503 });
    }

    const result = data?.chart?.result?.[0];
    if (!result) {
      const errCode = data?.chart?.error?.code || "not_found";
      throw Object.assign(new Error(`no data for ticker "${ticker}" (${errCode})`), { status: 400 });
    }

    const meta = result.meta;
    const price = Number(meta?.regularMarketPrice);
    if (!Number.isFinite(price)) {
      throw Object.assign(new Error(`upstream returned no current price for "${ticker}"`), { status: 503 });
    }
    const previous = Number(meta?.chartPreviousClose);
    const prev  = Number.isFinite(previous) ? previous : price;
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
