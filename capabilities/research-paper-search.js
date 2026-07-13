// research-paper-search.js
//
// Academic paper search across 250M+ works via OpenAlex (free, no key).
// Covers all disciplines: CS, medicine, physics, economics, social science, etc.
//
// Growth signal: "Search" category, +33.5 endpoints/day (signal-intel 2026-06-06).
// Use case: literature review agents, citation building, prior-art research.

const OPENALEX = "https://api.openalex.org";
const UA       = "Mozilla/5.0 (compatible; the-stall/1.0; +https://intuitek.ai)";
const T        = 12_000;

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(T) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// Decode OpenAlex inverted-index abstract (word → [positions]) to plain text
function decodeAbstract(inv) {
  if (!inv || typeof inv !== "object") return null;
  const entries = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const pos of positions) entries.push([pos, word]);
  }
  entries.sort((a, b) => a[0] - b[0]);
  const text = entries.map(([, w]) => w).join(" ").trim();
  return text.length > 10 ? text.slice(0, 500) : null;
}

function buildSortParam(sort) {
  switch ((sort ?? "").toLowerCase()) {
    case "cited":  return "cited_by_count:desc";
    case "recent": return "publication_year:desc";
    default:       return null;  // relevance (default OpenAlex behavior)
  }
}

export default {
  name:  "research-paper-search",
  price: "$0.059",

  description:
    "Academic paper search across 250M+ works via OpenAlex (free, no key). Returns top papers with title, authors, year, DOI, citation count, open-access status, and primary research topic. Covers all disciplines: AI/ML, medicine, physics, economics, law, biology, and more. Supports relevance, citation-count, and recency sorting; open-access filtering; and year-range constraints. Use for literature review, prior-art search, citation building, or finding the seminal papers in any field.",

  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query. Natural-language or keyword (e.g. 'transformer attention mechanism', 'CRISPR gene editing cancer', 'bitcoin game theory').",
      },
      limit: {
        type: "integer",
        description: "Number of papers to return (1–10). Default: 5.",
        default: 5,
        minimum: 1,
        maximum: 10,
      },
      sort: {
        type: "string",
        enum: ["relevant", "cited", "recent"],
        description: "Sort order. relevant = OpenAlex relevance score; cited = most-cited first; recent = newest first. Default: relevant.",
        default: "relevant",
      },
      min_year: {
        type: "integer",
        description: "Only return papers published this year or later (e.g. 2020). Optional.",
      },
      open_access_only: {
        type: "boolean",
        description: "If true, only return open-access papers with freely available PDFs. Default: false.",
        default: false,
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      query:          { type: "string" },
      total_in_index: { type: "integer", description: "Total matching works in OpenAlex for this query." },
      papers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title:          { type: "string" },
            authors:        { type: "array", items: { type: "string" }, description: "Up to 5 author display names." },
            year:           { type: "integer" },
            doi:            { type: "string" },
            cited_by_count: { type: "integer" },
            open_access:    { type: "boolean" },
            oa_url:         { type: "string", description: "Free full-text URL if open access." },
            primary_topic:  { type: "string", description: "OpenAlex primary research topic." },
            abstract:       { type: "string", description: "First ~500 chars of abstract (when available)." },
          },
        },
      },
      generated_at: { type: "string" },
    },
  },

  async handler(input) {
    const query         = String(input.query || "transformer neural networks").trim();
    const limit         = Math.min(10, Math.max(1, parseInt(input.limit ?? 5)));
    const sort          = input.sort ?? "relevant";
    const openAccessOnly = Boolean(input.open_access_only);
    const minYear       = input.min_year ? parseInt(input.min_year) : null;

    const params = new URLSearchParams({
      search:   query,
      per_page: String(limit),
      select:   "title,doi,publication_year,cited_by_count,authorships,open_access,primary_topic,abstract_inverted_index",
    });

    const sortParam = buildSortParam(sort);
    if (sortParam) params.set("sort", sortParam);

    const filters = [];
    if (openAccessOnly) filters.push("is_oa:true");
    if (minYear)        filters.push(`publication_year:>${minYear - 1}`);
    if (filters.length) params.set("filter", filters.join(","));

    const data = await get(`${OPENALEX}/works?${params.toString()}`);
    const meta    = data.meta    ?? {};
    const results = data.results ?? [];

    const papers = results.map(w => {
      const authors = (w.authorships ?? [])
        .slice(0, 5)
        .map(a => a?.author?.display_name)
        .filter(Boolean);
      const oa    = w.open_access ?? {};
      const topic = (w.primary_topic ?? {}).display_name ?? null;
      const abstract = decodeAbstract(w.abstract_inverted_index);

      return {
        title:          (w.title ?? "").replace(/<[^>]+>/g, "").trim() || null,
        authors,
        year:           w.publication_year ?? null,
        doi:            w.doi ?? null,
        cited_by_count: w.cited_by_count ?? 0,
        open_access:    Boolean(oa.is_oa),
        oa_url:         oa.oa_url ?? null,
        primary_topic:  topic,
        abstract,
      };
    });

    return {
      query,
      total_in_index: meta.count ?? 0,
      papers,
      generated_at: new Date().toISOString(),
    };
  },
};
