#!/usr/bin/env node
/**
 * canary_ping_fire.mjs — one-shot seeder-funded x402 payment to /cap/ping
 *
 * Fires CDP canary T1 (commit 7111b3f). Uses seeder wallet (AEGIS_WALLET_PRIVATE_KEY)
 * to make a real $0.021 x402 payment to /cap/ping. The local facilitator's /settle
 * handler will attempt CDP first (canary path) before falling back to EIP-3009 bypass.
 * Check journalctl for [cdp-canary] PASS or FAIL after this script exits 0.
 *
 * Self-traffic invariant: this payment is seeder-funded and must never appear in
 * organic/demand metrics.
 *
 * Run from: ~/intuitek/the-stall/
 * Requires: AEGIS_WALLET_PRIVATE_KEY in env, STALL running at localhost:4021,
 *           local facilitator at localhost:4099.
 */

import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import crypto from "crypto";

const SEEDER_KEY = process.env.AEGIS_WALLET_PRIVATE_KEY;
if (!SEEDER_KEY) { console.error("[canary] AEGIS_WALLET_PRIVATE_KEY not set"); process.exit(1); }

const account = privateKeyToAccount(`0x${SEEDER_KEY.replace(/^0x/, "")}`);
const STALL_HOST = "http://localhost:4021";
const PING_PATH = "/cap/ping?msg=cdp-canary-fire-2026-07-13";
const PING_URL  = STALL_HOST + PING_PATH;

console.log(`[canary] Seeder: ${account.address}`);
console.log(`[canary] Target: ${PING_URL}`);

// Step 1: Get payment requirements from 402 response
const resp402 = await fetch(PING_URL);
if (resp402.status !== 402) {
  console.error(`[canary] Expected 402, got ${resp402.status}. STALL may not be running.`);
  process.exit(1);
}

// STALL uses "payment-required" header (base64-encoded JSON array of requirements)
const reqHeader = resp402.headers.get("payment-required") ||
                  resp402.headers.get("x-payment-requirements") ||
                  resp402.headers.get("x-payment-requirement");
if (!reqHeader) {
  const wwwAuth = resp402.headers.get("www-authenticate");
  console.error(`[canary] No payment-required header. www-authenticate: ${wwwAuth?.slice(0,200)}`);
  console.error("[canary] Headers:", JSON.stringify(Object.fromEntries(resp402.headers.entries()), null, 2).slice(0, 400));
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(Buffer.from(reqHeader, "base64").toString("utf8"));
} catch (e) {
  try { parsed = JSON.parse(reqHeader); }
  catch { console.error("[canary] Could not parse requirements:", reqHeader.slice(0, 100)); process.exit(1); }
}

// x402 v2 format: {x402Version:2, resource:{url,description}, accepts:[...]}
// x402 v1 format: [{scheme, network, ...}]
const acceptsArray = Array.isArray(parsed) ? parsed : (parsed.accepts || [parsed]);
const req = acceptsArray.find(r => r.network === "eip155:8453" && r.scheme === "exact") || acceptsArray[0];

console.log(`[canary] Using requirement: network=${req.network} amount=${req.amount} asset=${req.asset?.slice(0,10)}...`);

if (!req.extra?.name || !req.extra?.version) {
  console.error("[canary] Missing EIP-712 domain params in requirement:", req.extra);
  process.exit(1);
}

// Step 2: Create EIP-3009 authorization
const now = Math.floor(Date.now() / 1000);
const nonceBytes = crypto.randomBytes(32);
// nonce must be bytes32: use hex string "0x..." — viem encodes bytes32 from hex correctly
const nonce = "0x" + nonceBytes.toString("hex");
const chainId = parseInt(req.network.split(":")[1]); // eip155:8453 → 8453

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

console.log(`[canary] Signature: ${signature.slice(0, 20)}...`);

// Step 3: Build x402 v2 payment payload
// v2 schema: { x402Version:2, accepted:<full_req_object>, resource:<ResourceInfo>, payload:{signature, authorization} }
const paymentPayload = {
  x402Version: 2,
  accepted: req,    // the full PaymentRequirementsV2 object from the 402 accepts array
  resource: {       // include resource so local facilitator CDP canary can detect /cap/ping path
    url: PING_URL,
    description: "Liveness + echo probe",
  },
  payload: {
    signature,
    authorization: {
      from:        authorizationMessage.from,
      to:          authorizationMessage.to,
      value:       req.amount,                           // string, e.g. "21000"
      validAfter:  authorizationMessage.validAfter.toString(),
      validBefore: authorizationMessage.validBefore.toString(),
      nonce,
    },
  },
};

const xPaymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

// Step 4: Submit paid request with payment-signature header (x402 v2)
// STALL chassis validates via local facilitator → /settle triggers CDP canary
console.log("[canary] Sending paid request...");
const respPaid = await fetch(PING_URL, {
  headers: { "payment-signature": xPaymentHeader },
});

console.log(`[canary] Paid response status: ${respPaid.status}`);
let body;
try { body = await respPaid.json(); }
catch { body = await respPaid.text(); }
console.log(`[canary] Paid response body: ${JSON.stringify(body)}`);

if (respPaid.status === 200) {
  console.log("[canary] DONE — payment accepted; check journalctl for [cdp-canary] PASS/FAIL");
  process.exit(0);
} else {
  const xPayResp = respPaid.headers.get("x-payment-response");
  if (xPayResp) {
    try { console.log("[canary] x-payment-response:", JSON.parse(Buffer.from(xPayResp, "base64").toString())); }
    catch {}
  }
  console.error("[canary] PAYMENT REJECTED");
  process.exit(1);
}
