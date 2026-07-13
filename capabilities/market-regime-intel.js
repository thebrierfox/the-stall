// market-regime-intel.js
//
// Classifies the current US equity market structural regime using five
// independent signals: SPY trend (SMA50/SMA200), VIX volatility level and
// trend, credit risk (HYG/IEF ratio), interest rate environment (^TNX),
// and momentum divergence (QQQ vs IWM relative strength). Outputs a
// discrete regime (BULL / CORRECTION / BEAR / SIDEWAYS / RISK_OFF) with
// per-signal scores, composite confidence, and plain-English narrative.
//
// Seam: orbisapi.com/proxy/stock-market-regime-classifier-api-fde6a6/:end
//   3,005 settlements/48h, 10 payers, $0.005/call (signal-intel 2026-06-09)
//
// Data sources (free, no auth):
//   SPY/QQQ/IWM/HYG/IEF/^TNX: Yahoo Finance v8 chart (1-year daily OHLCV)
//   VIX: CBOE delayed quotes historical endpoint

"use strict";

const YF_BASE = "https://query2.finance.yahoo.com/v8/finance/chart";
const VIX_URL = "https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/_VIX.json";
const UA      = "Mozilla/5.0 (compatible; the-stall/4.38; +https://intuitek.ai)";
const TIMEOUT = 12000;

// CBOE delayed quotes historical — rate-limit free, no auth (YF v8 blocks server IPs)
const CBOE_BASE = "https://cdn.cboe.com/api/global/delayed_quotes/charts/historical";
const CBOE_TICKER = { "SPY": "SPY", "QQQ": "QQQ", "IWM": "IWM", "HYG": "HYG", "IEF": "IEF", "^TNX": "_TNX" };

async function fetchYF(ticker) {
  const cboe = CBOE_TICKER[ticker] || ticker;
  const url = `${CBOE_BASE}/${cboe}.json`;
  const resp = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) throw new Error(`CBOE ${resp.status}: ${ticker}`);
  const body = await resp.json();
  const rows = body?.data;
  if (!rows || !rows.length) throw new Error(`No CBOE data: ${ticker}`);
  const recent = rows.slice(-252);
  const closes = recent.map(r => parseFloat(r.close)).filter(v => !isNaN(v));
  const lastTs = Math.floor(new Date(recent.at(-1).date + "T16:00:00Z").getTime() / 1000);
  return { closes, lastTs };
}

async function fetchVIX() {
  const resp = await fetch(VIX_URL, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) throw new Error(`CBOE VIX ${resp.status}`);
  const body = await resp.json();
  return (body.data ?? []).slice(-60).map(d => parseFloat(d.close));
}

function sma(arr, period) {
  if (arr.length < period) return null;
  const sl = arr.slice(-period);
  return sl.reduce((a, b) => a + b, 0) / period;
}

function avgN(arr, n) {
  const sl = arr.slice(-n);
  return sl.reduce((a, b) => a + b, 0) / sl.length;
}

function trendSlope(arr, n = 10) {
  if (arr.length < n + 1) return 0;
  const sl = arr.slice(-n);
  return (sl.at(-1) - sl[0]) / sl[0];
}

export default {
  name:        "market-regime-intel",
  price:       "$0.040",
  description: "Classify US stock market regime (BULL/CORRECTION/BEAR/SIDEWAYS/RISK_OFF) from 5 signals: SPY SMA50/200 trend, VIX level and trend, HYG/IEF credit spread, 10-yr yield, and QQQ/IWM momentum divergence. Returns regime label, per-signal scores, composite confidence 0-100, and narrative summary.",

  inputSchema: {
    type:                 "object",
    properties:           {},
    additionalProperties: false,
  },

  outputSchema: {
    type:       "object",
    properties: {
      regime:     { type: "string",  description: "BULL | CORRECTION | BEAR | SIDEWAYS | RISK_OFF" },
      confidence: { type: "number",  description: "Composite signal consensus 0–100." },
      signals:    { type: "object",  description: "Per-signal scores (trend, volatility, credit, rates, momentum)." },
      narrative:  { type: "string",  description: "Plain-English regime summary and key drivers." },
      price_data: { type: "object",  description: "Key levels: SPY, QQQ, IWM, VIX, HYG/IEF, TNX." },
      as_of:      { type: "string",  description: "ISO date of most recent data." },
    },
    required: [],
  },

  async handler(_query) {
    const [spy, qqq, iwm, hyg, ief, tnx, vixArr] = await Promise.all([
      fetchYF("SPY"),
      fetchYF("QQQ"),
      fetchYF("IWM"),
      fetchYF("HYG"),
      fetchYF("IEF"),
      fetchYF("^TNX"),
      fetchVIX(),
    ]);

    const spyC = spy.closes;
    const qqqC = qqq.closes;
    const iwmC = iwm.closes;
    const hygC = hyg.closes;
    const iefC = ief.closes;
    const tnxC = tnx.closes;

    const spyNow = spyC.at(-1);
    const qqqNow = qqqC.at(-1);
    const iwmNow = iwmC.at(-1);

    const sma50  = sma(spyC, 50);
    const sma200 = sma(spyC, 200);

    const vs200 = sma200 ? (spyNow - sma200) / sma200 : 0;
    const vs50  = sma50  ? (spyNow - sma50)  / sma50  : 0;

    // VIX
    const vixNow   = vixArr.at(-1);
    const vixAvg20 = avgN(vixArr, 20);
    const vixSlope = trendSlope(vixArr, 10);

    // Credit (HYG/IEF ratio; higher = benign, lower = stress)
    const minLen  = Math.min(hygC.length, iefC.length);
    const hiRatio = Array.from({ length: minLen }, (_, i) => hygC[hygC.length - minLen + i] / iefC[iefC.length - minLen + i]);
    const hrNow   = hiRatio.at(-1);
    const hrAvg30 = avgN(hiRatio, 30);
    const hrPct   = ((hrNow - hrAvg30) / hrAvg30) * 100;

    // Rates
    const tnxNow   = tnxC.at(-1);
    const tnxAvg20 = avgN(tnxC, 20);
    const ratesRising = tnxNow > tnxAvg20 * 1.02;

    // Momentum divergence (QQQ vs IWM 1-month return)
    const qRet = qqqC.length >= 21 ? (qqqNow - qqqC.at(-21)) / qqqC.at(-21) : 0;
    const iRet = iwmC.length >= 21 ? (iwmNow - iwmC.at(-21)) / iwmC.at(-21) : 0;
    const div  = qRet - iRet;

    // --- Scoring ---
    let trendScore = 0;
    if      (vs200 >  0.07)  trendScore =  2;
    else if (vs200 >  0.02)  trendScore =  1;
    else if (vs200 > -0.02)  trendScore =  0;
    else if (vs200 > -0.07)  trendScore = -1;
    else                     trendScore = -2;
    if (vs50 < 0 && vs200 > 0) trendScore = Math.max(-2, trendScore - 1);

    let volScore = 0;
    if      (vixNow < 15)  volScore =  2;
    else if (vixNow < 20)  volScore =  1;
    else if (vixNow < 25)  volScore =  0;
    else if (vixNow < 30)  volScore = -1;
    else                   volScore = -2;
    if (vixSlope > 0.03)   volScore = Math.max(-2, volScore - 1);

    let credScore = hrPct > 2 ? 2 : hrPct > 0 ? 1 : hrPct > -2 ? 0 : hrPct > -4 ? -1 : -2;
    let rateScore = ratesRising ? -1 : 0;
    let momScore  = Math.abs(div) < 0.02 ? 1 : div < -0.04 ? -1 : 0;

    const total   = trendScore + volScore + credScore + rateScore + momScore;
    const maxAbs  = 9;

    let regime;
    if      (total >= 5)  regime = "BULL";
    else if (total >= 2)  regime = "CORRECTION";
    else if (total >= -1) regime = "SIDEWAYS";
    else if (total >= -4) regime = "RISK_OFF";
    else                  regime = "BEAR";
    if (vixNow > 35 || vs200 < -0.12) regime = "BEAR";

    const confidence = Math.round(Math.min(100, 40 + (Math.abs(total) / maxAbs) * 60));

    const trendStr = vs200 >= 0
      ? `SPY is ${(vs200 * 100).toFixed(1)}% above SMA200`
      : `SPY is ${(Math.abs(vs200) * 100).toFixed(1)}% below SMA200`;
    const vixStr   = `VIX ${vixNow.toFixed(1)} (avg20 ${vixAvg20.toFixed(1)}, ${vixSlope > 0.02 ? "rising" : vixSlope < -0.02 ? "falling" : "flat"})`;
    const credStr  = hrPct < -2 ? `credit stress (HYG/IEF ${hrPct.toFixed(1)}% below 30d avg)` : `credit benign (HYG/IEF ${hrPct.toFixed(1)}% vs 30d avg)`;
    const parts    = [`Regime: ${regime} (signal score ${total > 0 ? "+" : ""}${total}).`, trendStr + ".", vixStr + ".", credStr + "."];
    if (ratesRising) parts.push("10-yr yield rising above 20d avg: rate headwind.");
    if (Math.abs(div) > 0.04) parts.push(div > 0 ? "Growth (QQQ) leading small-caps: late-cycle." : "Small-caps underperforming: risk-off breadth.");

    const asOf = spy.lastTs
      ? new Date(spy.lastTs * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    return {
      regime,
      confidence,
      signals: {
        trend:    { score: trendScore, spy_vs_sma200_pct: +(vs200 * 100).toFixed(2), spy_vs_sma50_pct: +(vs50 * 100).toFixed(2), sma50: sma50 ? +sma50.toFixed(2) : null, sma200: sma200 ? +sma200.toFixed(2) : null },
        volatility: { score: volScore, vix: +vixNow.toFixed(2), vix_avg_20d: +vixAvg20.toFixed(2), vix_trend: vixSlope > 0.02 ? "rising" : vixSlope < -0.02 ? "falling" : "flat" },
        credit:   { score: credScore, hyg_ief_ratio: +hrNow.toFixed(4), hyg_ief_avg_30d: +hrAvg30.toFixed(4), pct_vs_avg: +hrPct.toFixed(2) },
        rates:    { score: rateScore, tnx: +tnxNow.toFixed(3), tnx_avg_20d: +tnxAvg20.toFixed(3), rising: ratesRising },
        momentum: { score: momScore, qqq_1m_pct: +(qRet * 100).toFixed(2), iwm_1m_pct: +(iRet * 100).toFixed(2), divergence_pct: +(div * 100).toFixed(2) },
      },
      narrative: parts.join(" "),
      price_data: {
        spy: +spyNow.toFixed(2),
        qqq: +qqqNow.toFixed(2),
        iwm: +iwmNow.toFixed(2),
        vix: +vixNow.toFixed(2),
        hyg_ief_ratio: +hrNow.toFixed(4),
        tnx_yield_pct: +tnxNow.toFixed(3),
      },
      as_of: asOf,
    };
  },
};
