#!/usr/bin/env node
// Run from the-stall repository root after applying the patch and before activation.
import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";

const failures = [];
const checks = [];
function check(ok, label) {
  checks.push({ ok: Boolean(ok), label });
  if (!ok) failures.push(label);
}

let pkg = {};
try { pkg = JSON.parse(readFileSync("package.json", "utf8")); } catch {}
check(pkg.name === "the-stall", "running from the-stall repository root");
check(pkg.dependencies?.["@x402/mcp"] === "2.19.0", "@x402/mcp pinned to 2.19.0");
check(existsSync(join("src", "mcp-payment.js")), "src/mcp-payment.js installed");
check(readFileSync(join("src", "mcp.js"), "utf8").includes("controller.wrap(cap, baseHandler)"), "MCP handlers use payment wrapper");
check(readFileSync(join("src", "server.js"), "utf8").includes("readMcpPaymentStats"), "server telemetry wiring installed");

for (const file of ["src/mcp-payment.js", "src/mcp.js", "src/server.js"]) {
  const run = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  check(run.status === 0, `syntax valid: ${file}`);
}

const mode = String(process.env.MCP_PAYMENT_MODE || "off").toLowerCase();
check(["off", "canary", "all"].includes(mode), "MCP_PAYMENT_MODE is off, canary, or all");
if (mode !== "off") {
  check(process.env.MCP_PAYMENT_AUTHORIZED === "D92_LIFTED", "activation authorization sentinel present");
  check(/^0x[a-fA-F0-9]{40}$/.test(process.env.WALLET_ADDRESS || ""), "valid WALLET_ADDRESS present");
  check(Boolean(process.env.FACILITATOR_URL), "FACILITATOR_URL present");
}
if (mode === "all") {
  const free = new Set(String(process.env.MCP_FREE_TOOLS || "ping").split(",").map(v => v.trim()).filter(Boolean));
  check(free.has("ping"), "ping remains free");
}

console.log(JSON.stringify({
  status: failures.length ? "BLOCKED" : "READY",
  mode,
  checks,
  failures,
}, null, 2));
process.exit(failures.length ? 1 : 0);
