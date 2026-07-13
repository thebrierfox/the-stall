// earnings-calendar.js
//
// Returns upcoming US stock earnings — report date, EPS estimate, and
// pre/post-market timing. Accepts an optional ticker filter and a
// configurable look-ahead window (1–90 days).
//
// Data: Alpha Vantage EARNINGS_CALENDAR (public demo endpoint, 3-month window).
// In-memory CSV cache (2-hour TTL) keeps Alpha Vantage calls well within the
// 25-req/day demo limit while keeping data fresh for agents.
//
// [REDACTED]5, 2026-06-06.

const AV_URL =
  "https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=demo";
const UA = "Mozilla/5.0 (compatible; the-stall/3.56; +https://intuitek.ai)";
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

let _cache = null; // { rows: [], ts: number }

async function fetchCalendar() {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.rows;

  const resp = await fetch(AV_URL, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`upstream HTTP ${resp.status}`);

  const text = await resp.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2) throw new Error("empty calendar from upstream");

  // CSV: symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    if (parts.length < 4) continue;
    const [symbol, name, reportDate, fiscalDateEnding, estimate, currency, timeOfDay] = parts;
    if (!symbol || !reportDate || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate.trim())) continue;
    rows.push({
      symbol:           symbol.trim(),
      name:             name ? name.trim() : null,
      report_date:      reportDate.trim(),
      fiscal_period_end: fiscalDateEnding ? fiscalDateEnding.trim() : null,
      eps_estimate:     estimate && estimate.trim() !== "" ? parseFloat(estimate.trim()) : null,
      currency:         currency ? currency.trim() : "USD",
      timing:           timeOfDay ? timeOfDay.trim() || null : null,
    });
  }

  _cache = { rows, ts: Date.now() };
  return rows;
}

export default {
  name: "earnings-calendar",
  price: "$0.059",

  description:
    "Earnings calendar for upcoming US stock reports — earnings date, EPS estimate, pre/post-market timing. Filter by ticker for per-company lookups, or scan a date window (1–90 days ahead) for calendar-driven research automation. Data: Alpha Vantage 3-month calendar, cached 2 hr.",

  inputSchema: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description:
          "Optional. Ticker to filter by (e.g. NVDA, AAPL). Omit to get all earnings in the window.",
      },
      days_ahead: {
        type: "integer",
        description: "Calendar days ahead to include (1–90, default 7).",
        minimum: 1,
        maximum: 90,
        default: 7,
      },
      limit: {
        type: "integer",
        description:
          "Max results (default 20, max 100). Ignored when symbol is provided (returns all matches).",
        minimum: 1,
        maximum: 100,
        default: 20,
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      earnings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            symbol:           { type: "string",          description: "Ticker symbol." },
            name:             { type: ["string", "null"], description: "Company name." },
            report_date:      { type: "string",          description: "Earnings report date (YYYY-MM-DD)." },
            fiscal_period_end: { type: ["string", "null"], description: "Fiscal quarter/year end date." },
            eps_estimate:     { type: ["number", "null"], description: "Consensus EPS estimate (null if not available)." },
            currency:         { type: "string",          description: "Reporting currency (usually USD)." },
            timing:           { type: ["string", "null"], description: "pre-market | post-market | null" },
          },
        },
      },
      total:       { type: "integer", description: "Total matching results before limit applied." },
      window_end:  { type: "string",  description: "Last date included (YYYY-MM-DD)." },
      as_of:       { type: "string",  description: "ISO-8601 timestamp of this response." },
    },
    required: ["earnings", "total", "window_end", "as_of"],
  },

  async handler(query) {
    const daysAhead    = Math.min(90, Math.max(1, query.days_ahead ?? 7));
    const limit        = Math.min(100, Math.max(1, query.limit ?? 20));
    const symbolFilter = (query.symbol || "").toUpperCase().replace(/[^A-Z0-9.\-^]/g, "");

    const rows = await fetchCalendar();

    const now       = new Date();
    const todayStr  = now.toISOString().slice(0, 10);
    const cutoffStr = new Date(now.getTime() + daysAhead * 86_400_000)
      .toISOString()
      .slice(0, 10);

    let filtered = rows.filter(
      (r) => r.report_date >= todayStr && r.report_date <= cutoffStr
    );

    if (symbolFilter) {
      filtered = filtered.filter((r) => r.symbol === symbolFilter);
    }

    const total   = filtered.length;
    const limited = symbolFilter ? filtered : filtered.slice(0, limit);

    return {
      earnings:   limited,
      total,
      window_end: cutoffStr,
      as_of:      new Date().toISOString(),
    };
  },
};
