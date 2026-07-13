// analyst-upgrades.js
//
// Analyst rating change history (upgrades, downgrades, initiations) for any US stock.
// Sourced from Yahoo Finance upgradeDowngradeHistory (free, crumb-auth, no API key).
//
// Fills the gap between analyst-ratings (current consensus snapshot) and directional
// momentum: when multiple firms upgrade in a short window it signals institutional
// repositioning before the consensus score visibly shifts.
//
// Seam: event-driven equity agents track upgrade/downgrade clusters as a leading
// signal. analyst-ratings tells you WHERE consensus stands; this cap tells you
// which DIRECTION it is moving and how fast.
//
// Upstream: Yahoo Finance quoteSummary upgradeDowngradeHistory module.
// Price: $0.012

const UA           = "Mozilla/5.0 (compatible; the-stall/4.65; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const TMO          = 12_000;
const CRUMB_TTL    = 30 * 60 * 1000;

let _crumbCache = null;

async function refreshCrumb() {
  const seedResp = await fetch(YF_CRUMB_SRC, {
    headers: { "User-Agent": UA },
    redirect: "follow",
    signal: AbortSignal.timeout(TMO),
  });
  const setCookies = seedResp.headers.getSetCookie?.() ?? [];
  const cookies = setCookies.map(c => c.split(";")[0]).join("; ");

  const crumbResp = await fetch(YF_CRUMB_URL, {
    headers: { "User-Agent": UA, "Cookie": cookies },
    signal: AbortSignal.timeout(TMO),
  });
  if (!crumbResp.ok) throw new Error(`crumb ${crumbResp.status}`);
  const crumb = (await crumbResp.text()).trim();
  if (!crumb) throw new Error("empty crumb");
  _crumbCache = { crumb, cookies, ts: Date.now() };
  return _crumbCache;
}

async function getCrumb() {
  if (_crumbCache && (Date.now() - _crumbCache.ts) < CRUMB_TTL) return _crumbCache;
  return refreshCrumb();
}

async function fetchQuoteSummary(ticker, modules, retry = true) {
  const { crumb, cookies } = await getCrumb();
  const url = `${YF_SUMMARY}/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
    signal: AbortSignal.timeout(TMO),
  });
  if (resp.status === 401 && retry) {
    _crumbCache = null;
    return fetchQuoteSummary(ticker, modules, false);
  }
  if (!resp.ok) throw new Error(`Yahoo Finance ${resp.status}`);
  return resp.json();
}

const ACTION_LABELS = {
  up:   "Upgrade",
  down: "Downgrade",
  init: "Initiate",
  main: "Maintain",
  reit: "Reiterate",
};

export default {
  name:  "analyst-upgrades",
  price: "$0.025",

  description:
    "Analyst rating change history (upgrades, downgrades, initiations) for any US stock. Returns each firm, action, from/to grade, and date — up to 365 days back. Computes net sentiment (upgrades minus downgrades): positive = bullish momentum building. Pairs with analyst-ratings (current consensus) and earnings-estimates (forward EPS). Yahoo Finance, no API key.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker symbol (e.g. AAPL, NVDA, MSFT). Case-insensitive.",
      },
      days: {
        type: "integer",
        description: "How many calendar days back to include. Default 90, max 365.",
      },
      action: {
        type: "string",
        enum: ["all", "upgrade", "downgrade", "initiate"],
        description: "Filter by action type. Default 'all'.",
      },
      limit: {
        type: "integer",
        description: "Max entries to return. Default 20, max 50.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:        { type: "string" },
      name:          { type: "string" },
      days:          { type: "integer" },
      total_shown:   { type: "integer" },
      upgrades:      { type: "integer",  description: "Count of upgrades in window." },
      downgrades:    { type: "integer",  description: "Count of downgrades in window." },
      initiations:   { type: "integer",  description: "Count of new coverage initiations in window." },
      net_sentiment: { type: "integer",  description: "Upgrades minus downgrades. Positive = bullish analyst momentum." },
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date:       { type: "string",  description: "ISO date of rating change (YYYY-MM-DD)." },
            firm:       { type: "string" },
            action:     { type: "string",  description: "Upgrade | Downgrade | Initiate | Maintain | Reiterate" },
            from_grade: { type: "string",  description: "Prior rating (null if initiation)." },
            to_grade:   { type: "string",  description: "New rating." },
          },
        },
      },
      ts: { type: "string" },
    },
  },

  async handler(query) {
    const rawTicker = (query.ticker || "AAPL").trim();
    const ticker    = rawTicker.toUpperCase().replace(/[^A-Z0-9.\-^]/g, "");
    if (!ticker) throw new Error("invalid ticker symbol");

    const days   = Math.min(Math.max(1, parseInt(query.days,  10) || 90),  365);
    const filter = (query.action || "all").toLowerCase();
    const limit  = Math.min(Math.max(1, parseInt(query.limit, 10) || 20),  50);

    let data;
    try {
      data = await fetchQuoteSummary(ticker, "upgradeDowngradeHistory,quoteType");
    } catch (err) {
      throw new Error(`upstream fetch failed: ${err.message}`);
    }

    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      const errMsg = data?.quoteSummary?.error?.description || "no data";
      throw new Error(`no data for "${ticker}": ${errMsg}`);
    }

    const qt   = result.quoteType                            || {};
    const hist = result.upgradeDowngradeHistory?.history     || [];

    const cutoffMs  = Date.now() - days * 86_400_000;
    const inWindow  = hist.filter(h => (h.epochGradeDate ?? 0) * 1000 >= cutoffMs);

    const filtered = filter === "all"
      ? inWindow
      : inWindow.filter(h => {
          const a = (h.action || "").toLowerCase();
          if (filter === "upgrade")   return a === "up";
          if (filter === "downgrade") return a === "down";
          if (filter === "initiate")  return a === "init";
          return true;
        });

    // Most recent first
    filtered.sort((a, b) => (b.epochGradeDate || 0) - (a.epochGradeDate || 0));
    const sliced = filtered.slice(0, limit);

    let upgrades = 0, downgrades = 0, initiations = 0;
    for (const h of inWindow) {
      const a = (h.action || "").toLowerCase();
      if (a === "up")   upgrades++;
      if (a === "down") downgrades++;
      if (a === "init") initiations++;
    }

    const changes = sliced.map(h => {
      const epoch  = h.epochGradeDate ?? 0;
      const date   = epoch ? new Date(epoch * 1000).toISOString().split("T")[0] : null;
      const action = ACTION_LABELS[(h.action || "").toLowerCase()] ?? (h.action || null);
      return {
        date,
        firm:       h.firm      || null,
        action,
        from_grade: h.fromGrade || null,
        to_grade:   h.toGrade   || null,
      };
    });

    if (!hist.length) throw new Error(`no analyst coverage history for "${ticker}"`);

    return {
      ticker,
      name:           qt.longName || qt.shortName || null,
      days,
      total_shown:    changes.length,
      upgrades,
      downgrades,
      initiations,
      net_sentiment:  upgrades - downgrades,
      changes,
      ts:             new Date().toISOString(),
    };
  },
};
