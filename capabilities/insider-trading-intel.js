// insider-trading-intel.js
//
// SEC Form 4 — mandatory disclosure of equity transactions by insiders (officers,
// directors, 10%+ beneficial owners) in any US public company, filed within 2
// business days of the trade. The highest-conviction legal signal of insider belief:
// code-P (open-market purchase) means a named insider spent personal capital at
// market price, with no 10b5-1 plan shield or award backstop.
//
// Two modes:
//   1. get_insider_trades(ticker, days, limit)  — all Form 4 filings for a specific
//                                                company in the last N days. Returns
//                                                insider name, role, transaction type,
//                                                shares, price/share, total value, and
//                                                a net buy/sell sentiment score.
//   2. recent_insider_buys(days, min_usd, limit) — market-wide open-market purchase
//                                                feed (code P, Acquired) above a
//                                                minimum dollar threshold. Sorted by
//                                                total value descending.
//
// Source: SEC EDGAR submissions API + full-text search (data.sec.gov, efts.sec.gov,
// www.sec.gov/Archives/). No API key. No auth. Updated within minutes of acceptance.
//
// Seam: Form 4 open-market buys precede quarterly 13F disclosures by up to 45 days.
// Institutional-scale purchases above $1M from C-suite insiders are rare and strongly
// correlated with subsequent price appreciation. No other x402 cap surfaces this data.
//
// Price: $0.015 — multiple EDGAR round-trips per call; rivals charge $50+/month.

const UA         = "the-stall/4.72 insider-trading-intel (kyle@intuitek.ai)";
const TICKER_MAP = "https://www.sec.gov/files/company_tickers.json";
const SUBS_BASE  = "https://data.sec.gov/submissions/CIK";
const EFTS_BASE  = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_ARCH = "https://www.sec.gov/Archives/edgar/data";
const TIMEOUT_MS = 14_000;
const CACHE_TTL  = 6 * 60 * 60 * 1000;

let _tickerCache = null;
let _cacheTick   = 0;

// Transaction code → human label
const TCODE = {
  P: "open-market purchase", S: "open-market sale",
  A: "award/grant",         F: "tax withholding (share retention)",
  M: "option exercise",     D: "derivative exercise/disposition",
  G: "gift",                J: "other acquisition/disposition",
  X: "derivative expired",  Z: "trust transaction",
  W: "will/inheritance",    I: "discretionary transaction",
  C: "convertible conversion",
};

async function getTickerMap() {
  const now = Date.now();
  if (_tickerCache && now - _cacheTick < CACHE_TTL) return _tickerCache;
  const r = await fetch(TICKER_MAP, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
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

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${url}`);
  return r.json();
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${url}`);
  return r.text();
}

// Extract value from both direct text and nested <value> forms:
//   <transactionCode>P</transactionCode>
//   <transactionShares><value>1000</value></transactionShares>
function xmlVal(text, tag) {
  const nested = text.match(new RegExp(`<${tag}[^>]*>\\s*<value>([^<]+)</value>`));
  if (nested) return nested[1].trim();
  const direct = text.match(new RegExp(`<${tag}[^>]*>([^<]+)<\\/${tag}>`));
  return direct ? direct[1].trim() : null;
}

function xmlBlock(text, tag) {
  const m = text.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1] : null;
}

function xmlAll(text, tag) {
  const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "g");
  return text.match(re) || [];
}

// Fetch the filing index JSON and return the primary XML file URL
async function getXmlUrl(cikNoPad, accession) {
  const accNoDash = accession.replace(/-/g, "");
  try {
    const idx = await fetchJson(
      `${EDGAR_ARCH}/${cikNoPad}/${accNoDash}/${accession}-index.json`
    );
    const items = idx.directory?.item || [];
    const xmlFile = items.find(
      f => /\.xml$/i.test(f.name) &&
           !/xsd/i.test(f.name) &&
           !/formDef/i.test(f.name) &&
           !/R\d+\.xml$/i.test(f.name)
    );
    return xmlFile ? `${EDGAR_ARCH}/${cikNoPad}/${accNoDash}/${xmlFile.name}` : null;
  } catch {
    return null;
  }
}

// Parse Form 4 XML → { owner, role, issuer_ticker, transactions[] }
function parseForm4(xml) {
  // Issuer info
  const issuerTicker = xmlVal(xml, "issuerTradingSymbol");

  // Reporting owner (first owner if multiple)
  const ownerBlock = xmlBlock(xml, "reportingOwner") || "";
  const ownerName  = xmlVal(ownerBlock, "rptOwnerName") || xmlVal(xml, "rptOwnerName") || "Unknown";
  const isDir      = xmlVal(ownerBlock, "isDirector") === "1";
  const isOff      = xmlVal(ownerBlock, "isOfficer") === "1";
  const isTen      = xmlVal(ownerBlock, "isTenPercentOwner") === "1";
  const offTitle   = xmlVal(ownerBlock, "officerTitle");
  const role       = isDir ? "Director"
                   : isOff ? (offTitle || "Officer")
                   : isTen ? "10%+ Owner"
                   : "Other";

  // Non-derivative transactions (actual share purchases / sales)
  const txBlocks = xmlAll(xml, "nonDerivativeTransaction");
  const transactions = txBlocks.flatMap(block => {
    const code   = xmlVal(block, "transactionCode") || "?";
    const codingBlock = xmlBlock(block, "transactionCoding") || block;
    const code2  = xmlVal(codingBlock, "transactionCode") || code;

    const dateBlock = xmlBlock(block, "transactionDate") || "";
    const date   = xmlVal(dateBlock, "value") || xmlVal(block, "periodOfReport") || null;

    const sharesBlock = xmlBlock(block, "transactionShares") || "";
    const rawShares   = parseFloat(xmlVal(sharesBlock, "value") || "0");

    const priceBlock = xmlBlock(block, "transactionPricePerShare") || "";
    const rawPrice   = parseFloat(xmlVal(priceBlock, "value") || "0");

    const adBlock = xmlBlock(block, "transactionAcquiredDisposedCode") || "";
    const adCode  = xmlVal(adBlock, "value") || "";

    const postBlock  = xmlBlock(block, "sharesOwnedFollowingTransaction") || "";
    const postShares = parseFloat(xmlVal(postBlock, "value") || "0") || null;

    const security = xmlVal(xmlBlock(block, "securityTitle") || block, "value") || "Common Stock";

    if (!rawShares || rawShares <= 0) return [];

    const totalValue = Math.round(rawShares * rawPrice * 100) / 100;
    return [{
      code:            code2,
      type:            TCODE[code2] || code2 || "unknown",
      date,
      security,
      shares:          Math.round(rawShares),
      price_per_share: rawPrice,
      total_value_usd: totalValue,
      acquired:        adCode === "A",
      shares_owned_after: postShares ? Math.round(postShares) : null,
    }];
  });

  return { owner: ownerName, role, issuer_ticker: issuerTicker, transactions };
}

// ── Mode 1: per-company Form 4 transactions ────────────────────────────────────

async function getInsiderTrades(ticker, days, limit) {
  const map = await getTickerMap();
  const entry = map[ticker.toUpperCase()];
  if (!entry) throw new Error(`Unknown ticker: ${ticker.toUpperCase()}`);
  const { cik, name } = entry;
  const cikNoPad = String(parseInt(cik, 10));

  const subs = await fetchJson(`${SUBS_BASE}${cik}.json`);
  const f    = subs.filings?.recent || {};
  const forms = f.form || [], accs = f.accessionNumber || [], dates = f.filingDate || [];

  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const targets = [];
  for (let i = 0; i < forms.length; i++) {
    if ((forms[i] === "4" || forms[i] === "4/A") && dates[i] >= cutoff) {
      targets.push({ acc: accs[i], date: dates[i] });
    }
  }
  targets.sort((a, b) => b.date.localeCompare(a.date));
  const batch = targets.slice(0, Math.min(limit, 20));

  const results = (await Promise.all(batch.map(async ({ acc, date }) => {
    const accNoPad = acc.split("-")[0].replace(/^0+/, "");
    const xmlUrl = await getXmlUrl(accNoPad, acc);
    if (!xmlUrl) return null;
    try {
      const xml    = await fetchText(xmlUrl);
      const parsed = parseForm4(xml);
      return { filing_date: date, accession: acc, ...parsed };
    } catch { return null; }
  }))).filter(Boolean);

  // Aggregate buy/sell score across all filings (open-market only)
  let netBuyUsd = 0;
  let buyCount = 0, sellCount = 0;
  for (const r of results) {
    for (const t of r.transactions) {
      if (t.code === "P") { netBuyUsd += t.total_value_usd; buyCount++; }
      if (t.code === "S") { netBuyUsd -= t.total_value_usd; sellCount++; }
    }
  }

  return {
    mode:        "get_insider_trades",
    ticker:      ticker.toUpperCase(),
    company:     name,
    days_back:   days,
    filings_found:  targets.length,
    filings_parsed: results.length,
    open_market_buys:  buyCount,
    open_market_sells: sellCount,
    net_buy_sell_usd:  Math.round(netBuyUsd * 100) / 100,
    insider_sentiment: netBuyUsd >= 100_000 ? "bullish"
                     : netBuyUsd <= -100_000 ? "bearish"
                     : "neutral",
    filings: results,
  };
}

// ── Mode 2: market-wide recent insider open-market purchases ───────────────────

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function parseDisplayNames(displayNames) {
  let company = null, ticker = null, filer = null;
  for (const dn of (displayNames || [])) {
    const tm = dn.match(/\(([A-Z]{1,5}(?:\.[A-Z]{1,3})?)\)\s+\(CIK/);
    if (tm && !company) {
      company = dn.split(" (")[0].trim();
      ticker  = tm[1];
    } else if (!filer) {
      filer = dn.split(" (")[0].trim();
    }
  }
  return { company, ticker, filer };
}

async function recentInsiderBuys(days, minUsd, limit) {
  const params = new URLSearchParams({
    forms:     "4,4/A",
    dateRange: "custom",
    startdt:   daysAgo(Math.min(days, 30)),
    enddt:     new Date().toISOString().slice(0, 10),
    from:      "0",
    size:      "40",
  });

  const url  = `${EFTS_BASE}?${params}`;
  const r    = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`EDGAR EFTS ${r.status}`);
  const data = await r.json();
  const hits = data?.hits?.hits ?? [];
  const total = data?.hits?.total?.value ?? 0;

  const purchases = [];

  await Promise.all(hits.slice(0, 20).map(async hit => {
    const src       = hit._source ?? {};
    const accession = src.adsh ?? "";
    if (!accession) return;
    const { company, ticker, filer } = parseDisplayNames(src.display_names);
    const fileDate  = src.file_date ?? "";

    const cikNoPad  = accession.split("-")[0].replace(/^0+/, "");
    const xmlUrl = await getXmlUrl(cikNoPad, accession);
    if (!xmlUrl) return;

    let xml;
    try { xml = await fetchText(xmlUrl); } catch { return; }

    const parsed = parseForm4(xml);
    for (const t of parsed.transactions) {
      if (t.code === "P" && t.acquired && t.total_value_usd >= minUsd) {
        purchases.push({
          company:  company || parsed.issuer_ticker || "Unknown",
          ticker:   ticker  || parsed.issuer_ticker || null,
          insider:  parsed.owner,
          role:     parsed.role,
          filing_date: fileDate,
          accession,
          ...t,
        });
      }
    }
  }));

  purchases.sort((a, b) => b.total_value_usd - a.total_value_usd);

  return {
    mode:          "recent_insider_buys",
    days_back:     days,
    min_value_usd: minUsd,
    total_form4_filings_searched: Math.min(hits.length, 20),
    total_form4_in_period:        total,
    purchases_found: purchases.length,
    purchases: purchases.slice(0, limit),
  };
}

// ── Export ─────────────────────────────────────────────────────────────────────

export default {
  name:  "insider-trading-intel",
  price: "$0.021",
  description:
    "SEC Form 4 insider transaction intelligence. Mode get_insider_trades: Form 4 " +
    "filings for a ticker in the last N days — insider name, role, buy/sell type, " +
    "shares, price, total value, and net buy/sell sentiment. Mode recent_insider_buys: " +
    "market-wide open-market purchase events (code P) above a min dollar threshold — " +
    "highest-conviction insider signal. Source: SEC EDGAR public API, no auth required.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["get_insider_trades", "recent_insider_buys"],
        description:
          "get_insider_trades: Form 4s for a specific company (requires ticker). " +
          "recent_insider_buys: market-wide open-market purchase feed (no ticker needed).",
      },
      ticker: {
        type: "string",
        description: "Stock ticker symbol (e.g. AAPL, MSFT). Required for get_insider_trades.",
      },
      days: {
        type: "integer",
        description: "Days back to search (1–30). Default 7.",
        default: 7,
      },
      min_usd: {
        type: "number",
        description:
          "Minimum open-market purchase value in USD for recent_insider_buys mode. " +
          "Default 50000 ($50k). Use 100000 for high-conviction only.",
        default: 50000,
      },
      limit: {
        type: "integer",
        description: "Max results to return (1–20). Default 10.",
        default: 10,
      },
    },
    required: ["mode"],
  },
  outputSchema: {
    type: "object",
    properties: {
      mode:              { type: "string" },
      ticker:            { type: "string" },
      company:           { type: "string" },
      days_back:         { type: "integer" },
      filings_found:     { type: "integer" },
      filings_parsed:    { type: "integer" },
      open_market_buys:  { type: "integer" },
      open_market_sells: { type: "integer" },
      net_buy_sell_usd:  { type: "number" },
      insider_sentiment: { type: "string", enum: ["bullish", "bearish", "neutral"] },
      filings:           { type: "array" },
      purchases_found:   { type: "integer" },
      purchases:         { type: "array" },
    },
  },
  async handler({ mode, ticker, days = 7, min_usd = 50000, limit = 10 }) {
    const safeDays  = Math.min(Math.max(1, parseInt(days) || 7), 30);
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 10), 20);
    const safeMin   = Math.max(0, parseFloat(min_usd) || 50000);

    if (mode === "get_insider_trades") {
      if (!ticker) {
        const e = new Error("provide a ticker symbol for get_insider_trades mode");
        e.status = 400;
        throw e;
      }
      return getInsiderTrades(ticker, safeDays, safeLimit);
    }

    if (mode === "recent_insider_buys") {
      return recentInsiderBuys(safeDays, safeMin, safeLimit);
    }

    const e = new Error("provide a valid mode: get_insider_trades or recent_insider_buys");
    e.status = 400;
    throw e;
  },
};
