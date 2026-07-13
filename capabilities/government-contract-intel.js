// government-contract-intel.js
//
// Federal government contract award tracker via USASpending.gov public API.
//
// The U.S. government awards over $700B in contracts annually to private-sector
// companies. USASpending.gov is the authoritative public database of all federal
// contract awards, grants, loans, and other financial assistance — updated daily
// via the Federal Procurement Data System (FPDS-NG) and USASpending feeds.
//
// Three modes:
//   1. company(company_name) — all federal contract awards to a named company,
//      sorted by award amount. Shows which agencies hired them, for what, and
//      how much. Critical for defense/tech/healthcare stock due diligence.
//   2. recent(days, min_amount_millions) — market-wide feed of large new contract
//      awards in the last N days, optional minimum-dollar filter. Shows who is
//      winning the big government deals.
//   3. agency(agency_name, days) — what contracts has a federal agency awarded
//      recently? Useful for tracking DoD procurement cycles, NIH grants, etc.
//
// Source: USASpending.gov public API (no API key required, government open data).
// Data flows daily from FPDS-NG (contracts) and SAM.gov (awards ≥ $25K reported).
//
// Seam: defense/aerospace contractor revenue tracking, government-tech procurement,
// healthcare government contracts, infrastructure spending analysis. No x402 cap
// surfaces federal award data. Pairs with company-intel + earnings-calendar for
// full government-contractor coverage. Prime use: "Will Lockheed win the F-47?"
// or "What agencies are paying Palantir right now?"
//
// Price: $0.015 — multi-round POST API; unique government procurement dataset.

const BASE_URL   = "https://api.usaspending.gov/api/v2";
const UA         = "the-stall/4.67 government-contract-intel (kyle@intuitek.ai)";
const TIMEOUT_MS = 15_000;

// Contract award type codes (excludes grants, loans)
const CONTRACT_TYPES = ["A", "B", "C", "D"];

// Human-readable award type labels
const AWARD_TYPE_LABELS = {
  A: "BPA Call",
  B: "Purchase Order",
  C: "Delivery Order",
  D: "Definitive Contract",
};

// Fields to retrieve from the awards search endpoint
const AWARD_FIELDS = [
  "Award ID",
  "Recipient Name",
  "Start Date",
  "End Date",
  "Award Amount",
  "Awarding Agency",
  "Awarding Sub Agency",
  "Award Type",
  "Description",
  "Place of Performance State Code",
  "Place of Performance City Name",
  "Last Modified Date",
  "Base All Options Value",
];

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function searchAwards(filters, limit, sortField = "Award Amount") {
  const body = {
    filters,
    fields:  AWARD_FIELDS,
    page:    1,
    limit:   Math.min(limit, 100),
    sort:    sortField,
    order:   "desc",
    subawards: false,
  };

  const r = await fetch(`${BASE_URL}/search/spending_by_award/`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent":   UA,
    },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`USASpending API ${r.status}: ${errText.slice(0, 200)}`);
  }

  return r.json();
}

function formatAward(raw) {
  return {
    award_id:          raw["Award ID"]            ?? null,
    recipient:         raw["Recipient Name"]       ?? null,
    description:       raw["Description"]          ?? null,
    award_amount_usd:  raw["Award Amount"]         ?? null,
    base_all_options:  raw["Base All Options Value"] ?? null,
    award_type:        raw["Award Type"]           ?? null,
    award_type_label:  AWARD_TYPE_LABELS[raw["Award Type"]] ?? raw["Award Type"] ?? null,
    start_date:        raw["Start Date"]           ?? null,
    end_date:          raw["End Date"]             ?? null,
    last_modified:     raw["Last Modified Date"]   ?? null,
    awarding_agency:   raw["Awarding Agency"]      ?? null,
    awarding_sub_agency: raw["Awarding Sub Agency"] ?? null,
    place_of_performance: [
      raw["Place of Performance City Name"],
      raw["Place of Performance State Code"],
    ].filter(Boolean).join(", ") || null,
    usaspending_url: raw["Award ID"]
      ? `https://www.usaspending.gov/award/${raw["Award ID"]}/`
      : null,
  };
}

// Mode 1: awards to a specific company
async function companyMode(companyName, days, limit) {
  const filters = {
    award_type_codes: CONTRACT_TYPES,
    recipient_search_text: [companyName],
    time_period: days
      ? [{ start_date: daysAgo(days), end_date: today() }]
      : undefined,
  };
  if (!days) delete filters.time_period;

  const data   = await searchAwards(filters, limit);
  const awards = (data.results ?? []).map(formatAward);

  const totalUsd = awards.reduce((s, a) => s + (a.award_amount_usd ?? 0), 0);
  const agencies = [...new Set(awards.map(a => a.awarding_agency).filter(Boolean))];

  return {
    mode:           "company",
    company_query:  companyName,
    days_searched:  days ?? "all time",
    returned:       awards.length,
    total_in_db:    data.page_metadata?.total ?? null,
    sum_amount_usd: totalUsd,
    top_agencies:   agencies.slice(0, 10),
    awards,
    note: "Amounts in USD. 'Award Amount' = obligated amount; 'Base All Options Value' includes option years if exercised. Data from FPDS-NG via USASpending.gov, updated daily.",
    source: "USASpending.gov public API (api.usaspending.gov/api/v2)",
  };
}

// Mode 2: market-wide recent contract awards (largest first)
async function recentMode(days, minAmountMillions, limit) {
  const capped = Math.min(days, 180);
  const filters = {
    award_type_codes: CONTRACT_TYPES,
    time_period: [{ start_date: daysAgo(capped), end_date: today() }],
  };

  if (minAmountMillions > 0) {
    filters.award_amounts = [
      { lower_bound: minAmountMillions * 1_000_000, upper_bound: 999_000_000_000 },
    ];
  }

  const data   = await searchAwards(filters, limit);
  const awards = (data.results ?? []).map(formatAward);

  return {
    mode:                      "recent",
    days_searched:             capped,
    min_amount_filter_millions: minAmountMillions > 0 ? minAmountMillions : null,
    total_in_db:               data.page_metadata?.total ?? null,
    returned:                  awards.length,
    awards,
    note: "Sorted by Award Amount descending. Includes all federal contract types (definitive contracts, delivery orders, purchase orders, BPA calls). Data from FPDS-NG, updated daily.",
    source: "USASpending.gov public API (api.usaspending.gov/api/v2)",
  };
}

// Mode 3: what has a federal agency awarded recently
async function agencyMode(agencyName, days, limit) {
  const capped = Math.min(days, 180);
  const filters = {
    award_type_codes: CONTRACT_TYPES,
    time_period: [{ start_date: daysAgo(capped), end_date: today() }],
    agencies: [{ type: "awarding", tier: "toptier", name: agencyName }],
  };

  const data   = await searchAwards(filters, limit);
  const awards = (data.results ?? []).map(formatAward);

  const totalUsd   = awards.reduce((s, a) => s + (a.award_amount_usd ?? 0), 0);
  const recipients = [...new Set(awards.map(a => a.recipient).filter(Boolean))];

  return {
    mode:                 "agency",
    agency_query:         agencyName,
    days_searched:        capped,
    total_in_db:          data.page_metadata?.total ?? null,
    returned:             awards.length,
    sum_amount_usd:       totalUsd,
    unique_recipients:    recipients.length,
    top_recipients:       recipients.slice(0, 10),
    awards,
    note: "Top-tier agency match (e.g., 'Department of Defense' returns all DoD sub-agencies). For sub-agency: use tier='subtier' if results are empty — the API uses official USASpending agency names.",
    source: "USASpending.gov public API (api.usaspending.gov/api/v2)",
  };
}

export default {
  name:  "government-contract-intel",
  price: "$0.021",

  description:
    "Federal government contract award tracker via USASpending.gov (no API key). " +
    "The U.S. government awards $700B+ annually — this cap surfaces who wins the money, how much, and for what. " +
    "Mode 'company' (company_name): all federal contracts awarded to a named company — which agencies, what amounts, optional last-N-days filter. " +
    "Essential for defense/aerospace (Lockheed, Raytheon, Northrop), tech government contractors (Palantir, Leidos, SAIC, Booz Allen), " +
    "and healthcare (McKesson, UnitedHealth). " +
    "Mode 'recent' (days, min_amount_millions): market-wide feed of largest new awards in the last N days, optional floor filter. " +
    "Mode 'agency' (agency_name, days): what contracts has a federal agency (DoD, HHS, NASA, DHS) awarded recently and to whom. " +
    "All data from FPDS-NG via USASpending.gov, updated daily. $0.015/call.",

  inputSchema: {
    type:       "object",
    properties: {
      mode: {
        type:        "string",
        enum:        ["company", "recent", "agency"],
        description: "'company': contracts awarded to a named company. 'recent': market-wide largest new awards. 'agency': contracts awarded by a federal agency. Default: 'company' if company_name provided, else 'recent'.",
      },
      company_name: {
        type:        "string",
        description: "Company or contractor name to search (partial match OK). Used in company mode. Examples: 'Lockheed Martin', 'Palantir', 'Raytheon', 'General Dynamics', 'Leidos'.",
      },
      agency_name: {
        type:        "string",
        description: "Federal agency name for agency mode. Use official USASpending names: 'Department of Defense', 'Department of Health and Human Services', 'NASA', 'Department of Homeland Security', 'Department of Veterans Affairs'.",
      },
      days: {
        type:        "integer",
        description: "Calendar days back to search (default 90, max 180). In company mode, omit for all-time history.",
        minimum:     1,
        maximum:     180,
      },
      min_amount_millions: {
        type:        "number",
        description: "For mode=recent: only return awards >= this amount in USD millions (e.g., 100 = $100M+). Default 0 = no filter.",
        minimum:     0,
      },
      limit: {
        type:        "integer",
        description: "Max results to return (default 25, max 100).",
        minimum:     1,
        maximum:     100,
      },
    },
  },

  outputSchema: {
    type:       "object",
    properties: {
      mode:                       { type: "string" },
      company_query:              { type: "string" },
      agency_query:               { type: "string" },
      days_searched:              { type: ["integer", "string"] },
      returned:                   { type: "integer" },
      total_in_db:                { type: "integer" },
      sum_amount_usd:             { type: "number" },
      top_agencies:               { type: "array", items: { type: "string" } },
      top_recipients:             { type: "array", items: { type: "string" } },
      unique_recipients:          { type: "integer" },
      min_amount_filter_millions: { type: "number" },
      awards:                     { type: "array" },
      note:                       { type: "string" },
      source:                     { type: "string" },
    },
  },

  async handler({ mode, company_name, agency_name, days, min_amount_millions = 0, limit = 25 }) {
    const resolvedMode = mode
      ?? (company_name ? "company" : agency_name ? "agency" : "recent");

    if (resolvedMode === "company") {
      if (!company_name) throw new Error("Provide 'company_name' for company mode.");
      return companyMode(company_name, days ?? null, limit);
    }

    if (resolvedMode === "agency") {
      if (!agency_name) throw new Error("Provide 'agency_name' for agency mode. Example: 'Department of Defense'.");
      return agencyMode(agency_name, days ?? 90, limit);
    }

    // default: recent
    return recentMode(days ?? 90, min_amount_millions, limit);
  },
};
