// sector-rotation.js
//
// S&P 500 sector rotation intelligence via all 11 GICS SPDR Select Sector ETFs.
//
// Returns relative performance of each sector vs SPY benchmark across
// 1D, 5D, 1M, and 3M timeframes. Identifies rotation leaders, laggards,
// and direction-of-travel signals. All data from Yahoo Finance (free, no auth).
//
// Sectors covered:
//   XLK  — Technology           XLF  — Financials
//   XLE  — Energy               XLV  — Health Care
//   XLI  — Industrials          XLY  — Consumer Discretionary
//   XLP  — Consumer Staples     XLB  — Materials
//   XLRE — Real Estate          XLU  — Utilities
//   XLC  — Communication Svcs
//
// Per-sector output: absolute return + relative-to-SPY for each timeframe,
// a rotation signal (LEADING / CATCHING_UP / LAGGING / FALLING_BEHIND),
// and a 1M leadership rank across all 11 sectors.
//
// Rotation signal logic (based on 1M relative performance + 5D acceleration):
//   LEADING         — strong 1M outperformance AND accelerating (5D also positive vs SPY)
//   CATCHING_UP     — lagged 1M but 5D outperforming (momentum turning)
//   FALLING_BEHIND  — led 1M but 5D underperforming (momentum deteriorating)
//   LAGGING         — consistent underperformer on both 1M and 5D
//
// Seam: portfolio/allocation agents need sector-level context before making
// sector bets, interpreting macro signals, or building risk-parity strategies.
// Fills the gap between market-overview (index level) and equity-brief (single stock).
//
// Price: $0.020/call — parallel fetch of 12 symbols (11 sectors + SPY).

const YF_BASE = "https://query2.finance.yahoo.com/v8/finance/chart";
const UA      = "Mozilla/5.0 (compatible; the-stall/5.0; +https://intuitek.ai)";
const TMO     = 14_000;

const SECTORS = {
  XLK:  "Technology",
  XLF:  "Financials",
  XLE:  "Energy",
  XLV:  "Health Care",
  XLI:  "Industrials",
  XLY:  "Consumer Discretionary",
  XLP:  "Consumer Staples",
  XLB:  "Materials",
  XLRE: "Real Estate",
  XLU:  "Utilities",
  XLC:  "Communication Svcs",
};

function r2(n) { return Math.round(n * 100) / 100; }
function pct(a, b) { return b ? r2(((a - b) / b) * 100) : null; }

async function fetchOHLCV(symbol) {
  const url  = `${YF_BASE}/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TMO),
  });
  if (!resp.ok) throw new Error(`YF ${symbol} HTTP ${resp.status}`);
  const body   = await resp.json();
  const result = body?.chart?.result?.[0];
  if (!result)  throw new Error(`YF ${symbol}: no result`);
  const closes = (result.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  return closes;
}

// Extract price N trading days ago (approx). Uses last N+1 point.
function priceNDaysAgo(closes, n) {
  if (closes.length <= n) return closes[0];
  return closes[closes.length - 1 - n];
}

function rotationSignal(rel1m, rel5d) {
  const leading1m = rel1m > 0;
  const leading5d = rel5d > 0;
  if (leading1m && leading5d)   return "LEADING";
  if (!leading1m && leading5d)  return "CATCHING_UP";
  if (leading1m && !leading5d)  return "FALLING_BEHIND";
  return "LAGGING";
}

export default {
  name:  "sector-rotation",
  price: "$0.434",

  description:
    "S&P 500 sector rotation: relative performance of all 11 GICS sectors (XLK XLF XLE XLV XLI XLY XLP XLB XLRE XLU XLC) vs SPY benchmark. Returns 1D, 5D, 1M, and 3M absolute and relative returns, a rotation signal per sector (LEADING, CATCHING_UP, FALLING_BEHIND, LAGGING), and 1M leadership ranking. Parameterizable: sort by any timeframe. Free Yahoo Finance source, no API keys. Use for sector allocation, macro-regime interpretation, or screening rotation momentum.",

  inputSchema: {
    type: "object",
    properties: {
      rank_by: {
        type: "string",
        enum: ["1d", "5d", "1m", "3m"],
        description: "Timeframe to rank sectors by relative performance. Default: 1m.",
        default: "1m",
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      spy:     { type: "object", description: "SPY reference prices and returns for each timeframe." },
      sectors: { type: "array",  description: "Array of 11 sector objects sorted by rank_by relative performance." },
      leaders: { type: "array",  description: "Top 3 outperforming sectors (tickers) for the rank_by timeframe." },
      laggards:{ type: "array",  description: "Bottom 3 underperforming sectors (tickers) for the rank_by timeframe." },
      as_of:   { type: "string", description: "Date of most recent data (YYYY-MM-DD)." },
    },
  },

  async handler(params) {
    const rankBy = params?.rank_by || "1m";

    // Fetch SPY + all 11 sectors in parallel
    const tickers = ["SPY", ...Object.keys(SECTORS)];
    const results = await Promise.allSettled(
      tickers.map(t => fetchOHLCV(t).then(closes => ({ ticker: t, closes })))
    );

    const data = {};
    for (const r of results) {
      if (r.status === "fulfilled") data[r.value.ticker] = r.value.closes;
    }

    const spy = data["SPY"];
    if (!spy || spy.length < 5) throw new Error("SPY data unavailable");

    const spyCurrent = spy[spy.length - 1];
    const spy1d  = priceNDaysAgo(spy, 1);
    const spy5d  = priceNDaysAgo(spy, 5);
    const spy1m  = priceNDaysAgo(spy, 21);
    const spy3m  = spy[0];

    const dayLabels = spy.length;
    const asOfDate  = new Date().toISOString().slice(0, 10); // approximate

    const spyRef = {
      current: r2(spyCurrent),
      ret_1d:  pct(spyCurrent, spy1d),
      ret_5d:  pct(spyCurrent, spy5d),
      ret_1m:  pct(spyCurrent, spy1m),
      ret_3m:  pct(spyCurrent, spy3m),
    };

    const sectors = [];
    for (const [ticker, name] of Object.entries(SECTORS)) {
      const closes = data[ticker];
      if (!closes || closes.length < 5) {
        sectors.push({ ticker, name, error: "data unavailable" });
        continue;
      }
      const cur = closes[closes.length - 1];
      const d1  = priceNDaysAgo(closes, 1);
      const d5  = priceNDaysAgo(closes, 5);
      const m1  = priceNDaysAgo(closes, 21);
      const m3  = closes[0];

      const abs1d = pct(cur, d1);
      const abs5d = pct(cur, d5);
      const abs1m = pct(cur, m1);
      const abs3m = pct(cur, m3);

      const rel1d = spyRef.ret_1d != null ? r2(abs1d - spyRef.ret_1d) : null;
      const rel5d = spyRef.ret_5d != null ? r2(abs5d - spyRef.ret_5d) : null;
      const rel1m = spyRef.ret_1m != null ? r2(abs1m - spyRef.ret_1m) : null;
      const rel3m = spyRef.ret_3m != null ? r2(abs3m - spyRef.ret_3m) : null;

      sectors.push({
        ticker,
        name,
        current:    r2(cur),
        abs_1d:     abs1d,
        abs_5d:     abs5d,
        abs_1m:     abs1m,
        abs_3m:     abs3m,
        rel_1d:     rel1d,
        rel_5d:     rel5d,
        rel_1m:     rel1m,
        rel_3m:     rel3m,
        rotation:   rotationSignal(rel1m, rel5d),
      });
    }

    // Rank by chosen timeframe (descending relative performance)
    const relKey = `rel_${rankBy}`;
    sectors.sort((a, b) => {
      const av = a[relKey] ?? -999;
      const bv = b[relKey] ?? -999;
      return bv - av;
    });

    const valid = sectors.filter(s => s[relKey] != null);
    const leaders  = valid.slice(0, 3).map(s => s.ticker);
    const laggards = valid.slice(-3).reverse().map(s => s.ticker);

    return {
      spy:      spyRef,
      sectors,
      leaders,
      laggards,
      as_of:    asOfDate,
    };
  },
};
