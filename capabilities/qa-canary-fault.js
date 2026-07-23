// qa-canary-fault.js — INTERNAL QA ONLY. Not a product capability.
//
// Built per directive 87/88 (STALL P0 master execution directive) Stage 1
// acceptance test PAY-08: "Instrument a harmless canary handler with a
// durable invocation counter and unique request IDs." Used to empirically
// prove handler-failure behavior around the x402 settlement boundary
// without touching any revenue-generating capability.
//
// `fail=1` makes the handler bump the durable counter (proving it ran) and
// then throw. `fail` omitted/anything else returns success. Priced at the
// minimum to conserve seeder USDC during testing. Remove after P0 evidence
// collection completes — this is scaffolding, not a shipped product.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COUNTER_FILE = join(__dirname, "..", "logs", "qa_canary_fault_counter.json");

function bump(requestId, outcome) {
  let state = { count: 0, log: [] };
  try {
    state = JSON.parse(readFileSync(COUNTER_FILE, "utf8"));
  } catch {
    // no counter file yet — start fresh
  }
  state.count += 1;
  state.log.push({ ts: new Date().toISOString(), requestId, outcome });
  if (state.log.length > 50) state.log = state.log.slice(-50);
  writeFileSync(COUNTER_FILE, JSON.stringify(state, null, 2));
  return state.count;
}

export default {
  name: "qa-canary-fault",
  price: "$0.001",
  description: "INTERNAL QA ONLY — deliberately-failable canary for P0 fail-closed acceptance testing (directive 87/88). Not intended for agent use.",
  inputSchema: {
    type: "object",
    properties: {
      request_id: { type: "string", description: "caller-supplied id for correlating counter log entries" },
      fail: { type: "string", description: "if '1', handler bumps the durable counter then throws" },
    },
    required: ["request_id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      request_id: { type: "string" },
      invocation_count: { type: "number" },
    },
  },
  async handler(query) {
    const shouldFail = query.fail === "1";
    const invocation_count = bump(query.request_id ?? "unlabeled", shouldFail ? "handler_fault_triggered" : "handler_success");
    if (shouldFail) {
      throw new Error(`qa-canary-fault: deliberate handler failure for request_id=${query.request_id}`);
    }
    return { ok: true, request_id: query.request_id ?? null, invocation_count };
  },
};
