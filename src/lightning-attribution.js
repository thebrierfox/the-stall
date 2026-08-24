// lightning-attribution.js — fail-closed causal attribution for STALL revenue.
//
// Historical STALL revenue is never retroactively credited to Lightning. A live
// payment may carry Lightning attribution only when ALL of the following are
// true at request execution time:
//   1. a bounded active Lightning decision artifact exists;
//   2. route/effect/occurrence/wish/mechanism identity is complete;
//   3. the paid capability is explicitly in that decision's scope;
//   4. the runtime configuration independently matches the decision assertion;
//   5. the decision artifact is content-addressed by a server-computed SHA-256.
//
// The customer never supplies this identity. STALL seals it server-side from
// the active decision artifact, preventing buyer-controlled attribution.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const LIGHTNING_DECISION_SCHEMA = "stall.lightning-decision/1.0";
export const LIGHTNING_ATTRIBUTION_SCHEMA = "stall.lightning-attribution/1.0";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map(k => [k, stable(value[k])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(stable(value));
}

export function decisionSha256(value) {
  return "sha256:" + createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseUsd(value) {
  const n = Number(String(value ?? "").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function decisionFilePath(explicitPath) {
  return resolve(
    explicitPath
      || process.env.LIGHTNING_DECISION_FILE
      || "runtime/lightning/active-decision.json"
  );
}

function isoMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

function requiredString(obj, key, reasons) {
  const value = typeof obj?.[key] === "string" ? obj[key].trim() : "";
  if (!value) reasons.push(`MISSING_${key.toUpperCase()}`);
  return value || null;
}

function normalizeCaps(value, reasons) {
  if (!Array.isArray(value) || value.length === 0) {
    reasons.push("SCOPED_CAPS_REQUIRED");
    return [];
  }
  const caps = [...new Set(value.map(v => String(v || "").trim()).filter(Boolean))].sort();
  if (caps.length !== value.length) reasons.push("SCOPED_CAPS_INVALID_OR_DUPLICATE");
  if (caps.includes("*")) reasons.push("WILDCARD_SCOPE_FORBIDDEN");
  return caps;
}

/**
 * Read and validate the currently active Lightning decision artifact.
 * Never throws. No file, malformed JSON, stale decision, or incomplete causal
 * identity simply produces an ineligible verdict.
 */
export function readActiveLightningDecision({ filePath, now = Date.now() } = {}) {
  const path = decisionFilePath(filePath);
  if (!existsSync(path)) {
    return { ok: false, reason: "NO_ACTIVE_DECISION", path };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { ok: false, reason: "ACTIVE_DECISION_UNREADABLE", path, error_type: error?.constructor?.name || "Error" };
  }

  const reasons = [];
  if (raw?.schema_version !== LIGHTNING_DECISION_SCHEMA) reasons.push("DECISION_SCHEMA_INVALID");

  const wishExecutionId = requiredString(raw, "wish_execution_id", reasons);
  const routeId = requiredString(raw, "lightning_route_id", reasons);
  const mechanismId = requiredString(raw, "mechanism_id", reasons);
  const globalEffectKey = requiredString(raw, "global_effect_key", reasons);
  const occurrenceKey = requiredString(raw, "occurrence_key", reasons);
  const decisionKind = requiredString(raw, "decision_kind", reasons);
  const sourceRef = requiredString(raw, "source_ref", reasons);
  const scopedCaps = normalizeCaps(raw?.scoped_caps, reasons);

  const activatedMs = isoMs(raw?.activated_at);
  const expiresMs = isoMs(raw?.expires_at);
  if (activatedMs === null) reasons.push("ACTIVATED_AT_INVALID");
  if (expiresMs === null) reasons.push("EXPIRES_AT_INVALID");
  if (activatedMs !== null && expiresMs !== null && expiresMs <= activatedMs) reasons.push("DECISION_WINDOW_INVALID");
  if (activatedMs !== null && Number(now) < activatedMs) reasons.push("DECISION_NOT_YET_ACTIVE");
  if (expiresMs !== null && Number(now) >= expiresMs) reasons.push("DECISION_EXPIRED");

  const assertions = raw?.runtime_assertions;
  if (!assertions || typeof assertions !== "object" || Array.isArray(assertions)) {
    reasons.push("RUNTIME_ASSERTIONS_REQUIRED");
  } else {
    for (const cap of scopedCaps) {
      const assertion = assertions[cap];
      if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) {
        reasons.push(`RUNTIME_ASSERTION_MISSING:${cap}`);
        continue;
      }
      // v1 deliberately supports an independently observable price assertion.
      // Additional assertion types can be added explicitly; unknown assertion
      // shapes must not silently grant attribution.
      if (parseUsd(assertion.price_usd) === null) {
        reasons.push(`RUNTIME_PRICE_ASSERTION_REQUIRED:${cap}`);
      }
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reason: "ACTIVE_DECISION_INVALID", reasons, path };
  }

  const decision = {
    schema_version: LIGHTNING_DECISION_SCHEMA,
    wish_execution_id: wishExecutionId,
    lightning_route_id: routeId,
    mechanism_id: mechanismId,
    global_effect_key: globalEffectKey,
    occurrence_key: occurrenceKey,
    decision_kind: decisionKind,
    source_ref: sourceRef,
    scoped_caps: scopedCaps,
    runtime_assertions: Object.fromEntries(scopedCaps.map(cap => [cap, {
      price_usd: parseUsd(assertions[cap].price_usd),
    }])),
    activated_at: new Date(activatedMs).toISOString(),
    expires_at: new Date(expiresMs).toISOString(),
    prior_cycle_settlement_id: typeof raw?.prior_cycle_settlement_id === "string" && raw.prior_cycle_settlement_id.trim()
      ? raw.prior_cycle_settlement_id.trim()
      : null,
  };

  return {
    ok: true,
    reason: "ACTIVE_DECISION_VALID",
    path,
    decision,
    decision_sha256: decisionSha256(decision),
  };
}

/**
 * Bind one paid capability execution to a validated active decision and verify
 * that the real runtime price matches the decision's material assertion.
 */
export function lightningAttributionFor(capName, runtime = {}, options = {}) {
  const read = readActiveLightningDecision(options);
  if (!read.ok) {
    return {
      schema_version: LIGHTNING_ATTRIBUTION_SCHEMA,
      eligible: false,
      reason: read.reason,
      ...(read.reasons ? { reasons: read.reasons } : {}),
    };
  }

  const cap = String(capName || "").replace(/^\/cap\//, "").trim();
  if (!read.decision.scoped_caps.includes(cap)) {
    return {
      schema_version: LIGHTNING_ATTRIBUTION_SCHEMA,
      eligible: false,
      reason: "CAP_OUT_OF_DECISION_SCOPE",
      decision_sha256: read.decision_sha256,
    };
  }

  const expected = read.decision.runtime_assertions[cap];
  const actualPrice = parseUsd(runtime.price_usd ?? runtime.price);
  if (actualPrice === null) {
    return {
      schema_version: LIGHTNING_ATTRIBUTION_SCHEMA,
      eligible: false,
      reason: "RUNTIME_PRICE_UNOBSERVABLE",
      decision_sha256: read.decision_sha256,
    };
  }

  if (Math.abs(actualPrice - expected.price_usd) > 1e-9) {
    return {
      schema_version: LIGHTNING_ATTRIBUTION_SCHEMA,
      eligible: false,
      reason: "RUNTIME_ASSERTION_MISMATCH",
      decision_sha256: read.decision_sha256,
      expected_price_usd: expected.price_usd,
      actual_price_usd: actualPrice,
    };
  }

  const d = read.decision;
  return {
    schema_version: LIGHTNING_ATTRIBUTION_SCHEMA,
    eligible: true,
    reason: "CAUSAL_DECISION_AND_RUNTIME_VERIFIED",
    decision_sha256: read.decision_sha256,
    wish_execution_id: d.wish_execution_id,
    lightning_route_id: d.lightning_route_id,
    mechanism_id: d.mechanism_id,
    global_effect_key: d.global_effect_key,
    occurrence_key: d.occurrence_key,
    decision_kind: d.decision_kind,
    source_ref: d.source_ref,
    scoped_cap: cap,
    verified_runtime: { price_usd: actualPrice },
    activated_at: d.activated_at,
    expires_at: d.expires_at,
    prior_cycle_settlement_id: d.prior_cycle_settlement_id,
  };
}
