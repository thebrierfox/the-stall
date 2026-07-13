// stock-price-multi.js
//
// Returns current US equity prices for up to 5 tickers in a single call.
// Priced at $0.059. signal-intel signal: blockrun aggregator wallet received
// 153k STRC + 23k AMD + 1.9k MSTR settlements in 72 hours (2026-06-06 concentration signal).
//
// Free upstream: Yahoo Finance v8/finance/chart (public, no auth, no crumb).
// Concurrent fetches: all tickers resolve in parallel, response in ≤ 8s.

const YF_BASE = "https://query2.finance.yahoo.com/v8/finance/chart";
const UA      = "Mozilla/5.0 (compatible; the-stall/3.47; +https://intuitek.ai)";
const MAX_TICKERS = 5;

async function fetchTicker(ticker) {
  const sym = ticker.toUpperCase().replace(/[^A-Z0-9.\-^]/g, "");
  if (!sym) return { ticker, error: "invalid ticker symbol" };

  const url = `${YF_BASE}/${encodeURIComponent(sym)}?interval=1d&range=1d`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json();
    const result = data?.chart?.result?.[0];
    if (!result) {
      const errCode = data?.chart?.error?.code || "not_found";
      return { ticker: sym, error: `no data (${errCode})` };
    }
    const meta  = result.meta;
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
      error:        null,
    };
  } catch (err) {
    return { ticker: sym, error: `fetch failed: ${err.message}` };
  }
}

export default {
  name: "stock-price-multi",
  price: "$0.295",

  description:
    "Stock price for up to 5 US equity tickers in one call — returns current stock price, change %, volume, day range, and 52-week range per ticker. Works with any NYSE/NASDAQ symbol (STRC, AMD, MSTR, SLV, USO, etc.). " +
    "Sourced from Yahoo Finance public data, no API key.",

  inputSchema: {
    type: "object",
    properties: {
      tickers: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_TICKERS,
        description: `Up to ${MAX_TICKERS} US stock ticker symbols as an array (e.g. ["AAPL","NVDA","MSFT"]). Case-insensitive. A comma-separated string is also accepted.`,
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        description: "One entry per ticker, in the order requested.",
        items: {
          type: "object",
          properties: {
            ticker:       { type: "string"  },
            name:         { type: "string"  },
            price_usd:    { type: "number"  },
            change_pct:   { type: "number"  },
            change_usd:   { type: "number"  },
            volume:       { type: "integer" },
            day_high:     { type: "number"  },
            day_low:      { type: "number"  },
            week_52_high: { type: "number"  },
            week_52_low:  { type: "number"  },
            exchange:     { type: "string"  },
            currency:     { type: "string"  },
            market_time:  { type: "string"  },
            error:        { type: "string", description: "Non-null if this ticker failed; others still returned." },
          },
        },
      },
      ts: { type: "string", description: "ISO-8601 timestamp of this response." },
    },
  },

  async handler(query) {
    let raw = query.tickers || ["AAPL", "MSFT", "NVDA"];
    if (typeof raw === "string") raw = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (raw.length > MAX_TICKERS) throw new Error(`max ${MAX_TICKERS} tickers per call`);

    const results = await Promise.all(raw.map(fetchTicker));
    return { results, ts: new Date().toISOString() };
  },
};
