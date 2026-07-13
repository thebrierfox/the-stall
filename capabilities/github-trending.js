// github-trending.js
//
// Fetches trending GitHub repositories by recency + star velocity.
// Returns the fastest-rising repos created today or this week, optionally
// filtered by programming language or topic.
//
// Seam: ghapi.huchen.dev + github.com/trending — scraped daily by dev agents
// watching the ecosystem. Developer/AI agents checking "what new tools
// appeared today in Python/TypeScript" have no single paid API for this.
//
// Upstream: GitHub Search API v3 (public, no auth, 60 req/hr without token).
// Stars desc sort on recently-created repos is a reliable trending proxy.

const GH_SEARCH = "https://api.github.com/search/repositories";
const UA        = "Mozilla/5.0 (compatible; the-stall/3.62; +https://intuitek.ai)";
const TIMEOUT   = 12_000;

function sinceDate(period) {
  const d = new Date();
  if (period === "weekly") d.setDate(d.getDate() - 7);
  else if (period === "monthly") d.setDate(d.getDate() - 30);
  else d.setDate(d.getDate() - 1); // "daily" default
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
}

async function searchRepos({ language, since, limit, topic }) {
  let q = `created:>${sinceDate(since)} stars:>0`;
  if (language) q += ` language:${language}`;
  if (topic)    q += ` topic:${topic}`;

  const params = new URLSearchParams({
    q,
    sort:     "stars",
    order:    "desc",
    per_page: String(Math.min(Math.max(1, limit || 10), 25)),
  });

  const res = await fetch(`${GH_SEARCH}?${params}`, {
    headers: {
      "User-Agent": UA,
      Accept:       "application/vnd.github.v3+json",
    },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    const resetAt = reset ? new Date(parseInt(reset, 10) * 1000).toISOString() : "unknown";
    throw new Error(`GitHub rate limit hit — reset at ${resetAt}`);
  }
  if (!res.ok) throw new Error(`GitHub Search HTTP ${res.status}`);

  const data = await res.json();
  return {
    total_found: data.total_count ?? 0,
    repos: (data.items || []).map(r => ({
      name:        r.full_name,
      description: r.description || null,
      stars:       r.stargazers_count,
      forks:       r.forks_count,
      language:    r.language || null,
      topics:      r.topics || [],
      url:         r.html_url,
      owner:       r.owner?.login || null,
      created_at:  r.created_at,
      pushed_at:   r.pushed_at,
      open_issues: r.open_issues_count,
      license:     r.license?.spdx_id || null,
    })),
  };
}

export default {
  name:  "github-trending",
  price: "$0.021",
  description: "Top trending GitHub repositories by star velocity — new repos gaining the most stars today, this week, or this month. Filter by programming language and/or topic tag.",
  inputSchema: {
    type: "object",
    properties: {
      since: {
        type:        "string",
        enum:        ["daily", "weekly", "monthly"],
        default:     "daily",
        description: "Time window: 'daily' = repos created in last 24h, 'weekly' = last 7 days, 'monthly' = last 30 days.",
      },
      language: {
        type:        "string",
        description: "Filter by programming language (e.g. 'python', 'typescript', 'rust', 'go'). Case-insensitive.",
      },
      topic: {
        type:        "string",
        description: "Filter by GitHub topic tag (e.g. 'llm', 'ai-agent', 'mcp', 'nextjs'). Use GitHub's exact topic slug.",
      },
      limit: {
        type:        "number",
        default:     10,
        description: "Number of repositories to return (1–25, default 10).",
      },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      since:       { type: "string" },
      language:    { type: ["string", "null"] },
      topic:       { type: ["string", "null"] },
      total_found: { type: "number" },
      repos: {
        type:  "array",
        items: {
          type: "object",
          properties: {
            name:        { type: "string" },
            description: { type: ["string", "null"] },
            stars:       { type: "number" },
            forks:       { type: "number" },
            language:    { type: ["string", "null"] },
            topics:      { type: "array", items: { type: "string" } },
            url:         { type: "string" },
            owner:       { type: ["string", "null"] },
            created_at:  { type: "string" },
            pushed_at:   { type: "string" },
            open_issues: { type: "number" },
            license:     { type: ["string", "null"] },
          },
        },
      },
    },
  },
  async handler({ since = "daily", language, topic, limit = 10 }) {
    const result = await searchRepos({ language, since, limit, topic });
    return {
      since,
      language:    language || null,
      topic:       topic    || null,
      total_found: result.total_found,
      repos:       result.repos,
    };
  },
};
