// crypto-top-movers.js
//
// Real-time top gainers, top losers, and top coins by market cap — all in one call.
// Fetches top 100 coins from CoinGecko, filters stablecoins, sorts by 24h performance.
//
// Seam: orbisapi.com/proxy/crypto-news-impact-api
//       2,482 settlements/week, 74 payers — highest unique-payer count in the bazaar.
//       Agents use this for portfolio rebalancing triggers, regime detection, and
//       pre-trade context when working on crypto-adjacent tasks.
//
// Upstream: CoinGecko public API (free, no key required, 30 req/min).
//   - /coins/markets → top 100 by market cap with 24h price change
//   - /global        → total market cap, BTC dominance, 24h volume

const CG_BASE    = "https://api.coingecko.com/api/v3";
const UA         = "Mozilla/5.0 (compatible; the-stall/2.9; +https://intuitek.ai)";
const TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 60_000; // CoinGecko updates every 1-5 min; cache prevents rate-limit 500s under concurrent payers

let _cache = null; // { ts: Date, data: object }

// Stablecoin symbols to exclude from movers ranking.
const STABLECOINS = new Set([
  "usdt","usdc","dai","busd","tusd","usdp","usdd","gusd","frax","lusd",
  "susd","cusd","fei","ust","alusd","musd","usds","pyusd","usde","usdx",
  "eurc","eur","eurt","jeur","steur","figr_heloc",
]);

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from CoinGecko`);
  return resp.json();
}

function isStable(coin) {
  if (STABLECOINS.has(coin.symbol.toLowerCase())) return true;
  const change = Math.abs(coin.price_change_percentage_24h ?? 0);
  const price  = coin.current_price ?? 0;
  return price >= 0.95 && price <= 1.05 && change < 0.5;
}

function formatCoin(c) {
  return {
    symbol:       c.symbol.toUpperCase(),
    name:         c.name,
    price_usd:    c.current_price,
    change_24h:   Math.round((c.price_change_percentage_24h ?? 0) * 100) / 100,
    market_cap_b: c.market_cap != null ? Math.round(c.market_cap / 1e7) / 100 : null,
    volume_24h_m: c.total_volume != null ? Math.round(c.total_volume / 1e5) / 10 : null,
    rank:         c.market_cap_rank,
  };
}

export default {
  name:  "crypto-top-movers",
  price: "$0.059",

  description:
    "Crypto top movers — real-time top 5 gainers and top 5 losers by 24-hour percentage change among top-100 coins by market cap, plus the 10 largest coins with current prices and 24h change. Also returns global market statistics: total market cap (USD), BTC dominance %, and 24h trading volume. Stablecoins excluded from movers ranking. Use before any crypto portfolio, trading, or market analysis task. Data: CoinGecko public API (refreshes every 1–5 minutes).",

  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      top_gainers: {
        type: "array",
        description: "Top 5 coins with highest 24h % gain (market cap rank ≤ 100, stablecoins excluded).",
        items: {
          type: "object",
          properties: {
            symbol:       { type: "string",          description: "Ticker symbol (uppercased)." },
            name:         { type: "string",          description: "Coin name." },
            price_usd:    { type: "number",          description: "Current price in USD." },
            change_24h:   { type: "number",          description: "24-hour % price change." },
            market_cap_b: { type: ["number","null"], description: "Market cap in billions USD." },
            volume_24h_m: { type: ["number","null"], description: "24h trading volume in millions USD." },
            rank:         { type: ["integer","null"],description: "CoinGecko market cap rank." },
          },
        },
      },
      top_losers: {
        type: "array",
        description: "Top 5 coins with largest 24h % decline (market cap rank ≤ 100, stablecoins excluded).",
        items: { type: "object" },
      },
      top_by_mcap: {
        type: "array",
        description: "Top 10 coins by market cap with current price and 24h change.",
        items: { type: "object" },
      },
      global: {
        type: "object",
        description: "Global crypto market statistics.",
        properties: {
          total_market_cap_b:   { type: "number",  description: "Total crypto market cap in billions USD." },
          btc_dominance_pct:    { type: "number",  description: "Bitcoin market cap as % of total market." },
          total_volume_24h_b:   { type: "number",  description: "Total 24h trading volume in billions USD." },
          active_coins:         { type: "integer", description: "Number of active cryptocurrencies tracked." },
        },
      },
      ts: { type: "string", description: "ISO-8601 timestamp of this response." },
    },
  },

  async handler() {
    const now = Date.now();
    if (_cache && now - _cache.ts < CACHE_TTL_MS) {
      return _cache.data;
    }

    const [markets, globalData] = await Promise.all([
      fetchJson(`${CG_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h&sparkline=false`),
      fetchJson(`${CG_BASE}/global`),
    ]);

    const nonStable = markets.filter((c) => !isStable(c));

    const topGainers = [...nonStable]
      .sort((a, b) => (b.price_change_percentage_24h ?? 0) - (a.price_change_percentage_24h ?? 0))
      .slice(0, 5)
      .map(formatCoin);

    const topLosers = [...nonStable]
      .sort((a, b) => (a.price_change_percentage_24h ?? 0) - (b.price_change_percentage_24h ?? 0))
      .slice(0, 5)
      .map(formatCoin);

    const topByMcap = markets
      .filter((c) => c.market_cap != null && c.market_cap > 0)
      .slice(0, 10)
      .map(formatCoin);

    const gd = globalData.data;
    const global = {
      total_market_cap_b: Math.round((gd.total_market_cap?.usd ?? 0) / 1e7) / 100,
      btc_dominance_pct:  Math.round((gd.market_cap_percentage?.btc ?? 0) * 100) / 100,
      total_volume_24h_b: Math.round((gd.total_volume?.usd ?? 0) / 1e7) / 100,
      active_coins:       gd.active_cryptocurrencies ?? null,
    };

    const result = { top_gainers: topGainers, top_losers: topLosers, top_by_mcap: topByMcap, global, ts: new Date().toISOString() };
    _cache = { ts: now, data: result };
    return result;
  },
};
