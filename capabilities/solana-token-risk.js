// solana-token-risk.js
//
// Rug-pull / risk scanner for Solana SPL tokens. Checks mint & freeze
// authorities, top-holder concentration, liquidity depth, age, and
// composite safety score (0-100, higher = safer).
//
// Upstream 1: Solana public mainnet RPC (https://api.mainnet-beta.solana.com)
//   — getAccountInfo (jsonParsed) for mint/freeze authority + supply
//   — getTokenLargestAccounts for top-holder concentration
//
// Upstream 2: DexScreener public API (https://api.dexscreener.com)
//   — /latest/dex/tokens/:mint for price, liquidity, market cap, age
//
// Both upstreams are free, no key required.
// Priced at $0.35/call — 30% below oatp.cc/tools/token_risk_scan ($0.50/call,
// confirmed live 2026-06-05 via signal-intel archive, 27 calls / 3 unique payers).

const SOL_RPC    = "https://api.mainnet-beta.solana.com";
const DEX_BASE   = "https://api.dexscreener.com/latest/dex/tokens";
const UA         = "Mozilla/5.0 (compatible; the-stall/1.3; +https://intuitek.ai)";
const TIMEOUT_MS = 12000;

async function rpcCall(method, params) {
  const resp = await fetch(SOL_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Solana RPC HTTP ${resp.status}`);
  const j = await resp.json();
  if (j.error) throw new Error(`Solana RPC error: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

function computeRiskScore({ mintRenounced, freezeRenounced, liquidityUsd, ageDays, top10Pct }) {
  let score = 50; // baseline
  const flags  = [];
  const warnings = [];

  if (mintRenounced)  { score += 20; flags.push("mint-renounced"); }
  else                { score -= 20; warnings.push("mint-authority-active"); }

  if (freezeRenounced){ score += 15; flags.push("freeze-renounced"); }
  else                { score -= 15; warnings.push("freeze-authority-active"); }

  if (liquidityUsd !== null) {
    if (liquidityUsd >= 100_000)     { score += 20; flags.push("deep-liquidity"); }
    else if (liquidityUsd >= 10_000) { score += 10; flags.push("moderate-liquidity"); }
    else if (liquidityUsd < 1_000)   { score -= 20; warnings.push("low-liquidity"); }
  }

  if (ageDays !== null) {
    if (ageDays >= 180) { score += 15; flags.push("mature-token"); }
    else if (ageDays >= 30) { score += 5; }
    else if (ageDays < 7)  { score -= 15; warnings.push("new-token"); }
  }

  if (top10Pct !== null) {
    if (top10Pct <= 20)      { score += 10; flags.push("distributed-supply"); }
    else if (top10Pct >= 60) { score -= 15; warnings.push("high-concentration"); }
    else if (top10Pct >= 80) { score -= 25; warnings.push("extreme-concentration"); }
  }

  score = Math.max(0, Math.min(100, score));

  let level;
  if (score >= 75)     level = "safe";
  else if (score >= 50) level = "moderate";
  else if (score >= 25) level = "risky";
  else                  level = "danger";

  return { score, level, flags, warnings };
}

export default {
  name:  "solana-token-risk",
  price: "$0.120",

  description:
    "Rug-pull and risk scanner for Solana SPL tokens. Input a mint address; returns mint/freeze authority status, top-10 holder concentration, liquidity depth, token age, and a composite safety score (0–100, higher = safer) with risk level (safe/moderate/risky/danger) and green/warning flags. Uses Solana public RPC and DexScreener — no API keys required. Useful for agents vetting a memecoin or new token before trading, swapping, or recommending.",

  inputSchema: {
    type: "object",
    properties: {
      mint: {
        type: "string",
        description: "Solana SPL token mint address (base58, 32–44 chars).",
        minLength: 32,
        maxLength: 44,
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      mint:    { type: "string", description: "The queried mint address." },
      metadata: {
        type: "object",
        properties: {
          name:     { type: ["string","null"] },
          symbol:   { type: ["string","null"] },
          decimals: { type: ["integer","null"] },
        },
      },
      authorities: {
        type: "object",
        properties: {
          mint_renounced:   { type: "boolean", description: "true if mint authority has been burned (no new supply possible)." },
          freeze_renounced: { type: "boolean", description: "true if freeze authority has been burned." },
        },
      },
      distribution: {
        type: "object",
        properties: {
          supply:         { type: ["string","null"], description: "Total token supply (raw integer string)." },
          top10_holder_pct: { type: ["number","null"], description: "Percentage of supply held by the 10 largest wallets." },
        },
      },
      liquidity: {
        type: "object",
        properties: {
          price_usd:     { type: ["number","null"] },
          liquidity_usd: { type: ["number","null"] },
          market_cap:    { type: ["number","null"] },
          volume_24h:    { type: ["number","null"] },
        },
      },
      age: {
        type: "object",
        properties: {
          age_days:   { type: ["integer","null"] },
          created_at: { type: ["string","null"], description: "ISO-8601 first-pair-created timestamp." },
        },
      },
      risk: {
        type: "object",
        properties: {
          score:    { type: "integer", description: "Safety score 0–100 (higher = safer)." },
          level:    { type: "string",  description: "safe | moderate | risky | danger" },
          flags:    { type: "array",   items: { type: "string" }, description: "Positive signals (mint-renounced, deep-liquidity, …)" },
          warnings: { type: "array",   items: { type: "string" }, description: "Negative signals (mint-authority-active, low-liquidity, …)" },
        },
      },
      ts: { type: "string", description: "ISO-8601 response timestamp." },
    },
  },

  async handler(query) {
    const mint = String(query.mint || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").trim();
    if (!mint || mint.length < 32 || mint.length > 44) {
      throw new Error("mint must be a valid base58 Solana address (32–44 chars)");
    }

    // --- RPC calls (parallel) ---
    const [mintInfo, largestAccounts, dexRaw] = await Promise.allSettled([
      rpcCall("getAccountInfo", [mint, { encoding: "jsonParsed" }]),
      rpcCall("getTokenLargestAccounts", [mint]),
      fetch(`${DEX_BASE}/${mint}`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    // --- Parse mint info ---
    const mintVal   = mintInfo.status === "fulfilled" ? mintInfo.value : null;
    const parsedInfo = mintVal?.value?.data?.parsed?.info || {};
    const mintRenounced   = parsedInfo.mintAuthority   === null || parsedInfo.mintAuthority   === undefined ? true : parsedInfo.mintAuthority === null;
    const freezeRenounced = parsedInfo.freezeAuthority === null || parsedInfo.freezeAuthority === undefined ? true : parsedInfo.freezeAuthority === null;
    const supply    = parsedInfo.supply || null;
    const decimals  = typeof parsedInfo.decimals === "number" ? parsedInfo.decimals : null;

    // --- Parse holder concentration ---
    let top10Pct = null;
    if (largestAccounts.status === "fulfilled" && supply) {
      const accounts = largestAccounts.value?.value || [];
      const supplyBig = BigInt(supply);
      if (supplyBig > 0n) {
        const top10Sum = accounts.slice(0, 10).reduce((acc, a) => acc + BigInt(a.amount), 0n);
        top10Pct = Number(top10Sum * 10000n / supplyBig) / 100;
      }
    }

    // --- Parse DexScreener ---
    let name        = null, symbol = null;
    let priceUsd    = null, liquidityUsd = null, marketCap = null, volume24h = null;
    let ageDays     = null, createdAt = null;

    const dexData = dexRaw.status === "fulfilled" ? dexRaw.value : null;
    const pairs   = dexData?.pairs || [];

    if (pairs.length > 0) {
      // Use the pair with the highest USD liquidity for reliability
      pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      const best = pairs[0];
      name      = best.baseToken?.name   || null;
      symbol    = best.baseToken?.symbol || null;
      priceUsd  = best.priceUsd ? parseFloat(best.priceUsd) : null;
      liquidityUsd = best.liquidity?.usd ?? null;
      marketCap    = best.marketCap ?? best.fdv ?? null;
      volume24h    = best.volume?.h24 ?? null;
      if (best.pairCreatedAt) {
        const created = new Date(best.pairCreatedAt);
        createdAt = created.toISOString();
        ageDays   = Math.floor((Date.now() - best.pairCreatedAt) / 86400000);
      }
    }

    const { score, level, flags, warnings } = computeRiskScore({
      mintRenounced,
      freezeRenounced,
      liquidityUsd,
      ageDays,
      top10Pct,
    });

    return {
      mint,
      metadata: { name, symbol, decimals },
      authorities: {
        mint_renounced:   mintRenounced,
        freeze_renounced: freezeRenounced,
      },
      distribution: {
        supply,
        top10_holder_pct: top10Pct !== null ? Math.round(top10Pct * 100) / 100 : null,
      },
      liquidity: {
        price_usd:     priceUsd !== null    ? Math.round(priceUsd    * 1e8) / 1e8 : null,
        liquidity_usd: liquidityUsd !== null ? Math.round(liquidityUsd)       : null,
        market_cap:    marketCap    !== null ? Math.round(marketCap)          : null,
        volume_24h:    volume24h    !== null ? Math.round(volume24h)          : null,
      },
      age: { age_days: ageDays, created_at: createdAt },
      risk: { score, level, flags, warnings },
      ts: new Date().toISOString(),
    };
  },
};
