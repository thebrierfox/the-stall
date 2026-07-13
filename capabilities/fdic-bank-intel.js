// fdic-bank-intel.js
//
// FDIC BankFind Suite — US bank financial health, active institutions,
// and historical bank failure data from the Federal Deposit Insurance Corporation.
// Covers 10,000+ FDIC-insured institutions, 4,000+ historical bank failures,
// and quarterly financial performance metrics for every US commercial bank.
//
// Three modes:
//   1. search(query, limit)       — find institutions by name. Returns asset size,
//                                  state, FDIC certificate number, and active status.
//   2. profile(name_or_cert)      — deep financial profile: ROA, ROE, risk-based
//                                  capital ratio, net income, loans, deposits.
//                                  Pulls most-recent quarterly Call Report data.
//   3. failures(limit, year)      — recent bank failures: fail date, assets at
//                                  failure, resolution type (purchase & assumption,
//                                  payoff, etc.). 4,100+ failures since 1934.
//
// Source: api.fdic.gov/banks — FDIC BankFind Suite API (public, no auth).
// Updated: institutions weekly, financials quarterly (Call Report cycle),
// failures within days of FDIC press release.
//
// Seam: SVB, Signature, First Republic — agents doing banking-sector due diligence,
// credit risk analysis, M&A screening, and regional bank monitoring need FDIC data.
// No other x402/MCP cap covers regulatory bank financials.
//
// Price: $0.010 — single FDIC API call, structured output.

const FDIC_BASE   = "https://api.fdic.gov/banks";
const TIMEOUT_MS  = 12_000;
const UA          = "the-stall/4.69 fdic-bank-intel (kyle@intuitek.ai)";

// Resolution type codes → human-readable
const RESTYPE_MAP = {
  PA:  "Purchase & Assumption",
  PI:  "Payoff & Insured Deposit Transfer",
  OA:  "Open Bank Assistance",
  RA:  "Reimbursement Agreement",
  MB:  "Modified Payoff",
};

function toB(thousands) {
  if (thousands == null) return null;
  return parseFloat((thousands / 1_000_000).toFixed(3)); // billions
}
function toM(thousands) {
  if (thousands == null) return null;
  return parseFloat((thousands / 1_000).toFixed(1)); // millions
}
function pct(v) {
  return v != null ? parseFloat(v.toFixed(2)) : null;
}

async function fdic(path, params) {
  const url = new URL(`${FDIC_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`FDIC ${path} HTTP ${res.status}`);
  return res.json();
}

// --- Mode: search ---
function buildNameFilter(query) {
  const words = query.trim().toUpperCase().split(/\s+/).filter(Boolean);
  return words.map((w) => `NAME:*${w}*`).join(" AND ");
}

async function searchBanks(query, limit = 10) {
  const nameFilter = buildNameFilter(query);
  const data = await fdic("institutions", {
    filters: nameFilter,
    fields: "NAME,CERT,STNAME,STALP,ASSET,DEP,ACTIVE,REPDTE",
    sort_by: "ASSET",
    sort_order: "DESC",
    limit: String(Math.min(limit, 50)),
  });
  const results = (data.data || []).map((r) => {
    const d = r.data;
    return {
      name:     d.NAME,
      cert:     d.CERT,
      state:    d.STALP || d.STNAME,
      assets_b: toB(d.ASSET),
      deposits_b: toB(d.DEP),
      active:   d.ACTIVE === 1,
      report_date: d.REPDTE,
    };
  });
  return {
    query,
    total_found: data.meta?.total ?? results.length,
    institutions: results,
    source: "FDIC BankFind Suite — api.fdic.gov/banks/institutions",
    note: "Assets in $ billions. CERT = FDIC certificate number (use for profile mode).",
  };
}

// --- Mode: profile ---
async function bankProfile(nameOrCert) {
  let cert;
  let bankName;

  // Resolve name → cert
  if (typeof nameOrCert === "number" || /^\d+$/.test(String(nameOrCert))) {
    cert = parseInt(nameOrCert, 10);
  } else {
    const nameFilter = buildNameFilter(String(nameOrCert));
    const inst = await fdic("institutions", {
      filters: nameFilter,
      fields: "NAME,CERT,STNAME,STALP,ASSET,ACTIVE",
      sort_by: "ASSET",
      sort_order: "DESC",
      limit: "1",
    });
    const hit = inst.data?.[0]?.data;
    if (!hit) throw new Error(`No institution found matching "${nameOrCert}"`);
    cert = hit.CERT;
    bankName = hit.NAME;
  }

  // Fetch institution record
  const instData = await fdic("institutions", {
    filters: `CERT:${cert}`,
    fields: "NAME,CERT,STNAME,STALP,ASSET,DEP,ACTIVE,REPDTE,RSSDID,STALP",
    limit: "1",
  });
  const inst = instData.data?.[0]?.data;
  if (!inst) throw new Error(`CERT ${cert} not found in FDIC institutions`);

  // Fetch most-recent financials (latest reporting period)
  const finData = await fdic("financials", {
    filters: `CERT:${cert}`,
    fields: "REPDTE,CERT,ASSET,DEP,NETINC,INTINC,NONII,EQ,SC,LNLSNET,ROA,ROE,RBCRWAJ,NCLNLS",
    sort_by: "REPDTE",
    sort_order: "DESC",
    limit: "1",
  });
  const fin = finData.data?.[0]?.data;

  return {
    name:        inst.NAME,
    cert:        inst.CERT,
    state:       inst.STALP || inst.STNAME,
    active:      inst.ACTIVE === 1,
    rssd_id:     inst.RSSDID || null,
    report_date: fin?.REPDTE || inst.REPDTE,
    balance_sheet: {
      total_assets_b:    toB(fin?.ASSET ?? inst.ASSET),
      total_deposits_b:  toB(fin?.DEP ?? inst.DEP),
      total_equity_b:    toB(fin?.EQ),
      net_loans_b:       toB(fin?.LNLSNET),
      securities_b:      toB(fin?.SC),
      noncurrent_loans_m: toM(fin?.NCLNLS),
    },
    income: {
      net_income_m:        toM(fin?.NETINC),
      interest_income_m:   toM(fin?.INTINC),
      noninterest_income_m: toM(fin?.NONII),
    },
    ratios: {
      roa_pct:                  pct(fin?.ROA),
      roe_pct:                  pct(fin?.ROE),
      risk_based_capital_pct:   pct(fin?.RBCRWAJ),
    },
    source: "FDIC BankFind Suite — api.fdic.gov/banks",
    note: "Financial data from most-recent quarterly Call Report. Assets/deposits/income in $ billions or millions.",
  };
}

// --- Mode: failures ---
async function bankFailures(limit = 20, year = null) {
  const params = {
    fields: "NAME,CERT,FAILDATE,QBFASSET,QBFDEP,RESTYPE,RESTYPE1,SAVR",
    sort_by: "FAILDATE",
    sort_order: "DESC",
    limit: String(Math.min(limit, 100)),
  };
  if (year) params.filters = `FAILDATE:[1/1/${year} TO 12/31/${year}]`;

  const data = await fdic("failures", params);
  const results = (data.data || []).map((r) => {
    const d = r.data;
    return {
      name:          d.NAME,
      cert:          d.CERT,
      fail_date:     d.FAILDATE,
      assets_at_failure_b:   toB(d.QBFASSET),
      deposits_at_failure_b: toB(d.QBFDEP),
      resolution_type: RESTYPE_MAP[d.RESTYPE1] || d.RESTYPE1 || d.RESTYPE || null,
      deposit_insurance: d.SAVR === "DIF" ? "FDIC Deposit Insurance Fund" : d.SAVR,
    };
  });
  return {
    total_in_database: data.meta?.total ?? 4115,
    year_filter: year || "all",
    limit_shown: results.length,
    failures: results,
    source: "FDIC BankFind Suite — api.fdic.gov/banks/failures",
    note: "Covers 4,100+ bank failures since 1934. Assets/deposits in $ billions.",
  };
}

// --- Dispatch ---
export default {
  name: "fdic-bank-intel",
  price: "$0.015",

  description:
    "FDIC BankFind Suite: US bank financial health, regulatory capital ratios, and historical bank failure data. search mode: find institutions by name with asset size and state. profile mode: quarterly Call Report data — ROA, ROE, risk-based capital ratio, net income, loans, deposits (input: bank name or FDIC certificate number). failures mode: recent/historical bank closures with fail date, assets, resolution type. Covers 10,000+ institutions and 4,100+ failures since 1934. No API key.",

  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["search", "profile", "failures"],
        description:
          "search: find banks by name | profile: deep financial metrics for one bank (name or FDIC cert#) | failures: recent bank failures list",
      },
      query: {
        type: "string",
        description: "Bank name to search (for search or profile mode). Examples: 'JPMorgan', 'Silicon Valley Bank', 'First Republic'.",
      },
      cert: {
        type: "number",
        description: "FDIC certificate number for profile mode. Alternative to query. Example: 628 (JPMorgan Chase Bank NA).",
      },
      limit: {
        type: "number",
        description: "Max results to return. Default 10 (search), 20 (failures). Max 50/100.",
      },
      year: {
        type: "number",
        description: "Filter failures to a specific year (failures mode only). Example: 2023.",
      },
    },
    required: ["mode"],
  },

  outputSchema: {
    type: "object",
    properties: {
      query:             { type: "string"  },
      total_found:       { type: "integer" },
      institutions:      { type: "array"   },
      name:              { type: "string"  },
      cert:              { type: "integer" },
      state:             { type: "string"  },
      active:            { type: "boolean" },
      balance_sheet:     { type: "object"  },
      income:            { type: "object"  },
      ratios:            { type: "object"  },
      total_in_database: { type: "integer" },
      failures:          { type: "array"   },
      source:            { type: "string"  },
    },
  },

  async handler({ mode, query, cert, limit, year }) {
    switch (mode) {
      case "search": {
        if (!query) throw new Error("query is required for search mode");
        return searchBanks(query, limit ?? 10);
      }
      case "profile": {
        const target = cert ?? query;
        if (!target) throw new Error("query or cert is required for profile mode");
        return bankProfile(target);
      }
      case "failures": {
        return bankFailures(limit ?? 20, year ?? null);
      }
      default:
        throw new Error(`Unknown mode "${mode}". Use search, profile, or failures.`);
    }
  },
};
