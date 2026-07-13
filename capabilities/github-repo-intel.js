// github-repo-intel.js
//
// GitHub repository intelligence: stars, forks, open issues, language,
// license, last push, latest release, topics, and contributor count.
// Uses GitHub public API (free, no auth required, 60 req/hr anon).
//
// Useful for agents that need to evaluate a repo before:
//   - Pulling it as a dependency
//   - Citing it in research
//   - Deciding whether to fork vs build from scratch
//   - Identifying maintainer activity

const GH_API    = "https://api.github.com";
const UA         = "Mozilla/5.0 (compatible; the-stall/1.9; +https://intuitek.ai)";
const TIMEOUT_MS = 10000;
const GH_TOKEN   = process.env.GITHUB_TOKEN;

function parseRepo(input) {
  // Accept: "owner/repo" or full GitHub URL
  const clean = input.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/$/, "");
  const parts = clean.split("/");
  if (parts.length < 2) throw new Error(`Invalid repo: "${input}". Use format "owner/repo" or full GitHub URL.`);
  return { owner: parts[0], repo: parts[1] };
}

async function fetchJson(url) {
  const headers = { "User-Agent": UA, Accept: "application/vnd.github+json" };
  if (GH_TOKEN) headers["Authorization"] = `Bearer ${GH_TOKEN}`;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (resp.status === 404) throw new Error(`Repository not found: ${url}`);
  if (resp.status === 403) throw new Error(`GitHub rate limit reached. Retry in ~1 hour.`);
  if (!resp.ok) throw new Error(`GitHub API HTTP ${resp.status}`);
  return resp.json();
}

export default {
  name:  "github-repo-intel",
  price: "$0.075",

  description:
    "GitHub repository intelligence: stars, forks, open issues, language, license, last push date, latest release version and date, topics, and whether the repo is actively maintained. Input any GitHub repo as 'owner/repo' or a full GitHub URL. Use before wiring a new library as a dependency, when evaluating a project for acquisition or integration, or when you need to assess community health (stars/forks ratio, issue velocity, maintainer recency). Entity-parametric — one repo per call, parallel-safe for batch repo evaluation pipelines. Free upstream: GitHub public API (no key needed, 60 req/hr unauthenticated).",

  inputSchema: {
    type: "object",
    required: [],
    properties: {
      repo: {
        type: "string",
        description: "GitHub repo in 'owner/repo' format, or a full GitHub URL (e.g. 'torvalds/linux' or 'https://github.com/vercel/next.js').",
      },
      include_release: {
        type: "boolean",
        description: "If true, fetches the latest release tag and date (extra API call). Default true.",
        default: true,
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      full_name:         { type: "string" },
      description:       { type: ["string", "null"] },
      homepage:          { type: ["string", "null"] },
      language:          { type: ["string", "null"] },
      license:           { type: ["string", "null"] },
      topics:            { type: "array", items: { type: "string" } },
      stars:             { type: "integer" },
      forks:             { type: "integer" },
      open_issues:       { type: "integer" },
      watchers:          { type: "integer" },
      is_fork:           { type: "boolean" },
      is_archived:       { type: "boolean" },
      is_private:        { type: "boolean" },
      default_branch:    { type: "string" },
      created_at:        { type: "string" },
      pushed_at:         { type: "string", description: "Last code push date (proxy for maintainer activity)." },
      days_since_push:   { type: "integer", description: "Days since last push. <30=active, 30-180=slow, >365=stale." },
      activity_label:    { type: "string",  description: "VERY_ACTIVE | ACTIVE | SLOW | STALE | ARCHIVED" },
      latest_release: {
        type: ["object", "null"],
        properties: {
          tag:        { type: "string" },
          name:       { type: "string" },
          published:  { type: "string" },
          prerelease: { type: "boolean" },
        },
      },
      url:  { type: "string" },
      ts:   { type: "string" },
    },
  },

  async handler(query) {
    const { owner, repo } = parseRepo(query.repo || "vercel/next.js");
    const inclRelease     = query.include_release !== false;

    const [repoData, releaseData] = await Promise.all([
      fetchJson(`${GH_API}/repos/${owner}/${repo}`),
      inclRelease
        ? fetchJson(`${GH_API}/repos/${owner}/${repo}/releases/latest`).catch(() => null)
        : Promise.resolve(null),
    ]);

    const pushedAt    = new Date(repoData.pushed_at);
    const daysSincePush = Math.floor((Date.now() - pushedAt.getTime()) / 86_400_000);

    let activityLabel;
    if (repoData.archived) activityLabel = "ARCHIVED";
    else if (daysSincePush < 30)  activityLabel = "VERY_ACTIVE";
    else if (daysSincePush < 90)  activityLabel = "ACTIVE";
    else if (daysSincePush < 365) activityLabel = "SLOW";
    else                          activityLabel = "STALE";

    return {
      full_name:      repoData.full_name,
      description:    repoData.description || null,
      homepage:       repoData.homepage    || null,
      language:       repoData.language    || null,
      license:        repoData.license?.spdx_id || repoData.license?.name || null,
      topics:         repoData.topics || [],
      stars:          repoData.stargazers_count,
      forks:          repoData.forks_count,
      open_issues:    repoData.open_issues_count,
      watchers:       repoData.watchers_count,
      is_fork:        repoData.fork,
      is_archived:    repoData.archived,
      is_private:     repoData.private,
      default_branch: repoData.default_branch,
      created_at:     repoData.created_at,
      pushed_at:      repoData.pushed_at,
      days_since_push: daysSincePush,
      activity_label:  activityLabel,
      latest_release: releaseData ? {
        tag:       releaseData.tag_name,
        name:      releaseData.name || releaseData.tag_name,
        published: releaseData.published_at,
        prerelease: releaseData.prerelease,
      } : null,
      url: repoData.html_url,
      ts: new Date().toISOString(),
    };
  },
};
