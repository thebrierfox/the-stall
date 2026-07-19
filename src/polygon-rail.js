// polygon-rail.js — Polygon x402 payment rail for The Stall.
//
// POLYGON-PILOT-01 (2026-07-08, 003-B Kyle operator authority): adds Polygon
// native-USDC as a payment rail alongside Base EVM and Solana. Mirrors the
// solana-rail.js pattern — native on-chain verification via JSON-RPC, no
// additional library dependencies.
//
// Kill window: 2026-08-08. Zero Polygon-rail settlement by then → withdraw,
// dead-pond entry (Ruling 003 §3).
//
// Usage (in server.js): mount buildPolygonRailMiddleware() BEFORE the EVM
// x402Middleware. The middleware is a no-op if POLYGON_WALLET_ADDRESS is unset.

import { appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dir, "..", "logs");

// Native USDC on Polygon (not USDC.e / bridged)
export const POLYGON_USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
export const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";
// Revenue wallet — same EVM address on Polygon
export const POLYGON_WALLET = process.env.POLYGON_WALLET_ADDRESS || process.env.WALLET_ADDRESS || null;
// ERC-20 Transfer(from, to, value) topic0
const TRANSFER_T0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Call eth_getTransactionReceipt on the Polygon RPC.
 */
async function getPolygonReceipt(txHash) {
  const res = await fetch(POLYGON_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
    signal: AbortSignal.timeout(12000),
  });
  const data = await res.json();
  return data?.result ?? null;
}

/**
 * Determine if this X-PAYMENT header is for a Polygon payment.
 * Returns { isPolygon, txHash, decoded } or { isPolygon: false }.
 */
function detectPolygon(xPayment) {
  if (!xPayment) return { isPolygon: false };
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(String(xPayment), "base64").toString("utf-8"));
  } catch {
    return { isPolygon: false };
  }

  // Check network/chainId fields at multiple nesting levels
  const network = (
    decoded?.network ??
    decoded?.chainId ??
    decoded?.payload?.network ??
    decoded?.payload?.chainId ??
    decoded?.payment?.network ??
    null
  );

  const isPolygon137 = String(network) === "137" ||
    String(network) === "eip155:137" ||
    String(network).toLowerCase() === "polygon";

  if (!isPolygon137) return { isPolygon: false };

  // Extract tx hash
  const txHash = (
    decoded?.payload?.txHash ??
    decoded?.txHash ??
    decoded?.payment?.txHash ??
    decoded?.payload?.txSignature ??
    null
  );
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { isPolygon: false };

  return { isPolygon: true, txHash, decoded };
}

/**
 * Verify a Polygon USDC payment on-chain.
 * Returns { ok, payer, txHash, amountRaw } or { ok: false, error }.
 */
async function verifyPolygonPayment(txHash, priceStr) {
  if (!POLYGON_WALLET) return { ok: false, error: "POLYGON_WALLET_ADDRESS not configured" };

  let receipt;
  try {
    receipt = await getPolygonReceipt(txHash);
  } catch (err) {
    return { ok: false, error: `RPC fetch failed: ${err.message}` };
  }

  if (!receipt) return { ok: false, error: "tx not found on Polygon" };
  if (receipt.status !== "0x1") return { ok: false, error: "tx failed on-chain" };

  const recipientLower = POLYGON_WALLET.toLowerCase();
  const usdcLower = POLYGON_USDC.toLowerCase();
  const priceRaw = BigInt(Math.round(parseFloat(priceStr.replace("$", "")) * 1e6));

  for (const log of (receipt.logs || [])) {
    if ((log.address || "").toLowerCase() !== usdcLower) continue;
    if ((log.topics || [])[0] !== TRANSFER_T0) continue;
    const to = "0x" + (log.topics[2] || "").slice(26).toLowerCase();
    if (to !== recipientLower) continue;
    const amountRaw = BigInt(log.data || "0x0");
    if (amountRaw >= priceRaw) {
      const payer = "0x" + (log.topics[1] || "").slice(26);
      return { ok: true, payer, txHash, amountRaw };
    }
  }

  return { ok: false, error: "No matching USDC transfer to revenue wallet in tx" };
}

/**
 * Build the Polygon rail middleware.
 * Intercepts requests with a Polygon (chainId=137) X-PAYMENT header, verifies
 * the on-chain USDC transfer, and sets req._polygonRail = true on success.
 * Falls through to the next middleware for all other requests.
 */
export function buildPolygonRailMiddleware(capabilities) {
  if (!POLYGON_WALLET) {
    console.log("[polygon-rail] POLYGON_WALLET_ADDRESS not set — Polygon rail DISABLED");
    return (_req, _res, next) => next();
  }
  console.log(`[polygon-rail] Polygon rail ENABLED — receiver: ${POLYGON_WALLET} RPC: ${POLYGON_RPC_URL}`);

  const capPriceMap = new Map(capabilities.map(c => [c.name, c.price]));

  return async (req, _res, next) => {
    const xPayment = req.headers["x-payment"];
    const { isPolygon, txHash } = detectPolygon(xPayment);
    if (!isPolygon) return next();

    const capMatch = req.path.match(/^\/cap\/(.+)$/);
    if (!capMatch) return next();
    const capName = capMatch[1];
    const price = capPriceMap.get(capName);
    if (!price) return next();

    const result = await verifyPolygonPayment(txHash, price);
    if (!result.ok) {
      console.warn(`[polygon-rail] verify FAILED cap=${capName} tx=${txHash}: ${result.error}`);
      return next();
    }

    req._polygonRail = true;
    req._polygonPayer = result.payer;
    req._polygonTxHash = result.txHash;

    // Settlement log — matches settlement.jsonl schema
    try {
      appendFileSync(
        join(LOG_DIR, "settlement.jsonl"),
        JSON.stringify({
          ts: new Date().toISOString(),
          cap: capName,
          price,
          payer: result.payer,
          tx_hash: result.txHash,
          amount_raw: result.amountRaw.toString(),
          rail: "polygon",
          network: "eip155:137",
          referer: req.headers["referer"] || req.headers["referrer"] || null,
          user_agent: req.headers["user-agent"] || null,
          origin: req.headers["origin"] || null,
        }) + "\n"
      );
    } catch { /* never crash on log failure */ }

    console.log(`[polygon-rail] ✅ ${capName} — payer ${result.payer} tx ${result.txHash}`);
    return next();
  };
}
