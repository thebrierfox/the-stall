// merger-acquisition-intel.js
//
// SEC EDGAR M&A activity tracker — tender offers, going-private transactions,
// and definitive merger proxies for US public companies.
//
// Two modes:
//   1. company(ticker) — M&A-related EDGAR filings FOR that company: incoming
//                        tender offers (SC TO-T), going-private (SC 13E-3),
//                        merger proxies (DEFM14A / PREM14A), and issuer buyback
//                        tenders (SC TO-I). Answers: "is this company being acquired?"
//   2. recent(days)   — market-wide feed: all SC TO-T + SC 13E-3 + DEFM14A filings
//                        in the last N days. Answers: "what M&A is happening right now?"
//
// Source: SEC EDGAR public APIs (data.sec.gov + efts.sec.gov). No API key, no auth.
// Updated within minutes of SEC acceptance.
//
// Seam: M&A arbitrage, event-driven strategies, and corporate-action risk require
// knowing when a company files a tender offer or merger agreement before it surfaces
// in news. Pairs with activist-investor-intel: Schedule 13D activists often precede
// or trigger formal M&A. SC TO-T filings move stocks 20–40% on the day of disclosure.
//
// Price: $0.020 — multiple EDGAR round-trips per call; unique among x402 MCP caps.

const UA         = "the-stall/4.66 merger-acquisition-intel (kyle@intuitek.ai)";
const TICKER_MAP = "https://www.sec.gov/files/company_tickers.json";
const SUBS_BASE  = "https://data.sec.gov/submissions/CIK";
const EFTS_BASE  = "https://efts.sec.gov/LATEST/search-index";
const TIMEOUT_MS = 14_000;

const MA_FORMS = new Set([
  "SC TO-T", "SC TO-T/A",
  "SC 13E-3", "SC 13E-3/A",
  "DEFM14A", "PREM14A",
  "SC TO-I", "SC TO-I/A",
]);

const FORM_LABELS = {
  "SC TO-T":    "Tender Offer — third party acquiring company",
  "SC TO-T/A":  "Tender Offer Amendment",
  "SC 13E-3":   "Going-Private Transaction",
  "SC 13E-3/A": "Going-Private Amendment",
  "DEFM14A":    "Definitive Merger Proxy — shareholder vote pending",
  "PREM14A":    "Preliminary Merger Proxy",
  "SC TO-I":    "Issuer Self-Tender / Share Buyback",
  "SC TO-I/A":  "Issuer Self-Tender Amendment",
};

const SIGNAL_FORMS = new Set(["SC TO-T", "SC 13E-3", "DEFM14A"]);

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
    map[v.ticker.toUpperCase()] = {
      cik:  String(v.cik_str).padStart(10, "0"),
      name: v.title,
    };
  }
  _tickerCache = map;
  _cacheTick   = now;
  return map;
}

function edgarUrl(accession, cik) {
  const clean  = accession.replace(/-/g, "");
  const cikInt = parseInt(cik, 10);
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${clean}/${accession}.txt`;
}

// Company mode: scan submissions API for MA-related filings
async function getCompanyFilings(ticker, limit) {
  const map = await getTickerMap();
  const t   = ticker.toUpperCase();
  const co  = map[t];
  if (!co) throw new Error(`Ticker '${ticker}' not found in SEC EDGAR ticker map.`);

  const r = await fetch(`${SUBS_BASE}${co.cik}.json`, {
    headers: { "User-Agent": UA },
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`EDGAR submissions ${r.status}`);
  const subs    = await r.json();
  const recent  = subs.filings?.recent ?? {};
  const forms   = recent.form            ?? [];
  const dates   = recent.filingDate      ?? [];
  const accns   = recent.accessionNumber ?? [];

  const results = [];
  for (let i = 0; i < forms.length && results.length < limit; i++) {
    if (!MA_FORMS.has(forms[i])) continue;
    results.push({
      form_type:   forms[i],
      label:       FORM_LABELS[forms[i]] ?? forms[i],
      is_signal:   SIGNAL_FORMS.has(forms[i]),
      filing_date: dates[i] ?? null,
      accession:   accns[i] ?? null,
      edgar_url:   accns[i] ? edgarUrl(accns[i], co.cik) : null,
    });
  }

  const hasSignal = results.some(f => f.is_signal);
  return {
    ticker:           t,
    company:          co.name,
    cik:              co.cik,
    ma_filings_found: results.length,
    filings:          results,
    interpretation:   results.length === 0
      ? "No M&A-related EDGAR filings found for this company in recent history."
      : hasSignal
        ? "Active M&A event detected — tender offer, going-private, or merger proxy on file."
        : "M&A-related amendments or issuer self-tender on file; no inbound acquisition detected.",
    source: "SEC EDGAR submissions API (data.sec.gov)",
  };
}

// Recent mode: market-wide M&A feed via EFTS
async function recentFilings(days, limit) {
  function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }

  const params = new URLSearchParams({
    q:         "",
    forms:     "SC TO-T,SC 13E-3,DEFM14A",
    dateRange: "custom",
    startdt:   daysAgo(Math.min(days, 365)),
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

  function parseParties(displayNames) {
    let target = null, counterparty = null;
    for (const dn of (displayNames ?? [])) {
      const tickerM = dn.match(/\(([A-Z]{1,5}(?:\.[A-Z]{1,3})?)\)\s+\(CIK/);
      if (tickerM && !target) {
        target = { name: dn.split(" (")[0].trim(), ticker: tickerM[1] };
      } else if (!counterparty) {
        counterparty = { name: dn.split(" (")[0].trim() };
      }
    }
    return { target, counterparty };
  }

  const filings = hits.map(h => {
    const src  = h._source ?? {};
    const { target, counterparty } = parseParties(src.display_names);
    const acc  = src.adsh ?? "";
    const form = src.form ?? "";
    const fcik = acc.split("-")[0].replace(/^0+/, "");
    return {
      filing_date:    src.file_date ?? null,
      form_type:      form,
      label:          FORM_LABELS[form] ?? form,
      target_company: target?.name ?? "(unknown)",
      target_ticker:  target?.ticker ?? null,
      counterparty:   counterparty?.name ?? "(not separately disclosed)",
      accession:      acc,
      edgar_url:      acc
        ? `https://www.sec.gov/Archives/edgar/data/${fcik}/${acc.replace(/-/g, "")}/${acc}.txt`
        : null,
    };
  });

  return {
    total_filings_in_period: total,
    days_searched:           Math.min(days, 365),
    forms_searched:          ["SC TO-T (tender offers)", "SC 13E-3 (going-private)", "DEFM14A (merger proxies)"],
    returned:                filings.length,
    filings,
    source: "SEC EDGAR EFTS full-text search (efts.sec.gov)",
  };
}

export default {
  name:  "merger-acquisition-intel",
  price: "$0.021",

  description:
    "SEC EDGAR M&A activity tracker for US public companies. " +
    "Mode 'company' (ticker): returns all M&A-related EDGAR filings for that company — " +
    "incoming tender offers (SC TO-T), going-private transactions (SC 13E-3), merger " +
    "proxies (DEFM14A/PREM14A), and issuer self-tenders (SC TO-I) — with EDGAR URLs. " +
    "Mode 'recent': market-wide feed of tender offers, going-private filings, and " +
    "definitive merger proxies in the last N days. " +
    "Authoritative SEC government data, updated within minutes of filing acceptance. $0.020/call.",

  inputSchema: {
    type:       "object",
    properties: {
      ticker: {
        type:        "string",
        description: "US public company ticker symbol (e.g. TSLA, AAPL, T). Case-insensitive. Check if a specific company has M&A filings.",
      },
      mode: {
        type:        "string",
        enum:        ["company", "recent"],
        description: "'company' (default when ticker given) returns M&A filings for that ticker. 'recent' returns market-wide M&A activity in the last N days.",
      },
      days: {
        type:        "integer",
        description: "For mode=recent: calendar days back to search (default 30, max 365).",
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
      ticker:                  { type: "string" },
      company:                 { type: "string" },
      ma_filings_found:        { type: "integer" },
      filings:                 { type: "array" },
      total_filings_in_period: { type: "integer" },
      interpretation:          { type: "string" },
    },
  },

  async handler({ ticker, mode, days = 30, limit = 20 }) {
    const resolvedMode = mode ?? (ticker ? "company" : "recent");

    if (resolvedMode === "recent") {
      return recentFilings(days, Math.min(limit, 50));
    }

    if (!ticker) throw new Error("Provide 'ticker' for company mode, or set mode='recent'.");
    return getCompanyFilings(ticker, Math.min(limit, 50));
  },
};
