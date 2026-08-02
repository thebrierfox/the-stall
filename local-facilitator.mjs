/**
 * local-facilitator.mjs — Smart proxy x402 facilitator for The Stall.
 *
 * Applies EIP-3009 on-chain bypass for ALL payers where auth.to matches
 * the STALL revenue wallet (WALLET_ADDRESS). This bypasses CDP's
 * payment-method-required check, which blocks both seeder and organic
 * settlements since 2026-06-26T21Z.
 *
 * Prior behavior: bypass was seeder-only (from=0xf615); organic routed
 * to CDP. Updated 2026-06-28: CDP /settle now rejects organic payers too,
 * so bypass applies to any payment where auth.to === REVENUE_WALLET.
 *
 * Gas is paid by the seeder wallet (AEGIS_WALLET_PRIVATE_KEY) on Base.
 * Base tx cost is ~$0.001; seeder ETH balance covers hundreds of settlements.
 *
 * Usage: node local-facilitator.mjs  (sources .env from process.env)
 * Port: 4099 (localhost only)
 */

import express from "express";
import { createWalletClient, createPublicClient, http, getAddress, parseAbi } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getAuthHeaders } from "@coinbase/cdp-sdk/auth";

const PORT = 4099;
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const CDP_HOST = "api.cdp.coinbase.com";
const CDP_BASE = "/platform/v2/x402";
const SEEDER_WALLET = "0xf615BDa54D576e757B51A6128aC8A7C67a1C3d6C";
const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const SEEDER_KEY = process.env.AEGIS_WALLET_PRIVATE_KEY;
const CDP_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_KEY_SECRET = process.env.CDP_API_KEY_SECRET;
// Prefer Coinbase keyed RPC (avoids Tenderly public rate limits); gas: is specified on writeContract
// so eth_estimateGas is never called (CDP rejects estimateGas since 2026-06-29 — skip it entirely).
// Tenderly stays as a constant for reference but is no longer the default.
const TENDERLY_RPC = "https://gateway.tenderly.co/public/base";
const RPC = process.env.COINBASE_BASE_RPC || TENDERLY_RPC;
// Revenue wallet — payments destined here get EIP-3009 bypass (CDP broken since Jun26T21Z)
const REVENUE_WALLET = (process.env.WALLET_ADDRESS || process.env.X402_PAY_TO || "").toLowerCase();

// Caps for which we attempt CDP /settle FIRST, falling back to the EIP-3009
// bypass ONLY on a definitively-rejected, nonce-unconsumed outcome. CDP-routed
// settles are the only thing that produces a Bazaar ingestion event.
// Code default is intentionally `ping` only. Widen via the service environment.
const CDP_FIRST_CAPS = new Set(
  (process.env.CDP_FIRST_CAPS ?? "ping")
    .split(",").map(s => s.trim()).filter(Boolean)
);

// EIP-3009 ABI — packed-bytes signature variant (matches x402/evm facilitator)
const EIP3009_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

function log(msg) {
  // systemd StandardOutput=append:...log captures console.log — do not double-write with appendFileSync
  console.log(`${new Date().toISOString()} ${msg}`);
}

// Seeder wallet client — used to execute on-chain transferWithAuthorization
let seederAccount = null;
let walletClient = null;
if (SEEDER_KEY) {
  seederAccount = privateKeyToAccount(`0x${SEEDER_KEY.replace(/^0x/, "")}`);
  walletClient = createWalletClient({ account: seederAccount, chain: base, transport: http(RPC) });
}

const publicClient = createPublicClient({ chain: base, transport: http(RPC) });

// The x402/core HTTPFacilitatorClient sends:
//   /verify:  { payload: paymentPayload, paymentRequirements }
//   /settle:  { x402Version, paymentPayload, paymentRequirements }
// So the outer payload key differs between the two endpoints.
// paymentPayload inner structure: { x402Version, payload: { authorization, signature }, resource, accepted }

function extractOuterPayload(body, endpoint) {
  if (endpoint === "settle") return body?.paymentPayload;  // settle uses "paymentPayload"
  return body?.payload;                                    // verify uses "payload"
}

function shouldBypass(outerPayload) {
  try {
    const auth = outerPayload?.payload?.authorization;
    if (!auth?.to) return false;
    // Bypass if payment goes to our revenue wallet (covers seeder + all organic payers)
    return REVENUE_WALLET && getAddress(auth.to).toLowerCase() === REVENUE_WALLET;
  } catch { return false; }
}

async function cdpHeaders(method, path) {
  if (!CDP_KEY_ID || !CDP_KEY_SECRET) return {};
  try {
    return await getAuthHeaders({
      apiKeyId: CDP_KEY_ID, apiKeySecret: CDP_KEY_SECRET,
      requestMethod: method, requestHost: CDP_HOST, requestPath: path,
    });
  } catch (e) {
    log(`[warn] CDP auth header failed: ${e.message.slice(0, 60)}`);
    return {};
  }
}

async function proxyToCdp(endpoint, body, method = "POST") {
  const path = `${CDP_BASE}${endpoint}`;
  const authH = await cdpHeaders(method, path);
  const resp = await fetch(`${CDP_URL}${endpoint}`, {
    method,
    headers: { "Content-Type": "application/json", ...authH },
    body: method === "POST" ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const raw = await resp.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined; // non-JSON body — caller classifies this as AMBIGUOUS, not a thrown exception
  }
  return { status: resp.status, data, raw };
}

// Classify a CDP /settle response into SUCCESS | DEFINITIVE_REJECTION | AMBIGUOUS.
// AMBIGUOUS covers a request-level failure (timeout/network/abort) or a response
// that parsed but carries no clear success/failure signal (non-JSON body, missing
// `success` field). Only AMBIGUOUS/DEFINITIVE_REJECTION go through on-chain
// reconciliation before the caller decides whether to fall through to the bypass.
function classifyCdpOutcome(cdpResult, err) {
  if (err) return { cls: "AMBIGUOUS", detail: `request_error:${err.message.slice(0, 100)}` };
  const { status, data, raw } = cdpResult;
  if (data === undefined) {
    return { cls: "AMBIGUOUS", detail: `unparseable_body status=${status} raw=${(raw || "").slice(0, 140)}` };
  }
  if (data.success === true) return { cls: "SUCCESS", data };
  if (data.success === false) return { cls: "DEFINITIVE_REJECTION", detail: JSON.stringify(data).slice(0, 200) };
  return { cls: "AMBIGUOUS", detail: `missing_success_field status=${status} body=${JSON.stringify(data).slice(0, 140)}` };
}

// Reconcile an ambiguous or rejected CDP outcome against on-chain authorization
// state before letting the local EIP-3009 bypass touch the same nonce. CDP can
// broadcast/confirm a transfer on-chain while its HTTP response times out,
// truncates, or reads as a rejection — falling through blindly in that case
// would attempt the SAME authorization twice: the nonce is already consumed,
// the bypass reverts, and the payer paid but got no data (paid-but-denied).
// Retries the on-chain read once; if the read itself keeps failing, fails
// toward SERVING the paid customer rather than toward denying them.
async function reconcileAmbiguous(auth) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const used = await publicClient.readContract({
        address: USDC_ADDR, abi: EIP3009_ABI,
        functionName: "authorizationState",
        args: [getAddress(auth.from), auth.nonce],
      });
      return { consumed: used, readFailed: false };
    } catch (e) {
      if (attempt === 0) continue;
      log(`[cdp-ambiguous] authorizationState read FAILED after retry — ${e.message.slice(0, 100)} — failing toward serving paid customer`);
      return { consumed: true, readFailed: true };
    }
  }
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// ── Serial on-chain transaction queue ─────────────────────────────────────────
// Concurrent settle requests cause nonce collisions; serialise all on-chain settles
// through a promise chain with a minimum inter-transaction delay.
let _txChain = Promise.resolve();
const TX_MIN_DELAY_MS = 1000;

function enqueueOnChainSettle(settleFn) {
  const next = _txChain.then(async () => {
    try {
      return await settleFn();
    } finally {
      await new Promise(r => setTimeout(r, TX_MIN_DELAY_MS));
    }
  });
  _txChain = next.catch(() => Promise.resolve());
  return next;
}

// ── Nonce dedup guard ─────────────────────────────────────────────────────────
// The x402 middleware can retry /settle on timeout, producing duplicate requests
// with the same EIP-3009 authorization nonce. Track in-flight nonces to skip dups.
const _pendingNonces = new Set();

function acquireNonce(from, nonce) {
  const key = `${from}_${nonce}`;
  if (_pendingNonces.has(key)) return null; // duplicate
  _pendingNonces.add(key);
  return key;
}

function releaseNonce(key, delayMs = 30_000) {
  setTimeout(() => _pendingNonces.delete(key), delayMs);
}

// ── GET /supported ───────────────────────────────────────────────────────────
app.get("/supported", async (_req, res) => {
  try {
    const { status, data, raw } = await proxyToCdp("/supported", undefined, "GET");
    if (data === undefined) {
      log(`[supported] CDP returned unparseable body status=${status} raw=${(raw || "").slice(0, 140)}`);
      return res.json({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453", extra: {} }],
      });
    }
    // @x402/core >=2.19 requires the response keyed as `kinds`, not the older
    // `kindsSupported` name some facilitator responses (incl. CDP) still use.
    if (data && data.kinds === undefined && Array.isArray(data.kindsSupported)) {
      data.kinds = data.kindsSupported;
    }
    return res.status(status).json(data);
  } catch (e) {
    log(`[supported] proxy error: ${e.message.slice(0, 80)}`);
    return res.json({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453", extra: {} }],
    });
  }
});

// ── POST /verify ─────────────────────────────────────────────────────────────
app.post("/verify", async (req, res) => {
  const outerPayload = extractOuterPayload(req.body, "verify");

  if (shouldBypass(outerPayload)) {
    const auth = outerPayload.payload.authorization;
    log(`[bypass/verify] ${getAddress(auth.from)} → ${getAddress(auth.to)} $${(Number(auth.value) / 1e6).toFixed(6)}`);
    try {
      // Check nonce not already used
      const used = await publicClient.readContract({
        address: USDC_ADDR, abi: EIP3009_ABI,
        functionName: "authorizationState",
        args: [getAddress(auth.from), auth.nonce],
      }).catch(() => false);
      if (used) {
        return res.json({ isValid: false, invalidReason: "nonce_already_used" });
      }
      // Check payer balance
      const balance = await publicClient.readContract({
        address: USDC_ADDR, abi: EIP3009_ABI,
        functionName: "balanceOf",
        args: [getAddress(auth.from)],
      }).catch(() => BigInt(0));
      if (balance < BigInt(auth.value)) {
        return res.json({ isValid: false, invalidReason: "insufficient_balance" });
      }
      log(`[bypass/verify] OK`);
      return res.json({ isValid: true });
    } catch (e) {
      log(`[bypass/verify] error: ${e.message.slice(0, 100)}`);
      return res.json({ isValid: false, invalidReason: e.message.slice(0, 100) });
    }
  }

  // Payments to other recipients → proxy to CDP (fallback, not expected in practice)
  try {
    const { status, data, raw } = await proxyToCdp("/verify", req.body);
    if (data === undefined) {
      log(`[verify/proxy] CDP returned unparseable body status=${status} raw=${(raw || "").slice(0, 140)}`);
      return res.status(502).json({ isValid: false, invalidReason: `unparseable_cdp_response status=${status}` });
    }
    return res.status(status).json(data);
  } catch (e) {
    log(`[verify/proxy] error: ${e.message.slice(0, 80)}`);
    return res.status(502).json({ isValid: false, invalidReason: `proxy_error:${e.message.slice(0, 60)}` });
  }
});

// ── POST /settle ─────────────────────────────────────────────────────────────
app.post("/settle", async (req, res) => {
  const outerPayload = extractOuterPayload(req.body, "settle");

  if (shouldBypass(outerPayload)) {
    // ── CDP Canary for /cap/ping (T1 — 2026-07-13 → 2026-08-12) ──────────────
    // Test whether the 6/26 CDP payment-method wall is still up under x402 v2.
    // Attempt CDP settle first for ping only; fall through to EIP-3009 on failure.
    // If CDP succeeds: wall is down → Bazaar indexing resumes for ping (log PASS).
    // If CDP fails (AMBIGUOUS or DEFINITIVE_REJECTION): reconcile on-chain authorization
    // state before falling through — a consumed nonce means CDP already settled the
    // payer, so we serve the data instead of re-attempting the same authorization.
    const rawResource = outerPayload?.resource;
    const resourceUrl = typeof rawResource === "string" ? rawResource : (rawResource?.url || "");
    const capMatch = /\/cap\/([A-Za-z0-9._-]+)/.exec(resourceUrl);
    const capName = capMatch ? capMatch[1] : "";
    if (capName && CDP_FIRST_CAPS.has(capName) && CDP_KEY_ID && CDP_KEY_SECRET) {
      const auth = outerPayload.payload.authorization;
      let cdpResult, cdpErr;
      try {
        cdpResult = await proxyToCdp("/settle", req.body);
      } catch (e) {
        cdpErr = e;
      }
      const outcome = classifyCdpOutcome(cdpResult, cdpErr);

      if (outcome.cls === "SUCCESS") {
        log(`[cdp-canary] PASS — CDP wall DOWN ${capName} indexed via CDP tx=${outcome.data.transaction || "?"}`);
        return res.status(cdpResult.status).json(outcome.data);
      }

      log(outcome.cls === "AMBIGUOUS"
        ? `[cdp-ambiguous] ${capName} — ${outcome.detail}`
        : `[cdp-canary] FAIL — CDP rejected ${capName}: ${outcome.detail}`);

      // Both AMBIGUOUS and DEFINITIVE_REJECTION require on-chain confirmation that
      // the authorization was NOT consumed before the local bypass touches the same
      // nonce — CDP can broadcast/confirm on-chain while its HTTP response is lost,
      // truncated, or reads as a rejection.
      const { consumed, readFailed } = await reconcileAmbiguous(auth);
      if (consumed) {
        log(`[cdp-ambiguous] CONSUMED${readFailed ? " (read-failed, failing toward serving)" : ""} — serving data, tx hash unknown, from=${getAddress(auth.from)}`);
        return res.json({ success: true, transaction: "", network: "eip155:8453" });
      }
      log(`[cdp-canary] nonce unused — falling through to bypass normally`);
      // Fall through to EIP-3009 bypass
    }
    // ── end CDP canary (kill 2026-08-12) ─────────────────────────────────────

    if (!walletClient) {
      log("[bypass/settle] FATAL: no seeder key loaded");
      return res.json({ success: false, errorReason: "no_seeder_key_configured", transaction: "", network: "eip155:8453" });
    }
    const auth = outerPayload.payload.authorization;
    const sig = outerPayload.payload.signature;

    // Nonce dedup: reject duplicate settle requests for the same authorization
    const nonceKey = acquireNonce(getAddress(auth.from), auth.nonce);
    if (!nonceKey) {
      log(`[bypass/settle] DEDUP: nonce already in-flight ${auth.nonce?.slice?.(0,10)} from ${getAddress(auth.from)}`);
      return res.json({ success: false, errorReason: "duplicate_nonce_in_flight", transaction: "", network: "eip155:8453" });
    }

    return enqueueOnChainSettle(async () => {
      log(`[bypass/settle] executing on-chain: $${(Number(auth.value) / 1e6).toFixed(6)} USDC from ${getAddress(auth.from)} → ${getAddress(auth.to)}`);
      const RETRY_DELAYS_MS = [2000, 5000, 15000];
      let lastErr;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        try {
          // Fetch nonce from chain inside the serial queue to prevent stale-nonce collisions
          // when Tenderly rate-limits cause multiple retries that advance the on-chain counter.
          const txNonce = await publicClient.getTransactionCount({ address: seederAccount.address, blockTag: 'pending' });
          const txHash = await walletClient.writeContract({
            address: USDC_ADDR,
            abi: EIP3009_ABI,
            functionName: "transferWithAuthorization",
            args: [
              getAddress(auth.from),
              getAddress(auth.to),
              BigInt(auth.value),
              BigInt(auth.validAfter),
              BigInt(auth.validBefore),
              auth.nonce,
              sig,
            ],
            nonce: txNonce,
            gas: 90000n, // fixed gas — skips eth_estimateGas (CDP RPC rejects estimateGas)
          });
          log(`[bypass/settle] tx submitted: ${txHash}`);
          const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
          if (receipt.status !== "success") {
            log(`[bypass/settle] tx REVERTED: ${txHash}`);
            releaseNonce(nonceKey);
            return res.json({ success: false, errorReason: "tx_reverted", transaction: txHash, network: "eip155:8453" });
          }
          log(`[bypass/settle] CONFIRMED block=${receipt.blockNumber} tx=${txHash}`);
          releaseNonce(nonceKey);
          return res.json({ success: true, transaction: txHash, network: "eip155:8453" });
        } catch (e) {
          lastErr = e;
          if ((e.message.includes("Request exceeds defined limit") || e.message.includes("Too Many Requests") || e.message.includes("rate limit")) && attempt < RETRY_DELAYS_MS.length) {
            const delay = RETRY_DELAYS_MS[attempt];
            log(`[bypass/settle] RPC rate-limit, retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          break;
        }
      }
      log(`[bypass/settle] error: ${lastErr.message.slice(0, 200)}`);
      releaseNonce(nonceKey);
      return res.json({ success: false, errorReason: lastErr.message.slice(0, 200), transaction: "", network: "eip155:8453" });
    });
  }

  // Payments to other recipients → proxy to CDP (fallback, not expected in practice)
  try {
    const { status, data, raw } = await proxyToCdp("/settle", req.body);
    if (data === undefined) {
      log(`[settle/proxy] CDP returned unparseable body status=${status} raw=${(raw || "").slice(0, 140)}`);
      return res.status(502).json({ success: false, errorReason: `unparseable_cdp_response status=${status}` });
    }
    return res.status(status).json(data);
  } catch (e) {
    log(`[settle/proxy] error: ${e.message.slice(0, 80)}`);
    return res.status(502).json({ success: false, errorReason: `proxy_error:${e.message.slice(0, 60)}` });
  }
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    bypass_active: !!walletClient,
    bypass_scope: walletClient ? "all_payers_to_revenue_wallet" : "disabled",
    revenue_wallet: REVENUE_WALLET || null,
    cdp_auth: !!(CDP_KEY_ID && CDP_KEY_SECRET),
  })
);

app.listen(PORT, "127.0.0.1", () => {
  log(`[local-facilitator] UP on http://127.0.0.1:${PORT}`);
  log(`[local-facilitator] bypass: ${walletClient ? `ACTIVE scope=all_to_${REVENUE_WALLET} gas_wallet=${seederAccount.address}` : "INACTIVE (no AEGIS_WALLET_PRIVATE_KEY)"}`);
  log(`[local-facilitator] CDP fallback auth: ${CDP_KEY_ID ? "AUTHENTICATED" : "UNAUTHENTICATED"}`);
});
