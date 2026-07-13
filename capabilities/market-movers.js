// market-movers.js
//
// Today's top equity and crypto market movers (gainers, losers, most-active).
// Collapses the observed seam: api.printmoneylab.com/api/v1/market-movers →
// tx-explainer + chain/block chain (6-7 distinct wallets, 7-day persistence,
// signal-intel strength 1.0). Agents chain market movers with on-chain queries —
// this consolidates the market-context leg.
// Priced at $0.006. Free upstream: Yahoo Finance screener + CoinGecko.

const YF_BASE = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved";
const CG_BASE = "https://api.coingecko.com/api/v3/coins/markets";
const UA      = "Mozilla/5.0 (compatible; the-stall/0.7; +https://intuitek.ai)";
const TIMEOUT = 15_000;

async function fetchYF(scrId, count) {
  const url = `${YF_BASE}?formatted=false&scrIds=${scrId}&count=${count}&start=0`;
  const r   = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`YF screener HTTP ${r.status}`);
  const d   = await r.json();
  return (d?.finance?.result?.[0]?.quotes ?? []).map(q => ({
    symbol:       q.symbol,
    name:         q.shortName ?? q.longName ?? q.symbol,
    price:        q.regularMarketPrice ?? null,
    change_pct:   Number((q.regularMarketChangePercent ?? 0).toFixed(4)),
    volume:       q.regularMarketVolume ?? null,
    market_cap:   q.marketCap ?? null,
    asset_class:  "equity",
  }));
}

async function fetchCG(order, count) {
  const url = `${CG_BASE}?vs_currency=usd&order=${order}&per_page=${count}&page=1&sparkline=false&price_change_percentage=24h`;
  const r   = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`);
  const d   = await r.json();
  if (!Array.isArray(d)) throw new Error("Unexpected CoinGecko response");
  return d.map(c => ({
    symbol:      (c.symbol ?? "").toUpperCase(),
    name:        c.name ?? c.symbol,
    price:       c.current_price ?? null,
    change_pct:  Number((c.price_change_percentage_24h ?? 0).toFixed(4)),
    volume:      c.total_volume ?? null,
    market_cap:  c.market_cap ?? null,
    asset_class: "crypto",
  }));
}

export default {
  name:  "market-movers",
  price: "$0.059",

  description:
    "Today's top market movers — stock and equity gainers, losers, most-active, and crypto gainers/losers by 24h change. Sourced from Yahoo Finance screener and CoinGecko (free, no API key). Returns symbol, name, price, % change, volume, and market cap. Filter by asset class (equities, crypto, or both) and mover type (gainers, losers, active). Use for pre-trade context, on-chain event correlation, and market-regime detection.",

  inputSchema: {
    type: "object",
    properties: {
      asset_class: {
        type: "string",
        enum: ["both", "equities", "crypto"],
        description: "Which asset class to return. Default 'both'.",
        default: "both",
      },
      mover_type: {
        type: "string",
        enum: ["all", "gainers", "losers", "active"],
        description: "Which mover category. 'active' returns US equities by volume (no crypto equivalent). Default 'all'.",
        default: "all",
      },
      limit: {
        type: "integer",
        description: "Number of results per category (1–20, default 10).",
        default: 10,
        minimum: 1,
        maximum: 20,
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      equity_gainers:  { type: "array", items: { type: "object" } },
      equity_losers:   { type: "array", items: { type: "object" } },
      equity_active:   { type: "array", items: { type: "object" } },
      crypto_gainers:  { type: "array", items: { type: "object" } },
      crypto_losers:   { type: "array", items: { type: "object" } },
      sections_returned: { type: "array", items: { type: "string" } },
      generated_at:    { type: "string" },
    },
  },

  async handler(input) {
    const assetClass = input.asset_class  || "both";
    const moverType  = input.mover_type   || "all";
    const limit      = Math.min(Math.max(parseInt(input.limit || "10", 10), 1), 20);

    const wantEquity = assetClass === "both" || assetClass === "equities";
    const wantCrypto = assetClass === "both" || assetClass === "crypto";
    const wantGain   = moverType === "all" || moverType === "gainers";
    const wantLoss   = moverType === "all" || moverType === "losers";
    const wantActive = (moverType === "all" || moverType === "active") && wantEquity;

    const fetches = [];
    if (wantEquity && wantGain)   fetches.push(["equity_gainers",  fetchYF("day_gainers",    limit)]);
    if (wantEquity && wantLoss)   fetches.push(["equity_losers",   fetchYF("day_losers",     limit)]);
    if (wantActive)               fetches.push(["equity_active",   fetchYF("most_actives",   limit)]);
    if (wantCrypto && wantGain)   fetches.push(["crypto_gainers",  fetchCG("percent_change_24h_desc", limit)]);
    if (wantCrypto && wantLoss)   fetches.push(["crypto_losers",   fetchCG("percent_change_24h_asc",  limit)]);

    const results = await Promise.allSettled(fetches.map(([, p]) => p));

    const out = {
      sections_returned: [],
      generated_at:      new Date().toISOString(),
    };

    fetches.forEach(([key], i) => {
      const r = results[i];
      if (r.status === "fulfilled") {
        out[key] = r.value;
        out.sections_returned.push(key);
      } else {
        out[key] = [];
      }
    });

    return out;
  },
};
