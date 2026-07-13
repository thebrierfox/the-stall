// stock-brief.js
//
// Equity price + Limitless prediction market sentiment in one call.
// Collapses the observed seam: blockrun.ai/pm/limitless/markets → blockrun.ai/stocks/us/price/<TICKER>
// (signal-intel signal_id 57539 · 6 distinct wallets · 5-day persistence · 80% strength)
//
// Agents that want to pair a prediction market signal with a live price currently
// make 2 sequential calls. This collapses that into one paid endpoint at $0.015 —
// below what blockrun.ai charges for just the stock price ($0.044/call).
//
// Upstreams: Yahoo Finance public chart API (stock price) +
//            api.limitless.exchange (prediction markets) — both free, no API key.

const YF_BASE   = "https://query2.finance.yahoo.com/v8/finance/chart";
const LX_BASE   = "https://api.limitless.exchange/markets";
const UA        = "Mozilla/5.0 (compatible; the-stall/1.0; +https://intuitek.ai)";
const TIMEOUT   = 10_000;

async function get(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}

function formatMarket(m) {
  const prices = m.prices ?? [];
  return {
    title:       m.title || m.proxyTitle || "",
    slug:        m.slug  || "",
    yes_price:   prices[0] ?? null,
    no_price:    prices[1] ?? null,
    trade_type:  m.tradeType || "",
    volume:      m.volumeFormatted || m.volume || "0",
    expiration:  m.expirationDate || null,
    collateral:  m.collateralToken?.symbol || "USDC",
  };
}

export default {
  name:  "stock-brief",
  price: "$0.035",

  description:
    "US stock snapshot + Limitless prediction market sentiment in one call. Returns current stock price, intraday change, volume, 52-week range for any NYSE/NASDAQ ticker, plus any active Limitless prediction markets matching the ticker keyword (direction bets, price level markets). Single-call alternative to separate limitless-markets + stock-price calls. Free upstream — no API key required. $0.015/call.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker symbol (e.g. AMD, AAPL, NVDA, TSLA). Case-insensitive.",
      },
      market_limit: {
        type: "integer",
        description: "Max Limitless prediction markets to return (1–10, default 5). Markets are filtered by ticker keyword.",
        default: 5,
        minimum: 1,
        maximum: 10,
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker: { type: "string" },
      name:   { type: "string" },
      equity: {
        type: "object",
        description: "Current equity price and intraday metrics from Yahoo Finance.",
        properties: {
          price_usd:     { type: "number" },
          change_pct:    { type: "number" },
          change_usd:    { type: "number" },
          volume:        { type: "integer" },
          day_high:      { type: "number" },
          day_low:       { type: "number" },
          week_52_high:  { type: "number" },
          week_52_low:   { type: "number" },
          exchange:      { type: "string" },
          currency:      { type: "string" },
          market_time:   { type: "string" },
        },
      },
      prediction_markets: {
        type: "array",
        description: "Active Limitless prediction markets matching the ticker keyword. Empty array if none found.",
        items: {
          type: "object",
          properties: {
            title:      { type: "string" },
            slug:       { type: "string" },
            yes_price:  { type: "number", description: "Implied yes probability (0–1)." },
            no_price:   { type: "number" },
            trade_type: { type: "string" },
            volume:     { type: "string" },
            expiration: { type: "string" },
            collateral: { type: "string" },
          },
        },
      },
      prediction_market_count: { type: "integer" },
      seam_note: {
        type: "string",
        description: "Data provenance — the x402 settlement seam this capability collapses.",
      },
      generated_at: { type: "string" },
    },
  },

  async handler(input) {
    const raw = (input.ticker || "AAPL").trim();
    const ticker = raw.toUpperCase().replace(/[^A-Z0-9.\-^]/g, "");
    if (!ticker) throw new Error("invalid ticker symbol");

    const marketLimit = Math.min(Math.max(parseInt(input.market_limit ?? 5, 10), 1), 10);
    const keyword     = ticker.toLowerCase();

    // Parallel fetch — stock + prediction markets
    const [stockData, marketsData] = await Promise.all([
      get(`${YF_BASE}/${encodeURIComponent(ticker)}?interval=1d&range=1d`),
      get(`${LX_BASE}/active?limit=20&page=1`).catch(() => null),
    ]);

    // ── Equity ────────────────────────────────────────────────────────────────
    const result = stockData?.chart?.result?.[0];
    if (!result) {
      const errCode = stockData?.chart?.error?.code || "not_found";
      throw new Error(`no equity data for "${ticker}" (${errCode})`);
    }
    const meta  = result.meta;
    const prev  = meta.chartPreviousClose ?? meta.regularMarketPrice;
    const price = meta.regularMarketPrice;
    const diff  = price - prev;
    const pct   = prev !== 0 ? (diff / prev) * 100 : 0;

    const equity = {
      price_usd:    Math.round(price * 10000) / 10000,
      change_pct:   Math.round(pct   * 10000) / 10000,
      change_usd:   Math.round(diff  * 10000) / 10000,
      volume:       meta.regularMarketVolume  ?? null,
      day_high:     meta.regularMarketDayHigh ?? null,
      day_low:      meta.regularMarketDayLow  ?? null,
      week_52_high: meta.fiftyTwoWeekHigh     ?? null,
      week_52_low:  meta.fiftyTwoWeekLow      ?? null,
      exchange:     meta.fullExchangeName     ?? meta.exchangeName ?? null,
      currency:     meta.currency             ?? "USD",
      market_time:  meta.regularMarketTime
                      ? new Date(meta.regularMarketTime * 1000).toISOString()
                      : null,
    };

    // ── Prediction markets ────────────────────────────────────────────────────
    const raw_markets = marketsData?.data ?? (Array.isArray(marketsData) ? marketsData : []);
    const prediction_markets = raw_markets
      .filter((m) => {
        const title = (m.title || m.proxyTitle || "").toLowerCase();
        const slug  = (m.slug || "").toLowerCase();
        return title.includes(keyword) || slug.includes(keyword);
      })
      .slice(0, marketLimit)
      .map(formatMarket);

    return {
      ticker,
      name:                    meta.longName || meta.shortName || null,
      equity,
      prediction_markets,
      prediction_market_count: prediction_markets.length,
      seam_note:               "Collapses blockrun.ai/pm/limitless → blockrun.ai/stocks seam into a single call.",
      generated_at:            new Date().toISOString(),
    };
  },
};
