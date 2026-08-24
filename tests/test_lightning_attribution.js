// tests/test_lightning_attribution.js — causal revenue attribution gates.
// Run: node --test tests/test_lightning_attribution.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LIGHTNING_DECISION_SCHEMA,
  decisionSha256,
  lightningAttributionFor,
  readActiveLightningDecision,
} from "../src/lightning-attribution.js";

function fixture(overrides = {}) {
  return {
    schema_version: LIGHTNING_DECISION_SCHEMA,
    wish_execution_id: "wish-001",
    lightning_route_id: "route-001",
    mechanism_id: "stall-price-experiment",
    global_effect_key: "effect-001",
    occurrence_key: "occ-001",
    decision_kind: "PRICE_EXPERIMENT",
    source_ref: "github:thebrierfox/aegis-bridge@deadbeef#route-001",
    scoped_caps: ["research-synthesis"],
    runtime_assertions: {
      "research-synthesis": { price_usd: 2.25 },
    },
    activated_at: "2026-08-24T20:00:00.000Z",
    expires_at: "2026-08-27T20:00:00.000Z",
    prior_cycle_settlement_id: null,
    ...overrides,
  };
}

function fileWith(obj) {
  const dir = mkdtempSync(join(tmpdir(), "stall-lightning-"));
  const path = join(dir, "active-decision.json");
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return path;
}

const NOW = Date.parse("2026-08-24T22:00:00.000Z");

test("no active decision means no Lightning attribution", () => {
  const verdict = lightningAttributionFor("research-synthesis", { price_usd: 2.25 }, {
    filePath: join(tmpdir(), "definitely-not-present-stall-lightning.json"),
    now: NOW,
  });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "NO_ACTIVE_DECISION");
});

test("valid bounded decision is content-addressed", () => {
  const path = fileWith(fixture());
  const read = readActiveLightningDecision({ filePath: path, now: NOW });
  assert.equal(read.ok, true);
  assert.match(read.decision_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(read.decision_sha256, decisionSha256(read.decision));
});

test("runtime price must exactly match the Lightning material assertion", () => {
  const path = fileWith(fixture());
  const good = lightningAttributionFor("research-synthesis", { price: "$2.25" }, { filePath: path, now: NOW });
  assert.equal(good.eligible, true);
  assert.equal(good.reason, "CAUSAL_DECISION_AND_RUNTIME_VERIFIED");
  assert.equal(good.verified_runtime.price_usd, 2.25);

  const wrong = lightningAttributionFor("research-synthesis", { price: "$2.50" }, { filePath: path, now: NOW });
  assert.equal(wrong.eligible, false);
  assert.equal(wrong.reason, "RUNTIME_ASSERTION_MISMATCH");
  assert.equal(wrong.expected_price_usd, 2.25);
  assert.equal(wrong.actual_price_usd, 2.50);
});

test("payment to a different cap cannot inherit a nearby Lightning decision", () => {
  const path = fileWith(fixture());
  const verdict = lightningAttributionFor("github-repo-intel", { price_usd: 2.25 }, { filePath: path, now: NOW });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "CAP_OUT_OF_DECISION_SCOPE");
});

test("expired decision fails closed", () => {
  const path = fileWith(fixture({ expires_at: "2026-08-24T21:59:59.000Z" }));
  const verdict = lightningAttributionFor("research-synthesis", { price_usd: 2.25 }, { filePath: path, now: NOW });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "ACTIVE_DECISION_INVALID");
  assert.ok(verdict.reasons.includes("DECISION_EXPIRED"));
});

test("wildcard scope is forbidden so attribution stays occurrence-specific", () => {
  const path = fileWith(fixture({
    scoped_caps: ["*"],
    runtime_assertions: { "*": { price_usd: 2.25 } },
  }));
  const read = readActiveLightningDecision({ filePath: path, now: NOW });
  assert.equal(read.ok, false);
  assert.ok(read.reasons.includes("WILDCARD_SCOPE_FORBIDDEN"));
});

test("incomplete causal identity cannot attribute revenue", () => {
  const path = fileWith(fixture({ global_effect_key: "" }));
  const verdict = lightningAttributionFor("research-synthesis", { price_usd: 2.25 }, { filePath: path, now: NOW });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "ACTIVE_DECISION_INVALID");
  assert.ok(verdict.reasons.includes("MISSING_GLOBAL_EFFECT_KEY"));
});
