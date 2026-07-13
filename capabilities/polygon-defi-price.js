// polygon-defi-price.js
//
// Real-time Polygon DeFi token pricing — any ERC-20 by address or common symbol.
// Targets Polygon DEX agents and DeFi automation requiring network-native price data.
//
// Primary source: DeFiLlama coins API (free, no key, on-chain confidence scoring).
// 24h change: DeFiLlama chart endpoint (2-datapoint span, 5-min cache).
//
// Authorized: Ruling 003-B v3 §6 (2026-07-09, Kyle operator authority).
// Demand signal: Orderbook DEX 0x5e4943 / operator 0xaa5ac74, 353 calls / $7,282 / 229 calls last 2000 blocks.
// Kill window: 7d from 2026-07-09 (kill by 2026-07-16). Early-kill at zero organic calls. Probe pricing — no confirmed buyer.
// Reprice: $5.00 → $0.75 (2026-07-09, Cowork-confirmed). Sub-second DEX oracle requirement incompatible with HTTP latency.

const LLAMA_PRICE_URL = "https://coins.llama.fi/prices/current";
const LLAMA_CHART_URL  = "https://coins.llama.fi/chart";
const UA               = "Mozilla/5.0 (compatible; the-stall/4.0; +https://intuitek.ai)";
const TIMEOUT_MS       = 12_000;
const PRICE_TTL_MS     = 10_000;  // 10s for spot price cache
const CHANGE_TTL_MS    = 300_000; // 5min for 24h change cache

// Well-known Polygon token addresses (checksum-cased)
const TOKEN_REGISTRY = {
  matic:    "0x0000000000000000000000000000000000001010",
  pol:      "0x0000000000000000000000000000000000001010",
  wmatic:   "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  weth:     "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  eth:      "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  wbtc:     "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  btc:      "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  usdc:     "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "usdc.e": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  usdt:     "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  link:     "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
  aave:     "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",
  quick:    "0xB5C064F955D8e7F38fE0460C556a72987494eE17",
  stmatic:  "0x3A58a54C066FdC0f2D55FC9C89F0415C92eBf3C6",
};

// Module-level cache (lives for server process lifetime, avoids redundant API hits)
const priceCache  = new Map();
const changeCache = new Map();

function resolveAddress(token) {
  const t     = token.trim();
  const lower = t.toLowerCase();
  // polygon:0x... pass-through (preserve address case)
  if (lower.startsWith("polygon:0x") && t.length >= 50) return t.slice(8);
  // raw 0x address pass-through
  if (lower.startsWith("0x") && t.length >= 42) return t;
  // symbol lookup (case-insensitive)
  return TOKEN_REGISTRY[lower] ?? null;
}

async function fetchSpotPrice(llamaKey) {
  const cached = priceCache.get(llamaKey);
  if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) return cached;

  const resp = await fetch(`${LLAMA_PRICE_URL}/${encodeURIComponent(llamaKey)}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`DeFiLlama prices HTTP ${resp.status}`);
  const data = await resp.json();
  const coin = data.coins?.[llamaKey];
  if (!coin || coin.price === undefined) {
    throw new Error(`Token not found on DeFiLlama: ${llamaKey}. Try polygon:0x... address format.`);
  }

  const entry = {
    price:      coin.price,
    symbol:     coin.symbol   ?? null,
    confidence: coin.confidence ?? null,
    decimals:   coin.decimals   ?? null,
    fetchedAt:  Date.now(),
  };
  priceCache.set(llamaKey, entry);
  return entry;
}

async function fetch24hChange(llamaKey) {
  const cached = changeCache.get(llamaKey);
  if (cached && Date.now() - cached.fetchedAt < CHANGE_TTL_MS) return cached.change24h;

  try {
    const resp = await fetch(
      `${LLAMA_CHART_URL}/${encodeURIComponent(llamaKey)}?span=2&period=1d`,
      { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    if (!resp.ok) return null;
    const data   = await resp.json();
    const prices = data.coins?.[llamaKey]?.prices;
    if (!prices || prices.length < 2) return null;
    const prev      = prices[prices.length - 2].price;
    const curr      = prices[prices.length - 1].price;
    const change24h = prev > 0 ? ((curr - prev) / prev) * 100 : null;
    changeCache.set(llamaKey, { change24h, fetchedAt: Date.now() });
    return change24h;
  } catch {
    return null;
  }
}

export default {
  name:  "polygon-defi-price",
  price: "$0.75",

  description:
    "Real-time Polygon DeFi token price with 24h change and on-chain confidence score. Inputs: symbol (MATIC, WETH, WBTC, USDC, USDT, LINK, AAVE, QUICK, stMATIC) or polygon:0x... address for any Polygon ERC-20. Returns spot price in USD, 24h % change, DeFiLlama confidence (>0.9 = high), and cache staleness. Purpose-built for Polygon DEX agents, trade-sizing bots, and DeFi automation requiring network-native real-time prices. Data: DeFiLlama on-chain oracle (free, no key). No CEX dependency.",

  inputSchema: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description:
          "Token symbol (MATIC, WETH, WBTC, USDC, USDT, LINK, AAVE, QUICK, stMATIC, USDC.e) or Polygon contract address as polygon:0x... or raw 0x...",
      },
      include_change: {
        type: "boolean",
        description: "Include 24h price change (adds ~200ms if not cached). Default: true.",
        default: true,
      },
    },
    required: ["token"],
  },

  outputSchema: {
    type: "object",
    properties: {
      token:          { type: "string",           description: "Resolved token symbol" },
      address:        { type: "string",           description: "Polygon ERC-20 contract address" },
      price_usd:      { type: "number",           description: "Current spot price in USD" },
      change_24h_pct: { type: ["number", "null"], description: "24-hour price change % (null if unavailable)" },
      confidence:     { type: ["number", "null"], description: "DeFiLlama on-chain confidence score (0–1; >0.9 = high)" },
      source:         { type: "string",           description: "Data source" },
      timestamp_ms:   { type: "number",           description: "Epoch ms when data was fetched" },
      staleness_ms:   { type: "number",           description: "Age of cached price in ms (<10 000 = fresh)" },
      network:        { type: "string",           description: "Always: polygon" },
    },
  },

  async handler(query) {
    const tokenInput = String(query.token ?? "").trim();
    if (!tokenInput) throw new Error("token is required");

    const address = resolveAddress(tokenInput);
    if (!address) {
      const known = Object.keys(TOKEN_REGISTRY).join(", ");
      throw new Error(
        `Unknown token "${tokenInput}". Known symbols: ${known}. Or pass polygon:0x... address.`
      );
    }

    const llamaKey     = `polygon:${address}`;
    const inclChange   = query.include_change !== false && query.include_change !== "false";

    const spot     = await fetchSpotPrice(llamaKey);
    const change24 = inclChange ? await fetch24hChange(llamaKey) : null;

    return {
      token:          spot.symbol || tokenInput.toUpperCase(),
      address,
      price_usd:      spot.price,
      change_24h_pct: change24 !== null ? Math.round(change24 * 1000) / 1000 : null,
      confidence:     spot.confidence,
      source:         "defillama",
      timestamp_ms:   spot.fetchedAt,
      staleness_ms:   Date.now() - spot.fetchedAt,
      network:        "polygon",
    };
  },
};
