// prediction-stock-pulse.js — Collapses limitless-markets + us-stock-price into
// one x402 call. Agents routing prediction-market → equity-price represent the
// dominant seam in x402 archive (80% signal, 6 wallets, 5 days observation).
//
// Individual cost: $0.006 + $0.018 = $0.024. Seam price: $0.021 (33% discount).
// Upstreams: Limitless Exchange API (no key) + Yahoo Finance (no key).

import limitlessMarkets from "./limitless-markets.js";
import usStockPrice from "./us-stock-price.js";

export default {
  name: "prediction-stock-pulse",
  price: "$0.059",

  description:
    "One call returns prediction market sentiment (Limitless Exchange) + live equity price for a specified ticker. Collapses the prediction-market → stock-price agent chain into a single x402 payment. $0.016 vs $0.024 bought individually. Inputs: ticker (required), query (optional keyword filter for prediction markets).",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker (e.g. AMD, NVDA, SPY). Case-insensitive.",
      },
      query: {
        type: "string",
        description:
          "Optional keyword to filter prediction markets (e.g. 'btc', 'eth', 'rate cut'). If omitted returns top 5 markets by volume.",
      },
      market_limit: {
        type: "integer",
        description: "Number of prediction markets to return (1–10, default 5).",
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
      stock: {
        type: "object",
        description: "Live equity price and intraday metrics for the requested ticker.",
        properties: {
          ticker:     { type: "string" },
          name:       { type: "string" },
          price_usd:  { type: "number" },
          change_pct: { type: "number" },
          change_usd: { type: "number" },
          volume:     { type: "integer" },
          day_high:   { type: "number" },
          day_low:    { type: "number" },
          exchange:   { type: "string" },
          market_time: { type: "string" },
        },
      },
      prediction_markets: {
        type: "array",
        description: "Active prediction markets from Limitless Exchange.",
        items: {
          type: "object",
          properties: {
            title:      { type: "string" },
            yes_price:  { type: "number", description: "Implied Yes probability (0–1)." },
            no_price:   { type: "number", description: "Implied No probability (0–1)." },
            volume:     { type: "string" },
            expiration: { type: "string" },
            slug:       { type: "string" },
          },
        },
      },
      seam_note: {
        type: "string",
        description: "Confirms this endpoint collapsed a two-call chain into one.",
      },
      generated_at: { type: "string", description: "ISO-8601 timestamp." },
    },
  },

  async handler(query) {
    const ticker = (query.ticker || "AAPL").trim().toUpperCase().replace(/[^A-Z0-9.\-^]/g, "");
    if (!ticker) throw new Error("ticker is required");

    const limit = Math.min(Math.max(Number(query.market_limit) || 5, 1), 10);
    const keyword = query.query || undefined;

    const [stockResult, marketsResult] = await Promise.all([
      usStockPrice.handler({ ticker }),
      limitlessMarkets.handler({ limit, ...(keyword ? { query: keyword } : {}) }),
    ]);

    return {
      stock: {
        ticker:      stockResult.ticker,
        name:        stockResult.name,
        price_usd:   stockResult.price_usd,
        change_pct:  stockResult.change_pct,
        change_usd:  stockResult.change_usd,
        volume:      stockResult.volume,
        day_high:    stockResult.day_high,
        day_low:     stockResult.day_low,
        exchange:    stockResult.exchange,
        market_time: stockResult.market_time,
      },
      prediction_markets: (marketsResult.markets || []).map((m) => ({
        title:      m.title,
        yes_price:  m.yes_price,
        no_price:   m.no_price,
        volume:     m.volume,
        expiration: m.expiration,
        slug:       m.slug,
      })),
      seam_note: "Collapsed limitless-markets + us-stock-price ($0.024 individual) into one call ($0.016).",
      generated_at: new Date().toISOString(),
    };
  },
};
