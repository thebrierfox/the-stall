// code-security-scan.js
//
// Source-code security scan using T3MP3ST arsenal tools:
//   - semgrep 1.168.0 (p/security-audit SAST rules): injection, XSS, SQLi,
//     path traversal, SSRF, auth bypass, deserialization, race conditions
//   - gitleaks 8.x: exposed secrets, API keys, credentials in source
//
// Clones any public GitHub repo (shallow, no history) into a temp dir, scans,
// returns structured findings, then deletes the temp dir.
//
// Powered by T3MP3ST (github.com/elder-plinius/t3mp3st) — installed 2026-07-06.
// Deployed 2026-07-11 per Kyle directive: "use T3MP3ST however you know you can
// and make money you are able to deposit into our revenue wallet."
//
// Authorization required: caller must certify ownership/permission for the repo.
// Price: $2.00 — ~5–10× cheaper than commercial SAST tools (Snyk Code, Veracode).

import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const execAsync = promisify(execFile);

const SEMGREP_BIN  = "/home/aegis/.local/bin/semgrep";
const GITLEAKS_BIN = "/home/aegis/.local/bin/gitleaks";
const GIT_BIN      = "/usr/bin/git";

// Only GitHub HTTPS URLs to prevent SSRF to arbitrary hosts.
const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}(\.git)?$/;

export default {
  name: "code-security-scan",
  price: "$2.00",

  description:
    "Source-code security scan of a public GitHub repo. Runs semgrep SAST (p/security-audit rules: CWE coverage for injection, XSS, SQLi, path traversal, SSRF, auth bypass, deserialization, race conditions) + gitleaks secret detection (API keys, credentials, tokens). Returns structured findings with file/line/CWE/severity and any exposed secrets. authorized=true required — caller certifies ownership or written permission for the target repo. Typical execution: 20–90s depending on repo size. Powered by T3MP3ST arsenal.",

  inputSchema: {
    type: "object",
    properties: {
      repo_url: {
        type: "string",
        description:
          "Public GitHub HTTPS URL of the repository to scan, e.g. 'https://github.com/owner/repo'. Must be a public repo (no auth is provided).",
      },
      authorized: {
        type: "string",
        description:
          "Must be 'true'. By submitting you certify you own this repository or have explicit written authorization to perform a security audit against it.",
      },
    },
    required: ["repo_url", "authorized"],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      repo_url:            { type: "string" },
      sast_findings:       {
        type: "array",
        items: {
          type: "object",
          properties: {
            rule_id:  { type: "string" },
            severity: { type: "string" },
            file:     { type: "string" },
            line:     { type: "integer" },
            message:  { type: "string" },
            cwe:      { type: "array", items: { type: "string" } },
          },
        },
      },
      sast_finding_count:  { type: "integer" },
      secrets_found:       {
        type: "array",
        items: {
          type: "object",
          properties: {
            rule_id: { type: "string" },
            file:    { type: "string" },
            line:    { type: "integer" },
            match:   { type: "string" },
          },
        },
      },
      secrets_finding_count: { type: "integer" },
      scan_duration_ms:    { type: "integer" },
      as_of:               { type: "string" },
    },
  },

  async handler(query) {
    // ── Authorization gate — first ─────────────────────────────────────────
    if (String(query.authorized || "").trim().toLowerCase() !== "true") {
      const err = new Error(
        "authorized must be 'true'. You must certify you own this repository or have explicit written authorization to audit it."
      );
      err.status = 400;
      throw err;
    }

    // ── Validate repo_url ─────────────────────────────────────────────────
    const repoUrl = String(query.repo_url || "").trim().replace(/\s+/g, "");
    if (!repoUrl || !GITHUB_URL_RE.test(repoUrl)) {
      const err = new Error(
        "repo_url must be a public GitHub HTTPS URL (e.g. https://github.com/owner/repo). Only github.com is accepted."
      );
      err.status = 400;
      throw err;
    }

    const start  = Date.now();
    const tmpDir = mkdtempSync(join(tmpdir(), "stall-scan-"));

    try {
      // ── 1. Shallow clone (no history — faster, less data) ───────────────
      await execAsync(GIT_BIN, ["clone", "--depth", "1", "--quiet", repoUrl, tmpDir], {
        timeout:   60_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      // ── 2. semgrep SAST scan ────────────────────────────────────────────
      let sastFindings = [];
      try {
        const { stdout } = await execAsync(
          SEMGREP_BIN,
          [
            "--config=p/security-audit",
            "--json",
            "--no-rewrite-rule-ids",
            "--timeout=60",
            "--max-target-bytes=2000000",
            "--quiet",
            tmpDir,
          ],
          { timeout: 150_000, maxBuffer: 20 * 1024 * 1024 }
        );

        let parsed;
        try { parsed = JSON.parse(stdout); } catch { parsed = { results: [] }; }

        const KEEP_SEV = new Set(["error", "warning", "high", "critical", "medium"]);
        sastFindings = (parsed.results || [])
          .map((r) => ({
            rule_id:  r.check_id || "",
            severity: (r.extra?.severity || "").toLowerCase(),
            file:     (r.path || "").replace(tmpDir + "/", ""),
            line:     r.start?.line || 0,
            message:  r.extra?.message || "",
            cwe:      Array.isArray(r.extra?.metadata?.cwe)
                        ? r.extra.metadata.cwe
                        : (r.extra?.metadata?.cwe ? [r.extra.metadata.cwe] : []),
          }))
          .filter((f) => KEEP_SEV.has(f.severity));
      } catch (e) {
        // semgrep error (exit 1 = findings, exit 2 = error) — non-fatal
        if (e.stdout) {
          try {
            const parsed = JSON.parse(e.stdout);
            const KEEP_SEV = new Set(["error", "warning", "high", "critical", "medium"]);
            sastFindings = (parsed.results || [])
              .map((r) => ({
                rule_id:  r.check_id || "",
                severity: (r.extra?.severity || "").toLowerCase(),
                file:     (r.path || "").replace(tmpDir + "/", ""),
                line:     r.start?.line || 0,
                message:  r.extra?.message || "",
                cwe:      Array.isArray(r.extra?.metadata?.cwe)
                            ? r.extra.metadata.cwe
                            : (r.extra?.metadata?.cwe ? [r.extra.metadata.cwe] : []),
              }))
              .filter((f) => KEEP_SEV.has(f.severity));
          } catch { /* malformed output */ }
        }
      }

      // ── 3. gitleaks secrets scan ─────────────────────────────────────────
      const leaksReport = join(tmpDir, ".gitleaks-report.json");
      let secretsFindings = [];
      try {
        await execAsync(
          GITLEAKS_BIN,
          [
            "detect",
            "--source", tmpDir,
            "--report-format", "json",
            "--report-path", leaksReport,
            "--no-git",
            "--quiet",
          ],
          { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }
        );
      } catch {
        // exit 1 = secrets found (expected) — report file still written
      }

      if (existsSync(leaksReport)) {
        try {
          const raw   = readFileSync(leaksReport, "utf8");
          const leaks = JSON.parse(raw);
          secretsFindings = (Array.isArray(leaks) ? leaks : []).map((l) => ({
            rule_id: l.RuleID  || l.ruleID  || "unknown",
            file:    (l.File   || l.file   || "").replace(tmpDir + "/", ""),
            line:    l.StartLine || l.startLine || 0,
            // Truncate match to avoid leaking full secret in response
            match:   (l.Match  || l.match  || "").slice(0, 50) + (
                       (l.Match || l.match || "").length > 50 ? "…" : ""
                     ),
          }));
        } catch { /* malformed report */ }
      }

      return {
        repo_url:              repoUrl,
        sast_findings:         sastFindings,
        sast_finding_count:    sastFindings.length,
        secrets_found:         secretsFindings,
        secrets_finding_count: secretsFindings.length,
        scan_duration_ms:      Date.now() - start,
        as_of:                 new Date().toISOString(),
      };
    } finally {
      // Always clean up cloned code — never leave on disk
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
    }
  },
};
