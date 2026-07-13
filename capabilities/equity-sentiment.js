// equity-sentiment.js
//
// Equity market Fear & Greed composite for US equities.
//
// Four independent signals, all free public sources with no API keys:
//
//   1. VIX level vs 90-day percentile  (Yahoo Finance ^VIX)
//      High VIX percentile = fear; low = greed.
//   2. SPY momentum vs 200-day MA      (Yahoo Finance SPY)
//      Above 200d = bullish (greed); below = bearish (fear); magnitude amplifies.
//   3. HY credit spread vs 90-day range (FRED BAMLH0A0HYM2)
//      Wide spreads vs recent range = fear; tight = greed.
//   4. SPY RSI-14                      (derived from SPY OHLCV above)
//      Overbought (RSI > 70) = greed; oversold (< 30) = fear.
//
// Composite score: 0 (extreme greed) → 100 (extreme fear).
// Weights: VIX 40%, momentum 25%, HY spread 20%, RSI 15%.
//
// Seam: equity agents need an equity-specific market-regime signal before
// sizing positions or routing capital. market-sentiment.js covers crypto;
// this fills the equity gap. Pairs naturally with equity-brief, market-overview,
// credit-spreads, and treasury-yields for the complete risk backdrop.

const YF_BASE   = "https://query2.finance.yahoo.com/v8/finance/chart";
const FRED_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const UA        = "Mozilla/5.0 (compatible; the-stall/4.4; +https://intuitek.ai)";
const YF_TMO    = 12_000;
const FRED_TMO  = 14_000;

function r2(n) { return Math.round(n * 100) / 100; }

async function fetchYF(symbol, range, interval) {
  const url  = `${YF_BASE}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(YF_TMO),
  });
  if (!resp.ok) throw new Error(`YF ${symbol} HTTP ${resp.status}`);
  const body   = await resp.json();
  const result = body?.chart?.result?.[0];
  if (!result)  throw new Error(`YF ${symbol}: no result`);
  return result;
}

function getCloses(result) {
  return (result.indicators?.quote?.[0]?.close || []).filter(v => v != null);
}

// Fraction of arr values strictly below v, expressed as 0–100
function percentileRank(arr, v) {
  if (!arr.length) return 50;
  return Math.round((arr.filter(x => x < v).length / arr.length) * 100);
}

function rsi14(closes) {
  if (closes.length < 15) return null;
  const recent = closes.slice(-15);
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const d = recent[i] - recent[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  return r2(100 - (100 / (1 + avgGain / avgLoss)));
}

function sma(arr, n) {
  if (arr.length < n) n = arr.length;
  const s = arr.slice(-n);
  return r2(s.reduce((a, b) => a + b, 0) / s.length);
}

async function fetchFredLast90(id) {
  const resp = await fetch(`${FRED_BASE}?id=${id}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(FRED_TMO),
  });
  if (!resp.ok) throw new Error(`FRED ${id} HTTP ${resp.status}`);
  const text  = await resp.text();
  const rows  = text.trim().split("\n").filter(l => !l.startsWith("DATE") && l.includes(","));
  const valid = [];
  for (const l of rows) {
    const [date, val] = l.split(",");
    const v = parseFloat(val?.trim());
    if (!isNaN(v) && val?.trim() !== ".") valid.push({ date: date?.trim(), value: v });
  }
  return valid.slice(-90);
}

function regimeLabel(score) {
  if (score <= 20) return "EXTREME_GREED";
  if (score <= 40) return "GREED";
  if (score <= 60) return "NEUTRAL";
  if (score <= 80) return "FEAR";
  return "EXTREME_FEAR";
}
function vixSignal(pct) {
  if (pct <= 20) return "LOW";
  if (pct <= 40) return "BELOW_AVG";
  if (pct <= 60) return "AVERAGE";
  if (pct <= 80) return "ELEVATED";
  return "HIGH";
}
function momentumSignal(pctAbove) {
  if (pctAbove >  5) return "STRONGLY_BULLISH";
  if (pctAbove >  0) return "BULLISH";
  if (pctAbove > -5) return "BEARISH";
  return "STRONGLY_BEARISH";
}
function spreadSignal(pct) {
  if (pct <= 25) return "TIGHT";
  if (pct <= 50) return "NORMAL";
  if (pct <= 75) return "WIDE";
  return "VERY_WIDE";
}
function rsiSignal(rsi) {
  if (rsi >= 70) return "OVERBOUGHT";
  if (rsi >= 55) return "STRONG";
  if (rsi >= 45) return "NEUTRAL";
  if (rsi >= 30) return "WEAK";
  return "OVERSOLD";
}

export default {
  name:  "equity-sentiment",
  price: "$0.040",

  description:
    "Stock market Fear & Greed composite (equity sentiment). Four signals: VIX vs 90-day percentile, SPY vs 200-day moving average, US high-yield credit spread vs 90-day range (FRED BAMLH0A0HYM2), SPY RSI-14. Returns composite score 0–100 (0=extreme greed, 100=extreme fear) with regime label and per-signal breakdown. Distinct from market-sentiment (crypto). Use before sizing positions, adjusting portfolio risk, or routing capital. Free sources, no API keys.",

  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      score:        { type: "number", description: "Composite score 0–100. 0=extreme greed, 100=extreme fear." },
      regime:       { type: "string", description: "EXTREME_GREED | GREED | NEUTRAL | FEAR | EXTREME_FEAR" },
      vix:          { type: "object", description: "VIX current, 90d percentile, signal (LOW→HIGH), fear contribution." },
      spy_momentum: { type: "object", description: "SPY vs 200-day SMA, % above/below, signal, fear contribution." },
      hy_spread:    { type: "object", description: "HY OAS current (FRED), 90d percentile, signal (TIGHT→VERY_WIDE), fear contribution." },
      rsi:          { type: "object", description: "SPY RSI-14, signal (OVERSOLD→OVERBOUGHT), fear contribution." },
      as_of:        { type: "string", description: "Date of most recent data (YYYY-MM-DD)." },
    },
  },

  async handler(_params) {
    const [vixResult, spyResult, hyObs] = await Promise.all([
      fetchYF("^VIX", "3mo", "1d"),
      fetchYF("SPY",  "1y",  "1d"),
      fetchFredLast90("BAMLH0A0HYM2"),
    ]);

    // VIX
    const vixCloses  = getCloses(vixResult);
    const vixCurrent = vixCloses[vixCloses.length - 1];
    const vixPct     = percentileRank(vixCloses, vixCurrent);
    const vixFear    = vixPct;

    // SPY momentum
    const spyCloses  = getCloses(spyResult);
    const spyCurrent = spyCloses[spyCloses.length - 1];
    const spy200     = sma(spyCloses, 200);
    const pctAbove   = r2(((spyCurrent - spy200) / spy200) * 100);
    // Map: +10% → score ~10 (greed), 0% → 50, −10% → 90 (fear), clamped 0–100
    const momentumFear = Math.max(0, Math.min(100, Math.round(50 - pctAbove * 4)));

    // HY spread
    const hyValues  = hyObs.map(o => o.value);
    const hyCurrent = hyValues[hyValues.length - 1];
    const hyDate    = hyObs[hyObs.length - 1]?.date;
    const hyPct     = percentileRank(hyValues, hyCurrent);
    const hyFear    = hyPct;

    // RSI
    const rsiVal  = rsi14(spyCloses);
    // Map RSI 30→85 fear, 50→50, 70→15, clamped
    const rsiFear = rsiVal !== null
      ? Math.max(0, Math.min(100, Math.round(100 - (rsiVal - 5) * (90 / 65))))
      : 50;

    // Composite
    const score = Math.round(
      vixFear       * 0.40 +
      momentumFear  * 0.25 +
      hyFear        * 0.20 +
      rsiFear       * 0.15
    );

    const vixTs  = (vixResult.timestamp || []);
    const vixDate = vixTs.length
      ? new Date(vixTs[vixTs.length - 1] * 1000).toISOString().slice(0, 10)
      : null;
    const asOf = hyDate || vixDate || new Date().toISOString().slice(0, 10);

    return {
      score,
      regime:       regimeLabel(score),
      vix: {
        current:        r2(vixCurrent),
        percentile_90d: vixPct,
        signal:         vixSignal(vixPct),
        fear_score:     vixFear,
      },
      spy_momentum: {
        price:           r2(spyCurrent),
        sma200:          spy200,
        pct_above_200d:  pctAbove,
        signal:          momentumSignal(pctAbove),
        fear_score:      momentumFear,
      },
      hy_spread: {
        current:         r2(hyCurrent),
        current_bps:     Math.round(hyCurrent * 100),
        percentile_90d:  hyPct,
        as_of:           hyDate,
        signal:          spreadSignal(hyPct),
        fear_score:      hyFear,
      },
      rsi: {
        value:      rsiVal,
        signal:     rsiVal !== null ? rsiSignal(rsiVal) : "UNAVAILABLE",
        fear_score: rsiFear,
      },
      as_of: asOf,
    };
  },
};
