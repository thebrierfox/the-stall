// patent-intel.js
//
// USPTO patent intelligence for any company or keyword query.
//
// Data source: PatentsView API (search.patentsview.org), the USPTO's official
// machine-readable patent database covering all US granted patents from 1976
// to within 2 weeks of present.  No API key required; public domain data.
//
// Two modes:
//   1. company(ticker_or_name) — recent granted patents assigned to a company.
//      Accepts a US stock ticker (resolved to company name via SEC EDGAR) or
//      a free-form company / assignee name.  Returns latest N patents with
//      title, abstract excerpt, CPC technology codes, inventors, grant date,
//      and filing date.
//   2. search(query)           — full-text keyword search across patent titles
//      and abstracts.  Useful for tracking who is innovating in a given area.
//
// Returns per-patent: patent_id, title, abstract (≤400 chars), grant_date,
// filing_date, patent_type, assignee names, inventor names (first 5), CPC
// section labels (e.g., "H – Electricity"), CPC group codes, and a direct
// Google Patents URL.
//
// Seam: patent filing velocity and CPC code clustering are leading indicators
// of a company's R&D strategy and technology moat.  No x402 competitor cap
// covers USPTO data at this level of structure.  Pairs with equity-fundamentals
// and company-due-diligence for IP-layer competitive intelligence.
//
// Price: $0.008/call — single PatentsView API round-trip per invocation.

const UA          = "the-stall/4.68 patent-intel (kyle@intuitek.ai)";
const PV_BASE     = "https://search.patentsview.org/api/v1/patent/";
const TICKER_MAP  = "https://www.sec.gov/files/company_tickers.json";
const TIMEOUT_MS  = 14_000;

// CPC section labels for human-readable output
const CPC_SECTIONS = {
  A: "Human Necessities",
  B: "Performing Operations / Transporting",
  C: "Chemistry / Metallurgy",
  D: "Textiles / Paper",
  E: "Fixed Constructions",
  F: "Mechanical Engineering / Lighting / Heating",
  G: "Physics",
  H: "Electricity",
  Y: "General Tagging of New Technological Developments",
};

// Patent type labels
const PATENT_TYPES = {
  utility:   "Utility",
  design:    "Design",
  plant:     "Plant",
  reissue:   "Reissue",
};

let _tickerCache = null;
let _cacheTick   = 0;
const CACHE_TTL  = 6 * 60 * 60 * 1000; // 6 hours

async function getCompanyName(ticker) {
  const now = Date.now();
  if (!_tickerCache || now - _cacheTick > CACHE_TTL) {
    const r = await fetch(TICKER_MAP, {
      headers: { "User-Agent": UA },
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`EDGAR ticker map ${r.status}`);
    const raw    = await r.json();
    _tickerCache = {};
    for (const v of Object.values(raw)) {
      _tickerCache[v.ticker.toUpperCase()] = v.title;
    }
    _cacheTick = now;
  }
  const name = _tickerCache[ticker.toUpperCase()];
  if (!name) return null;
  // Strip common legal suffixes — patent assignee names often omit them
  return name
    .replace(/,?\s*(Inc\.|Corp\.|Corporation|LLC|Ltd\.|L\.L\.C\.|Co\.|Company|Group|Holdings?|Technologies|International)\.?$/i, "")
    .trim();
}

async function pvSearch(query, fields, sort, perPage) {
  const params = new URLSearchParams({
    q: JSON.stringify(query),
    f: JSON.stringify(fields),
    s: JSON.stringify(sort),
    o: JSON.stringify({ per_page: perPage }),
  });
  const url = `${PV_BASE}?${params}`;
  const r   = await fetch(url, {
    headers: { "User-Agent": UA },
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`PatentsView API ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

const FIELDS = [
  "patent_id",
  "patent_title",
  "patent_abstract",
  "patent_date",
  "patent_type",
  "applications.filing_date",
  "assignees.assignee_organization",
  "assignees.assignee_country",
  "inventors.inventor_first_name",
  "inventors.inventor_last_name",
  "cpcs.cpc_section_id",
  "cpcs.cpc_subsection_id",
  "cpcs.cpc_group_id",
];

const SORT_RECENT = [{ patent_date: "desc" }];

function formatPatent(p) {
  const assignees = [...new Set(
    (p.assignees || []).map(a => a.assignee_organization).filter(Boolean)
  )];
  const inventors = [...new Set(
    (p.inventors || [])
      .map(i => [i.inventor_first_name, i.inventor_last_name].filter(Boolean).join(" "))
      .filter(Boolean)
  )].slice(0, 5);
  const cpcGroups = [...new Set(
    (p.cpcs || []).map(c => c.cpc_group_id).filter(Boolean)
  )].slice(0, 8);
  const cpcSections = [...new Set(
    (p.cpcs || []).map(c => {
      const sec = c.cpc_section_id;
      return sec ? `${sec} – ${CPC_SECTIONS[sec] || sec}` : null;
    }).filter(Boolean)
  )];

  const filingDate  = (p.applications && p.applications.length > 0)
    ? p.applications[0].filing_date
    : null;

  const abstract = p.patent_abstract
    ? (p.patent_abstract.length > 400
        ? p.patent_abstract.slice(0, 400) + "…"
        : p.patent_abstract)
    : null;

  return {
    patent_number:  p.patent_id,
    title:          p.patent_title,
    abstract,
    grant_date:     p.patent_date,
    filing_date:    filingDate,
    patent_type:    PATENT_TYPES[p.patent_type] ?? p.patent_type ?? null,
    assignees,
    inventors,
    cpc_sections:   cpcSections,
    cpc_groups:     cpcGroups,
    google_patents: `https://patents.google.com/patent/US${p.patent_id}`,
  };
}

// Mode 1: patents by company assignee
async function companyMode(input, limit) {
  const trimmed  = input.trim();
  // Ticker: 1-5 uppercase letters, no digits or special chars
  const isTicker = /^[A-Z]{1,5}$/.test(trimmed.toUpperCase()) && trimmed.length <= 5;
  let companyName   = trimmed;
  let resolvedFrom  = null;

  if (isTicker) {
    const resolved = await getCompanyName(trimmed.toUpperCase());
    if (resolved) {
      companyName   = resolved;
      resolvedFrom  = trimmed.toUpperCase();
    }
  }

  // Use _text_phrase for phrase match on assignee organization (handles multi-word names)
  const query = { "_text_phrase": { "assignees.assignee_organization": companyName } };

  const data    = await pvSearch(query, FIELDS, SORT_RECENT, Math.min(limit, 50));
  const patents = (data.patents || []).map(formatPatent);
  const total   = data.total_patent_count ?? data.count ?? patents.length;

  return {
    company:     companyName,
    ticker:      resolvedFrom,
    total_found: total,
    returned:    patents.length,
    patents,
    note: patents.length === 0
      ? `No patents found for assignee "${companyName}". Try a shorter or alternate company name, or use mode=search.`
      : `${patents.length} most-recent granted patents assigned to "${companyName}" (${total.toLocaleString()} total in USPTO). Sorted by grant date descending.`,
    source: "USPTO PatentsView API — public domain (search.patentsview.org)",
  };
}

// Mode 2: keyword search across titles and abstracts
async function searchMode(query, limit) {
  const pvQuery = {
    "_or": [
      { "_text_any": { "patent_title":    query } },
      { "_text_any": { "patent_abstract": query } },
    ],
  };

  const data    = await pvSearch(pvQuery, FIELDS, SORT_RECENT, Math.min(limit, 50));
  const patents = (data.patents || []).map(formatPatent);
  const total   = data.total_patent_count ?? data.count ?? patents.length;

  return {
    query,
    total_found: total,
    returned:    patents.length,
    patents,
    note: patents.length === 0
      ? `No patents found matching "${query}". Try different keywords.`
      : `${patents.length} most-recent patents matching "${query}" in title or abstract (${total.toLocaleString()} total found). Sorted by grant date descending.`,
    source: "USPTO PatentsView API — public domain (search.patentsview.org)",
  };
}

export default {
  name:  "patent-intel",
  price: "$0.015",

  description:
    "USPTO patent intelligence for any company or keyword. " +
    "Mode 'company' (ticker or company name): recent granted patents assigned to that company — " +
    "accepts US stock ticker (resolved via SEC EDGAR) or free-form assignee name. " +
    "Returns title, abstract excerpt (≤400 chars), grant date, filing date, CPC technology section labels " +
    "(e.g., 'H – Electricity', 'G – Physics'), CPC group codes, inventor names, and a Google Patents link. " +
    "Mode 'search' (query): full-text keyword search across all USPTO patent titles and abstracts — " +
    "useful for finding who is innovating in a technology area (e.g., 'transformer neural network', 'solid state battery'). " +
    "Covers all US granted patents from 1976 to within ~2 weeks of present. " +
    "Data source: USPTO PatentsView API (public domain, no API key). $0.008/call.",

  inputSchema: {
    type:       "object",
    properties: {
      company: {
        type:        "string",
        description: "US stock ticker (e.g., AAPL, NVDA, MSFT) or company/assignee name for patent search. Used in mode=company.",
      },
      query: {
        type:        "string",
        description: "Keyword search string for mode=search (searches patent titles and abstracts). Example: 'solid state battery' or 'transformer architecture'.",
      },
      mode: {
        type:        "string",
        enum:        ["company", "search"],
        description: "'company' (default when company is given): recent patents by assignee name. 'search': keyword search across all US patents.",
      },
      limit: {
        type:        "integer",
        description: "Max patents to return (default 15, max 50).",
        minimum:     1,
        maximum:     50,
      },
    },
  },

  outputSchema: {
    type:       "object",
    properties: {
      patents:     { type: "array"   },
      total_found: { type: "integer" },
      returned:    { type: "integer" },
      company:     { type: "string"  },
      ticker:      { type: "string"  },
      query:       { type: "string"  },
      note:        { type: "string"  },
      source:      { type: "string"  },
    },
  },

  async handler({ company, query, mode, limit = 15 }) {
    const resolvedMode = mode ?? (company ? "company" : (query ? "search" : null));
    if (!resolvedMode) throw new Error("Provide 'company' (ticker or name) for company mode, or 'query' for search mode.");

    if (resolvedMode === "company") {
      if (!company) throw new Error("Provide 'company' (ticker or company name) for mode=company.");
      return companyMode(company, limit);
    }

    if (!query) throw new Error("Provide 'query' for mode=search.");
    return searchMode(query, limit);
  },
};
