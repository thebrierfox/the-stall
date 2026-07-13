// github-intel.js
//
// GitHub repository intelligence via the GitHub REST API.
// Authenticates with GITHUB_TOKEN (env) for 5000 req/hr; falls back to
// 60 req/hr unauthenticated. Completes the dev-ecosystem trio:
// npm-lookup + pypi-intel + github-intel.
//
// Actions:
//   repo             — full repo metadata: stars, forks, language, topics, license,
//                      last push, open issues, is_archived, contributor count
//   contributors     — top 30 contributors with commit counts and profile links
//   releases         — latest 10 releases with tag, publish date, download totals
//   issues           — 10 most recent open issues with labels, age, comment count
//   commit_activity  — weekly commit counts for the past 52 weeks (participation)
//   compare          — key metrics side-by-side for up to 4 repos
//   search           — GitHub code/repo search by keyword, language, or topic
//
// Use cases:
//   - Evaluate whether a library is actively maintained before adopting
//   - Find the canonical repo for a project and check its health
//   - Compare competing frameworks on stars, activity, and contributor breadth
//   - Identify the top maintainers of a critical dependency
//   - Search GitHub for repos solving a specific problem
//
// Upstream: api.github.com (free, 5000 req/hr authenticated, 60/hr unauth).
// Price: $0.010/call.

const GH_API  = "https://api.github.com";
const UA      = "Mozilla/5.0 (compatible; the-stall/4.68; +https://intuitek.ai)";
const TIMEOUT = 14_000;

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_KM_TOKEN;
  const h = {
    "User-Agent": UA,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function ghGet(path) {
  const resp = await fetch(`${GH_API}${path}`, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (resp.status === 404) throw new Error(`GitHub: not found — ${path}`);
  if (resp.status === 403) {
    const remaining = resp.headers.get("x-ratelimit-remaining");
    if (remaining === "0") throw new Error("GitHub rate limit exceeded — retry in ~60 seconds");
    throw new Error(`GitHub 403: ${await resp.text().catch(() => "forbidden")}`);
  }
  if (!resp.ok) throw new Error(`GitHub API ${resp.status} for ${path}`);
  return resp.json();
}

function parseOwnerRepo(input) {
  if (!input) throw new Error("repo must be provided as 'owner/repo'");
  const clean = input.trim().replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\/$/, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid repo format "${input}" — expected owner/repo`);
  return [parts[0], parts[1]];
}

function ageStr(isoTs) {
  if (!isoTs) return null;
  const diff = Date.parse(new Date().toISOString()) - Date.parse(isoTs);
  const d = Math.floor(diff / 86400000);
  if (d === 0) return "today";
  if (d === 1) return "1 day ago";
  if (d < 30) return `${d} days ago`;
  if (d < 365) return `${Math.floor(d / 30)} months ago`;
  return `${(d / 365).toFixed(1)} years ago`;
}

async function actionRepo(query) {
  const [owner, repo] = parseOwnerRepo(query.repo);
  const data = await ghGet(`/repos/${owner}/${repo}`);

  // contributor count (separate call, first page count gives upper-bound)
  let contributor_count = null;
  try {
    const contribs = await ghGet(`/repos/${owner}/${repo}/contributors?per_page=1&anon=false`);
    if (Array.isArray(contribs)) {
      // heuristic: 1 result → exact; if we get 1 and list_contributors returned Link with last page use that
      contributor_count = contribs.length;
    }
  } catch (_) { /* optional */ }

  return {
    owner,
    repo,
    full_name:         data.full_name,
    description:       data.description,
    homepage:          data.homepage || null,
    language:          data.language,
    topics:            data.topics ?? [],
    stars:             data.stargazers_count,
    forks:             data.forks_count,
    watchers:          data.watchers_count,
    open_issues:       data.open_issues_count,
    is_fork:           data.fork,
    is_archived:       data.archived,
    is_template:       data.is_template ?? false,
    default_branch:    data.default_branch,
    license:           data.license?.spdx_id ?? data.license?.name ?? null,
    created_at:        data.created_at,
    last_push:         data.pushed_at,
    last_push_age:     ageStr(data.pushed_at),
    network_count:     data.network_count ?? null,
    contributor_count,
    size_kb:           data.size,
    visibility:        data.visibility,
    github_url:        data.html_url,
    api_url:           data.url,
    ts:                new Date().toISOString(),
  };
}

async function actionContributors(query) {
  const [owner, repo] = parseOwnerRepo(query.repo);
  const data = await ghGet(`/repos/${owner}/${repo}/contributors?per_page=30&anon=false`);
  if (!Array.isArray(data)) throw new Error("Unexpected contributors response");
  return {
    owner, repo,
    contributors: data.map((c, i) => ({
      rank:          i + 1,
      login:         c.login,
      contributions: c.contributions,
      profile_url:   c.html_url,
      avatar_url:    c.avatar_url,
      type:          c.type,
    })),
    total_shown: data.length,
    ts: new Date().toISOString(),
  };
}

async function actionReleases(query) {
  const [owner, repo] = parseOwnerRepo(query.repo);
  const data = await ghGet(`/repos/${owner}/${repo}/releases?per_page=10`);
  if (!Array.isArray(data)) throw new Error("Unexpected releases response");
  return {
    owner, repo,
    releases: data.map(r => ({
      tag:              r.tag_name,
      name:             r.name || r.tag_name,
      published_at:     r.published_at,
      age:              ageStr(r.published_at),
      prerelease:       r.prerelease,
      draft:            r.draft,
      total_downloads:  (r.assets ?? []).reduce((s, a) => s + (a.download_count ?? 0), 0),
      assets:           (r.assets ?? []).map(a => ({ name: a.name, downloads: a.download_count, size_mb: +(a.size / 1048576).toFixed(2) })),
      release_url:      r.html_url,
    })),
    total_shown: data.length,
    ts: new Date().toISOString(),
  };
}

async function actionIssues(query) {
  const [owner, repo] = parseOwnerRepo(query.repo);
  const data = await ghGet(`/repos/${owner}/${repo}/issues?state=open&per_page=10&sort=created&direction=desc`);
  if (!Array.isArray(data)) throw new Error("Unexpected issues response");
  // Filter out pull requests (GitHub issues API returns PRs too)
  const issues = data.filter(i => !i.pull_request);
  return {
    owner, repo,
    issues: issues.map(i => ({
      number:    i.number,
      title:     i.title,
      state:     i.state,
      labels:    (i.labels ?? []).map(l => l.name),
      comments:  i.comments,
      created_at: i.created_at,
      age:       ageStr(i.created_at),
      author:    i.user?.login,
      url:       i.html_url,
    })),
    total_shown: issues.length,
    ts: new Date().toISOString(),
  };
}

async function actionCommitActivity(query) {
  const [owner, repo] = parseOwnerRepo(query.repo);
  const data = await ghGet(`/repos/${owner}/${repo}/stats/participation`);
  if (!data || !Array.isArray(data.all)) {
    // 202 means GitHub is computing stats async — just return empty
    return { owner, repo, note: "GitHub is computing statistics — retry in 10-30 seconds", ts: new Date().toISOString() };
  }
  const all = data.all;         // 52 weekly totals, oldest first
  const owner_weeks = data.owner ?? [];
  const total = all.reduce((s, v) => s + v, 0);
  const last4  = all.slice(-4).reduce((s, v) => s + v, 0);
  const last13 = all.slice(-13).reduce((s, v) => s + v, 0);
  const active_weeks = all.filter(v => v > 0).length;
  return {
    owner, repo,
    total_commits_52w:    total,
    commits_last_4w:      last4,
    commits_last_13w:     last13,
    active_weeks_of_52:   active_weeks,
    owner_commits_52w:    owner_weeks.reduce((s, v) => s + v, 0),
    weekly_all:           all,
    weekly_owner:         owner_weeks,
    ts: new Date().toISOString(),
  };
}

async function actionCompare(query) {
  const repos = (query.repos || []).slice(0, 4);
  if (repos.length < 2) throw new Error("compare requires at least 2 repos in the repos array");

  const results = await Promise.allSettled(repos.map(r => actionRepo({ repo: r })));
  return {
    comparison: results.map((r, i) => {
      if (r.status === "rejected") return { repo: repos[i], error: r.reason?.message };
      const d = r.value;
      return {
        repo:          d.full_name,
        stars:         d.stars,
        forks:         d.forks,
        open_issues:   d.open_issues,
        language:      d.language,
        last_push:     d.last_push_age,
        is_archived:   d.is_archived,
        license:       d.license,
        topics:        d.topics.slice(0, 5),
        github_url:    d.github_url,
      };
    }),
    ts: new Date().toISOString(),
  };
}

async function actionSearch(query) {
  const q = (query.query || "").trim();
  if (!q) throw new Error("query is required for search action");
  let searchQ = q;
  if (query.language) searchQ += ` language:${query.language}`;
  if (query.topic) searchQ += ` topic:${query.topic}`;

  const data = await ghGet(`/search/repositories?q=${encodeURIComponent(searchQ)}&sort=stars&order=desc&per_page=${query.limit || 10}`);
  return {
    query: searchQ,
    total_count: data.total_count,
    results: (data.items ?? []).map(r => ({
      full_name:   r.full_name,
      description: r.description,
      stars:       r.stargazers_count,
      forks:       r.forks_count,
      language:    r.language,
      topics:      r.topics?.slice(0, 5) ?? [],
      last_push:   ageStr(r.pushed_at),
      is_archived: r.archived,
      license:     r.license?.spdx_id ?? null,
      github_url:  r.html_url,
    })),
    ts: new Date().toISOString(),
  };
}

export default {
  name:  "github-intel",
  price: "$0.015",

  description:
    "GitHub repository intelligence: stars, forks, contributors, releases, open issues, and weekly commit activity. Compare up to 4 repos side-by-side or search GitHub for repos by keyword, language, and topic. Use to evaluate library health before adopting a dependency, find the top maintainers of a project, track release cadence, or benchmark competing frameworks. Authenticated (5000 req/hr). Actions: repo | contributors | releases | issues | commit_activity | compare | search.",

  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["repo", "contributors", "releases", "issues", "commit_activity", "compare", "search"],
        description: "repo: full metadata. contributors: top 30 committers. releases: latest 10 releases + download counts. issues: 10 recent open issues. commit_activity: 52-week weekly commit trend. compare: side-by-side metrics for ≤4 repos. search: find repos by keyword.",
      },
      repo: {
        type: "string",
        description: "Repository in owner/repo format (e.g. 'facebook/react', 'anthropics/claude-code'). Full GitHub URLs also accepted. Required for repo, contributors, releases, issues, commit_activity.",
      },
      repos: {
        type: "array",
        items: { type: "string" },
        maxItems: 4,
        description: "Array of owner/repo strings for compare action (2–4 repos).",
      },
      query: {
        type: "string",
        description: "Search query for search action (e.g. 'vector database', 'llm agent framework').",
      },
      language: {
        type: "string",
        description: "Filter search results by programming language (e.g. 'Python', 'TypeScript').",
      },
      topic: {
        type: "string",
        description: "Filter search results by GitHub topic (e.g. 'machine-learning', 'mcp').",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 30,
        description: "Max search results to return (default 10, max 30).",
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    description: "Varies by action. Always includes owner/repo or query + ts (ISO-8601 timestamp).",
  },

  async handler(query) {
    const action = (query.action || "repo").toLowerCase();
    switch (action) {
      case "repo":            return actionRepo(query);
      case "contributors":    return actionContributors(query);
      case "releases":        return actionReleases(query);
      case "issues":          return actionIssues(query);
      case "commit_activity": return actionCommitActivity(query);
      case "compare":         return actionCompare(query);
      case "search":          return actionSearch(query);
      default: throw new Error(`Unknown action "${action}". Valid: repo | contributors | releases | issues | commit_activity | compare | search`);
    }
  },
};
