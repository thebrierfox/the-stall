// institutional-ownership.js
//
// Who owns a given US equity — institutional and insider holdings snapshot.
// Returns three slices from a single Yahoo Finance call:
//   1. Major holders breakdown: % insiders, % institutions, float coverage, institution count.
//   2. Top institutional holders: up to 10 largest reported positions with name, pct held,
//      share count, total value, recent pct change since last 13F, and reporting date.
//   3. Top insider holders: officers/directors with name, relation, shares direct,
//      latest transaction description and date.
//
// Seam: hedge-fund-holdings (this STALL) answers "given a manager, what do they own?"
// This cap inverts the query — given a ticker, who are the current owners? Standard
// equity research step before any fundamental analysis: insider alignment (skin in game),
// concentration risk (top-5 institutions > 30% = squeeze/overhang risk), and smart-money
// signal (institutional pct change direction).
//
// Upstream: Yahoo Finance quoteSummary majorHoldersBreakdown + institutionOwnership
//           + insiderHolders (free, crumb-auth, no API key required).
// Price: $0.015.

const UA           = "Mozilla/5.0 (compatible; the-stall/4.65; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const MODULES      = "majorHoldersBreakdown,institutionOwnership,insiderHolders";
const TMO          = 12_000;
const CRUMB_TTL    = 30 * 60 * 1000;

let _crumbCache = null;

function pct2(n) { return n != null ? Math.round(n * 10000) / 100 : null; }
function rawVal(f) { if (f == null) return null; if (typeof f === "number") return f; return f?.raw ?? null; }
function fmtDate(ts) { if (!ts) return null; return new Date(ts * 1000).toISOString().slice(0, 10); }

async function refreshCrumb() {
  const seed = await fetch(YF_CRUMB_SRC, {
    headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(TMO),
  });
  const cookies = (seed.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
  const cr = await fetch(YF_CRUMB_URL, {
    headers: { "User-Agent": UA, "Cookie": cookies }, signal: AbortSignal.timeout(TMO),
  });
  if (!cr.ok) throw new Error(`crumb fetch ${cr.status}`);
  const crumb = (await cr.text()).trim();
  if (!crumb) throw new Error("empty crumb");
  _crumbCache = { crumb, cookies, ts: Date.now() };
  return _crumbCache;
}

async function getCrumb() {
  if (_crumbCache && (Date.now() - _crumbCache.ts) < CRUMB_TTL) return _crumbCache;
  return refreshCrumb();
}

export default {
  name:  "institutional-ownership",
  price: "$0.021",

  description:
    "Institutional and insider ownership snapshot for any US stock. Returns: (1) major holders " +
    "breakdown — % insiders, % institutions, float coverage, total institution count; " +
    "(2) up to 10 largest institutional holders — name, pct of shares held, share count, total " +
    "value (USD), pct change since prior 13F quarter, reporting date; " +
    "(3) up to 10 insider holders — officer/director name, relation, shares held directly, " +
    "latest transaction description and date. Inverts hedge-fund-holdings: given a ticker, " +
    "who are the owners? Institutional momentum (pct change) and insider alignment are standard " +
    "inputs to equity research and conviction scoring. Free upstream: Yahoo Finance.",

  inputSchema: {
    type: "object",
    required: ["symbol"],
    properties: {
      symbol: {
        type: "string",
        description: "US equity ticker symbol (e.g. 'AAPL', 'MSFT', 'NVDA').",
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      symbol:        { type: "string" },
      major_holders: {
        type: "object",
        properties: {
          insiders_pct:           { type: ["number", "null"], description: "% shares held by company insiders." },
          institutions_pct:       { type: ["number", "null"], description: "% shares held by institutions (of total shares)." },
          institutions_float_pct: { type: ["number", "null"], description: "% of float held by institutions." },
          institution_count:      { type: ["integer", "null"], description: "Total number of institutional holders." },
        },
      },
      top_institutions: {
        type: "array",
        description: "Up to 10 largest institutional holders, ordered by position size.",
        items: {
          type: "object",
          properties: {
            name:        { type: "string" },
            pct_held:    { type: ["number", "null"], description: "% of total shares held." },
            shares:      { type: ["integer", "null"] },
            value_usd:   { type: ["integer", "null"], description: "Market value of position (USD)." },
            pct_change:  { type: ["number", "null"], description: "Change in position since prior 13F quarter (%)." },
            report_date: { type: ["string", "null"], description: "13F reporting date (YYYY-MM-DD)." },
          },
        },
      },
      top_insiders: {
        type: "array",
        description: "Up to 10 corporate insiders (officers/directors) with direct share holdings.",
        items: {
          type: "object",
          properties: {
            name:              { type: "string" },
            relation:          { type: ["string", "null"], description: "Role: Officer, Director, 10% Owner, etc." },
            shares_direct:     { type: ["integer", "null"], description: "Shares held directly." },
            latest_trans_date: { type: ["string", "null"], description: "Most recent reported transaction date." },
            transaction:       { type: ["string", "null"], description: "Transaction type (e.g. 'Stock Gift', 'S - Sale', 'P - Purchase')." },
          },
        },
      },
      related_capabilities: { type: "array" },
      ts: { type: "string" },
    },
  },

  async handler(query) {
    const symbol = (query.symbol || "").toUpperCase().trim();
    if (!symbol) throw Object.assign(new Error("symbol is required"), { status: 400 });

    const { crumb, cookies } = await getCrumb();
    const url = `${YF_SUMMARY}/${encodeURIComponent(symbol)}?modules=${encodeURIComponent(MODULES)}&crumb=${encodeURIComponent(crumb)}`;

    const resp = await fetch(url, {
      headers: { "User-Agent": UA, "Cookie": cookies },
      signal: AbortSignal.timeout(TMO),
    });
    if (!resp.ok) {
      const body = await resp.text();
      if (resp.status === 404 || body.includes("No fundamentals data")) {
        throw Object.assign(new Error(`symbol not found: ${symbol}`), { status: 404 });
      }
      throw new Error(`YF quoteSummary ${resp.status}: ${body.slice(0, 120)}`);
    }

    const data = await resp.json();
    const result = data?.quoteSummary?.result?.[0];
    if (!result) throw new Error("no quoteSummary result for symbol");

    // Major holders breakdown
    const mhb = result.majorHoldersBreakdown || {};
    const major_holders = {
      insiders_pct:           pct2(rawVal(mhb.insidersPercentHeld)),
      institutions_pct:       pct2(rawVal(mhb.institutionsPercentHeld)),
      institutions_float_pct: pct2(rawVal(mhb.institutionsFloatPercentHeld)),
      institution_count:      rawVal(mhb.institutionsCount),
    };

    if (
      major_holders.insiders_pct == null &&
      major_holders.institutions_pct == null &&
      major_holders.institution_count == null
    ) {
      throw Object.assign(
        new Error(`no ownership data for ${symbol} — non-US or non-standard ticker`),
        { status: 404 },
      );
    }

    // Top institutional holders
    const ioList = result.institutionOwnership?.ownershipList ?? [];
    const top_institutions = ioList.map(h => ({
      name:        h.organization ?? null,
      pct_held:    pct2(rawVal(h.pctHeld)),
      shares:      rawVal(h.position),
      value_usd:   rawVal(h.value),
      pct_change:  pct2(rawVal(h.pctChange)),
      report_date: fmtDate(rawVal(h.reportDate)),
    }));

    // Top insider holders
    const ihList = result.insiderHolders?.holders ?? [];
    const top_insiders = ihList.map(h => ({
      name:              h.name ?? null,
      relation:          h.relation ?? null,
      shares_direct:     rawVal(h.positionDirect),
      latest_trans_date: fmtDate(rawVal(h.latestTransDate)),
      transaction:       h.transactionDescription ?? null,
    }));

    return {
      symbol,
      major_holders,
      top_institutions,
      top_insiders,
      related_capabilities: [
        { cap: "equity-fundamentals", description: "Trailing P/E, EV/EBITDA, beta, margins, FCF — full fundamentals.",      price: "$0.020" },
        { cap: "hedge-fund-holdings", description: "Invert: given a fund name, see all their current stock positions.",       price: "$0.025" },
        { cap: "sec-insider-trades",  description: "Real-time SEC Form 4 insider buy/sell transaction feed.",                price: "$0.015" },
        { cap: "analyst-ratings",     description: "Current buy/hold/sell consensus, price target, and recommendation score.", price: "$0.010" },
        { cap: "peer-benchmarking",   description: "Comps table: 5 sector peers with valuation, growth, and profitability.",  price: "$0.100" },
      ],
      ts: new Date().toISOString(),
    };
  },
};
