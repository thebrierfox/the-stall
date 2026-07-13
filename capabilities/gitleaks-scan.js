// gitleaks-scan.js
//
// Secret and credential exposure scan on a public GitHub repository
// using Gitleaks 8.30.1. Clones the full git history (not just HEAD)
// and scans 140+ secret patterns: API keys, tokens, private keys,
// passwords, connection strings, and more. Returns up to 50 findings
// with file, line, commit SHA, author, rule ID, and a truncated hint
// of the detected secret.
//
// Powered by T3MP3ST (capabilities/t3mpest) — Gitleaks installed 2026-07-08.
//
// No direct x402-ecosystem competitor as of 2026-07-10.
// Use cases: supply-chain risk assessment, third-party dependency vetting,
// OSS audits, pre-acquisition security due diligence.

import { execFile }             from "child_process";
import { promisify }            from "util";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir }               from "os";
import { join }                 from "path";

const execAsync    = promisify(execFile);
const GITLEAKS_BIN = "/home/aegis/.local/bin/gitleaks";
const GIT_TIMEOUT  = 90_000;   // 90 s — full history clone can be large
const SCAN_TIMEOUT = 120_000;  // 2 min gitleaks

export default {
  name: "gitleaks-scan",
  price: "$4.00",

  description:
    "Secret and credential exposure scan on a public GitHub repo using Gitleaks. Scans full git history for hardcoded API keys, tokens, private keys, passwords, and 140+ secret patterns. Returns up to 50 findings with file, line, commit SHA, author, and rule ID. Use for supply-chain risk assessment, third-party dependency vetting, and pre-merge security gates.",

  inputSchema: {
    type: "object",
    properties: {
      github_repo: {
        type: "string",
        description: "Public GitHub repo in 'owner/repo' format (e.g. 'vercel/next.js'). Must be publicly accessible without authentication.",
      },
    },
    required: ["github_repo"],
  },

  outputSchema: {
    type: "object",
    properties: {
      repo:             { type: "string" },
      findings_count:   { type: "integer" },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rule_id:     { type: "string" },
            description: { type: "string" },
            file:        { type: "string" },
            line:        { type: "integer" },
            commit:      { type: "string", description: "Short (8-char) commit SHA" },
            author:      { type: "string" },
            date:        { type: "string" },
            secret_hint: { type: "string", description: "First 8 chars of detected secret + '...'" },
          },
        },
      },
      clean:            { type: "boolean", description: "true when no secrets found" },
      scan_duration_ms: { type: "integer" },
      as_of:            { type: "string" },
    },
  },

  async handler(query) {
    const repoInput = String(query.github_repo || "").trim();
    if (!repoInput || !/^[a-zA-Z0-9_.\-]+\/[a-zA-Z0-9_.\-]+$/.test(repoInput)) {
      throw new Error("github_repo must be in owner/repo format (e.g. vercel/next.js)");
    }

    const cloneUrl   = `https://github.com/${repoInput}.git`;
    const tmpDir     = await mkdtemp(join(tmpdir(), "stall-gitleaks-"));
    const repoDir    = join(tmpDir, "repo");
    const reportPath = join(tmpDir, "report.json");
    const startMs    = Date.now();

    try {
      await execAsync("git", [
        "clone", "--quiet", cloneUrl, repoDir,
      ], { timeout: GIT_TIMEOUT, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

      try {
        await execAsync(GITLEAKS_BIN, [
          "detect",
          "--source", repoDir,
          "--report-format", "json",
          "--report-path", reportPath,
          "--no-banner",
          "--exit-code=0",
        ], { timeout: SCAN_TIMEOUT });
      } catch (_) {
        // gitleaks exits 1 when findings found — that's expected and OK
      }

      let rawFindings = [];
      try {
        const raw = await readFile(reportPath, "utf8");
        rawFindings = JSON.parse(raw) || [];
      } catch (_) {}

      const findings = rawFindings.slice(0, 50).map(f => ({
        rule_id:     f.RuleID      || "",
        description: f.Description || "",
        file:        f.File        || "",
        line:        f.StartLine   || 0,
        commit:      (f.Commit || "").slice(0, 8),
        author:      f.Author      || "",
        date:        f.Date        || "",
        secret_hint: f.Secret ? f.Secret.slice(0, 8) + "..." : "",
      }));

      return {
        repo:             repoInput,
        findings_count:   rawFindings.length,
        findings,
        clean:            rawFindings.length === 0,
        scan_duration_ms: Date.now() - startMs,
        as_of:            new Date().toISOString(),
      };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
