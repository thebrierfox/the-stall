#!/usr/bin/env node
/**
 * seeder_single.mjs — Generic single-cap seeder for ECHO-SEED-A and HOT-PULSE-A.
 *
 * Usage: node seeder_single.mjs --cap <cap_id> [--echo] [--hot-pulse]
 *
 * Uses seeder wallet (AEGIS_WALLET_PRIVATE_KEY = 0xf615) to fire one x402
 * settlement on the specified cap. All calls are is_seeder by payer address
 * and excluded from organic metrics by stall_exclusions.py / canonical_metrics.py.
 *
 * Exits 0 on successful 200, 1 on failure.
 */

import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { readFileSync } from "fs";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";

const BASE_URL  = process.env.STALL_BASE_URL  || "https://the-stall.intuitek.ai";
const RPC_URL   = process.env.BASE_RPC_URL    || "https://api.developer.coinbase.com/rpc/v1/base/SH2ERnua9qjQ08v2clFSDgG5c91RTcds";

// Parse --cap argument
const capIdx = process.argv.indexOf("--cap");
if (capIdx === -1 || !process.argv[capIdx + 1]) {
  console.error("Usage: seeder_single.mjs --cap <cap_id>");
  process.exit(1);
}
const CAP_ID = process.argv[capIdx + 1];
const IS_ECHO      = process.argv.includes("--echo");
const IS_HOT_PULSE = process.argv.includes("--hot-pulse");

// Load seeder private key
let PRIVATE_KEY = process.env.AEGIS_WALLET_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  try {
    const w = JSON.parse(readFileSync(
      new URL("../../credentials/keys/aegis-seeder-wallet.json", import.meta.url)
    ));
    PRIVATE_KEY = w.private_key?.replace(/^0x/, "");
  } catch {
    console.error("ERROR: AEGIS_WALLET_PRIVATE_KEY not set and no seeder wallet file found");
    process.exit(1);
  }
}

async function main() {
  const tag = IS_ECHO ? "echo" : IS_HOT_PULSE ? "hot_pulse" : "seed";
  console.log(`[seeder-single] cap=${CAP_ID} tag=${tag}`);

  const account = privateKeyToAccount(`0x${PRIVATE_KEY}`);

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(RPC_URL),
  });

  const signer = {
    address: account.address,
    signTypedData: (args) => walletClient.signTypedData(args),
  };

  // Probe for 402
  const probeUrl = `${BASE_URL}/cap/${CAP_ID}`;
  const probeResp = await fetch(probeUrl);
  if (probeResp.status !== 402) {
    console.error(`[seeder-single] Expected 402 on probe, got ${probeResp.status}`);
    process.exit(1);
  }

  const prHeader = probeResp.headers.get("payment-required");
  if (!prHeader) {
    console.error("[seeder-single] No payment-required header");
    process.exit(1);
  }

  const requirements = decodePaymentRequiredHeader(prHeader);
  const payReq = requirements.accepts?.[0];
  if (!payReq) {
    console.error("[seeder-single] No accepts in payment requirements");
    process.exit(1);
  }
  console.log(`[seeder-single] price=${Number(payReq.amount) / 1e6} USDC`);

  const evmScheme = new ExactEvmScheme(signer);

  // Submit paid request. Retry once on the facilitator's intermittent
  // pre-broadcast "execution reverted" simulation failure (anomaly #126).
  // Each attempt signs a fresh EIP-3009 authorization (anomaly #164 fix) —
  // resubmitting an identical header on retry can hit "authorization is
  // used or canceled" if attempt 1 actually broadcast despite the client
  // observing a non-200. The nonce is logged so a future incident can be
  // correlated to its on-chain event.
  const MAX_ATTEMPTS = 2;
  let lastStatus, lastBody;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const partial = await evmScheme.createPaymentPayload(requirements.x402Version, payReq);
    const payload = {
      x402Version: partial.x402Version,
      payload:     partial.payload,
      resource:    requirements.resource,
      accepted:    payReq,
    };
    const paymentHeader = encodePaymentSignatureHeader(payload);
    const nonce = partial.payload?.authorization?.nonce ?? "unknown";

    const paidResp = await fetch(`${probeUrl}?_tag=${tag}`, {
      headers: {
        "X-PAYMENT":        paymentHeader,
        "PAYMENT-SIGNATURE": paymentHeader,
      },
    });

    if (paidResp.status === 200) {
      console.log(`[seeder-single] OK cap=${CAP_ID} status=200 nonce=${nonce}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      process.exit(0);
    }

    lastStatus = paidResp.status;
    lastBody = await paidResp.text().catch(() => "");
    const isRetryableRevert = lastStatus === 402 && lastBody.includes("execution reverted");
    if (isRetryableRevert && attempt < MAX_ATTEMPTS) {
      console.error(`[seeder-single] attempt ${attempt} facilitator execution-reverted, retrying cap=${CAP_ID} nonce=${nonce}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    break;
  }

  console.error(`[seeder-single] FAILED cap=${CAP_ID} status=${lastStatus} body=${lastBody.slice(0, 200)}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("[seeder-single] EXCEPTION:", err.message);
  process.exit(1);
});
