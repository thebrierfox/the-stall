#!/usr/bin/env node
/**
 * canary_cap_fire.mjs — one-shot seeder-funded x402 payment to an arbitrary /cap/<name> route,
 * with a hard evidence gate. Exits nonzero unless every predicate below is independently verified
 * against settlement.jsonl, the on-chain receipt, and the facilitator log — never from the paid
 * HTTP response alone.
 *
 * Directive 103 Stage 1 (Kyle ruling, telegram 822630200/201, 2026-08-02T15:18Z): controlled
 * mainnet payment evidence for CDP_FIRST_CAPS canary routes. Generalized from
 * canary_ping_fire.mjs (commit 7111b3f) to accept the path via argv instead of hardcoding /cap/ping.
 *
 * Hardened per Kyle's 2026-08-02T22:52Z Stage-2 ruling (telegram 822630211/212/213) after a
 * false-success incident: the prior version declared "DONE" on HTTP 200 alone, with zero check
 * of settlement.jsonl, tx_hash, on-chain receipt status, or facilitator CDP-routing classification.
 * A 402 body accidentally treated as success, or a settle-endpoint that lies about success, would
 * have passed silently. This version cannot.
 *
 * A route is declared PASS only when ALL of the following hold:
 *   1. Final client response is HTTP 200.
 *   2. Response payload is real fulfillment (non-empty, not a 402/error shape).
 *   3. A new matching settlement.jsonl row exists (cap match, ts >= run start).
 *   4. receipt.success === true in that row.
 *   5. tx_hash is present (non-null) in that row.
 *   6. The Base transaction receipt independently confirms status "success" (fresh eth_getTransactionReceipt).
 *   7. Paid amount (settlement row's price) equals the live 402-advertised amount.
 *   8. If capName is in CDP_FIRST_CAPS: facilitator log has a "[cdp-canary] PASS" line for this
 *      cap in the run window, naming the same tx_hash — i.e. genuinely CDP-routed, not local-bypass.
 *      If capName is NOT in CDP_FIRST_CAPS: no such line exists — confirms local-bypass path used.
 *   9. No ambiguous/duplicate settlement path fired for this cap in the run window
 *      ([cdp-ambiguous] or DEDUP log lines).
 *
 * Self-traffic invariant: this payment is seeder-funded and must never appear in
 * organic/demand metrics.
 *
 * Usage: node canary_cap_fire.mjs "/cap/us-stock-price?ticker=AAPL"
 * Run from: ~/intuitek/the-stall/
 * Requires: AEGIS_WALLET_PRIVATE_KEY in env, STALL running at localhost:4021,
 *           local facilitator at localhost:4099.
 */

import { privateKeyToAccount } from "viem/accounts";
import { getAddress, createPublicClient, http } from "viem";
import { base } from "viem/chains";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTLEMENT_LOG = path.join(__dirname, "logs", "settlement.jsonl");
const FACILITATOR_LOG = path.join(__dirname, "..", "logs", "local-facilitator.log");
const ENV_PATH = path.join(__dirname, ".env");

function fail(reason) {
  console.error(`[canary] FAIL — ${reason}`);
  process.exit(1);
}

function readEnvVar(name) {
  const text = fs.readFileSync(ENV_PATH, "utf8");
  const re = new RegExp(`^${name}=(.*)$`, "m");
  const m = re.exec(text);
  return m ? m[1].trim() : "";
}

const SEEDER_KEY = process.env.AEGIS_WALLET_PRIVATE_KEY;
if (!SEEDER_KEY) fail("AEGIS_WALLET_PRIVATE_KEY not set");

const CAP_PATH = process.argv[2];
if (!CAP_PATH || !CAP_PATH.startsWith("/cap/")) {
  fail(`Usage: node canary_cap_fire.mjs "/cap/<name>?query=..."`);
}
const capName = /\/cap\/([A-Za-z0-9._-]+)/.exec(CAP_PATH)[1];

const CDP_FIRST_CAPS = new Set(
  (readEnvVar("CDP_FIRST_CAPS") || "ping").split(",").map(s => s.trim()).filter(Boolean)
);
const expectCdpRouted = CDP_FIRST_CAPS.has(capName);

const BASE_RPC = readEnvVar("BASE_RPC_URL") || "https://mainnet.base.org";
const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });

const account = privateKeyToAccount(`0x${SEEDER_KEY.replace(/^0x/, "")}`);
const STALL_HOST = "http://localhost:4021";
const TARGET_URL = STALL_HOST + CAP_PATH;

console.log(`[canary] Seeder: ${account.address}`);
console.log(`[canary] Target: ${TARGET_URL}`);
console.log(`[canary] Expected route: ${expectCdpRouted ? "CDP-routed (in CDP_FIRST_CAPS)" : "local-bypass (not in CDP_FIRST_CAPS)"}`);

const runStart = new Date();

// Step 1: Get payment requirements from 402 response
const resp402 = await fetch(TARGET_URL);
if (resp402.status !== 402) fail(`Expected 402, got ${resp402.status}. STALL may not be running.`);

const body402 = await resp402.json();
console.log(`[canary] 402 body: ${JSON.stringify(body402).slice(0, 500)}`);

const acceptsArray = Array.isArray(body402) ? body402 : (body402.accepts || [body402]);
const req = acceptsArray.find(r => r.network === "eip155:8453" && r.scheme === "exact") || acceptsArray[0];
const advertisedUsd = Number(req.amount) / 1e6;

console.log(`[canary] Using requirement: network=${req.network} amount=${req.amount} ($${advertisedUsd.toFixed(3)}) asset=${req.asset?.slice(0,10)}... payTo=${req.payTo}`);

if (!req.extra?.name || !req.extra?.version) fail(`Missing EIP-712 domain params in requirement: ${JSON.stringify(req.extra)}`);

// Step 2: Create EIP-3009 authorization
const now = Math.floor(Date.now() / 1000);
const nonceBytes = crypto.randomBytes(32);
const nonce = "0x" + nonceBytes.toString("hex");
const chainId = parseInt(req.network.split(":")[1]);

const authorizationMessage = {
  from: getAddress(account.address),
  to:   getAddress(req.payTo),
  value: BigInt(req.amount),
  validAfter:  BigInt(now - 600),
  validBefore: BigInt(now + req.maxTimeoutSeconds),
  nonce: nonce,
};

const domain = {
  name:              req.extra.name,
  version:           req.extra.version,
  chainId:           chainId,
  verifyingContract: getAddress(req.asset),
};

const types = {
  TransferWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
  ],
};

console.log(`[canary] Signing EIP-3009 auth: from=${account.address.slice(0,10)}... to=${req.payTo.slice(0,10)}... value=${req.amount}`);

const signature = await account.signTypedData({
  domain,
  types,
  primaryType: "TransferWithAuthorization",
  message: authorizationMessage,
});

const paymentPayload = {
  x402Version: 2,
  accepted: req,
  resource: {
    url: TARGET_URL,
    description: body402.resource?.description || "",
  },
  payload: {
    signature,
    authorization: {
      from:        authorizationMessage.from,
      to:          authorizationMessage.to,
      value:       req.amount,
      validAfter:  authorizationMessage.validAfter.toString(),
      validBefore: authorizationMessage.validBefore.toString(),
      nonce,
    },
  },
};

const xPaymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

console.log("[canary] Sending paid request...");
const respPaid = await fetch(TARGET_URL, {
  headers: { "payment-signature": xPaymentHeader },
});

console.log(`[canary] Paid response status: ${respPaid.status}`);
let respBody;
try { respBody = await respPaid.json(); }
catch { respBody = await respPaid.text(); }
console.log(`[canary] Paid response body: ${JSON.stringify(respBody).slice(0, 800)}`);

// ── Evidence gate — nothing below trusts the paid-response status code alone ──

// Predicate 1+2: HTTP 200 and real fulfillment payload
if (respPaid.status !== 200) fail(`predicate 1 — HTTP status ${respPaid.status}, not 200`);
const bodyIsFulfillment = respBody && typeof respBody === "object"
  ? !("error" in respBody) && !("accepts" in respBody)
  : String(respBody || "").length > 0;
if (!bodyIsFulfillment) fail(`predicate 2 — 200 response body does not look like fulfillment: ${JSON.stringify(respBody).slice(0,200)}`);

// Predicate 3: new matching settlement.jsonl row (poll briefly — res.on('finish') logging is async)
let settleEntry = null;
for (let attempt = 0; attempt < 10 && !settleEntry; attempt++) {
  if (attempt > 0) await new Promise(r => setTimeout(r, 500));
  const lines = fs.readFileSync(SETTLEMENT_LOG, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (row.cap !== capName) continue;
    if (new Date(row.ts) < runStart) break; // walked past this run's window
    settleEntry = row;
    break;
  }
}
if (!settleEntry) fail(`predicate 3 — no new settlement.jsonl entry found for cap=${capName} with ts >= ${runStart.toISOString()}`);
console.log(`[canary] settlement.jsonl entry: ${JSON.stringify(settleEntry)}`);

// Predicate 4: receipt.success === true
if (settleEntry.receipt?.success !== true) fail(`predicate 4 — settlement receipt.success is not true: ${JSON.stringify(settleEntry.receipt)}`);

// Predicate 5: tx_hash present
const txHash = settleEntry.tx_hash;
if (!txHash) fail(`predicate 5 — settlement row has null tx_hash`);

// Predicate 6: independent on-chain confirmation
let onChainReceipt;
try {
  onChainReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
} catch (e) {
  fail(`predicate 6 — could not fetch on-chain receipt for ${txHash}: ${e.message.slice(0,150)}`);
}
if (onChainReceipt.status !== "success") fail(`predicate 6 — on-chain receipt status=${onChainReceipt.status}, not success, tx=${txHash}`);

// Predicate 7: paid amount equals live advertised amount
const settledUsd = Number(String(settleEntry.price).replace("$", ""));
if (Math.abs(settledUsd - advertisedUsd) > 0.0005) {
  fail(`predicate 7 — settled price $${settledUsd} does not match live-advertised price $${advertisedUsd.toFixed(3)}`);
}

// Predicate 8+9: facilitator log classification, no ambiguity/duplication
const facLog = fs.readFileSync(FACILITATOR_LOG, "utf8").split("\n");
const windowLines = facLog.filter(line => {
  const m = /^(\S+)/.exec(line);
  if (!m) return false;
  const ts = new Date(m[1]);
  return !isNaN(ts) && ts >= runStart;
});
const capLines = windowLines.filter(l => l.includes(capName));
const cdpPassLine = capLines.find(l => l.includes("[cdp-canary] PASS") && l.includes(`tx=${txHash}`));
const ambiguousLines = capLines.filter(l => l.includes("[cdp-ambiguous]") || l.includes("DEDUP"));

if (expectCdpRouted) {
  if (!cdpPassLine) fail(`predicate 8 — cap is in CDP_FIRST_CAPS but no matching "[cdp-canary] PASS" facilitator log line found for tx=${txHash} (route did not actually go CDP-routed)`);
  console.log(`[canary] facilitator log confirms CDP-routed: ${cdpPassLine.trim()}`);
} else {
  if (cdpPassLine) fail(`predicate 8 — cap is NOT in CDP_FIRST_CAPS but a "[cdp-canary] PASS" line was found — unexpected CDP routing`);
  console.log(`[canary] facilitator log confirms local-bypass path (no cdp-canary line), as expected for a non-CDP-first cap`);
}
if (ambiguousLines.length > 0) fail(`predicate 9 — ambiguous/duplicate settlement path detected: ${ambiguousLines.join(" | ")}`);

console.log(`[canary] PASS — all evidence predicates verified for cap=${capName} tx=${txHash} $${settledUsd} routed=${expectCdpRouted ? "CDP" : "local-bypass"}`);
process.exit(0);
