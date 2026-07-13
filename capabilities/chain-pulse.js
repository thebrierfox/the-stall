// chain-pulse.js
//
// Seam: eth-block → stablecoin-watch in one call.
// signal-intel signal_id 60977 (seam, strength 70%) — 10 distinct wallets running
// skills.onesource.io/api/chain/block → stablecoin-watch over 2-day window.
// Collapses 2 hops into 1. Priced at $0.006 (~70% of $0.009 summed).
//
// Free upstreams: DRPC.org public RPC (no key) + DeFiLlama (no key).

const CHAINS = {
  ethereum: "https://eth.drpc.org",
  base:     "https://base.drpc.org",
  polygon:  "https://polygon.drpc.org",
  arbitrum: "https://arbitrum.drpc.org",
};
const TAGS = new Set(["latest", "pending", "earliest", "safe", "finalized"]);
const LLAMA_URL = "https://stablecoins.llama.fi/stablecoins?includePrices=true";
const UA = "Mozilla/5.0 (compatible; the-stall/chain-pulse; +https://intuitek.ai)";

async function rpc(url, method, params) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!resp.ok) throw new Error(`RPC HTTP ${resp.status}`);
  const d = await resp.json();
  if (d.error) throw new Error(`RPC: ${d.error.message}`);
  return d.result;
}

function toBlockParam(number) {
  if (number === undefined || number === null || number === "") return "latest";
  const s = String(number).trim().toLowerCase();
  if (TAGS.has(s)) return s;
  if (s.startsWith("0x")) return s;
  const n = parseInt(s, 10);
  if (!isNaN(n) && n >= 0) return "0x" + n.toString(16);
  throw new Error(`invalid block: ${number} — use an integer, 0x hex, or tag`);
}

function depegStatus(price) {
  const dev = Math.abs(price - 1.0);
  if (dev < 0.001) return "PARITY";
  if (dev < 0.005) return "MILD_DEPEG";
  if (dev < 0.01)  return "MODERATE_DEPEG";
  return "SEVERE_DEPEG";
}

export default {
  name:  "chain-pulse",
  price: "$0.117",

  description:
    "Returns an Ethereum block header + current stablecoin depeg status in one call. Collapses the eth-block → stablecoin-watch 2-hop chain. Block fields: number, hash, miner, timestamp, gas_used, tx_count. Stablecoin fields: symbol, price, peg_deviation, depeg_status, composite alert level. Supports Ethereum, Base, Polygon, Arbitrum. Free upstreams (DRPC + DeFiLlama), no API key required.",

  inputSchema: {
    type: "object",
    properties: {
      block: {
        description: "Block number (integer or 0x hex) or tag: latest/pending/earliest/safe/finalized. Default: latest.",
        oneOf: [
          { type: "integer", minimum: 0 },
          { type: "string" },
        ],
      },
      network: {
        type: "string",
        enum: ["ethereum", "base", "polygon", "arbitrum"],
        description: "Chain to query for block data. Default: ethereum.",
      },
      stablecoin_symbol: {
        type: "string",
        description: "Filter stablecoins to a specific symbol (e.g. USDT, USDC, DAI). Omit to return top 10 by market cap.",
      },
      alert_only: {
        type: "boolean",
        description: "If true, only return stablecoins depegged (MILD_DEPEG or worse).",
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      block: {
        type: "object",
        description: "Block header from the requested chain.",
        properties: {
          network:        { type: "string" },
          block_number:   { type: "integer" },
          hash:           { type: "string" },
          miner:          { type: "string" },
          timestamp_iso:  { type: "string" },
          timestamp_unix: { type: "integer" },
          gas_used:       { type: "integer" },
          gas_limit:      { type: "integer" },
          base_fee_gwei:  { type: ["number", "null"] },
          tx_count:       { type: "integer" },
        },
      },
      stablecoins: {
        type: "object",
        properties: {
          alert_level: { type: "string", description: "GREEN | YELLOW | ORANGE | RED" },
          coins: {
            type: "array",
            items: {
              type: "object",
              properties: {
                symbol:        { type: "string" },
                price:         { type: "number" },
                peg_deviation: { type: "number" },
                depeg_status:  { type: "string" },
                circulating_bn:{ type: "number" },
              },
            },
          },
          count: { type: "integer" },
        },
      },
      ts: { type: "string" },
    },
  },

  async handler(query) {
    const network    = (query.network || "ethereum").toLowerCase();
    const rpcUrl     = CHAINS[network];
    if (!rpcUrl) throw new Error(`unsupported network: ${network}`);
    const blockParam  = toBlockParam(query.block);
    const filterSym   = query.stablecoin_symbol ? String(query.stablecoin_symbol).toUpperCase().trim() : null;
    const alertOnly   = !!query.alert_only;

    // Parallel fetch
    const [blockRaw, llamaResp] = await Promise.all([
      rpc(rpcUrl, "eth_getBlockByNumber", [blockParam, false]),
      fetch(LLAMA_URL, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) }),
    ]);

    if (!blockRaw) throw new Error(`block not found: ${blockParam}`);
    if (!llamaResp.ok) throw new Error(`DeFiLlama HTTP ${llamaResp.status}`);
    const llamaData = await llamaResp.json();

    // Build block result
    const h = (hex) => hex ? parseInt(hex, 16) : null;
    const tsUnix = h(blockRaw.timestamp);
    const baseFeeRaw = blockRaw.baseFeePerGas ? parseInt(blockRaw.baseFeePerGas, 16) : null;

    const block = {
      network,
      block_number:   h(blockRaw.number),
      hash:           blockRaw.hash,
      miner:          blockRaw.miner,
      timestamp_iso:  tsUnix ? new Date(tsUnix * 1000).toISOString() : null,
      timestamp_unix: tsUnix,
      gas_used:       h(blockRaw.gasUsed),
      gas_limit:      h(blockRaw.gasLimit),
      base_fee_gwei:  baseFeeRaw !== null ? Math.round(baseFeeRaw / 1e9 * 1e4) / 1e4 : null,
      tx_count:       Array.isArray(blockRaw.transactions) ? blockRaw.transactions.length : 0,
    };

    // Build stablecoin result
    let assets = (llamaData.peggedAssets || []).filter(
      a => a.pegType === "peggedUSD" && typeof a.price === "number"
    );
    assets.sort((a, b) => {
      const capA = a.circulating?.peggedUSD || 0;
      const capB = b.circulating?.peggedUSD || 0;
      return capB - capA;
    });

    if (filterSym) {
      assets = assets.filter(a => a.symbol.toUpperCase() === filterSym);
    } else {
      assets = assets.slice(0, 10);
    }

    let coins = assets.map(a => {
      const cap = (a.circulating?.peggedUSD || 0) / 1e9;
      const dev = Math.abs(a.price - 1.0);
      return {
        symbol:         a.symbol,
        price:          Math.round(a.price * 1e6) / 1e6,
        peg_deviation:  Math.round(dev * 1e6) / 1e6,
        depeg_status:   depegStatus(a.price),
        circulating_bn: Math.round(cap * 100) / 100,
      };
    });

    if (alertOnly) {
      coins = coins.filter(c => c.depeg_status !== "PARITY");
    }

    function compositeAlert(cs) {
      if (cs.some(c => c.depeg_status === "SEVERE_DEPEG"))   return "RED";
      if (cs.some(c => c.depeg_status === "MODERATE_DEPEG")) return "ORANGE";
      if (cs.some(c => c.depeg_status === "MILD_DEPEG"))     return "YELLOW";
      return "GREEN";
    }

    return {
      block,
      stablecoins: {
        alert_level: compositeAlert(coins),
        coins,
        count: coins.length,
      },
      ts: new Date().toISOString(),
    };
  },
};
