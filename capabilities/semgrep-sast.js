// semgrep-sast.js
//
// SAST security analysis on a public GitHub repository using Semgrep 1.168.0.
// Shallow-clones the repo, runs semgrep with the chosen ruleset (auto /
// security-audit / owasp-top-ten), returns findings with file, line,
// severity, rule ID, and CWE. Up to 100 findings returned; clean repos
// return findings_count=0 and clean=true.
//
// Powered by T3MP3ST (capabilities/t3mpest) — Semgrep installed 2026-07-08.
// Free community rulesets only; no Semgrep Pro auth required.
//
// No direct x402-ecosystem competitor as of 2026-07-10.
// Use cases: pre-PR security gates, supply-chain vetting, OSS audits,
// coordinated-disclosure prep.

import { execFile }    from "child_process";
import { promisify }   from "util";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir }      from "os";
import { join }        from "path";

const execAsync   = promisify(execFile);
const SEMGREP_BIN = "/home/aegis/.local/bin/semgrep";
const GIT_TIMEOUT = 60_000;   // 60 s clone
const SCAN_TIMEOUT = 180_000; // 3 min semgrep

export default {
  name: "semgrep-sast",
  price: "$5.00",

  description:
    "SAST security scan on a public GitHub repo using Semgrep. Returns findings with file, line, severity, rule ID, and CWE. Covers OWASP Top 10, injection, auth flaws, cryptographic misuse, and 1 000+ rules across Python, JS/TS, Go, Java, Ruby, PHP, C/C++. Input: owner/repo. Up to 100 findings; scan takes 20–120 s depending on repo size.",

  inputSchema: {
    type: "object",
    properties: {
      github_repo: {
        type: "string",
        description: "Public GitHub repo in 'owner/repo' format (e.g. 'expressjs/express'). Must be publicly accessible without authentication.",
      },
      ruleset: {
        type: "string",
        enum: ["auto", "security-audit", "owasp-top-ten"],
        description: "Semgrep ruleset. 'auto' (default) applies best-match rules for the detected language stack. 'security-audit' targets common vuln classes. 'owasp-top-ten' focuses on OWASP Top 10.",
        default: "auto",
      },
    },
    required: ["github_repo"],
  },

  outputSchema: {
    type: "object",
    properties: {
      repo:             { type: "string" },
      ruleset:          { type: "string" },
      findings_count:   { type: "integer" },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rule_id:  { type: "string" },
            severity: { type: "string" },
            message:  { type: "string" },
            file:     { type: "string" },
            line:     { type: "integer" },
            cwe:      { type: "string" },
          },
        },
      },
      clean:            { type: "boolean", description: "true when no findings returned" },
      scan_duration_ms: { type: "integer" },
      as_of:            { type: "string" },
    },
  },

  async handler(query) {
    const repoInput = String(query.github_repo || "").trim();
    if (!repoInput || !/^[a-zA-Z0-9_.\-]+\/[a-zA-Z0-9_.\-]+$/.test(repoInput)) {
      throw new Error("github_repo must be in owner/repo format (e.g. expressjs/express)");
    }

    const ruleset  = ["auto", "security-audit", "owasp-top-ten"].includes(query.ruleset)
      ? query.ruleset : "auto";
    const cloneUrl = `https://github.com/${repoInput}.git`;
    const tmpDir   = await mkdtemp(join(tmpdir(), "stall-semgrep-"));
    const repoDir  = join(tmpDir, "repo");
    const startMs  = Date.now();

    try {
      await execAsync("git", [
        "clone", "--depth=1", "--quiet", "--single-branch", cloneUrl, repoDir,
      ], { timeout: GIT_TIMEOUT, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

      const args = ["--json", "--quiet", "--timeout=60", "--max-memory=500"];
      if (ruleset === "security-audit")    args.push("--config=p/security-audit");
      else if (ruleset === "owasp-top-ten") args.push("--config=p/owasp-top-ten");
      else                                 args.push("--config=auto");
      args.push(repoDir);

      let semgrepOut = "";
      try {
        const res = await execAsync(SEMGREP_BIN, args, {
          timeout: SCAN_TIMEOUT, maxBuffer: 10 * 1024 * 1024,
        });
        semgrepOut = res.stdout;
      } catch (e) {
        // exit 1 = findings found — stdout still has JSON
        semgrepOut = e.stdout || "";
      }

      let parsed = null;
      try { parsed = JSON.parse(semgrepOut); } catch (_) {}

      const rawFindings = parsed?.results || [];
      const findings = rawFindings.slice(0, 100).map(f => ({
        rule_id:  f.check_id || "",
        severity: f.extra?.severity || "INFO",
        message:  (f.extra?.message || "").slice(0, 300),
        file:     (f.path || "").replace(repoDir + "/", ""),
        line:     f.start?.line || 0,
        cwe:      (f.extra?.metadata?.cwe || [])[0] || null,
      }));

      return {
        repo:             repoInput,
        ruleset,
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
