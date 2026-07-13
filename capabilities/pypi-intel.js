// pypi-intel.js
//
// Python package intelligence from the PyPI public API and pypistats.org.
// No API key required. Covers package metadata, download velocity, and
// full version history — everything an agent needs to evaluate a Python
// library before adopting it.
//
// Actions:
//   package_info    — metadata: author, license, classifiers, deps, project URLs
//   download_stats  — last day/week/month download counts (pypistats.org)
//   version_history — all published versions with upload dates, newest first
//   compare         — package_info + download_stats for up to 4 packages side-by-side
//
// Use cases:
//   - Evaluate library maturity and maintenance health before adopting
//   - Check whether a popular package has recent security vulnerabilities
//   - Compare competing libraries by download velocity (e.g. aiohttp vs httpx)
//   - Trace transitive dependencies before committing to a package
//   - Agents building Python tooling deciding which ML framework to use
//
// Upstreams: pypi.org/pypi/<pkg>/json (free, no auth) + pypistats.org/api/ (free, no auth)
// Price: $0.008/call.

const PYPI_BASE  = "https://pypi.org/pypi";
const STATS_BASE = "https://pypistats.org/api/packages";
const UA         = "Mozilla/5.0 (compatible; the-stall/4.67; +https://intuitek.ai)";
const TIMEOUT    = 12_000;

async function pypiGet(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`PyPI API ${resp.status} for ${url}: ${body.slice(0, 120)}`);
  }
  return resp.json();
}

function normalize(name) {
  // PyPI canonical name: lowercase, replace runs of [-_.] with single -
  return name.toLowerCase().replace(/[-_.]+/g, "-").trim();
}

function summarizeInfo(data) {
  const i = data.info;
  const vulns = (data.vulnerabilities ?? []).map(v => ({
    id:       v.id,
    aliases:  v.aliases?.slice(0, 3),
    details:  (v.details ?? "").slice(0, 200),
    fixed_in: v.fixed_in ?? [],
  }));

  // Sort releases by upload_time to find the true latest N
  const releases = data.releases ?? {};
  const relList = [];
  for (const [ver, files] of Object.entries(releases)) {
    const latest_upload = files
      .map(f => f.upload_time ?? "")
      .sort()
      .pop();
    if (latest_upload) relList.push({ version: ver, released: latest_upload });
  }
  relList.sort((a, b) => b.released.localeCompare(a.released));
  const recent_versions = relList.slice(0, 5).map(r => ({
    version:  r.version,
    released: r.released.slice(0, 10),
  }));

  // Extract dev-status classifier
  const dev_status = (i.classifiers ?? [])
    .find(c => c.startsWith("Development Status"))?.split(" :: ")[2] ?? null;

  // Python version requirement classifiers
  const py_versions = (i.classifiers ?? [])
    .filter(c => c.startsWith("Programming Language :: Python :: "))
    .map(c => c.split(":: ").pop())
    .filter(v => /^\d/.test(v))
    .slice(0, 8);

  return {
    name:           i.name,
    version:        i.version,
    summary:        (i.summary ?? "").slice(0, 300).trim(),
    author:         i.author ?? i.author_email ?? null,
    license:        i.license ?? null,
    dev_status,
    python_versions: py_versions,
    home_page:      i.home_page ?? null,
    project_urls:   i.project_urls ?? {},
    requires_python: i.requires_python ?? null,
    dependencies:   (i.requires_dist ?? []).filter(d => !d.includes("; extra ==")).slice(0, 20),
    pypi_url:       `https://pypi.org/project/${i.name}/`,
    recent_versions,
    vulnerabilities: vulns,
    total_releases:  relList.length,
  };
}

async function packageInfo({ package: pkg }) {
  if (!pkg) throw new Error("'package' parameter is required");
  const canon = normalize(pkg);
  const data  = await pypiGet(`${PYPI_BASE}/${canon}/json`);
  return {
    action: "package_info",
    ...summarizeInfo(data),
  };
}

async function downloadStats({ package: pkg }) {
  if (!pkg) throw new Error("'package' parameter is required");
  const canon = normalize(pkg);
  const data  = await pypiGet(`${STATS_BASE}/${canon}/recent`);
  const d     = data.data ?? {};
  return {
    action:       "download_stats",
    package:      data.package ?? canon,
    last_day:     d.last_day    ?? null,
    last_week:    d.last_week   ?? null,
    last_month:   d.last_month  ?? null,
    source:       "pypistats.org (counts pip installs from PyPI CDN)",
    note:         "Counts may undercount docker/CI pulls that use cached layers.",
  };
}

async function versionHistory({ package: pkg, limit }) {
  if (!pkg) throw new Error("'package' parameter is required");
  const canon = normalize(pkg);
  const data  = await pypiGet(`${PYPI_BASE}/${canon}/json`);
  const releases = data.releases ?? {};
  const relList  = [];
  for (const [ver, files] of Object.entries(releases)) {
    const latest_upload = files
      .map(f => f.upload_time ?? "")
      .sort()
      .pop();
    if (latest_upload) relList.push({ version: ver, released: latest_upload.slice(0, 10) });
  }
  relList.sort((a, b) => b.released.localeCompare(a.released));
  const cap = Math.min(limit ?? 20, 50);
  return {
    action:           "version_history",
    package:          data.info.name,
    total_releases:   relList.length,
    latest_version:   data.info.version,
    versions:         relList.slice(0, cap),
    note:             `Showing newest ${cap} of ${relList.length} total releases.`,
  };
}

async function compare({ packages, include_downloads }) {
  if (!Array.isArray(packages) || packages.length < 2) {
    throw new Error("'packages' must be an array of 2–4 package names");
  }
  const pkgs = packages.slice(0, 4);
  const results = await Promise.allSettled(
    pkgs.map(async (name) => {
      const canon = normalize(name);
      const [info, stats] = await Promise.allSettled([
        pypiGet(`${PYPI_BASE}/${canon}/json`),
        include_downloads !== false
          ? pypiGet(`${STATS_BASE}/${canon}/recent`)
          : Promise.resolve(null),
      ]);
      if (info.status === "rejected") throw info.reason;
      const infoData  = summarizeInfo(info.value);
      const statsData = stats.status === "fulfilled" && stats.value?.data
        ? { last_day: stats.value.data.last_day, last_week: stats.value.data.last_week, last_month: stats.value.data.last_month }
        : null;
      return { package: infoData.name, info: infoData, downloads: statsData };
    })
  );

  const comparison = results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { package: pkgs[i], error: r.reason?.message ?? "fetch failed" }
  );

  return {
    action:     "compare",
    count:      comparison.length,
    comparison,
    note:       "Compare license, dev_status, dependencies, and download velocity to choose the right library.",
  };
}

export default {
  name:  "pypi-intel",
  price: "$0.021",

  description:
    "Python package intelligence from PyPI and pypistats.org. Returns metadata (author, license, dev status, dependencies, Python version support), download velocity (last day/week/month), version history, and known vulnerabilities. Compare up to 4 packages side-by-side. Use to evaluate library maturity, check maintenance health, compare competing frameworks, or trace transitive dependencies before adopting a package.",

  inputSchema: {
    type: "object",
    required: [],
    properties: {
      action: {
        type: "string",
        enum: ["package_info", "download_stats", "version_history", "compare"],
        description:
          "Action to perform. " +
          "'package_info': full metadata for one package (license, deps, dev status, vulnerabilities). " +
          "'download_stats': last day/week/month pip download counts. " +
          "'version_history': all published versions with release dates, newest first. " +
          "'compare': package_info + download_stats for 2–4 packages side-by-side. " +
          "Default: 'package_info'.",
      },
      package: {
        type: "string",
        description:
          "PyPI package name (case-insensitive). Required for package_info, download_stats, and version_history. " +
          "Examples: 'requests', 'numpy', 'langchain', 'fastapi', 'pydantic'.",
      },
      packages: {
        type: "array",
        items: { type: "string" },
        description:
          "List of 2–4 package names for the 'compare' action. " +
          "Example: ['aiohttp', 'httpx', 'requests'] to compare HTTP client libraries.",
      },
      limit: {
        type: "number",
        description: "Max versions to return in version_history (default 20, max 50).",
      },
      include_downloads: {
        type: "boolean",
        description:
          "Whether to include download stats in 'compare' action (default true). " +
          "Set false to skip the pypistats.org call and get faster metadata-only comparison.",
      },
    },
  },

  outputSchema: {
    type: "object",
    properties: {
      action:  { type: "string", description: "Action that was performed." },
      name:    { type: "string", description: "Canonical PyPI package name." },
      version: { type: "string", description: "Latest published version." },
      summary: { type: "string", description: "One-sentence package description." },
      author:  { type: ["string","null"], description: "Package author or maintainer name." },
      license: { type: ["string","null"], description: "SPDX license identifier (e.g. 'MIT', 'Apache-2.0')." },
      dev_status: {
        type: ["string","null"],
        description: "PyPI development status (e.g. '5 - Production/Stable', '4 - Beta').",
      },
      python_versions: { type: "array", description: "Supported Python versions from classifiers." },
      requires_python: { type: ["string","null"], description: "Python version constraint (e.g. '>=3.8')." },
      dependencies: {
        type: "array",
        description: "Direct dependencies (requires_dist, optional deps excluded), up to 20.",
      },
      project_urls: {
        type: "object",
        description: "Project URLs: Documentation, Source, Changelog, etc.",
      },
      pypi_url: { type: "string", description: "Direct link to PyPI package page." },
      recent_versions: {
        type: "array",
        description: "5 most recently published versions with release dates.",
        items: {
          type: "object",
          properties: {
            version:  { type: "string" },
            released: { type: "string", description: "Release date YYYY-MM-DD." },
          },
        },
      },
      vulnerabilities: {
        type: "array",
        description: "Known security vulnerabilities from PyPI advisory database.",
        items: {
          type: "object",
          properties: {
            id:       { type: "string" },
            details:  { type: "string" },
            fixed_in: { type: "array" },
          },
        },
      },
      total_releases: { type: "number", description: "Total number of published versions." },
      last_day:       { type: ["number","null"], description: "Downloads in last 24 hours." },
      last_week:      { type: ["number","null"], description: "Downloads in last 7 days." },
      last_month:     { type: ["number","null"], description: "Downloads in last 30 days." },
      versions: {
        type: "array",
        description: "Paginated version list for version_history action.",
        items: {
          type: "object",
          properties: {
            version:  { type: "string" },
            released: { type: "string" },
          },
        },
      },
      comparison: {
        type: "array",
        description: "Per-package results for compare action.",
      },
    },
  },

  async handler({ action = "package_info", package: pkg, packages, limit, include_downloads }) {
    switch (action) {
      case "package_info":    return packageInfo({ package: pkg });
      case "download_stats":  return downloadStats({ package: pkg });
      case "version_history": return versionHistory({ package: pkg, limit });
      case "compare":         return compare({ packages: packages ?? (pkg ? [pkg] : []), include_downloads });
      default:
        throw new Error(
          `Unknown action: "${action}". Valid: package_info, download_stats, version_history, compare`
        );
    }
  },
};
