// earnings-reaction.js
//
// Stock price reactions to past earnings events for any US equity.
// For each quarterly earnings date: EPS surprise magnitude paired with
// actual price move on report day and the next trading day.
//
// Fills the gap between earnings-surprises (did it beat/miss?) and the
// market's RESPONSE. Event-driven traders and momentum models need to
// know the reaction pattern — a 5% EPS beat can still lead to a -3%
// day if the market expected 10%. This cap surfaces beat-selloff and
// miss-rally anomalies explicitly via reaction_class.
//
// Computed per period:
//   report_day_move_pct  — close vs prev day close on earnings report date
//   next_day_move_pct    — next trading day close vs report day close
//   two_day_move_pct     — combined effect
//   reaction_class       — "beat_and_up" | "beat_selloff" | "miss_and_down"
//                          | "miss_rally" | "neutral" | "unknown"
//
// Upstream: Yahoo Finance quoteSummary earningsHistory (EPS data) +
//           v8/finance/chart 2yr daily OHLCV (price reaction).
//           Both free, crumb-auth, no API key.
// Price: $0.025

const UA           = "Mozilla/5.0 (compatible; the-stall/4.65; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const YF_CHART     = "https://query2.finance.yahoo.com/v8/finance/chart";
const TMO          = 14_000;
const CRUMB_TTL    = 30 * 60 * 1000;

let _crumbCache = null;

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }

function rawVal(f) {
  if (f == null) return null;
  if (typeof f === "number") return f;
  return f?.raw ?? null;
}

async function refreshCrumb() {
  const seedResp = await fetch(YF_CRUMB_SRC, {
    headers: { "User-Agent": UA },
    redirect: "follow",
    signal: AbortSignal.timeout(TMO),
  });
  const setCookies = seedResp.headers.getSetCookie?.() ?? [];
  const cookies    = setCookies.map(c => c.split(";")[0]).join("; ");
  const crumbResp  = await fetch(YF_CRUMB_URL, {
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
  const url = `${YF_SUMMARY}/${encodeURIComponent(ticker)}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(crumb)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
    signal: AbortSignal.timeout(TMO),
  });
  if (resp.status === 401 && retry) { _crumbCache = null; return fetchQuoteSummary(ticker, modules, false); }
  if (!resp.ok) throw new Error(`Yahoo Finance ${resp.status}`);
  return resp.json();
}

async function fetchChart(ticker, retry = true) {
  const { crumb, cookies } = await getCrumb();
  const url = `${YF_CHART}/${encodeURIComponent(ticker)}?range=2y&interval=1d&crumb=${encodeURIComponent(crumb)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
    signal: AbortSignal.timeout(TMO),
  });
  if (resp.status === 401 && retry) { _crumbCache = null; return fetchChart(ticker, false); }
  if (!resp.ok) throw new Error(`Yahoo chart ${resp.status}`);
  return resp.json();
}

function classifyReaction(surpPct, movePct) {
  if (surpPct == null || movePct == null) return "unknown";
  if (surpPct > 0 && movePct >  2) return "beat_and_up";
  if (surpPct > 0 && movePct < -2) return "beat_selloff";
  if (surpPct < 0 && movePct < -2) return "miss_and_down";
  if (surpPct < 0 && movePct >  2) return "miss_rally";
  return "neutral";
}

export default {
  name:  "earnings-reaction",
  price: "$0.079",

  description:
    "Stock price reaction to past earnings events for any US equity. Returns report-day and next-day price move % for each recent quarterly earnings date, paired with the EPS beat/miss magnitude and reaction class (beat_and_up, beat_selloff, miss_and_down, miss_rally, neutral). Identifies contrarian signals where price moved opposite to the EPS surprise. Pairs with earnings-calendar (upcoming dates) and earnings-surprises (EPS history). Yahoo Finance, no API key.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US equity ticker symbol (e.g. AAPL, MSFT, NVDA).",
      },
      periods: {
        type: "integer",
        description: "Number of past earnings periods to return (default 8, max 16).",
        default: 8,
        minimum: 1,
        maximum: 16,
      },
    },
    required: ["ticker"],
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:                  { type: "string" },
      name:                    { type: "string" },
      periods_shown:           { type: "integer" },
      avg_report_day_move_pct: { type: ["number", "null"] },
      avg_two_day_move_pct:    { type: ["number", "null"] },
      beat_rate_pct:           { type: ["number", "null"] },
      earnings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date:                { type: "string" },
            period:              { type: ["string", "null"] },
            eps_actual:          { type: ["number", "null"] },
            eps_estimate:        { type: ["number", "null"] },
            surprise_pct:        { type: ["number", "null"] },
            prev_close:          { type: ["number", "null"] },
            report_day_move_pct: { type: ["number", "null"] },
            next_day_move_pct:   { type: ["number", "null"] },
            two_day_move_pct:    { type: ["number", "null"] },
            reaction_class:      { type: "string" },
          },
        },
      },
      ts: { type: "string" },
    },
  },

  async handler({ ticker, periods = 8 }) {
    if (!ticker || typeof ticker !== "string") throw new Error("ticker is required");
    const sym   = ticker.trim().toUpperCase();
    const limit = Math.min(Math.max(1, Math.floor(periods)), 16);

    const [summaryData, chartData] = await Promise.all([
      fetchQuoteSummary(sym, "earningsHistory,quoteType"),
      fetchChart(sym),
    ]);

    const result = summaryData?.quoteSummary?.result?.[0];
    if (!result) throw new Error(`no data for "${sym}"`);

    const qt    = result.quoteType || {};
    const ehist = (result.earningsHistory?.history || []);

    // Build date→close map from daily chart
    const chart      = chartData?.chart?.result?.[0];
    const timestamps = chart?.timestamp || [];
    const closes     = chart?.indicators?.quote?.[0]?.close || [];
    const closeByDate = {};
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] != null) {
        const d = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
        closeByDate[d] = closes[i];
      }
    }
    const sortedDates = Object.keys(closeByDate).sort();

    function getOnOrAfter(targetDate) {
      if (closeByDate[targetDate]) return { date: targetDate, close: closeByDate[targetDate] };
      for (const d of sortedDates) {
        if (d >= targetDate) return { date: d, close: closeByDate[d] };
      }
      return null;
    }

    function getPrev(targetDate) {
      let prev = null;
      for (const d of sortedDates) {
        if (d < targetDate) prev = { date: d, close: closeByDate[d] };
        else break;
      }
      return prev;
    }

    function getNext(afterDate) {
      for (const d of sortedDates) {
        if (d > afterDate) return { date: d, close: closeByDate[d] };
      }
      return null;
    }

    // Sort newest first
    ehist.sort((a, b) => (rawVal(b.earningsDate) ?? 0) - (rawVal(a.earningsDate) ?? 0));

    const entries      = [];
    let beats = 0, misses = 0;
    const rdMoves = [], tdMoves = [];

    for (const h of ehist.slice(0, limit)) {
      const epochMs = (rawVal(h.earningsDate) ?? 0) * 1000;
      if (!epochMs) continue;
      const date         = new Date(epochMs).toISOString().split("T")[0];
      const eps_actual   = r2(rawVal(h.epsActual));
      const eps_estimate = r2(rawVal(h.epsEstimate));
      const surprise_pct =
        eps_actual != null && eps_estimate != null && eps_estimate !== 0
          ? r2((eps_actual - eps_estimate) / Math.abs(eps_estimate) * 100)
          : null;

      if (surprise_pct != null) { if (surprise_pct > 0) beats++; else misses++; }

      const reportEntry = getOnOrAfter(date);
      const prevEntry   = reportEntry ? getPrev(reportEntry.date) : null;
      const nextEntry   = reportEntry ? getNext(reportEntry.date) : null;

      let prev_close = null, report_day_move_pct = null, next_day_move_pct = null, two_day_move_pct = null;

      if (reportEntry && prevEntry) {
        prev_close           = r2(prevEntry.close);
        report_day_move_pct  = r2((reportEntry.close - prevEntry.close) / prevEntry.close * 100);
        rdMoves.push(report_day_move_pct);
      }
      if (reportEntry && nextEntry) {
        next_day_move_pct = r2((nextEntry.close - reportEntry.close) / reportEntry.close * 100);
      }
      if (report_day_move_pct != null && next_day_move_pct != null) {
        two_day_move_pct = r2(report_day_move_pct + next_day_move_pct);
        tdMoves.push(two_day_move_pct);
      }

      entries.push({
        date,
        period:              h.period ?? null,
        eps_actual,
        eps_estimate,
        surprise_pct,
        prev_close,
        report_day_move_pct,
        next_day_move_pct,
        two_day_move_pct,
        reaction_class: classifyReaction(surprise_pct, report_day_move_pct),
      });
    }

    const avg  = arr => arr.length ? r2(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    const n    = beats + misses;

    return {
      ticker:                  sym,
      name:                    qt.longName || qt.shortName || null,
      periods_shown:           entries.length,
      avg_report_day_move_pct: avg(rdMoves),
      avg_two_day_move_pct:    avg(tdMoves),
      beat_rate_pct:           n > 0 ? r2(beats / n * 100) : null,
      earnings:                entries,
      ts:                      new Date().toISOString(),
    };
  },
};
