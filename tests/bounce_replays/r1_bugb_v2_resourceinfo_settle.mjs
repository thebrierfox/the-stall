#!/usr/bin/env node
/**
 * r1_bugb_v2_resourceinfo_settle.mjs — Regression replay for bug b
 *
 * Bug b: local-facilitator.mjs /settle crashed with TypeError when resource
 * was a ResourceInfo OBJECT {url, description} (v2 format). Fix in 4e7883c
 * changed `resource.includes(...)` → normalize to string first.
 *
 * This replay sends a SEEDER x402 payment to /cap/research-synthesis
 * with resource as a ResourceInfo OBJECT — the exact shape that crashed.
 * PASS: 200 response + new settlement row + facilitator PID unchanged.
 *
 * Self-traffic: seeder-funded, excluded from organic metrics.
 * Cost: ~$2.50 USDC seeder→revenue circulation, plus gas (~$0.001).
 */

import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import crypto from "crypto";
import { readFileSync } from "fs";
import { execSync } from "child_process";

const SEEDER_KEY = process.env.AEGIS_WALLET_PRIVATE_KEY;
if (!SEEDER_KEY) { console.error("[r1-bugb] AEGIS_WALLET_PRIVATE_KEY not set"); process.exit(1); }

const account = privateKeyToAccount(`0x${SEEDER_KEY.replace(/^0x/, "")}`);
const STALL_HOST = "http://localhost:4021";
const CAP_PATH = "/cap/research-synthesis";
const CAP_URL  = STALL_HOST + CAP_PATH;

const SETTLEMENT_LOG = "/home/aegis/intuitek/the-stall/logs/settlement.jsonl";
const FACILITATOR_PID = parseInt(execSync("pgrep -f local-facilitator").toString().trim());

console.log(`[r1-bugb] Seeder: ${account.address}`);
console.log(`[r1-bugb] Target: ${CAP_URL}`);
console.log(`[r1-bugb] Facilitator PID baseline: ${FACILITATOR_PID}`);

function settlementCount() {
  try { return readFileSync(SETTLEMENT_LOG, "utf8").trim().split("\n").filter(Boolean).length; }
  catch { return 0; }
}
const baselineSettlements = settlementCount();
console.log(`[r1-bugb] Settlement count baseline: ${baselineSettlements}`);

// Step 1: GET 402 to fetch payment requirements
const resp402 = await fetch(CAP_URL);
if (resp402.status !== 402) {
  console.error(`[r1-bugb] Expected 402, got ${resp402.status}`);
  process.exit(1);
}

const reqHeader = resp402.headers.get("payment-required");
if (!reqHeader) {
  console.error("[r1-bugb] No payment-required header");
  process.exit(1);
}

let parsed;
try { parsed = JSON.parse(Buffer.from(reqHeader, "base64").toString("utf8")); }
catch { console.error("[r1-bugb] Failed to parse payment-required"); process.exit(1); }

const acceptsArray = Array.isArray(parsed) ? parsed : (parsed.accepts || [parsed]);
const req = acceptsArray.find(r => r.network === "eip155:8453" && r.scheme === "exact");
if (!req) { console.error("[r1-bugb] No Base/eip155:8453 requirement found"); process.exit(1); }

console.log(`[r1-bugb] Requirement: amount=${req.amount} (${Number(req.amount)/1e6} USDC) payTo=${req.payTo.slice(0,14)}...`);

// Step 2: Build EIP-3009 authorization
const now = Math.floor(Date.now() / 1000);
const nonceBytes = crypto.randomBytes(32);
const nonce = "0x" + nonceBytes.toString("hex");
const chainId = parseInt(req.network.split(":")[1]); // eip155:8453 → 8453

const authorizationMessage = {
  from: getAddress(account.address),
  to:   getAddress(req.payTo),
  value: BigInt(req.amount),
  validAfter:  BigInt(now - 600),
  validBefore: BigInt(now + req.maxTimeoutSeconds),
  nonce,
};

const domain = {
  name:              req.extra.name,
  version:           req.extra.version,
  chainId,
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

const signature = await account.signTypedData({ domain, types, primaryType: "TransferWithAuthorization", message: authorizationMessage });
console.log(`[r1-bugb] Signature: ${signature.slice(0, 20)}...`);

// Step 3: Build v2 payload with resource as ResourceInfo OBJECT (bug b trigger shape)
// This is the EXACT format that caused TypeError in local-facilitator before 4e7883c.
const paymentPayload = {
  x402Version: 2,
  accepted: req,
  resource: {             // ← ResourceInfo OBJECT, NOT a string — this was bug b
    url: CAP_URL,
    description: "research-synthesis bounce-replay-proof R1.1",
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

// Step 4: Submit paid request
console.log("[r1-bugb] Sending paid request with v2 ResourceInfo OBJECT...");
const respPaid = await fetch(CAP_URL, {
  method: "POST",
  headers: {
    "payment-signature": xPaymentHeader,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ ticker: "AAPL" }),
});

console.log(`[r1-bugb] Paid response status: ${respPaid.status}`);
let body;
try { body = await respPaid.json(); }
catch { body = await respPaid.text(); }

if (respPaid.status !== 200) {
  const xPayResp = respPaid.headers.get("x-payment-response") || respPaid.headers.get("payment-response");
  if (xPayResp) {
    try { console.error("[r1-bugb] x-payment-response:", JSON.parse(Buffer.from(xPayResp, "base64").toString())); }
    catch {}
  }
  console.error("[r1-bugb] FAIL — payment rejected");
  console.error("[r1-bugb] Response body:", JSON.stringify(body).slice(0, 300));
  process.exit(1);
}

// Step 5: Verify pass criteria
// Wait 3 seconds for settlement row to be written
await new Promise(r => setTimeout(r, 3000));

// Criterion 1: status 200 ✓ (already verified)
// Criterion 2: settlement row added
const newSettlements = settlementCount();
const settlementAdded = newSettlements > baselineSettlements;

// Criterion 3: facilitator PID unchanged (no crash/restart)
let pidStable = true;
try {
  const currentPid = parseInt(execSync("pgrep -f local-facilitator").toString().trim());
  pidStable = (currentPid === FACILITATOR_PID);
} catch { pidStable = false; }

console.log(`\n[r1-bugb] === PASS CRITERIA ===`);
console.log(`[r1-bugb] 1. 200 response:      ${respPaid.status === 200 ? "PASS ✓" : "FAIL ✗"}`);
console.log(`[r1-bugb] 2. Settlement added:  ${settlementAdded ? `PASS ✓ (${baselineSettlements} → ${newSettlements})` : `FAIL ✗ (${baselineSettlements} → ${newSettlements})`}`);
console.log(`[r1-bugb] 3. Facilitator PID:   ${pidStable ? `PASS ✓ (${FACILITATOR_PID})` : `FAIL ✗ (PID changed)`}`);

const allPass = respPaid.status === 200 && settlementAdded && pidStable;
console.log(`\n[r1-bugb] RESULT: ${allPass ? "ALL PASS — bug b fix proven" : "FAIL — regression detected"}`);
process.exit(allPass ? 0 : 1);
