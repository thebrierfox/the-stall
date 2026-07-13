// nonprofit-intel.js
//
// Nonprofit financial intelligence via ProPublica Nonprofit Explorer.
//
// The IRS requires ~1.5M tax-exempt organizations to file Form 990 annually,
// disclosing revenue, expenses, assets, officer compensation, program spending,
// and governance data. ProPublica Nonprofit Explorer aggregates these public
// filings into a searchable API covering over 2M US nonprofits across 30+ years.
//
// Three modes:
//   1. search(org_name, state) — find nonprofits by name; optional two-letter
//      state filter. Returns up to 20 orgs: EIN, city, state, NTEE category,
//      latest reported revenue / assets / income.
//   2. by_ein(ein) — full financial history for an org by its 9-digit EIN.
//      Returns 990 filings for up to 10 years with revenue, expenses, assets,
//      officer compensation, program service revenue, and governance flags.
//   3. recent(ntee_code, state) — browse orgs by NTEE category (single letter:
//      A=Arts, B=Education, E=Health, P=Human Services, T=Philanthropy, etc.)
//      and/or state. Useful for sector-wide research.
//
// Source: ProPublica Nonprofit Explorer API v2 (free, no API key required).
// Data is sourced from IRS e-filing XML submissions; typically 3-12 months lag
// from filing date to public availability.
//
// Seam: due diligence on grant recipients, charity evaluations, executive
// compensation benchmarking, program efficiency (expense ratios), revenue trend
// analysis, and governance transparency scoring. No x402 cap surfaces 990 data.
// Pairs with fec-donor-intel (political giving), government-contract-intel
// (federal grants), and company-intel (for-profit benchmarking).
//
// Price: $0.008/call -- single ProPublica API round-trip per invocation.

const PP_BASE    = "https://projects.propublica.org/nonprofits/api/v2";
const UA         = "the-stall/4.68 nonprofit-intel (kyle@intuitek.ai)";
const TIMEOUT_MS = 14_000;

const NTEE_GROUPS = {
  A: "Arts, Culture & Humanities",
  B: "Education",
  C: "Environment",
  D: "Animal-Related",
  E: "Health Care",
  F: "Mental Health",
  G: "Diseases, Disorders & Medical Disciplines",
  H: "Medical Research",
  I: "Crime & Legal-Related",
  J: "Employment",
  K: "Food, Agriculture & Nutrition",
  L: "Housing & Shelter",
  M: "Public Safety & Disaster Preparedness",
  N: "Recreation & Sports",
  O: "Youth Development",
  P: "Human Services",
  Q: "International & Foreign Affairs",
  R: "Civil Rights, Social Action & Advocacy",
  S: "Community Improvement & Capacity Building",
  T: "Philanthropy, Voluntarism & Grantmaking",
  U: "Science & Technology",
  V: "Social Science",
  W: "Public & Societal Benefit",
  X: "Religion-Related",
  Y: "Mutual & Membership Benefit",
  Z: "Unknown / Unclassified",
};

function nteeLabel(code) {
  if (!code) return null;
  const letter = code[0].toUpperCase();
  return NTEE_GROUPS[letter] ? `${code} -- ${NTEE_GROUPS[letter]}` : code;
}

function fmtDollars(val) {
  if (val == null || val === "") return null;
  const n = Number(val);
  if (isNaN(n)) return null;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

function expenseRatio(revenue, expenses) {
  const r = Number(revenue), e = Number(expenses);
  if (!r || !e || isNaN(r) || isNaN(e)) return null;
  return `${((e / r) * 100).toFixed(1)}%`;
}

async function ppFetch(path, params) {
  const url = `${PP_BASE}/${path}${params ? "?" + new URLSearchParams(params) : ""}`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`ProPublica API ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

async function modeSearch(orgName, stateCode) {
  const params = { q: orgName };
  if (stateCode && stateCode.length === 2) params["state[id]"] = stateCode.toUpperCase();
  const data  = await ppFetch("search.json", params);
  const orgs  = data.organizations ?? [];
  const total = data.total_results ?? orgs.length;

  return {
    mode:          "search",
    query:         orgName,
    state_filter:  stateCode?.toUpperCase() ?? null,
    total_results: total,
    showing:       orgs.length,
    organizations: orgs.slice(0, 20).map(o => ({
      name:          o.name,
      ein:           o.ein,
      city:          o.city,
      state:         o.state,
      ntee_category: nteeLabel(o.ntee_code),
      revenue:       fmtDollars(o.revenue_amount),
      income:        fmtDollars(o.income_amount),
      assets:        fmtDollars(o.asset_amount),
      subsection:    o.subsection_code ? `501(c)(${o.subsection_code})` : null,
      ruling_year:   o.ruling_year ?? null,
      explorer_url:  `https://projects.propublica.org/nonprofits/organizations/${o.ein}`,
    })),
    source: "ProPublica Nonprofit Explorer (projects.propublica.org/nonprofits)",
  };
}

async function modeByEin(ein) {
  const cleanEin = String(ein).replace(/\D/g, "");
  if (cleanEin.length !== 9) throw new Error(`EIN must be 9 digits (received: ${ein})`);
  const data  = await ppFetch(`organizations/${cleanEin}.json`);
  const org   = data.organization ?? {};
  const filings = (data.filings_with_data ?? []).slice(0, 10);

  return {
    mode: "by_ein",
    profile: {
      name:           org.name,
      ein:            org.ein,
      city:           org.city,
      state:          org.state,
      zip:            org.zipcode,
      ntee_category:  nteeLabel(org.ntee_code),
      subsection:     org.subsection_code ? `501(c)(${org.subsection_code})` : null,
      ruling_year:    org.ruling_year,
      latest_revenue: fmtDollars(org.revenue_amount),
      latest_assets:  fmtDollars(org.asset_amount),
      explorer_url:   `https://projects.propublica.org/nonprofits/organizations/${cleanEin}`,
    },
    filings_count: filings.length,
    financial_history: filings.map(f => ({
      tax_year:             f.tax_prd_yr,
      period_end:           f.tax_prd,
      total_revenue:        fmtDollars(f.totrevenue),
      total_expenses:       fmtDollars(f.totfuncexpns),
      total_assets_eoy:     fmtDollars(f.totassetsend),
      total_liabilities:    fmtDollars(f.totliabend),
      net_assets:           fmtDollars(f.netassetsend),
      program_service_rev:  fmtDollars(f.prgmservrev),
      officer_compensation: fmtDollars(f.compnsatncurrofcr),
      employee_count:       f.noemployees ?? null,
      expense_ratio:        expenseRatio(f.totrevenue, f.totfuncexpns),
      audit_committee:      f.auditcommt === "1" ? true : f.auditcommt === "0" ? false : null,
      conflict_policy:      f.conflictsinterest === "1" ? true : f.conflictsinterest === "0" ? false : null,
      whistleblower_policy: f.wstlblwr === "1" ? true : f.wstlblwr === "0" ? false : null,
      form_type:            f.FormType,
      filing_pdf:           f.pdf_url ?? null,
    })),
    source: "ProPublica Nonprofit Explorer (projects.propublica.org/nonprofits)",
  };
}

async function modeRecent(nteeCode, stateCode) {
  const params = {};
  if (nteeCode) params["ntee[id]"] = nteeCode[0].toUpperCase();
  if (stateCode && stateCode.length === 2) params["state[id]"] = stateCode.toUpperCase();
  const data  = await ppFetch("search.json", params);
  const orgs  = data.organizations ?? [];
  const total = data.total_results ?? orgs.length;
  const nteeKey = nteeCode ? nteeCode[0].toUpperCase() : null;

  return {
    mode:          "recent",
    ntee_filter:   nteeKey ? `${nteeKey} -- ${NTEE_GROUPS[nteeKey] ?? ""}` : null,
    state_filter:  stateCode?.toUpperCase() ?? null,
    total_results: total,
    showing:       orgs.length,
    ntee_reference: NTEE_GROUPS,
    organizations: orgs.slice(0, 20).map(o => ({
      name:          o.name,
      ein:           o.ein,
      city:          o.city,
      state:         o.state,
      ntee_category: nteeLabel(o.ntee_code),
      revenue:       fmtDollars(o.revenue_amount),
      assets:        fmtDollars(o.asset_amount),
      ruling_year:   o.ruling_year ?? null,
      explorer_url:  `https://projects.propublica.org/nonprofits/organizations/${o.ein}`,
    })),
    source: "ProPublica Nonprofit Explorer (projects.propublica.org/nonprofits)",
  };
}

export default {
  name:  "nonprofit-intel",
  price: "$0.015",

  description:
    "Nonprofit financial intelligence from IRS Form 990 filings via ProPublica Nonprofit Explorer. " +
    "Mode 'search' (org_name, optional state): find nonprofits by name -- returns EIN, city, state, " +
    "NTEE category (B=Education, E=Health, T=Philanthropy), revenue, assets, and 501(c) subsection. " +
    "Mode 'by_ein' (ein): full financial history for a specific organization by 9-digit EIN -- " +
    "returns up to 10 years of 990 data: total revenue, total expenses, total assets, officer compensation, " +
    "program service revenue, expense ratio, employee count, and governance flags (audit committee, " +
    "conflict-of-interest policy, whistleblower policy). " +
    "Mode 'recent' (optional ntee_code, optional state): browse nonprofits by NTEE sector and/or state. " +
    "NTEE codes: A=Arts, B=Education, C=Environment, E=Health, G=Disease Research, H=Medical Research, " +
    "K=Food/Nutrition, L=Housing, P=Human Services, Q=International, T=Philanthropy, X=Religion. " +
    "Covers 2M+ US nonprofits. Free IRS public data via ProPublica. $0.008/call.",

  inputSchema: {
    type:       "object",
    properties: {
      mode: {
        type:        "string",
        enum:        ["search", "by_ein", "recent"],
        description: "'search' (default): find by organization name. 'by_ein': full 990 financial history by EIN. 'recent': browse by NTEE sector and/or state.",
      },
      org_name: {
        type:        "string",
        description: "Organization name to search for (mode=search). Example: 'American Red Cross', 'Gates Foundation', 'Planned Parenthood'.",
      },
      ein: {
        type:        "string",
        description: "9-digit IRS Employer Identification Number (mode=by_ein). Example: '530196605'. Hyphens stripped automatically.",
      },
      state: {
        type:        "string",
        description: "Two-letter US state code to filter results (optional). Example: 'NY', 'CA', 'TX'.",
      },
      ntee_code: {
        type:        "string",
        description: "NTEE major group letter for mode=recent (optional). A=Arts, B=Education, C=Environment, E=Health, G=Disease, H=Medical Research, K=Food, L=Housing, P=Human Services, Q=International, T=Philanthropy, X=Religion.",
      },
    },
  },

  outputSchema: {
    type:       "object",
    properties: {
      mode:              { type: "string"  },
      organizations:     { type: "array"   },
      profile:           { type: "object"  },
      financial_history: { type: "array"   },
      filings_count:     { type: "integer" },
      total_results:     { type: "integer" },
      showing:           { type: "integer" },
      ntee_reference:    { type: "object"  },
      source:            { type: "string"  },
    },
  },

  async handler({ mode = "search", org_name, ein, state, ntee_code }) {
    const m = mode.toLowerCase();

    if (m === "search") {
      const name = org_name ?? "";
      if (!name.trim()) throw new Error('search mode requires "org_name" parameter. Example: "American Red Cross".');
      return modeSearch(name.trim(), state);
    }

    if (m === "by_ein" || m === "ein") {
      if (!ein) throw new Error('by_ein mode requires "ein" parameter (9-digit IRS EIN). Example: "530196605".');
      return modeByEin(ein);
    }

    if (m === "recent") {
      return modeRecent(ntee_code ?? null, state ?? null);
    }

    throw new Error(`Unknown mode "${mode}". Valid modes: search, by_ein, recent`);
  },
};
