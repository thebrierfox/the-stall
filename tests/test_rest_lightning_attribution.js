// tests/test_rest_lightning_attribution.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LIGHTNING_DECISION_SCHEMA } from "../src/lightning-attribution.js";
import {
  classifyRestSettlement,
  scanRestSettlements,
  settlementAttributionKey,
} from "../scripts/watch_rest_lightning_attribution.mjs";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "stall-rest-lightning-"));
  return {
    dir,
    decision: join(dir, "active-decision.json"),
    rest: join(dir, "settlement.jsonl"),
    output: join(dir, "attributed.jsonl"),
  };
}

function decision(overrides = {}) {
  return {
    schema_version: LIGHTNING_DECISION_SCHEMA,
    wish_execution_id: "wish-rest-001",
    lightning_route_id: "route-rest-001",
    mechanism_id: "stall-rest-price-experiment",
    global_effect_key: "effect-rest-001",
    occurrence_key: "occ-rest-001",
    decision_kind: "PRICE_EXPERIMENT",
    source_ref: "aegis-ops:genie/route-rest-001",
    scoped_caps: ["research-synthesis"],
    runtime_assertions: { "research-synthesis": { price_usd: 2.25 } },
    activated_at: "2026-08-24T22:00:00.000Z",
    expires_at: "2026-08-27T22:00:00.000Z",
    prior_cycle_settlement_id: null,
    ...overrides,
  };
}

function settlement(overrides = {}) {
  return {
    ts: "2026-08-25T00:00:00.000Z",
    cap: "research-synthesis",
    price: "$2.25",
    status: 200,
    payer: "0x1111111111111111111111111111111111111111",
    tx_hash: "0xabc001",
    ...overrides,
  };
}

test("external REST settlement with matching active decision is attributable", () => {
  const w = workspace();
  writeFileSync(w.decision, JSON.stringify(decision()));
  const verdict = classifyRestSettlement(settlement(), {
    selfWallets: new Set(["0x9999999999999999999999999999999999999999"]),
    decisionFile: w.decision,
  });
  assert.equal(verdict.eligible, true);
  assert.equal(verdict.reason, "EXTERNAL_SETTLEMENT_CAUSALLY_ATTRIBUTABLE");
  assert.equal(verdict.cap, "research-synthesis");
  assert.equal(verdict.price_usd, 2.25);
  assert.match(verdict.settlement_attribution_key, /^sha256:[a-f0-9]{64}$/);
});

test("self payment cannot become Lightning revenue", () => {
  const w = workspace();
  writeFileSync(w.decision, JSON.stringify(decision()));
  const payer = "0x1111111111111111111111111111111111111111";
  const verdict = classifyRestSettlement(settlement({ payer }), {
    selfWallets: new Set([payer]),
    decisionFile: w.decision,
  });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "SELF_CONTROLLED_PAYER");
});

test("wrong runtime price fails closed", () => {
  const w = workspace();
  writeFileSync(w.decision, JSON.stringify(decision()));
  const verdict = classifyRestSettlement(settlement({ price: "$2.50" }), {
    selfWallets: new Set(),
    decisionFile: w.decision,
  });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "LIGHTNING_ATTRIBUTION_UNVERIFIED");
  assert.equal(verdict.lightning_attribution.reason, "RUNTIME_ASSERTION_MISMATCH");
});

test("decision must have been active at settlement time", () => {
  const w = workspace();
  writeFileSync(w.decision, JSON.stringify(decision({ expires_at: "2026-08-24T23:00:00.000Z" })));
  const verdict = classifyRestSettlement(settlement({ ts: "2026-08-25T00:00:00.000Z" }), {
    selfWallets: new Set(),
    decisionFile: w.decision,
  });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.lightning_attribution.reason, "ACTIVE_DECISION_INVALID");
  assert.ok(verdict.lightning_attribution.reasons.includes("DECISION_EXPIRED"));
});

test("scan writes each attributable transaction exactly once", () => {
  const w = workspace();
  writeFileSync(w.decision, JSON.stringify(decision()));
  const row = settlement();
  writeFileSync(w.rest, JSON.stringify(row) + "\n");

  const first = scanRestSettlements({
    restLog: w.rest,
    outputLog: w.output,
    decisionFile: w.decision,
    selfWallets: new Set(),
    write: true,
  });
  assert.equal(first.newly_attributed, 1);

  const second = scanRestSettlements({
    restLog: w.rest,
    outputLog: w.output,
    decisionFile: w.decision,
    selfWallets: new Set(),
    write: true,
  });
  assert.equal(second.newly_attributed, 0);
  assert.equal(second.rejected.ALREADY_ATTRIBUTED, 1);
  assert.equal(readFileSync(w.output, "utf8").trim().split("\n").length, 1);
});

test("settlement attribution key is deterministic and transaction-scoped", () => {
  const base = {
    transaction: "0xABC001",
    cap: "research-synthesis",
    decision_sha256: "sha256:" + "a".repeat(64),
  };
  const a = settlementAttributionKey(base);
  const b = settlementAttributionKey({ ...base, transaction: "0xabc001" });
  const c = settlementAttributionKey({ ...base, transaction: "0xabc002" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});
