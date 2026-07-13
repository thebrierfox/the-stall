// security-recon.js
//
// Host network reconnaissance: port scan (nmap) + DNS resolution (dig) + WHOIS.
// Returns open ports, service versions, DNS records, and WHOIS registrar info.
//
// Powered by T3MP3ST arsenal (nmap 7.94SVN + dig + whois).
// Installed 2026-07-08; deployed 2026-07-11 per Kyle directive.
//
// Authorization required: caller must certify ownership/permission.
// Use cases: own-infra security posture, CTF recon, agent infra checks,
// pre-deploy port verification.

import { execFile } from "child_process";
import { promisify } from "util";

const execAsync = promisify(execFile);

// Only hostnames, IPv4, IPv6 — no shell metacharacters ever reach a subprocess.
const TARGET_RE = /^[A-Za-z0-9._:-]+$/;

const NMAP_BIN  = "/usr/bin/nmap";
const DIG_BIN   = "/usr/bin/dig";
const WHOIS_BIN = "/usr/bin/whois";

const SCAN_CONFIGS = {
  quick: {
    portArgs: ["-F"],           // top 100 ports
    timing:   "-T4",
    sV:       false,
    timeout:  45_000,
  },
  standard: {
    portArgs: ["--top-ports", "1000"],
    timing:   "-T3",
    sV:       true,
    timeout:  120_000,
  },
};

function parseNmapPorts(output) {
  const ports = [];
  const re = /^(\d+)\/(tcp|udp)\s+open\s+(\S+)\s*(.*)?$/gm;
  let m;
  while ((m = re.exec(output)) !== null) {
    ports.push({
      port:     parseInt(m[1], 10),
      protocol: m[2],
      service:  m[3],
      version:  (m[4] || "").trim() || null,
    });
  }
  return ports;
}

async function runBin(bin, args, timeout) {
  if (args.some(a => a.includes("\0"))) {
    return { ok: false, out: "", err: "NUL byte in arg" };
  }
  try {
    const { stdout, stderr } = await execAsync(bin, args, {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, out: stdout || stderr };
  } catch (e) {
    return { ok: false, out: e.stdout || "", err: e.message };
  }
}

export default {
  name: "security-recon",
  price: "$0.25",

  description:
    "Host network recon using nmap + DNS (dig) + WHOIS. Returns open ports with service/version, A/AAAA/MX/TXT DNS records, and WHOIS registrar info. authorized=true required — caller certifies they own or have written permission to scan the target. quick scan: top-100 ports / ~10s. standard scan: top-1000 ports + service versions / ~30–60s.",

  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "Hostname or IP address to scan (e.g. 'example.com' or '192.168.1.1').",
      },
      scan_type: {
        type: "string",
        enum: ["quick", "standard"],
        description: "Scan depth. 'quick' = top-100 ports, fast. 'standard' = top-1000 ports + service version detection.",
        default: "quick",
      },
      authorized: {
        type: "string",
        description: "Must be 'true'. By submitting you certify you own this target or have explicit written authorization to perform network reconnaissance against it.",
      },
    },
    required: ["target", "authorized"],
  },

  outputSchema: {
    type: "object",
    properties: {
      target:        { type: "string" },
      scan_type:     { type: "string" },
      open_ports: {
        type: "array",
        items: {
          type: "object",
          properties: {
            port:     { type: "integer" },
            protocol: { type: "string" },
            service:  { type: "string" },
            version:  { type: "string" },
          },
        },
      },
      open_port_count: { type: "integer" },
      dns: {
        type: "object",
        properties: {
          A:    { type: "array", items: { type: "string" } },
          AAAA: { type: "array", items: { type: "string" } },
          MX:   { type: "array", items: { type: "string" } },
          TXT:  { type: "array", items: { type: "string" } },
        },
      },
      whois_registrar: { type: "string" },
      scan_duration_ms: { type: "integer" },
      as_of:           { type: "string" },
    },
  },

  async handler(query) {
    // Authorization gate — must come first.
    if (String(query.authorized || "").trim().toLowerCase() !== "true") {
      const err = new Error(
        "authorized must be 'true'. You must certify you own this target or have explicit written authorization to scan it."
      );
      err.status = 400;
      throw err;
    }

    const target   = String(query.target || "").trim().toLowerCase();
    const scanType = ["quick", "standard"].includes(query.scan_type)
      ? query.scan_type
      : "quick";

    if (!target || !TARGET_RE.test(target)) {
      const err = new Error(
        "Invalid target. Only hostnames and IPv4/IPv6 addresses are accepted (no shell metacharacters)."
      );
      err.status = 400;
      throw err;
    }

    // Block obvious localhost / RFC-1918 scans to avoid infra self-probing.
    const BLOCKED = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
    if (BLOCKED.test(target)) {
      const err = new Error("Private/loopback targets are not permitted.");
      err.status = 400;
      throw err;
    }

    const cfg   = SCAN_CONFIGS[scanType];
    const start = Date.now();

    const nmapArgs = [
      ...cfg.portArgs,
      cfg.timing,
      ...(cfg.sV ? ["-sV"] : []),
      "--open",
      "-oN", "-",   // normal output to stdout
      target,
    ];

    const [nmapRes, digA, digAAAA, digMX, digTXT, whoisRes] = await Promise.all([
      runBin(NMAP_BIN,  nmapArgs, cfg.timeout),
      runBin(DIG_BIN,   ["+short", target, "A"],    8_000),
      runBin(DIG_BIN,   ["+short", target, "AAAA"], 8_000),
      runBin(DIG_BIN,   ["+short", target, "MX"],   8_000),
      runBin(DIG_BIN,   ["+short", target, "TXT"],  8_000),
      runBin(WHOIS_BIN, ["-H", target],              15_000),
    ]);

    const openPorts = parseNmapPorts(nmapRes.out);

    function toLines(out) {
      return out.split("\n").map(l => l.trim()).filter(Boolean);
    }

    // Extract registrar from whois output.
    let registrar = null;
    if (whoisRes.ok) {
      const m = whoisRes.out.match(/Registrar:\s*(.+)/i);
      if (m) registrar = m[1].trim();
    }

    return {
      target,
      scan_type:        scanType,
      open_ports:       openPorts,
      open_port_count:  openPorts.length,
      dns: {
        A:    toLines(digA.out),
        AAAA: toLines(digAAAA.out),
        MX:   toLines(digMX.out),
        TXT:  toLines(digTXT.out),
      },
      whois_registrar:  registrar,
      scan_duration_ms: Date.now() - start,
      as_of:            new Date().toISOString(),
    };
  },
};
