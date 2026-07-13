// npm-trends.js
//
// Compare npm package download trends over time.
// Returns weekly download counts for up to 5 packages across the last
// day, last-week, last-month, or last-year.
//
// Seam: developer/AI agents evaluating tech stack choices — "Is express
//       still gaining vs fastify?" "Is react-query declining vs tanstack?"
//       npm-lookup gives metadata per package; npm-trends gives the market signal.
//
// Upstream: api.npmjs.org/downloads — public, no auth, high rate limits.
// Price: $0.020 — cheap comparison utility for dev agents.

const NPM_DL = "https://api.npmjs.org/downloads";
const UA     = "Mozilla/5.0 (compatible; the-stall/3.93; +https://intuitek.ai)";
const TMO    = 12_000;

async function getDownloads(period, packages) {
  const results = {};
  await Promise.all(
    packages.map(async pkg => {
      const url = `${NPM_DL}/range/${period}/${encodeURIComponent(pkg)}`;
      try {
        const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TMO) });
        if (!r.ok) { results[pkg] = { error: `HTTP ${r.status}` }; return; }
        const d = await r.json();
        if (d.error) { results[pkg] = { error: d.error }; return; }
        const downloads = (d.downloads || []).map(w => ({ date: w.day, count: w.downloads }));
        const total = downloads.reduce((s, w) => s + w.count, 0);
        // Compute last-7d vs prev-7d trend if enough data
        let trend_pct = null;
        if (downloads.length >= 14) {
          const recent = downloads.slice(-7).reduce((s, w) => s + w.count, 0);
          const prev   = downloads.slice(-14, -7).reduce((s, w) => s + w.count, 0);
          trend_pct = prev > 0 ? Math.round(((recent - prev) / prev) * 1000) / 10 : null;
        }
        results[pkg] = { total, trend_pct, weekly: downloads };
      } catch (e) {
        results[pkg] = { error: e.message.slice(0, 80) };
      }
    })
  );
  return results;
}

export default {
  name:  "npm-trends",
  price: "$0.021",

  description:
    "Compare npm package download trends for up to 5 packages. Returns total downloads and week-over-week trend for the requested period (last-week, last-month, last-year). Useful for evaluating package adoption before adding a dependency, comparing competing libraries (express vs fastify, react-query vs tanstack-query), or tracking whether a package is growing or declining. Free upstream: api.npmjs.org (no key required).",

  inputSchema: {
    type: "object",
    required: [],
    properties: {
      packages: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 5,
        description: "npm package names to compare. e.g. ['express','fastify','hono']. Scoped packages like '@anthropic-ai/sdk' are supported.",
      },
      period: {
        type: "string",
        enum: ["last-day", "last-week", "last-month", "last-year"],
        description: "Download period to retrieve. 'last-month' gives 30 daily data points; 'last-year' gives 365. Defaults to last-month.",
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      period: { type: "string", description: "Period queried." },
      packages: {
        type: "object",
        description: "Keyed by package name.",
        additionalProperties: {
          type: "object",
          properties: {
            total:     { type: ["integer", "null"], description: "Total downloads in period." },
            trend_pct: { type: ["number", "null"],  description: "% change last-7d vs prev-7d (null if insufficient data)." },
            weekly:    { type: "array", items: { type: "object", properties: { date: { type: "string" }, count: { type: "integer" } } }, description: "Daily download counts." },
            error:     { type: ["string", "null"], description: "Error message if this package failed." },
          },
        },
      },
      ts: { type: "string", description: "ISO-8601 response timestamp." },
    },
  },

  async handler(query) {
    const packages = query.packages?.length ? query.packages.slice(0, 5) : ["express", "fastify", "hono"];
    const period   = query.period || "last-month";
    const data     = await getDownloads(period, packages);
    return { period, packages: data, ts: new Date().toISOString() };
  },
};
