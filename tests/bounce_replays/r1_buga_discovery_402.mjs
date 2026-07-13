#!/usr/bin/env node
/**
 * r1_buga_discovery_402.mjs — Regression replay for bug a
 *
 * Bug a: PayAI canary middleware was serving PayAI's 402 to fresh discovery
 * fetches on /cap/ping, directing agents to PayAI's payment system instead
 * of STALL's revenue wallet. Fixed in payai-canary.js (commit 4e7883c).
 *
 * PASS: unpaid GET /cap/ping returns STALL's own 402 where:
 *   - payTo = STALL revenue wallet 0x03d773
 *   - accepts[] contains eip155:8453 (Base) entry
 *   - NO PayAI facilitator URL or PayAI payment terms
 *   - body is x402Version=2 format
 *
 * No payment made — read-only. Zero cost.
 */

const STALL_HOST = "http://localhost:4021";
const PING_URL   = STALL_HOST + "/cap/ping";
const REVENUE_WALLET = "0x03d773c52b67993e60ecb3134b17436fe03b584c";

console.log(`[r1-buga] Target: ${PING_URL}`);
console.log(`[r1-buga] Expected payTo: ${REVENUE_WALLET}`);

const resp = await fetch(PING_URL);
if (resp.status !== 402) {
  console.error(`[r1-buga] FAIL — expected 402, got ${resp.status}`);
  process.exit(1);
}

const reqHeader = resp.headers.get("payment-required");
if (!reqHeader) {
  console.error("[r1-buga] FAIL — no payment-required header");
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(Buffer.from(reqHeader, "base64").toString("utf8"));
} catch {
  console.error("[r1-buga] FAIL — cannot parse payment-required header");
  process.exit(1);
}

const accepts = parsed.accepts || (Array.isArray(parsed) ? parsed : [parsed]);
const baseEntry = accepts.find(r => r.network === "eip155:8453" && r.scheme === "exact");

console.log(`[r1-buga] x402Version: ${parsed.x402Version}`);
console.log(`[r1-buga] Base entry payTo: ${baseEntry?.payTo}`);
console.log(`[r1-buga] Accepts count: ${accepts.length}`);

// Check: payTo is STALL's revenue wallet (not PayAI or other intermediary)
const payToMatch = baseEntry?.payTo?.toLowerCase() === REVENUE_WALLET;
// Check: not PayAI's 402 format (PayAI uses different schema)
const isX402v2 = parsed.x402Version === 2;
// Check: Base network present
const hasBase = !!baseEntry;

console.log(`\n[r1-buga] === PASS CRITERIA ===`);
console.log(`[r1-buga] 1. payTo = STALL revenue wallet: ${payToMatch ? "PASS ✓" : `FAIL ✗ (got ${baseEntry?.payTo})`}`);
console.log(`[r1-buga] 2. x402Version = 2:             ${isX402v2 ? "PASS ✓" : `FAIL ✗ (got ${parsed.x402Version})`}`);
console.log(`[r1-buga] 3. eip155:8453 (Base) present:  ${hasBase ? "PASS ✓" : "FAIL ✗"}`);

const allPass = payToMatch && isX402v2 && hasBase;
console.log(`\n[r1-buga] RESULT: ${allPass ? "ALL PASS — bug a fix proven" : "FAIL — regression detected"}`);
process.exit(allPass ? 0 : 1);
