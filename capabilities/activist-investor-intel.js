// activist-investor-intel.js
//
// SEC EDGAR 13D/13G beneficial ownership disclosures — who holds >5% of any
// US public company, and whether they are an activist (Schedule 13D) or
// passive investor (Schedule 13G). Covers all significant owners: hedge funds,
// institutional activists, individuals, and corporate acquirers.
//
// Two modes:
//   1. get_activists(ticker)      — 5%+ holders for a specific company with
//                                  names, ownership %, and activist flag.
//   2. recent_13d_filings(days)   — market-wide Schedule 13D filings in the
//                                  last N days (activists who just disclosed).
//
// Source: SEC EDGAR public APIs (data.sec.gov + efts.sec.gov + www.sec.gov).
// No API key. No auth. Filings updated within minutes of SEC acceptance.
//
// Seam: Schedule 13D filings move stocks 5–15% on the day of disclosure.
// Agents doing event-driven analysis or pre-trade diligence need to know
// who is activisting a target before the filing hits the news. This cap
// delivers both the per-company view and the market-wide feed from one call.
//
// Price: $0.020 — multiple EDGAR fetches per call; unique among x402 MCP caps.

const UA           = "the-stall/4.66 activist-investor-intel (kyle@intuitek.ai)";
const TICKER_MAP   = "https://www.sec.gov/files/company_tickers.json";
const SUBS_BASE    = "https://data.sec.gov/submissions/CIK";
const EDGAR_ARCH   = "https://www.sec.gov/Archives/edgar/data";
const EFTS_BASE    = "https://efts.sec.gov/LATEST/search-index";
const TIMEOUT_MS   = 14_000;
const MAX_DETAIL   = 8;

let _tickerCache = null;
let _cacheTick   = 0;
const CACHE_TTL  = 6 * 60 * 60 * 1000;

async function getTickerMap() {
  const now = Date.now();
  if (_tickerCache && now - _cacheTick < CACHE_TTL) return _tickerCache;
  const r = await fetch(TICKER_MAP, {
    headers: { "User-Agent": UA },
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Ticker map ${r.status}`);
  const raw = await r.json();
  const map = {};
  for (const v of Object.values(raw)) {
    map[v.ticker.toUpperCase()] = { cik: String(v.cik_str).padStart(10, "0"), name: v.title };
  }
  _tickerCache = map;
  _cacheTick   = now;
  return map;
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA },
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${url}`);
  return r.text();
}

function xmlVal(text, tag) {
  const m = text.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`));
  return m ? m[1].trim() : null;
}

// Parse the SEC header text file for subject company and filed-by names
function parseHeader(txt) {
  const sections = txt.split(/(?=SUBJECT COMPANY:|FILED BY:)/);
  let subject = {}, filer = {};
  for (const sec of sections) {
    if (sec.startsWith("SUBJECT COMPANY:")) {
      const m = sec.match(/COMPANY CONFORMED NAME:\s+(.+)/);
      const c = sec.match(/CENTRAL INDEX KEY:\s+(\d+)/);
      if (m) subject.name = m[1].trim();
      if (c) subject.cik  = c[1].trim();
    } else if (sec.startsWith("FILED BY:")) {
      const m = sec.match(/COMPANY CONFORMED NAME:\s+(.+)/);
      const c = sec.match(/CENTRAL INDEX KEY:\s+(\d+)/);
      if (m) filer.name = m[1].trim();
      if (c) filer.cik  = c[1].trim();
    }
  }
  return { subject, filer };
}

// Fetch and parse a single 13D/13G filing header + ownership %
async function getFilingDetail(accession, subjectCik) {
  const filerCik  = accession.split("-")[0].replace(/^0+/, "");
  const accNoDash = accession.replace(/-/g, "");
  const url       = `${EDGAR_ARCH}/${filerCik}/${accNoDash}/${accession}.txt`;
  try {
    const txt = await fetchText(url);
    const { subject, filer } = parseHeader(txt);
    const pct    = xmlVal(txt, "percentOfClass") || xmlVal(txt, "classPercent");
    const shares = xmlVal(txt, "aggregateAmountOwned") || xmlVal(txt, "amountBeneficiallyOwned") ||
                   xmlVal(txt, "reportingPersonBeneficiallyOwnedAggregateNumberOfShares");
    return { filer_name: filer.name || null, filer_cik: filer.cik || null,
             subject_name: subject.name || null, pct_owned: pct ? parseFloat(pct) : null,
             shares_owned: shares ? Math.round(parseFloat(shares)) : null };
  } catch {
    return null;
  }
}

// Mode 1: 5%+ holders for a specific company
async function getActivists(ticker, limit) {
  const map = await getTickerMap();
  const entry = map[ticker.toUpperCase()];
  if (!entry) throw new Error(`Unknown ticker: ${ticker}`);
  const { cik, name } = entry;

  const subsUrl = `${SUBS_BASE}${cik}.json`;
  const r       = await fetch(subsUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`EDGAR submissions ${r.status}`);
  const subs    = await r.json();
  const filings = subs.filings?.recent ?? {};
  const forms   = filings.form    ?? [];
  const accs    = filings.accessionNumber ?? [];
  const dates   = filings.filingDate ?? [];

  const ACTIVIST_FORMS  = new Set(["SC 13D", "SC 13D/A", "SCHEDULE 13D", "SCHEDULE 13D/A"]);
  const PASSIVE_FORMS   = new Set(["SC 13G", "SC 13G/A", "SCHEDULE 13G", "SCHEDULE 13G/A"]);

  // Collect all 13D/13G filings, deduplicate by filer CIK (keep most recent)
  const byFilerCik = new Map();
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    if (!ACTIVIST_FORMS.has(form) && !PASSIVE_FORMS.has(form)) continue;
    const acc       = accs[i];
    const filerCik  = acc.split("-")[0];
    const isActivist = ACTIVIST_FORMS.has(form);
    const existing   = byFilerCik.get(filerCik);
    if (!existing || dates[i] > existing.date) {
      byFilerCik.set(filerCik, { acc, form, date: dates[i], is_activist: isActivist });
    }
  }

  if (!byFilerCik.size) {
    return { ticker, company: name, cik: entry.cik, total_disclosures: 0,
             activist_count: 0, passive_count: 0, holders: [],
             note: "No Schedule 13D/13G filings found in recent EDGAR submissions." };
  }

  // Fetch detail for the top N most recent filings
  const sorted = [...byFilerCik.values()]
    .sort((a, b) => (b.date > a.date ? 1 : -1))
    .slice(0, limit);

  const details = await Promise.all(
    sorted.map(f => getFilingDetail(f.acc, cik).then(d => ({ ...f, ...d })))
  );

  const holders = details
    .filter(d => d !== null)
    .map(d => ({
      investor:    d.filer_name ?? "(unknown filer)",
      investor_cik: d.filer_cik ?? null,
      pct_owned:   d.pct_owned,
      shares_owned: d.shares_owned,
      filing_type:  d.form,
      is_activist:  d.is_activist,
      classification: d.is_activist ? "Activist (Schedule 13D)" : "Passive (Schedule 13G)",
      filing_date:  d.date,
      edgar_url:    (() => {
        const fc = d.acc.split("-")[0].replace(/^0+/, "");
        return `https://www.sec.gov/Archives/edgar/data/${fc}/${d.acc.replace(/-/g, "")}/${d.acc}.txt`;
      })(),
    }))
    .sort((a, b) => (b.filing_date > a.filing_date ? 1 : -1));

  const activistCount = holders.filter(h => h.is_activist).length;

  return {
    ticker,
    company: name,
    cik:     entry.cik,
    total_disclosures: byFilerCik.size,
    activist_count:    activistCount,
    passive_count:     holders.length - activistCount,
    holders,
    source: "SEC EDGAR Schedule 13D/13G filings (data.sec.gov)",
    note:   activistCount > 0
      ? `${activistCount} activist investor(s) with Schedule 13D disclosures.`
      : "No active Schedule 13D activists found; all holders filed as passive (13G).",
  };
}

// Mode 2: Market-wide recent Schedule 13D filings
async function recentFilings(days, limit) {
  function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }

  const params = new URLSearchParams({
    q:         "",
    forms:     "SCHEDULE 13D,SCHEDULE 13D/A",
    dateRange: "custom",
    startdt:   daysAgo(Math.min(days, 365)),
    enddt:     new Date().toISOString().slice(0, 10),
    from:      "0",
    size:      String(Math.min(limit, 50)),
  });

  const url = `${EFTS_BASE}?${params}`;
  const r   = await fetch(url, {
    headers: { "User-Agent": UA },
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`EDGAR EFTS ${r.status}`);
  const data  = await r.json();
  const hits  = data?.hits?.hits ?? [];
  const total = data?.hits?.total?.value ?? 0;

  function parseDisplayNames(displayNames) {
    // display_names: ["CompanyName (TICKER) (CIK xxx)", "FilerName (CIK xxx)"]
    // First entry with a ticker symbol in parens is the target company
    let target = null, filer = null;
    for (const dn of (displayNames ?? [])) {
      const tickerM = dn.match(/\(([A-Z]{1,5}(?:\.[A-Z]{1,3})?)\)\s+\(CIK/);
      if (tickerM && !target) {
        target = { name: dn.split(" (")[0].trim(), ticker: tickerM[1] };
      } else if (!filer) {
        filer = { name: dn.split(" (")[0].trim() };
      }
    }
    return { target, filer };
  }

  const filings = hits.map(h => {
    const src  = h._source ?? {};
    const { target, filer } = parseDisplayNames(src.display_names);
    const acc  = src.adsh ?? "";
    const fcik = acc.split("-")[0].replace(/^0+/, "");
    return {
      filing_date:       src.file_date ?? null,
      form_type:         src.form ?? "SCHEDULE 13D",
      is_amendment:      (src.form ?? "").endsWith("/A"),
      target_company:    target?.name ?? "(unknown target)",
      target_ticker:     target?.ticker ?? null,
      activist_investor: filer?.name ?? "(unknown filer)",
      accession:         acc,
      edgar_url:         acc ? `https://www.sec.gov/Archives/edgar/data/${fcik}/${acc.replace(/-/g, "")}/${acc}.txt` : null,
    };
  });

  return {
    total_filings_in_period: total,
    days_searched: Math.min(days, 365),
    returned: filings.length,
    filings,
    source: "SEC EDGAR EFTS full-text search (efts.sec.gov)",
  };
}

export default {
  name:  "activist-investor-intel",
  price: "$0.021",

  description:
    "SEC EDGAR Schedule 13D/13G beneficial ownership disclosures for US equities. " +
    "Mode 1 (ticker): returns all 5%+ shareholders for a company — activist funds (13D) vs " +
    "passive holders (13G), with ownership %, share count, and EDGAR filing URL. " +
    "Mode 2 (recent): returns market-wide Schedule 13D disclosures in the last N days. " +
    "Authoritative US government data, updated within minutes of SEC acceptance.",

  inputSchema: {
    type:       "object",
    properties: {
      ticker: {
        type:        "string",
        description: "US public company ticker symbol (e.g. TSLA, AAPL, CRM). Case-insensitive. Provide to get 5%+ holders for that specific company.",
      },
      mode: {
        type:        "string",
        enum:        ["company", "recent"],
        description: "'company' (default when ticker provided) returns 5%+ shareholders for that ticker. 'recent' returns market-wide Schedule 13D filings in the last N days.",
      },
      days: {
        type:        "integer",
        description: "For mode=recent: how many calendar days back to search (default 30, max 365).",
        minimum:     1,
        maximum:     365,
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
      ticker:      { type: "string" },
      company:     { type: "string" },
      holders:     { type: "array" },
      filings:     { type: "array" },
      activist_count: { type: "integer" },
      total_disclosures: { type: "integer" },
    },
  },

  async handler({ ticker, mode, days = 30, limit = 20 }) {
    const resolvedMode = mode ?? (ticker ? "company" : "recent");

    if (resolvedMode === "recent") {
      return recentFilings(days, limit);
    }

    if (!ticker) throw new Error("Provide 'ticker' for company mode, or set mode='recent'.");
    return getActivists(ticker, Math.min(limit, MAX_DETAIL));
  },
};
