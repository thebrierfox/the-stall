// pubmed-intel.js
//
// PubMed / NCBI biomedical literature search and article retrieval.
// Covers 36M+ citations from MEDLINE, life science journals, and books.
//
// Two modes:
//   1. search(query, limit, year_start, year_end, article_type)
//      — full-text search with optional date/type filters. Returns title,
//        authors, journal, pub date, DOI, PMID. Ranked by relevance.
//   2. article(pmid)
//      — full article details: structured abstract, author affiliations,
//        MeSH terms, keywords, DOI, journal, dates.
//
// Source: NCBI E-utilities (eutils.ncbi.nlm.nih.gov) — public domain, no API key.
// Covers biomedical and life science literature since 1946; updated daily.
//
// Seam: pharma/biotech investment agents doing pipeline due diligence,
//       clinical researchers tracking competitive trial outcomes,
//       AI agents synthesizing scientific literature for drug mechanism
//       or disease-area analysis, healthcare tech platforms. No auth,
//       no key, no markup — NCBI mandates free open access to this data.
//
// Price: $0.008/call — one to two NCBI API calls per request.

const BASE    = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const UA      = "the-stall/4.69 pubmed-intel (kyle@intuitek.ai)";
const TIMEOUT = 15_000;

// Article type → PubMed filter term
const TYPE_MAP = {
  journal_article:    "Journal Article[pt]",
  clinical_trial:     "Clinical Trial[pt]",
  review:             "Review[pt]",
  meta_analysis:      "Meta-Analysis[pt]",
  case_report:        "Case Reports[pt]",
  systematic_review:  "Systematic Review[pt]",
  randomized_trial:   "Randomized Controlled Trial[pt]",
};

async function ncbi(endpoint, params) {
  const url = new URL(`${BASE}/${endpoint}`);
  url.searchParams.set("tool", "the-stall");
  url.searchParams.set("email", "kyle@intuitek.ai");
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": UA, Accept: "*/*" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`NCBI ${endpoint} HTTP ${res.status}`);
  return res;
}

// --- XML helpers (no external deps) ---

function xmlText(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m  = re.exec(xml);
  return m ? stripTags(m[1]).trim() : null;
}

function xmlAttr(block, attrName) {
  const re = new RegExp(`${attrName}="([^"]*)"`, "i");
  const m  = re.exec(block);
  return m ? m[1] : null;
}

function xmlAll(xml, tag) {
  const re  = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#x2009;/g, " ").replace(/&#\d+;/g, "").trim();
}

// --- Mode: search ---

async function buildQuery(query, yearStart, yearEnd, articleType) {
  let q = query.trim();
  if (yearStart || yearEnd) {
    const from = yearStart ?? "1946";
    const to   = yearEnd   ?? "3000";
    q += ` AND ${from}:${to}[pdat]`;
  }
  if (articleType) {
    const filter = TYPE_MAP[articleType];
    if (filter) q += ` AND ${filter}`;
  }
  return q;
}

async function searchPubmed(query, limit = 10, yearStart, yearEnd, articleType) {
  const term = await buildQuery(query, yearStart, yearEnd, articleType);
  const cap  = Math.min(limit, 50);

  // Step 1: esearch → get PMIDs
  const searchRes  = await ncbi("esearch.fcgi", { db: "pubmed", term, retmax: cap, format: "json" });
  const searchJson = await searchRes.json();
  const ids        = searchJson.esearchresult?.idlist ?? [];
  const total      = parseInt(searchJson.esearchresult?.count ?? "0", 10);

  if (ids.length === 0) {
    return { query, total_found: 0, articles: [], source: "NCBI PubMed E-utilities" };
  }

  // Step 2: esummary → get metadata for those PMIDs
  const summaryRes  = await ncbi("esummary.fcgi", { db: "pubmed", id: ids.join(","), format: "json" });
  const summaryJson = await summaryRes.json();
  const result      = summaryJson.result ?? {};

  const articles = ids.map((pmid) => {
    const r = result[pmid];
    if (!r) return null;

    const doi = (r.articleids ?? []).find((a) => a.idtype === "doi")?.value ?? null;
    const authors = (r.authors ?? [])
      .filter((a) => a.authtype === "Author")
      .map((a) => a.name)
      .slice(0, 6);

    return {
      pmid,
      title:        r.title ?? null,
      authors,
      journal:      r.source ?? null,
      pub_date:     r.pubdate ?? null,
      article_type: (r.pubtype ?? []).slice(0, 2),
      doi,
      pubmed_url:   `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    };
  }).filter(Boolean);

  return {
    query,
    total_found: total,
    returned: articles.length,
    articles,
    source: "NCBI PubMed E-utilities — eutils.ncbi.nlm.nih.gov",
    note: `Showing top ${articles.length} of ${total} results. Use article mode with a PMID for the full abstract.`,
  };
}

// --- Mode: article ---

async function articleDetail(pmid) {
  const cleanId = String(pmid).replace(/\D/g, "");
  if (!cleanId) throw new Error("pmid must be a numeric PubMed ID");

  const xmlRes = await ncbi("efetch.fcgi", { db: "pubmed", id: cleanId, retmode: "xml" });
  const xml    = await xmlRes.text();

  // Title
  const title = xmlText(xml, "ArticleTitle") ?? null;

  // Journal
  const journalFull = xmlText(xml, "Title") ?? null;
  const journalAbbr = xmlText(xml, "ISOAbbreviation") ?? null;

  // Volume, issue, pages
  const volume = xmlText(xml, "Volume") ?? null;
  const issue  = xmlText(xml, "Issue") ?? null;
  const pages  = xmlText(xml, "MedlinePgn") ?? null;

  // Pub date — try ArticleDate first, then MedlineDate, then Year/Month inside PubDate
  const artDateBlock = xml.match(/<ArticleDate[^>]*>([\s\S]*?)<\/ArticleDate>/i)?.[1] ?? "";
  const pubYear  = xmlText(artDateBlock || xml, "Year") ?? null;
  const pubMonth = xmlText(artDateBlock || xml, "Month") ?? null;
  const pubDate  = [pubYear, pubMonth].filter(Boolean).join(" ") || null;

  // Authors with affiliations
  const authorBlocks = xmlAll(xml, "Author");
  const authors = authorBlocks.map((block) => {
    const last  = xmlText(block, "LastName") ?? "";
    const fore  = xmlText(block, "ForeName") ?? xmlText(block, "Initials") ?? "";
    const name  = [fore, last].filter(Boolean).join(" ") || null;
    const affil = xmlText(block, "AffiliationInfo") ?? xmlText(block, "Affiliation") ?? null;
    return { name, affiliation: affil };
  }).filter((a) => a.name);

  // Abstract — may be structured (Background, Methods, etc.) or plain
  const abstractBlocks = xml.match(/<AbstractText(?:\s[^>]*)?>[\s\S]*?<\/AbstractText>/gi) ?? [];
  let abstract_text = null;
  if (abstractBlocks.length === 1) {
    abstract_text = stripTags(abstractBlocks[0]);
  } else if (abstractBlocks.length > 1) {
    // structured abstract
    abstract_text = abstractBlocks.map((block) => {
      const label = xmlAttr(block, "Label") ?? xmlAttr(block, "NlmCategory");
      const body  = stripTags(block);
      return label ? `${label}: ${body}` : body;
    }).join("\n");
  }

  // Keywords
  const kwBlocks  = xmlAll(xml, "Keyword");
  const keywords  = kwBlocks.map(stripTags).filter(Boolean);

  // MeSH terms
  const meshBlocks = xmlAll(xml, "DescriptorName");
  const mesh_terms = meshBlocks.map(stripTags).filter(Boolean).slice(0, 15);

  // DOI
  const doiBlock = xml.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/i);
  const doi      = doiBlock ? doiBlock[1].trim() : null;

  // PMC ID for open access
  const pmcBlock = xml.match(/<ArticleId IdType="pmc">([^<]+)<\/ArticleId>/i);
  const pmc_id   = pmcBlock ? pmcBlock[1].trim() : null;

  return {
    pmid:        cleanId,
    title,
    authors,
    journal:     journalFull ?? journalAbbr,
    journal_abbr: journalAbbr,
    volume,
    issue,
    pages,
    pub_date:    pubDate,
    abstract:    abstract_text,
    keywords,
    mesh_terms,
    doi,
    pmc_id,
    pubmed_url:  `https://pubmed.ncbi.nlm.nih.gov/${cleanId}/`,
    full_text_url: pmc_id ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmc_id}/` : null,
    source:      "NCBI PubMed E-utilities — efetch XML",
  };
}

// --- Dispatch ---

export default {
  name: "pubmed-intel",
  price: "$0.021",

  description:
    "PubMed biomedical literature search and article retrieval across 36M+ NCBI/MEDLINE citations. search mode: find papers by keyword with optional year range and article type filter (clinical_trial, review, meta_analysis, systematic_review, randomized_trial, case_report) — returns PMID, title, authors, journal, date, DOI. article mode: full article details for a PMID — structured abstract, author affiliations, MeSH terms, keywords, DOI, PMC open-access link. No API key. Covers all biomedical and life science literature since 1946.",

  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["search", "article"],
        description: "search: find papers by query | article: full details for a specific PMID",
      },
      query: {
        type: "string",
        description: "Search query for search mode. Supports PubMed syntax: e.g. 'CRISPR cancer[Title]', 'Alzheimer treatment', 'COVID-19 mRNA vaccine efficacy'.",
      },
      pmid: {
        type: ["string", "number"],
        description: "PubMed ID for article mode. Example: '38650234' or 38650234.",
      },
      limit: {
        type: "number",
        description: "Max results to return in search mode. Default 10, max 50.",
      },
      year_start: {
        type: "number",
        description: "Filter search results to this year or later. Example: 2020.",
      },
      year_end: {
        type: "number",
        description: "Filter search results to this year or earlier. Example: 2024.",
      },
      article_type: {
        type: "string",
        enum: [
          "journal_article",
          "clinical_trial",
          "review",
          "meta_analysis",
          "case_report",
          "systematic_review",
          "randomized_trial",
        ],
        description: "Filter by article type. clinical_trial: FDA-registered trials. review: narrative reviews. meta_analysis: quantitative evidence synthesis. systematic_review: PRISMA-style. randomized_trial: RCTs.",
      },
    },
    required: ["mode"],
  },

  outputSchema: {
    type: "object",
    properties: {
      query:       { type: "string"  },
      total_found: { type: "integer" },
      returned:    { type: "integer" },
      articles:    { type: "array"   },
      pmid:        { type: "string"  },
      title:       { type: "string"  },
      authors:     { type: "array"   },
      journal:     { type: "string"  },
      pub_date:    { type: "string"  },
      abstract:    { type: "string"  },
      keywords:    { type: "array"   },
      mesh_terms:  { type: "array"   },
      doi:         { type: "string"  },
      pmc_id:      { type: "string"  },
      pubmed_url:  { type: "string"  },
      full_text_url: { type: "string" },
      source:      { type: "string"  },
    },
  },

  async handler({ mode, query, pmid, limit, year_start, year_end, article_type }) {
    switch (mode) {
      case "search": {
        if (!query) throw new Error("query is required for search mode");
        return searchPubmed(
          query,
          limit       ?? 10,
          year_start  ?? null,
          year_end    ?? null,
          article_type ?? null,
        );
      }
      case "article": {
        if (pmid == null) throw new Error("pmid is required for article mode");
        return articleDetail(pmid);
      }
      default:
        throw new Error(`Unknown mode "${mode}". Use search or article.`);
    }
  },
};
