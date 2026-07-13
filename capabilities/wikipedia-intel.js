// wikipedia-intel.js
//
// Wikipedia article summary and search via the free Wikipedia REST API (no auth).
// Lookup by title or search by query; returns extract, thumbnail, categories,
// and cross-links for the top matching articles.
//
// Free upstream: en.wikipedia.org REST API v1 (no key, open data).
// Useful for: knowledge-base agents, fact-checking, entity enrichment,
// research pre-flight, classification, and general QA pipelines.

const REST   = "https://en.wikipedia.org/api/rest_v1";
const SEARCH = "https://en.wikipedia.org/w/api.php";
const UA     = "Mozilla/5.0 (compatible; the-stall/1.0; +https://intuitek.ai)";
const T      = 10_000;

async function get(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(T),
  });
  if (!r.ok) {
    if (r.status === 404) return null;
    throw new Error(`Wikipedia HTTP ${r.status}`);
  }
  return r.json();
}

// Fetch the REST summary for a known page title
async function pageSummary(title) {
  const encoded = encodeURIComponent(title.replace(/ /g, "_"));
  return get(`${REST}/page/summary/${encoded}`);
}

// Search MediaWiki for titles matching a query
async function searchTitles(query, limit) {
  const params = new URLSearchParams({
    action:   "query",
    list:     "search",
    srsearch: query,
    srlimit:  String(limit),
    srprop:   "snippet|titlesnippet|wordcount",
    format:   "json",
    origin:   "*",
  });
  const data = await get(`${SEARCH}?${params}`);
  return (data?.query?.search ?? []).map(r => r.title);
}

function shapeSummary(d) {
  if (!d) return null;
  return {
    title:       d.title ?? null,
    display_title: d.displaytitle?.replace(/<[^>]+>/g, "") ?? d.title ?? null,
    description: d.description ?? null,
    extract:     d.extract ? d.extract.slice(0, 800) : null,
    thumbnail:   d.thumbnail?.source ?? null,
    url:         d.content_urls?.desktop?.page ?? null,
    pageid:      d.pageid ?? null,
    last_modified: d.timestamp ?? null,
  };
}

export default {
  name:  "wikipedia-intel",
  price: "$0.034",

  description:
    "Wikipedia article lookup and search. Given a search query, returns the top matching Wikipedia articles with title, plain-text extract (~800 chars), description, thumbnail URL, page URL, and last-modified date. Use for rapid factual lookup, entity enrichment, concept explanation, or pre-flight research on any topic. Entity-parametric — accepts one query per call; parallel-safe for enriching lists of companies, people, or places in distributed agentic pipelines. No API key required.",

  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query or article title (e.g. 'transformer neural network', 'Warren Buffett', 'CRISPR'). Used for full-text search when exact=false.",
      },
      exact: {
        type: "boolean",
        default: false,
        description: "If true, treat 'query' as an exact page title for a direct lookup (faster, returns one article). If false, run a search and return the top matches.",
      },
      limit: {
        type: "integer",
        default: 3,
        minimum: 1,
        maximum: 8,
        description: "Number of articles to return when exact=false (1–8). Default: 3.",
      },
      lang: {
        type: "string",
        default: "en",
        description: "Wikipedia language edition (ISO 639-1 code, e.g. 'en', 'es', 'fr', 'de'). Default: 'en'.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      query:        { type: "string" },
      articles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title:          { type: "string" },
            display_title:  { type: "string" },
            description:    { type: "string" },
            extract:        { type: "string", description: "First ~800 chars of the article extract." },
            thumbnail:      { type: "string" },
            url:            { type: "string" },
            pageid:         { type: "integer" },
            last_modified:  { type: "string" },
          },
        },
      },
      generated_at: { type: "string" },
    },
  },

  async handler(input) {
    const query = String(input.query ?? "artificial intelligence").trim();
    const exact = Boolean(input.exact ?? false);
    const limit = Math.min(8, Math.max(1, parseInt(input.limit ?? 3)));
    const lang  = String(input.lang ?? "en").toLowerCase().trim();

    // For non-English, override the base URLs
    const restBase   = lang === "en" ? REST   : `https://${lang}.wikipedia.org/api/rest_v1`;
    const searchBase = lang === "en" ? SEARCH : `https://${lang}.wikipedia.org/w/api.php`;

    // Patch get() URLs for non-default language
    async function langGet(url) {
      const adjusted = url
        .replace(REST, restBase)
        .replace(SEARCH, searchBase);
      return get(adjusted);
    }

    let articles = [];

    if (exact) {
      const summary = await pageSummary(query);
      if (summary) articles = [shapeSummary(summary)].filter(Boolean);
    } else {
      // Search for matching titles, then fetch summaries in parallel
      const params = new URLSearchParams({
        action:   "query",
        list:     "search",
        srsearch: query,
        srlimit:  String(limit),
        srprop:   "snippet",
        format:   "json",
        origin:   "*",
      });
      const data   = await langGet(`${searchBase}?${params}`);
      const titles = (data?.query?.search ?? []).map(r => r.title);

      const summaries = await Promise.allSettled(
        titles.map(t => {
          const encoded = encodeURIComponent(t.replace(/ /g, "_"));
          return langGet(`${restBase}/page/summary/${encoded}`);
        })
      );

      articles = summaries
        .map(s => (s.status === "fulfilled" ? shapeSummary(s.value) : null))
        .filter(Boolean);
    }

    return {
      query,
      articles,
      generated_at: new Date().toISOString(),
    };
  },
};
