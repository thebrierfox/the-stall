// vc-funding-intel.js
//
// Private fundraising round tracker via SEC Form D EDGAR filings.
//
// Regulation D (Rule 504, Rule 506(b), Rule 506(c)) offerings must be reported
// to the SEC within 15 days of the first sale of securities — making Form D a
// near-real-time window into private capital raises: venture rounds, PE buyouts,
// hedge fund raises, real estate syndicates, and startup seed rounds.
//
// Two modes:
//   1. company(company_name) — Form D filings for a specific company, with
//      amount raised, industry group, exemption type, investor count, and state.
//   2. recent(days)         — market-wide feed of new Reg D offerings in the
//      last N days, optional minimum-amount filter.
//
// Source: SEC EDGAR public APIs (efts.sec.gov + EDGAR Archives). No API key, no auth.
// Form D required within 15 days of first sale — data is near-real-time.
//
// Seam: competitive VC intelligence, startup due diligence, deal-flow tracking,
// industry fundraising trends. No x402 cap currently surfaces private-company
// fundraising data. Pairs with merger-acquisition-intel + activist-investor-intel
// for full corporate-action coverage.
//
// Price: $0.015 — EDGAR EFTS + XML round-trips; unique private-company dataset.

const UA         = "the-stall/4.67 vc-funding-intel (kyle@intuitek.ai)";
const EFTS_BASE  = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_BASE = "https://www.sec.gov/Archives/edgar/data";
const TIMEOUT_MS = 14_000;
const XML_TIMEOUT = 8_000;

// Regulation D exemption codes as they appear in Form D XML
const EXEMPTION_LABELS = {
  "06b": "Rule 506(b) — unlimited raise, no general solicitation, accredited investors",
  "06c": "Rule 506(c) — unlimited raise, general solicitation allowed, verified accredited only",
  "04b": "Rule 504 — up to $10M, state-registered",
  "3C":  "Section 3(c) — investment company exclusion",
  "3C1": "Section 3(c)(1) — private fund ≤100 beneficial owners",
  "3C7": "Section 3(c)(7) — qualified purchasers only",
};

// Extract a single XML tag's text content by local name (namespace-agnostic)
function xmlVal(text, tag) {
  const re = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tag}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*<`, "i");
  const m  = text.match(re);
  return m ? m[1].trim() : null;
}

// Extract all text values for a repeated XML tag
function xmlAll(text, tag) {
  const re      = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tag}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*<`, "gi");
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null) results.push(m[1].trim());
  return results;
}

function parseCikFromAccession(adsh) {
  // adsh format: "0001234567-26-001234" — first segment is zero-padded CIK
  if (!adsh) return null;
  return adsh.split("-")[0].replace(/^0+/, "") || null;
}

function buildEdgarXmlUrl(adsh, cik) {
  if (!adsh || !cik) return null;
  const clean = adsh.replace(/-/g, "");
  return `${EDGAR_BASE}/${cik}/${clean}/primary_doc.xml`;
}

function buildEdgarViewUrl(adsh, cik) {
  if (!adsh || !cik) return null;
  const clean = adsh.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${clean}/${adsh}.txt`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function fetchFormDDetail(adsh, cik) {
  const url = buildEdgarXmlUrl(adsh, cik);
  if (!url) return {};
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA },
      signal:  AbortSignal.timeout(XML_TIMEOUT),
    });
    if (!r.ok) return {};
    const xml = await r.text();

    const totalOffering = xmlVal(xml, "totalOfferingAmount");
    const totalSold     = xmlVal(xml, "totalAmountSold");
    const totalRemaining = xmlVal(xml, "totalAmountRemaining");
    const industry      = xmlVal(xml, "industryGroupType");
    const firstSale     = xmlVal(xml, "dateOfFirstSale");
    const numInvestors  = xmlVal(xml, "totalNumberAlreadyInvested");
    const stateOrCountry = xmlVal(xml, "stateOrCountry");
    const isamendment   = xmlVal(xml, "isAmendment");

    // Extract Reg D exemption types from the federalExemptionsExclusions section
    const exemptions = [];
    const exemSectionRe = /<(?:[a-zA-Z0-9_]+:)?federalExemptionsExclusions[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?federalExemptionsExclusions>/i;
    const exemSection = xml.match(exemSectionRe);
    if (exemSection) {
      const itemRe = /<(?:[a-zA-Z0-9_]+:)?item[^>]*>([^<]+)<\/(?:[a-zA-Z0-9_]+:)?item>/gi;
      let em;
      while ((em = itemRe.exec(exemSection[1])) !== null) {
        const code = em[1].trim();
        exemptions.push({ code, label: EXEMPTION_LABELS[code] ?? code });
      }
    }

    const offered  = totalOffering ? parseFloat(totalOffering)  : null;
    const sold     = totalSold     ? parseFloat(totalSold)       : null;
    const remaining = totalRemaining ? parseFloat(totalRemaining) : null;

    return {
      total_offering_amount_usd: offered,
      total_amount_sold_usd:     sold,
      total_remaining_usd:       remaining,
      raise_pct_complete:        offered && sold ? Math.round(sold / offered * 100) : null,
      industry_group:            industry        ?? null,
      date_of_first_sale:        firstSale       ?? null,
      num_investors_so_far:      numInvestors    ? parseInt(numInvestors, 10) : null,
      state_or_country:          stateOrCountry  ?? null,
      is_amendment:              isamendment === "true",
      exemptions:                exemptions.length ? exemptions : null,
    };
  } catch {
    return {};
  }
}

function extractCompanyName(src) {
  const names = src.display_names ?? [];
  if (names.length > 0) return names[0].split(" (CIK")[0].trim();
  return src.entity_name ?? "(unknown)";
}

// Company mode: search EFTS by company name, fetch XML detail for each hit
async function searchByCompany(companyName, limit) {
  const params = new URLSearchParams({
    q:     `"${companyName}"`,
    forms: "D,D/A",
    from:  "0",
    size:  String(Math.min(limit, 20)),
  });

  const r = await fetch(`${EFTS_BASE}?${params}`, {
    headers: { "User-Agent": UA },
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`EDGAR EFTS ${r.status}`);
  const data  = await r.json();
  const hits  = data?.hits?.hits ?? [];
  const total = data?.hits?.total?.value ?? 0;

  const filings = await Promise.all(hits.map(async h => {
    const src    = h._source ?? {};
    const adsh   = src.adsh  ?? "";
    const cik    = parseCikFromAccession(adsh);
    const detail = await fetchFormDDetail(adsh, cik);
    return {
      company_name: extractCompanyName(src),
      filing_date:  src.file_date             ?? null,
      period_of_report: src.period_of_report  ?? null,
      form_type:    src.form                  ?? "D",
      cik,
      accession:    adsh,
      edgar_url:    buildEdgarViewUrl(adsh, cik),
      ...detail,
    };
  }));

  return {
    query:          companyName,
    total_filings:  total,
    returned:       filings.length,
    filings,
    note: "Form D required within 15 days of first sale. Matches by company name — refine query if too broad.",
    source: "SEC EDGAR EFTS + Form D XML (efts.sec.gov)",
  };
}

// Recent mode: market-wide Form D feed, fetch XML detail in parallel for all results
async function recentFilings(days, minAmountMillions, limit) {
  const capped = Math.min(days, 90);
  const params = new URLSearchParams({
    forms:     "D",
    dateRange: "custom",
    startdt:   daysAgo(capped),
    enddt:     new Date().toISOString().slice(0, 10),
    from:      "0",
    size:      String(Math.min(limit, 50)),
  });

  const r = await fetch(`${EFTS_BASE}?${params}`, {
    headers: { "User-Agent": UA },
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`EDGAR EFTS ${r.status}`);
  const data  = await r.json();
  const hits  = data?.hits?.hits ?? [];
  const total = data?.hits?.total?.value ?? 0;

  // Fetch XML in parallel — parallel calls stay within XML_TIMEOUT each
  const filings = await Promise.all(hits.map(async h => {
    const src    = h._source ?? {};
    const adsh   = src.adsh  ?? "";
    const cik    = parseCikFromAccession(adsh);
    const detail = await fetchFormDDetail(adsh, cik);
    return {
      company_name:      extractCompanyName(src),
      filing_date:       src.file_date ?? null,
      form_type:         src.form      ?? "D",
      cik,
      accession:         adsh,
      edgar_url:         buildEdgarViewUrl(adsh, cik),
      ...detail,
    };
  }));

  // Apply minimum amount filter post-fetch
  const minUsd = minAmountMillions * 1_000_000;
  const filtered = minUsd > 0
    ? filings.filter(f => f.total_amount_sold_usd == null || f.total_amount_sold_usd >= minUsd)
    : filings;

  return {
    days_searched:              capped,
    total_form_d_in_edgar:      total,
    returned:                   filtered.length,
    min_amount_filter_millions: minAmountMillions > 0 ? minAmountMillions : null,
    filings:                    filtered,
    note: "Form D must be filed within 15 days of first securities sale. Includes VC rounds, PE deals, hedge funds, real estate syndicates. Amendments (D/A) not included unless specifically searched.",
    source: "SEC EDGAR EFTS full-text search (efts.sec.gov)",
  };
}

export default {
  name:  "vc-funding-intel",
  price: "$0.021",

  description:
    "Private fundraising round tracker via SEC Form D EDGAR filings. " +
    "Regulation D offerings (Rule 506(b)/506(c)/504) must be reported within 15 days of first sale " +
    "— a near-real-time window into VC rounds, PE buyouts, startup raises, hedge fund raises, " +
    "and real estate syndicates. " +
    "Mode 'company' (company_name): all Form D filings for that company with amount raised, " +
    "industry group, exemption type (506b/506c/504), investor count, and state. " +
    "Mode 'recent': market-wide feed of new Reg D offerings in the last N days (max 90), " +
    "filterable by minimum raise amount in millions. " +
    "Free SEC government data, no API key. $0.015/call.",

  inputSchema: {
    type:       "object",
    properties: {
      company_name: {
        type:        "string",
        description: "Company or fund name to search (partial match OK, quoted exact phrase). Used in company mode.",
      },
      mode: {
        type:        "string",
        enum:        ["company", "recent"],
        description: "'company' (default when company_name given): Form D filings for that company with full detail. 'recent': market-wide Form D feed in last N days.",
      },
      days: {
        type:        "integer",
        description: "For mode=recent: calendar days back to search (default 14, max 90).",
        minimum:     1,
        maximum:     90,
      },
      min_amount_millions: {
        type:        "number",
        description: "For mode=recent: filter to raises with total_amount_sold >= this many USD millions (e.g., 5 = $5M+ raises only). Default 0 = no filter.",
        minimum:     0,
      },
      limit: {
        type:        "integer",
        description: "Max results to return (default 20, max 50).",
        minimum:     1,
        maximum:     50,
      },
    },
  },

  outputSchema: {
    type:       "object",
    properties: {
      filings:                   { type: "array" },
      total_filings:             { type: "integer" },
      total_form_d_in_edgar:     { type: "integer" },
      returned:                  { type: "integer" },
      days_searched:             { type: "integer" },
      min_amount_filter_millions: { type: "number" },
      note:                      { type: "string" },
      source:                    { type: "string" },
    },
  },

  async handler({ company_name, mode, days = 14, min_amount_millions = 0, limit = 20 }) {
    const resolvedMode = mode ?? (company_name ? "company" : "recent");

    if (resolvedMode === "company") {
      if (!company_name) throw new Error("Provide 'company_name' for company mode, or use mode='recent'.");
      return searchByCompany(company_name, Math.min(limit, 20));
    }

    return recentFilings(days, min_amount_millions > 0 ? min_amount_millions : 0, Math.min(limit, 50));
  },
};
