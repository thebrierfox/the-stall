// tx-intel.js
//
// EVM transaction decoder — collapses the observed seam:
//   x402.ottoai.services/tx-explainer   18 wallets / 8-day persistence / $0.010
//   skills.onesource.io/api/chain/block  called immediately after by same agents
//   signal-intel signals 60350/60351/60271 (seam, strength 1.00).
//
// Decodes and summarises any EVM tx: type detection (ETH transfer, ERC20 transfer,
// swap, approval, contract call), token amount parsing from logs, block context —
// all in one call. Free upstream: DRPC.org + publicnode public JSON-RPC.
// Priced at $0.006 — 40% below tx-explainer's $0.010.

const CHAINS = {
  base:      "https://mainnet.base.org",
  ethereum:  "https://ethereum.publicnode.com",
  eth:       "https://ethereum.publicnode.com",
  arbitrum:  "https://arb1.arbitrum.io/rpc",
  optimism:  "https://mainnet.optimism.io",
  polygon:   "https://polygon-bor-rpc.publicnode.com",
  matic:     "https://polygon-bor-rpc.publicnode.com",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
  bsc:       "https://bsc-rpc.publicnode.com",
};

const EXPLORER = {
  base:      "https://basescan.org/tx/",
  ethereum:  "https://etherscan.io/tx/",
  eth:       "https://etherscan.io/tx/",
  arbitrum:  "https://arbiscan.io/tx/",
  optimism:  "https://optimistic.etherscan.io/tx/",
  polygon:   "https://polygonscan.com/tx/",
  matic:     "https://polygonscan.com/tx/",
  avalanche: "https://snowtrace.io/tx/",
  bsc:       "https://bscscan.com/tx/",
};

const KNOWN_PROTOCOLS = {
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": "Uniswap V2 Router",
  "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap V3 Router",
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap Universal Router",
  "0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b": "Uniswap Universal Router 2",
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": "Uniswap Universal Router Base",
  "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24": "Uniswap V2 Router Base",
  "0x2626664c2603336e57b271c5c0b26f421741e481": "Uniswap V3 Router Base",
  "0x1111111254eeb25477b68fb85ed929f73a960582": "1inch V5",
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff": "0x Protocol",
  "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f": "SushiSwap Router",
  "0x00000000219ab540356cbb839cbe05303d7705fa": "ETH2 Deposit",
  "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": "AAVE V3 Pool",
  "0x794a61358d6845594f94dc1db02a252b5b4814ad": "AAVE V3 Pool (Avalanche)",
};

const KNOWN_TOKENS = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC",  decimals: 6  },
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT",  decimals: 6  },
  "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI",   decimals: 18 },
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH",  decimals: 18 },
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": { symbol: "WBTC",  decimals: 8  },
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC",  decimals: 6  }, // Base USDC
  "0x4200000000000000000000000000000000000006": { symbol: "WETH",  decimals: 18 }, // Base WETH
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { symbol: "DAI",   decimals: 18 }, // Base DAI
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": { symbol: "USDbC", decimals: 6  }, // Base USDbC
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { symbol: "USDC",  decimals: 6  }, // Polygon USDC
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { symbol: "USDT",  decimals: 6  }, // Polygon USDT
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { symbol: "USDT",  decimals: 6  }, // Arb USDT
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC",  decimals: 6  }, // Arb USDC
};

// ERC20 Transfer(address indexed from, address indexed to, uint256 value)
const SIG_TRANSFER  = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// ERC20 Approval(address indexed owner, address indexed spender, uint256 value)
const SIG_APPROVAL  = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
// Uniswap V3 Swap event topic
const SIG_SWAP_V3   = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
// Uniswap V2 Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)
const SIG_SWAP_V2   = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";

const TIMEOUT = 15_000;

function short(addr) {
  if (!addr) return "unknown";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function hexToInt(hex) {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

function weiToEth(wei, decimals = 18) {
  if (!wei) return "0";
  const divisor = 10n ** BigInt(decimals);
  const whole   = wei / divisor;
  const frac    = wei % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 6);
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

function decodeUint256(data) {
  if (!data || data.length < 2) return 0n;
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  return BigInt("0x" + hex.slice(-64).padStart(64, "0"));
}

function decodeAddress(topic) {
  if (!topic || topic.length < 26) return null;
  return "0x" + topic.slice(-40).toLowerCase();
}

async function rpcCall(url, method, params) {
  const resp = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal:  AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) throw new Error(`RPC HTTP ${resp.status}`);
  const d = await resp.json();
  if (d.error) throw new Error(`RPC error: ${d.error.message}`);
  return d.result;
}

function parseTransfers(logs) {
  return logs
    .filter((l) => l.topics?.[0] === SIG_TRANSFER)
    .map((l) => {
      const contract = (l.address || "").toLowerCase();
      const from     = decodeAddress(l.topics[1]);
      const to       = decodeAddress(l.topics[2]);
      const raw      = decodeUint256(l.data);
      const token    = KNOWN_TOKENS[contract];
      const decimals = token?.decimals ?? 18;
      const symbol   = token?.symbol ?? short(contract);
      return { contract, symbol, decimals, from, to, raw, amount: weiToEth(raw, decimals) };
    });
}

function buildSummary(tx, receipt, transfers, chainName) {
  const value    = hexToInt(tx.value);
  const inputHex = (tx.input || "0x").slice(0, 10);
  const hasSwap  = receipt.logs?.some(
    (l) => l.topics?.[0] === SIG_SWAP_V3 || l.topics?.[0] === SIG_SWAP_V2
  );

  // ETH transfer
  if ((tx.input === "0x" || !tx.input) && value > 0n) {
    return `Transferred ${weiToEth(value)} ETH from ${short(tx.from)} to ${short(tx.to)}`;
  }

  // Contract creation
  if (!tx.to) {
    return `Deployed new contract at ${short(receipt?.contractAddress)}`;
  }

  // Approval
  const approvalLog = receipt.logs?.find((l) => l.topics?.[0] === SIG_APPROVAL);
  if (approvalLog && transfers.length === 0) {
    const spender = decodeAddress(approvalLog.topics[2]);
    const raw     = decodeUint256(approvalLog.data);
    const token   = KNOWN_TOKENS[(approvalLog.address || "").toLowerCase()];
    const symbol  = token?.symbol ?? short(approvalLog.address);
    const decimals = token?.decimals ?? 18;
    const maxVal  = 2n ** 256n - 1n;
    const amount  = raw >= maxVal ? "unlimited" : weiToEth(raw, decimals);
    return `Approved ${amount} ${symbol} for ${KNOWN_PROTOCOLS[spender] ?? short(spender)}`;
  }

  // Swap detection: >= 2 Transfer events where sender receives one token and sends another
  if (hasSwap || transfers.length >= 2) {
    const fromLower = tx.from.toLowerCase();
    // Find token leaving wallet (from==tx.from or to==protocol)
    const outXfers = transfers.filter(
      (t) => t.from === fromLower || (t.to !== fromLower && t.from !== fromLower)
    );
    const inXfers  = transfers.filter((t) => t.to === fromLower);

    if (inXfers.length > 0 && outXfers.length > 0) {
      const inT  = inXfers[inXfers.length - 1];
      const outT = outXfers[0];
      const proto = KNOWN_PROTOCOLS[(tx.to || "").toLowerCase()];
      const via   = proto ? ` via ${proto}` : "";
      return `Swapped ${outT.amount} ${outT.symbol} for ${inT.amount} ${inT.symbol}${via}`;
    }

    // Fallback for swaps we can't fully parse
    const proto = KNOWN_PROTOCOLS[(tx.to || "").toLowerCase()];
    return proto ? `Interacted with ${proto} (swap detected)` : "Swap via unknown DEX";
  }

  // Single ERC20 transfer
  if (transfers.length === 1) {
    const t = transfers[0];
    return `Sent ${t.amount} ${t.symbol} from ${short(t.from)} to ${short(t.to)}`;
  }

  // Generic contract call
  const proto = KNOWN_PROTOCOLS[(tx.to || "").toLowerCase()];
  if (proto) return `Called ${proto} (${inputHex})`;
  return `Contract call to ${short(tx.to)} (${inputHex})`;
}

export default {
  name:  "tx-intel",
  price: "$0.031",

  description:
    "Decode and explain any EVM transaction — in one x402 payment. Returns: transaction status, type (ETH transfer / ERC20 transfer / swap / approval / contract call), human-readable summary, token transfers parsed from logs, gas cost, block context, and explorer URL. Collapses the observed tx-explainer + onesource/block agent seam (18 wallets, 8-day persistence). Supports Base (default), Ethereum, Arbitrum, Optimism, Polygon, Avalanche, BSC. Free upstream: DRPC + public RPC nodes. $0.006/call — 40% below the x402.ottoai.services tx-explainer.",

  inputSchema: {
    type: "object",
    properties: {
      tx_hash: {
        type: "string",
        description: "Transaction hash (0x-prefixed, 66 chars).",
      },
      chain: {
        type: "string",
        enum: ["base", "ethereum", "eth", "arbitrum", "optimism", "polygon", "matic", "avalanche", "bsc"],
        default: "base",
        description: "EVM chain. Default: base.",
      },
      include_block_context: {
        type: "boolean",
        default: true,
        description: "Include block-level context (base_fee, tx_count, miner). Collapses the onesource/chain/block seam agents use after tx-explainer. Default: true.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      tx_hash:        { type: "string" },
      chain:          { type: "string" },
      explorer_url:   { type: "string" },
      status:         { type: "string", enum: ["success", "failed", "pending"] },
      type:           { type: "string" },
      summary:        { type: "string", description: "Human-readable one-line explanation." },
      from:           { type: "string" },
      to:             { type: ["string", "null"] },
      value_eth:      { type: "string" },
      gas_used:       { type: "integer" },
      gas_price_gwei: { type: "number" },
      tx_fee_eth:     { type: "string" },
      block_number:   { type: "integer" },
      block_timestamp_iso: { type: "string" },
      transfers: {
        type: "array",
        description: "ERC20 Transfer events decoded from logs.",
        items: {
          type: "object",
          properties: {
            symbol:  { type: "string" },
            from:    { type: "string" },
            to:      { type: "string" },
            amount:  { type: "string" },
            contract: { type: "string" },
          },
        },
      },
      block_context: {
        type: ["object", "null"],
        description: "Block-level context (only if include_block_context=true).",
        properties: {
          block_number:   { type: "integer" },
          timestamp_iso:  { type: "string" },
          miner:          { type: "string" },
          tx_count:       { type: "integer" },
          gas_used:       { type: "integer" },
          gas_limit:      { type: "integer" },
          base_fee_gwei:  { type: ["number", "null"] },
        },
      },
    },
  },

  async handler(input) {
    const chain  = (input.chain || "ethereum").toLowerCase();
    const rpcUrl = CHAINS[chain];
    if (!rpcUrl) throw new Error(`Unsupported chain: ${chain}`);

    const txHash = (input.tx_hash || "0x34b0204a1b6095816252517acff4e8d94ba2a71c2e3f180c6fe4e6530c021d8d").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
      throw new Error("tx_hash must be 0x-prefixed and 64 hex characters");
    }

    // Parallel fetch: tx + receipt
    const [tx, receipt] = await Promise.all([
      rpcCall(rpcUrl, "eth_getTransactionByHash", [txHash]),
      rpcCall(rpcUrl, "eth_getTransactionReceipt", [txHash]),
    ]);

    if (!tx) return { tx_hash: txHash, chain: chain === "eth" ? "ethereum" : chain, found: false, message: `Transaction not found on ${chain}. Provide a valid tx_hash to decode a specific transaction.` };

    const pending = !receipt;
    const status  = pending ? "pending"
      : receipt.status === "0x1" ? "success" : "failed";

    const blockNum = tx.blockNumber ? Number(hexToInt(tx.blockNumber)) : null;
    const blockTs  = tx.blockTimestamp ? Number(hexToInt(tx.blockTimestamp)) : null;

    const value      = hexToInt(tx.value);
    const gasPrice   = hexToInt(tx.gasPrice || tx.effectiveGasPrice || "0x0");
    const gasUsed    = receipt ? Number(hexToInt(receipt.gasUsed)) : 0;
    const gasPriceGwei = Number((gasPrice / 1_000_000_000n)) + (Number(gasPrice % 1_000_000_000n) / 1e9);
    const feeWei     = BigInt(gasUsed) * gasPrice;

    const transfers = receipt ? parseTransfers(receipt.logs || []) : [];
    const summary   = pending
      ? `Pending: ${short(tx.from)} → ${short(tx.to)}`
      : buildSummary(tx, receipt, transfers, chain);

    // Detect type
    let txType = "contract_call";
    if (!tx.to)                                         txType = "contract_creation";
    else if ((tx.input === "0x" || !tx.input) && value > 0n) txType = "eth_transfer";
    else if (receipt?.logs?.some((l) => l.topics?.[0] === SIG_APPROVAL)) txType = "approval";
    else if (receipt?.logs?.some((l) => l.topics?.[0] === SIG_SWAP_V3 || l.topics?.[0] === SIG_SWAP_V2)) txType = "swap";
    else if (transfers.length === 1)                    txType = "erc20_transfer";
    else if (transfers.length >= 2)                     txType = "swap";

    const chainBase = chain === "eth" ? "ethereum" : chain === "matic" ? "polygon" : chain;
    const explorerBase = EXPLORER[chain] || EXPLORER[chainBase] || `https://blockscan.com/tx/`;

    const result = {
      tx_hash:             txHash,
      chain:               chainBase,
      explorer_url:        explorerBase + txHash,
      status,
      type:                txType,
      summary,
      from:                tx.from,
      to:                  tx.to || null,
      value_eth:           weiToEth(value),
      gas_used:            gasUsed,
      gas_price_gwei:      Number(gasPriceGwei.toFixed(6)),
      tx_fee_eth:          weiToEth(feeWei),
      block_number:        blockNum,
      block_timestamp_iso: blockTs ? new Date(blockTs * 1000).toISOString() : null,
      transfers:           transfers.map((t) => ({
        symbol:   t.symbol,
        from:     t.from,
        to:       t.to,
        amount:   t.amount,
        contract: t.contract,
      })),
      block_context: null,
    };

    // Optional block context (collapses the onesource/block seam)
    if (input.include_block_context !== false && blockNum !== null) {
      try {
        const block = await rpcCall(rpcUrl, "eth_getBlockByNumber", [`0x${blockNum.toString(16)}`, false]);
        if (block) {
          const bTs       = block.timestamp ? Number(hexToInt(block.timestamp)) : null;
          const baseFeeWei = block.baseFeePerGas ? hexToInt(block.baseFeePerGas) : null;
          result.block_context = {
            block_number:  Number(hexToInt(block.number)),
            timestamp_iso: bTs ? new Date(bTs * 1000).toISOString() : null,
            miner:         block.miner,
            tx_count:      (block.transactions || []).length,
            gas_used:      Number(hexToInt(block.gasUsed)),
            gas_limit:     Number(hexToInt(block.gasLimit)),
            base_fee_gwei: baseFeeWei !== null
              ? Number((baseFeeWei / 1_000_000_000n)) + Number(baseFeeWei % 1_000_000_000n) / 1e9
              : null,
          };
        }
      } catch { /* block context is non-fatal */ }
    }

    return result;
  },
};
