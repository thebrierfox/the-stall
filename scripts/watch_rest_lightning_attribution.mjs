#!/usr/bin/env node
// watch_rest_lightning_attribution.mjs
//
// Additive verifier for STALL's existing REST/x402 settlement log. It does not
// touch payment execution, pricing, or customer responses. A settlement is
// credited to Lightning only when the immutable decision artifact was valid at
// the settlement timestamp, the paid cap is in scope, the observed price exactly
// matches the decision's runtime assertion, the payer is not a configured self
// wallet, a transaction hash exists, and the settlement has not already been
// attributed.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, watchFile, unwatchFile } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJson,
  lightningAttributionFor,
  parseUsd,
} from "../src/lightning-attribution.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REST_LOG = resolve(__dir, "..", "logs", "settlement.jsonl");
const DEFAULT_OUTPUT_LOG = resolve(__dir, "..", "logs", "lightning_rest_attribution.jsonl");

function csvSet(value) {
  return new Set(String(value || "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean));
}

export function configuredSelfWallets(env = process.env) {
  return new Set([
    ...csvSet(env.MCP_SELF_WALLETS),
    ...csvSet(env.SEEDER_WALLET_ADDRESS),
    ...csvSet(env.WALLET_ADDRESS),
  ]);
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export function settlementAttributionKey({ transaction, cap, decision_sha256 }) {
  if (!transaction || !cap || !decision_sha256) throw new Error("transaction, cap, and decision_sha256 required");
  const body = canonicalJson({
    transaction: String(transaction).toLowerCase(),
    cap: String(cap),
    decision_sha256: String(decision_sha256),
  });
  return "sha256:" + createHash("sha256").update(body).digest("hex");
}

export function classifyRestSettlement(row, {
  selfWallets = configuredSelfWallets(),
  decisionFile,
} = {}) {
  if (!row || typeof row !== "object") return { eligible: false, reason: "ROW_INVALID" };
  if (Number(row.status) < 200 || Number(row.status) >= 300) return { eligible: false, reason: "REST_STATUS_NOT_SUCCESS" };
  const transaction = String(row.tx_hash || "").trim();
  if (!transaction) return { eligible: false, reason: "SETTLEMENT_TX_REQUIRED" };
  const payer = String(row.payer || "").trim().toLowerCase();
  if (!payer) return { eligible: false, reason: "PAYER_REQUIRED" };
  if (selfWallets.has(payer)) return { eligible: false, reason: "SELF_CONTROLLED_PAYER" };
  const cap = String(row.cap || "").replace(/^\/cap\//, "").trim();
  if (!cap) return { eligible: false, reason: "CAP_REQUIRED" };
  const priceUsd = parseUsd(row.price);
  if (priceUsd === null || priceUsd <= 0) return { eligible: false, reason: "POSITIVE_PRICE_REQUIRED" };
  const settlementMs = Date.parse(String(row.ts || ""));
  if (!Number.isFinite(settlementMs)) return { eligible: false, reason: "SETTLEMENT_TIMESTAMP_INVALID" };

  const attribution = lightningAttributionFor(
    cap,
    { price_usd: priceUsd },
    { filePath: decisionFile, now: settlementMs },
  );
  if (attribution.eligible !== true) {
    return { eligible: false, reason: "LIGHTNING_ATTRIBUTION_UNVERIFIED", lightning_attribution: attribution };
  }

  const key = settlementAttributionKey({
    transaction,
    cap,
    decision_sha256: attribution.decision_sha256,
  });
  return {
    eligible: true,
    reason: "EXTERNAL_SETTLEMENT_CAUSALLY_ATTRIBUTABLE",
    settlement_attribution_key: key,
    settlement_id: transaction,
    transaction,
    cap,
    price_usd: priceUsd,
    payer,
    settled_at: new Date(settlementMs).toISOString(),
    lightning_attribution: attribution,
  };
}

export function scanRestSettlements({
  restLog = process.env.STALL_SETTLEMENT_LOG || DEFAULT_REST_LOG,
  outputLog = process.env.LIGHTNING_REST_ATTRIBUTION_LOG || DEFAULT_OUTPUT_LOG,
  decisionFile = process.env.LIGHTNING_DECISION_FILE,
  selfWallets = configuredSelfWallets(),
  write = true,
} = {}) {
  const rows = readJsonl(resolve(restLog));
  const existing = readJsonl(resolve(outputLog));
  const seen = new Set(existing.map(r => r?.settlement_attribution_key).filter(Boolean));
  const attributed = [];
  const rejected = {};

  for (const row of rows) {
    const verdict = classifyRestSettlement(row, { selfWallets, decisionFile });
    if (!verdict.eligible) {
      rejected[verdict.reason] = (rejected[verdict.reason] || 0) + 1;
      continue;
    }
    if (seen.has(verdict.settlement_attribution_key)) {
      rejected.ALREADY_ATTRIBUTED = (rejected.ALREADY_ATTRIBUTED || 0) + 1;
      continue;
    }
    const record = {
      schema_version: "stall.lightning-rest-settlement/1.0",
      recorded_at: new Date().toISOString(),
      ...verdict,
    };
    if (write) appendFileSync(resolve(outputLog), JSON.stringify(record) + "\n");
    seen.add(verdict.settlement_attribution_key);
    attributed.push(record);
  }

  return {
    schema_version: "stall.lightning-rest-scan/1.0",
    settlement_rows_scanned: rows.length,
    newly_attributed: attributed.length,
    attributed,
    rejected,
    output_log: resolve(outputLog),
  };
}

function cliArgs(argv) {
  const out = { watch: false, intervalMs: 5000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--watch") out.watch = true;
    else if (argv[i] === "--interval-ms") out.intervalMs = Math.max(1000, Number(argv[++i] || 5000));
    else if (argv[i] === "--no-write") out.write = false;
  }
  return out;
}

function printSummary(result) {
  console.log(JSON.stringify({
    schema_version: result.schema_version,
    settlement_rows_scanned: result.settlement_rows_scanned,
    newly_attributed: result.newly_attributed,
    settlement_attribution_keys: result.attributed.map(r => r.settlement_attribution_key),
    rejected: result.rejected,
    output_log: result.output_log,
  }, null, 2));
}

async function main() {
  const args = cliArgs(process.argv.slice(2));
  const run = () => printSummary(scanRestSettlements({ write: args.write !== false }));
  run();
  if (!args.watch) return;
  const restLog = resolve(process.env.STALL_SETTLEMENT_LOG || DEFAULT_REST_LOG);
  let pending = false;
  watchFile(restLog, { interval: args.intervalMs }, () => {
    if (pending) return;
    pending = true;
    try { run(); } finally { pending = false; }
  });
  const stop = () => { unwatchFile(restLog); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(error => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
