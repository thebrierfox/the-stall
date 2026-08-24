// tests/test_activate_lightning_decision.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activateLightningDecision } from "../scripts/activate_lightning_decision.mjs";

function candidate(overrides = {}) {
  return {
    wish_execution_id: "wish-activate-001",
    lightning_route_id: "route-activate-001",
    mechanism_id: "stall-price-experiment",
    global_effect_key: "effect-activate-001",
    occurrence_key: "occ-activate-001",
    decision_kind: "PRICE_EXPERIMENT",
    source_ref: "aegis-ops:genie/route-activate-001",
    scoped_caps: ["research-synthesis"],
    runtime_assertions: { "research-synthesis": { price_usd: 2.25 } },
    prior_cycle_settlement_id: null,
    ...overrides,
  };
}

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "stall-activate-"));
  return {
    active: join(dir, "runtime", "lightning", "active-decision.json"),
    archive: join(dir, "runtime", "lightning", "decisions"),
  };
}

test("valid decision is archived by hash and atomically activated", () => {
  const p = paths();
  const now = Date.parse("2026-08-24T23:00:00.000Z");
  const result = activateLightningDecision({
    candidate: candidate(), activePath: p.active, archiveDir: p.archive,
    durationHours: 72, now,
  });
  assert.equal(result.status, "ACTIVATED");
  assert.match(result.decision_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.activated_at, "2026-08-24T23:00:00.000Z");
  assert.equal(result.expires_at, "2026-08-27T23:00:00.000Z");
  assert.equal(existsSync(p.active), true);
  assert.equal(existsSync(result.archive_path), true);
  const active = JSON.parse(readFileSync(p.active, "utf8"));
  const archived = JSON.parse(readFileSync(result.archive_path, "utf8"));
  assert.equal(active.decision_sha256, result.decision_sha256);
  assert.deepEqual(active, archived);
});

test("invalid wildcard decision never replaces active pointer", () => {
  const p = paths();
  assert.throws(() => activateLightningDecision({
    candidate: candidate({ scoped_caps: ["*"], runtime_assertions: { "*": { price_usd: 2.25 } } }),
    activePath: p.active, archiveDir: p.archive,
    durationHours: 24,
    now: Date.parse("2026-08-24T23:00:00.000Z"),
  }), /decision activation rejected/);
  assert.equal(existsSync(p.active), false);
});

test("activation lifetime is bounded to seven days", () => {
  const p = paths();
  assert.throws(() => activateLightningDecision({
    candidate: candidate(), activePath: p.active, archiveDir: p.archive,
    durationHours: 169,
  }), /durationHours/);
});
