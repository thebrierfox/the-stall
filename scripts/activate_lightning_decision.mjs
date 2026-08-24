#!/usr/bin/env node
// activate_lightning_decision.mjs
//
// Atomically promotes a GENIE/Lightning decision template into STALL's active
// runtime attribution boundary. The planner supplies causal identity + scoped
// material assertions. The host supplies the activation timestamp and bounded
// lifetime. The normalized decision is archived by content hash before the
// active pointer is replaced.

import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LIGHTNING_DECISION_SCHEMA,
  canonicalJson,
  readActiveLightningDecision,
} from "../src/lightning-attribution.js";

function parseArgs(argv) {
  const out = {
    candidate: null,
    active: process.env.LIGHTNING_DECISION_FILE || "runtime/lightning/active-decision.json",
    archiveDir: process.env.LIGHTNING_DECISION_ARCHIVE_DIR || "runtime/lightning/decisions",
    durationHours: 72,
    dryRun: false,
    now: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--candidate") out.candidate = argv[++i];
    else if (arg === "--active") out.active = argv[++i];
    else if (arg === "--archive-dir") out.archiveDir = argv[++i];
    else if (arg === "--duration-hours") out.durationHours = Number(argv[++i]);
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--now") out.now = argv[++i];
  }
  return out;
}

function activationMs(value) {
  if (value == null) return Date.now();
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new Error("--now must be valid ISO 8601");
  return ms;
}

export function activateLightningDecision({
  candidate,
  activePath = process.env.LIGHTNING_DECISION_FILE || "runtime/lightning/active-decision.json",
  archiveDir = process.env.LIGHTNING_DECISION_ARCHIVE_DIR || "runtime/lightning/decisions",
  durationHours = 72,
  now = Date.now(),
  dryRun = false,
} = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("candidate decision object required");
  }
  const hours = Number(durationHours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    throw new Error("durationHours must be > 0 and <= 168");
  }
  const start = Number(now);
  if (!Number.isFinite(start)) throw new Error("now must be epoch milliseconds");

  // Planner identity/material assertions are preserved. Activation timestamps are
  // host-generated so the audit window starts exactly when the decision becomes
  // eligible to govern runtime attribution.
  const proposed = {
    ...candidate,
    schema_version: LIGHTNING_DECISION_SCHEMA,
    activated_at: new Date(start).toISOString(),
    expires_at: new Date(start + hours * 3600_000).toISOString(),
  };

  const active = resolve(activePath);
  const archive = resolve(archiveDir);
  const validationPath = active + `.validate-${process.pid}-${Date.now()}.json`;
  mkdirSync(dirname(active), { recursive: true });
  mkdirSync(archive, { recursive: true });
  writeFileSync(validationPath, JSON.stringify(proposed, null, 2) + "\n", { mode: 0o600 });

  const validation = readActiveLightningDecision({ filePath: validationPath, now: start });
  if (!validation.ok) {
    // Deliberately leave no active mutation on validation failure. The temporary
    // file is not the configured active pointer and therefore grants nothing.
    throw Object.assign(new Error(`decision activation rejected: ${validation.reason}`), {
      validation,
      validationPath,
    });
  }

  const normalized = validation.decision;
  const hash = validation.decision_sha256;
  const archivePath = resolve(archive, hash.replace(/^sha256:/, "") + ".json");
  const rendered = JSON.stringify({
    ...normalized,
    decision_sha256: hash,
  }, null, 2) + "\n";

  if (dryRun) {
    return {
      status: "VALID_DRY_RUN",
      decision_sha256: hash,
      active_path: active,
      archive_path: archivePath,
      decision: normalized,
    };
  }

  writeFileSync(archivePath, rendered, { mode: 0o600 });
  const activeTemp = active + `.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(activeTemp, rendered, { mode: 0o600 });
  renameSync(activeTemp, active);

  return {
    status: "ACTIVATED",
    decision_sha256: hash,
    active_path: active,
    archive_path: archivePath,
    activated_at: normalized.activated_at,
    expires_at: normalized.expires_at,
    scoped_caps: normalized.scoped_caps,
    source_ref: normalized.source_ref,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.candidate) throw new Error("usage: activate_lightning_decision.mjs --candidate decision.json [--duration-hours 72] [--dry-run]");
  const candidate = JSON.parse(readFileSync(resolve(args.candidate), "utf8"));
  const result = activateLightningDecision({
    candidate,
    activePath: args.active,
    archiveDir: args.archiveDir,
    durationHours: args.durationHours,
    now: activationMs(args.now),
    dryRun: args.dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(error => {
    console.error(JSON.stringify({
      status: "BLOCKED",
      error: error?.message || String(error),
      validation: error?.validation || null,
    }, null, 2));
    process.exit(1);
  });
}
