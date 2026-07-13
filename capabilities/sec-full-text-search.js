// sec-full-text-search.js
//
// Full-text search across all SEC EDGAR filings: find every company that
// mentioned a keyword or phrase in their 10-K, 10-Q, 8-K, or any other
// filing type.
//
// Seam: agents running equity research or thematic investing need to know
// which public companies are talking about a specific topic (AI risk, tariff
// exposure, China operations, climate liability, etc.) in their official
// filings. sec-filing-intel looks up one company; this cap scans all ~12,000
// public companies at once.
//
// Source: SEC EDGAR Full-Text Search API (efts.sec.gov) — public, no API key,
// authoritative. Rate limit: 10 req/sec; compliant with SEC open-data policy.

const BASE    = "https://efts.sec.gov/LATEST/search-index";
const UA      = "the-stall/4.9 sec-full-text-search (kyle@intuitek.ai)";
const TIMEOUT = 12_000;

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

function parseName(display) {
  if (!display || !display.length) return { name: null, tickers: [] };
  const raw = display[0];
  const m   = raw.match(/^(.*?)\s+\(([^)]+)\)\s+\(CIK/);
  if (m) {
    const name    = m[1].trim();
    const tickers = m[2].split(",").map(t => t.trim()).filter(Boolean);
    return { name, tickers };
  }
  return { name: raw.split("(")[0].trim(), tickers: [] };
}

export default {
  name:  "sec-full-text-search",
  price: "$0.010",

  description:
    "Full-text search across all SEC EDGAR filings. Finds every public company that mentioned a keyword or phrase in their 10-K, 10-Q, 8-K, or other forms. Returns company names, tickers, filing dates, and relevance scores. Ideal for thematic stock and equity research: 'which companies disclosed tariff risk in Q1 2026?'",

  inputSchema: {
    type:       "object",
    properties: {
      query: {
        type:        "string",
        description: "Keyword or phrase to search (e.g. 'tariff risk', 'artificial intelligence', 'China operations'). Wrap in quotes for exact phrase match.",
      },
      forms: {
        type:        "string",
        description: "Comma-separated SEC form types to search (e.g. '10-K,10-Q,8-K'). Default: 10-K,10-Q,8-K",
      },
      days: {
        type:        "integer",
        description: "How many days back to search. Default 90, max 730.",
      },
      limit: {
        type:        "integer",
        description: "Max results to return. Default 10, max 25.",
      },
    },
    required:            ["query"],
    additionalProperties: false,
  },

  outputSchema: {
    type:       "object",
    properties: {
      query:         { type: "string" },
      total_matches: { type: "integer" },
      forms_searched: { type: "string" },
      date_range:     { type: "string" },
      results: {
        type:  "array",
        items: {
          type:       "object",
          properties: {
            company:     { type: "string" },
            tickers:     { type: "array", items: { type: "string" } },
            cik:         { type: "string" },
            form_type:   { type: "string" },
            filed:       { type: "string" },
            period:      { type: "string" },
            relevance:   { type: "number" },
            filing_url:  { type: "string" },
          },
        },
      },
    },
  },

  async handler(query) {
    const searchQuery = query.query || "AI";
    const forms       = (query.forms || "10-K,10-Q,8-K").trim();
    const days        = Math.min(Math.max(1, parseInt(query.days, 10) || 90), 730);
    const limit       = Math.min(Math.max(1, parseInt(query.limit, 10) || 10), 25);
    const startDate   = daysAgo(days);
    const endDate     = new Date().toISOString().split("T")[0];

    const params = new URLSearchParams({
      q:          searchQuery,
      forms,
      dateRange:  "custom",
      startdt:    startDate,
      enddt:      endDate,
      from:       "0",
      size:       String(limit),
    });

    const url = `${BASE}?${params}`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal:  AbortSignal.timeout(TIMEOUT),
    });

    if (res.status === 429) throw new Error("SEC EDGAR rate limit — retry in 60 seconds");
    if (!res.ok) throw new Error(`SEC EDGAR ${res.status}`);

    const data       = await res.json();
    const hits       = data?.hits?.hits || [];
    const totalValue = data?.hits?.total?.value ?? 0;

    const results = hits.map(h => {
      const src        = h._source || {};
      const { name, tickers } = parseName(src.display_names);
      const ciks       = src.ciks || [];
      const cik        = ciks[0]?.replace(/^0+/, "") || null;
      const forms_list = src.root_forms || [];
      const accession  = h._id?.split(":")[0] || null;
      const filingUrl  = accession && cik
        ? `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, "")}`
        : null;

      return {
        company:    name,
        tickers,
        cik,
        form_type:  forms_list[0] || null,
        filed:      src.file_date || null,
        period:     src.period_ending || null,
        relevance:  Math.round((h._score || 0) * 100) / 100,
        filing_url: filingUrl,
      };
    });

    return {
      query:          searchQuery,
      total_matches:  totalValue,
      forms_searched: forms,
      date_range:     `${startDate} to ${endDate}`,
      results,
    };
  },
};
