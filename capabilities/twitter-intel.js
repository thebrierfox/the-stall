// twitter-intel.js
//
// Real-time Twitter/X data via twit.sh x402-native API.
// No Twitter API key required — all costs settled in USDC on Base via x402.
//
// Seam: twit-api-production-de12.up.railway.app → twit.sh
//       3,791 calls/12h · 13 payers · $0.005–$0.010/call upstream
//       twit.sh eliminates the $100/mo Twitter API key requirement
//
// Actions:
//   lookup_user   — full profile (followers, bio, verification) by @username  — upstream $0.005
//   search_tweets — keyword/filter tweet search, returns 10 results            — upstream $0.010
//
// STALL price: $0.040 (50–67% gross margin depending on action)

import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const TWIT_BASE = "https://x402.twit.sh";
const TIMEOUT_MS = 20_000;

function loadAccount() {
  const kp = JSON.parse(
    readFileSync(join(__dir, "../../credentials/keys/revenue-wallet.json"), "utf8")
  );
  return privateKeyToAccount("0x" + kp.private_key.replace(/^0x/, ""));
}

async function twitPay(path, params = {}) {
  const account = loadAccount();
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(account));

  const qs = new URLSearchParams(params).toString();
  const url = `${TWIT_BASE}${path}${qs ? `?${qs}` : ""}`;

  const r402 = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (r402.status !== 402) {
    const body = await r402.text();
    throw new Error(`twit.sh: expected 402, got ${r402.status} — ${body.slice(0, 200)}`);
  }

  const reqHeader = r402.headers.get("PAYMENT-REQUIRED") || r402.headers.get("payment-required");
  if (!reqHeader) throw new Error("twit.sh: missing PAYMENT-REQUIRED header");

  const paymentRequired = JSON.parse(Buffer.from(reqHeader, "base64").toString("utf8"));
  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  const resp = await fetch(url, {
    headers: { "PAYMENT-SIGNATURE": encoded },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`twit.sh ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

export default {
  name: "twitter-intel",
  price: "$0.035",

  description:
    "Real-time Twitter/X data without an API key. lookup_user returns full profile (followers, bio, verification) for any @username. search_tweets returns 10 recent tweets matching a keyword or filter query. x402-settled upstream.",

  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["lookup_user", "search_tweets"],
        description: "lookup_user: profile by @username | search_tweets: keyword tweet search",
      },
      username: {
        type: "string",
        description: "@handle without the @. Required for lookup_user.",
      },
      q: {
        type: "string",
        description: "Search query string (keywords, filters). Required for search_tweets.",
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      action: { type: "string" },
      data: { type: "object", description: "Twitter API response (user or tweets)" },
      upstream_cost_usd: { type: "number", description: "Actual upstream cost paid to twit.sh" },
    },
  },

  async handler(query) {
    const { action = "lookup_user", username = "AnthropicAI", q } = query;

    if (action === "lookup_user") {
      if (!username) throw new Error("lookup_user requires username");
      const clean = username.replace(/^@/, "").trim();
      if (!clean) throw new Error("username cannot be empty");
      const data = await twitPay("/users/by/username", { username: clean });
      return { action, data, upstream_cost_usd: 0.005 };
    }

    if (action === "search_tweets") {
      if (!q) throw new Error("search_tweets requires q");
      const data = await twitPay("/tweets/search", { q: q.trim(), max_results: "10" });
      return { action, data, upstream_cost_usd: 0.010 };
    }

    throw new Error(`Unknown action "${action}". Use lookup_user or search_tweets.`);
  },
};
