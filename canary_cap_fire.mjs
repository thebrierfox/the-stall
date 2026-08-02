#!/usr/bin/env node
/**
 * canary_cap_fire.mjs — one-shot seeder-funded x402 payment to an arbitrary /cap/<name> route.
 *
 * Directive 103 Stage 1 (Kyle ruling, telegram 822630200/201, 2026-08-02T15:18Z): controlled
 * mainnet payment evidence for CDP_FIRST_CAPS canary routes. Generalized from
 * canary_ping_fire.mjs (commit 7111b3f) to accept the path via argv instead of hardcoding /cap/ping.
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
import { getAddress } from "viem";
import crypto from "crypto";

const SEEDER_KEY = process.env.AEGIS_WALLET_PRIVATE_KEY;
if (!SEEDER_KEY) { console.error("[canary] AEGIS_WALLET_PRIVATE_KEY not set"); process.exit(1); }

const CAP_PATH = process.argv[2];
if (!CAP_PATH || !CAP_PATH.startsWith("/cap/")) {
  console.error("[canary] Usage: node canary_cap_fire.mjs \"/cap/<name>?query=...\"");
  process.exit(1);
}

const account = privateKeyToAccount(`0x${SEEDER_KEY.replace(/^0x/, "")}`);
const STALL_HOST = "http://localhost:4021";
const TARGET_URL = STALL_HOST + CAP_PATH;

console.log(`[canary] Seeder: ${account.address}`);
console.log(`[canary] Target: ${TARGET_URL}`);

// Step 1: Get payment requirements from 402 response
const resp402 = await fetch(TARGET_URL);
if (resp402.status !== 402) {
  console.error(`[canary] Expected 402, got ${resp402.status}. STALL may not be running.`);
  process.exit(1);
}

const body402 = await resp402.json();
console.log(`[canary] 402 body: ${JSON.stringify(body402).slice(0, 500)}`);

const acceptsArray = Array.isArray(body402) ? body402 : (body402.accepts || [body402]);
const req = acceptsArray.find(r => r.network === "eip155:8453" && r.scheme === "exact") || acceptsArray[0];

console.log(`[canary] Using requirement: network=${req.network} amount=${req.amount} asset=${req.asset?.slice(0,10)}... payTo=${req.payTo}`);

if (!req.extra?.name || !req.extra?.version) {
  console.error("[canary] Missing EIP-712 domain params in requirement:", req.extra);
  process.exit(1);
}

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

console.log(`[canary] Signature: ${signature.slice(0, 20)}...`);

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

const xPayResp = respPaid.headers.get("x-payment-response");
if (xPayResp) {
  try { console.log("[canary] x-payment-response:", JSON.parse(Buffer.from(xPayResp, "base64").toString())); }
  catch {}
}

if (respPaid.status === 200) {
  console.log("[canary] DONE — payment accepted");
  process.exit(0);
} else {
  console.error("[canary] PAYMENT REJECTED");
  process.exit(1);
}
