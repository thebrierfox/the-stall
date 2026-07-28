#!/usr/bin/env node
import { cpSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const repo = process.cwd();
const latestFile = join(repo, ".stall-floodgate-backup", "LATEST");
if (!existsSync(latestFile)) {
  console.error("ROLLBACK_ABORTED: no .stall-floodgate-backup/LATEST found");
  process.exit(1);
}
const backup = readFileSync(latestFile, "utf8").trim();
for (const rel of ["package.json", "src/mcp.js", "src/server.js"]) {
  const source = join(backup, rel);
  if (existsSync(source)) cpSync(source, join(repo, rel));
}
const priorLock = join(backup, "package-lock.json");
if (existsSync(priorLock)) cpSync(priorLock, join(repo, "package-lock.json"));
else rmSync(join(repo, "package-lock.json"), { force: true });
const priorPaymentFile = join(backup, "src", "mcp-payment.js");
if (existsSync(priorPaymentFile)) cpSync(priorPaymentFile, join(repo, "src", "mcp-payment.js"));
else rmSync(join(repo, "src", "mcp-payment.js"), { force: true });

if (!process.argv.includes("--no-install")) {
  const install = spawnSync("npm", ["install", "--legacy-peer-deps"], { cwd: repo, stdio: "inherit" });
  if (install.status !== 0) process.exit(install.status || 1);
}
console.log(JSON.stringify({ status: "ROLLED_BACK", backup }, null, 2));
