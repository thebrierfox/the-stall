// institutional-ownership-intel.js
//
// Institutional ownership and fund holdings intelligence for US equities.
// Sourced from Yahoo Finance quoteSummary (free, crumb-auth, no API key).
//
// Closes the equity-research stack:
//   insider-trading-intel → C-suite & director transactions (Form 4)
//   activist-investor-intel → 5%+ beneficial owners (13D/13G)
//   institutional-ownership-intel → full institutional picture (all funds)
//
// Three modes:
//   holders — Top institutional funds: name, shares held, % outstanding,
//             market value, reporting date. Sorted by position size.
//   summary — High-level breakdown: % institutional, % insider, float size,
//             total institution count, and concentration signals.
//   full    — Both holders + summary in one call.
//
// Seam: equity-research agents need institutional conviction as a signal layer.
// "Vanguard + Blackrock + Fidelity are increasing" is buy-side confirmation
// no other x402 MCP cap delivers. Pairs with earnings-quality (Beneish M-Score)
// and capital-allocation-score for full stock diligence workflows.
//
// Price: $0.015 — single YF fetch, crumb-auth, no paid key required.

const UA           = "Mozilla/5.0 (compatible; the-stall/4.74; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const TMO          = 12_000;
const CRUMB_TTL    = 30 * 60 * 1000;

let _crumbCache = null;

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }
function pct(n) { return n != null ? r2(n * 100) : null; }
function rawVal(f) {
  if (f == null) return null;
  if (typeof f === "number") return f;
  return f?.raw ?? null;
}
function fmtVal(f) {
  if (f == null) return null;
  if (typeof f === "string") return f;
  return f?.fmt ?? null;
}

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

async function fetchQS(ticker, modules, retry = true) {
  const { crumb, cookies } = await getCrumb();
  const url = `${YF_SUMMARY}/${encodeURIComponent(ticker.toUpperCase())}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
    signal: AbortSignal.timeout(TMO),
  });
  if (r.status === 401 && retry) {
    _crumbCache = null;
    return fetchQS(ticker, modules, false);
  }
  if (!r.ok) throw new Error(`Yahoo Finance ${r.status} for ${ticker}`);
  return r.json();
}

function parseHolders(data, limit) {
  const qs = data?.quoteSummary?.result?.[0];
  if (!qs) throw new Error("No data returned from Yahoo Finance");

  const list = qs.institutionOwnership?.ownershipList ?? [];
  if (!list.length) return [];

  return list.slice(0, limit).map((h, i) => {
    const pctHeld   = rawVal(h.pctHeld);
    const position  = rawVal(h.position);
    const value     = rawVal(h.value);
    const reportTs  = rawVal(h.reportDate);
    const reportDate = reportTs ? new Date(reportTs * 1000).toISOString().slice(0, 10) : null;

    return {
      rank:          i + 1,
      institution:   h.organization ?? "(unknown)",
      shares_held:   position,
      pct_of_shares: pctHeld != null ? pct(pctHeld) : null,
      market_value_usd: value,
      report_date:   reportDate,
    };
  });
}

function parseSummary(data, ticker) {
  const qs = data?.quoteSummary?.result?.[0];
  if (!qs) throw new Error("No data returned from Yahoo Finance");

  const mhb = qs.majorHoldersBreakdown ?? {};

  const insiderPct   = rawVal(mhb.insidersPercentHeld);
  const instPct      = rawVal(mhb.institutionsPercentHeld);
  const instFloatPct = rawVal(mhb.institutionsFloatPercentHeld);
  const instCount    = rawVal(mhb.institutionsCount);

  const publicPct = insiderPct != null && instPct != null
    ? r2(Math.max(0, 100 - pct(insiderPct) - pct(instPct)))
    : null;

  // Concentration signal: top-5 institutions' combined % of shares held
  const holders = qs.institutionOwnership?.ownershipList ?? [];
  const top5Pct = holders.slice(0, 5).reduce((sum, h) => {
    const p = rawVal(h.pctHeld);
    return p != null ? sum + p : sum;
  }, 0);

  let concentration = null;
  if (top5Pct > 0) {
    if (top5Pct > 0.25)       concentration = "HIGH";
    else if (top5Pct > 0.15)  concentration = "MODERATE";
    else                       concentration = "DISTRIBUTED";
  }

  return {
    ticker:                      ticker.toUpperCase(),
    pct_held_by_institutions:    instPct != null ? pct(instPct) : null,
    pct_of_float_institutional:  instFloatPct != null ? pct(instFloatPct) : null,
    pct_held_by_insiders:        insiderPct != null ? pct(insiderPct) : null,
    pct_public_float:            publicPct,
    total_institutions:          instCount,
    top5_combined_pct:           top5Pct ? r2(top5Pct * 100) : null,
    concentration_signal:        concentration,
    interpretation: (() => {
      if (instPct == null) return null;
      const instP = pct(instPct);
      if (instP > 80) return "Heavily institutionally owned — price moves driven by fund flows.";
      if (instP > 50) return "Majority institutional — institutional consensus matters greatly.";
      if (instP > 25) return "Mixed ownership — retail and institutional both influential.";
      return "Primarily retail-owned — lower institutional oversight.";
    })(),
    source: "Yahoo Finance majorHoldersBreakdown + institutionOwnership",
  };
}

export default {
  name:  "institutional-ownership-intel",
  price: "$0.021",

  description:
    "Institutional fund holdings intelligence for US equities. Returns which funds " +
    "own the stock (Vanguard, Blackrock, Fidelity, etc.), their position sizes, " +
    "% of shares outstanding, and market value. Breakdown mode shows % institutional " +
    "vs insider vs public float and top-5 concentration signal (HIGH/MODERATE/DISTRIBUTED). " +
    "Closes the equity-research stack alongside insider-trading-intel (Form 4) and " +
    "activist-investor-intel (13D/13G). Source: Yahoo Finance, no API key.",

  inputSchema: {
    type:       "object",
    required:   ["ticker"],
    properties: {
      ticker: {
        type:        "string",
        description: "US equity ticker symbol (e.g. AAPL, TSLA, NVDA). Case-insensitive.",
      },
      mode: {
        type:        "string",
        enum:        ["holders", "summary", "full"],
        description:
          "'holders' (default) returns top institutional funds with shares and value. " +
          "'summary' returns aggregate breakdown: % institutional, % insider, float size, concentration. " +
          "'full' returns both in one call.",
      },
      limit: {
        type:        "integer",
        description: "Max number of institutional holders to return in holders/full mode (default 15, max 30).",
        minimum:     1,
        maximum:     30,
      },
    },
  },

  outputSchema: {
    type:       "object",
    properties: {
      ticker:             { type: "string" },
      holders:            { type: "array" },
      summary:            { type: "object" },
      total_institutions: { type: "integer" },
    },
  },

  async handler({ ticker, mode = "holders", limit = 15 }) {
    if (!ticker) throw new Error("'ticker' is required.");

    const resolvedLimit = Math.min(Math.max(1, limit), 30);
    const needHolders = mode === "holders" || mode === "full";
    const needSummary = mode === "summary" || mode === "full";

    const modules = [
      "institutionOwnership",
      "majorHoldersBreakdown",
    ].join(",");

    const data = await fetchQS(ticker, modules);
    const err  = data?.quoteSummary?.error;
    if (err) throw new Error(`Yahoo Finance error: ${err.description ?? JSON.stringify(err)}`);

    const result = { ticker: ticker.toUpperCase(), mode };

    if (needHolders) {
      const holders = parseHolders(data, resolvedLimit);
      result.holders        = holders;
      result.holders_count  = holders.length;
      result.holders_note   = holders.length === 0
        ? "No institutional ownership data available for this ticker."
        : `Top ${holders.length} institutional holders by position size.`;
    }

    if (needSummary) {
      result.summary = parseSummary(data, ticker);
    }

    result.source = "Yahoo Finance quoteSummary (institutionOwnership + majorHoldersBreakdown)";
    return result;
  },
};
