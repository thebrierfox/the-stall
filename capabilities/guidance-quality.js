// guidance-quality.js
//
// Earnings guidance quality and predictability scoring for any US stock.
// Converts a company's historical EPS beat/miss record into an actionable
// predictability label and score — answering the DCF analyst's key question:
// "Should I trust this company's forward guidance in my model?"
//
// Four guidance quality tiers:
//   SUPER_BEATER     — beat rate ≥ 75%, avg surprise > 5%
//                      Management reliably under-promises and over-delivers.
//                      Discount analyst consensus by 5–10% for conservatism.
//   RELIABLE_BEATER  — beat rate ≥ 75%, avg surprise 0–5%
//                      Guidance is dependable, minimal cushion.
//                      Accept analyst consensus estimates at face value.
//   INCONSISTENT     — beat rate 40–74%
//                      Mixed accuracy; guidance has low informational content.
//                      Apply ±10% uncertainty band to forward estimates.
//   GUIDANCE_RISK    — beat rate < 40%
//                      History of missing guidance; discount forward estimates
//                      by 10–20% before modeling.
//
// Predictability score (0–100): weighted composite of beat rate, consistency
// (std deviation of surprise %), and directional trend (improving vs. declining).
//
// Seam: DCF and earnings-momentum agents already chain earnings-surprises,
// earnings-estimates, and earnings-calendar. guidance-quality slots between
// them — it tells the agent *how much to trust* the forward estimates it
// just fetched, enabling calibrated DCF inputs rather than raw analyst consensus.
// Distinct from earnings-quality (Beneish M-Score for manipulation) and
// earnings-surprises (raw beat/miss table).
//
// Source: Yahoo Finance quoteSummary (earnings, calendarEvents). Free, no API key.
// Price: $0.012

const UA           = "Mozilla/5.0 (compatible; the-stall/4.77; +https://intuitek.ai)";
const YF_CRUMB_SRC = "https://fc.yahoo.com";
const YF_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_SUMMARY   = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const TMO          = 14_000;
const CRUMB_TTL    = 30 * 60 * 1000;

let _crumbCache = null;

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }

function rawVal(f) {
  if (f == null) return null;
  if (typeof f === "number") return f;
  return f?.raw ?? null;
}

function isoDate(ts) {
  if (!ts) return null;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

async function refreshCrumb() {
  const seed = await fetch(YF_CRUMB_SRC, {
    headers: { "User-Agent": UA }, redirect: "follow",
    signal: AbortSignal.timeout(TMO),
  });
  const cookies = (seed.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
  const cr = await fetch(YF_CRUMB_URL, {
    headers: { "User-Agent": UA, "Cookie": cookies },
    signal: AbortSignal.timeout(TMO),
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
  const url = `${YF_SUMMARY}/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Cookie": cookies, "Accept": "application/json" },
    signal: AbortSignal.timeout(TMO),
  });
  if (r.status === 401 && retry) { _crumbCache = null; return fetchQS(ticker, modules, false); }
  if (!r.ok) throw new Error(`Yahoo Finance ${r.status} for ${ticker}`);
  return r.json();
}

function stdDev(arr) {
  if (arr.length < 2) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function guidanceLabel(beatRate, avgSurprise) {
  if (beatRate == null) return "INSUFFICIENT_DATA";
  if (beatRate >= 75 && avgSurprise > 5)  return "SUPER_BEATER";
  if (beatRate >= 75)                      return "RELIABLE_BEATER";
  if (beatRate >= 40)                      return "INCONSISTENT";
  return "GUIDANCE_RISK";
}

function trendLabel(recentBeatRate, olderBeatRate) {
  if (recentBeatRate == null || olderBeatRate == null) return "INSUFFICIENT_DATA";
  const delta = recentBeatRate - olderBeatRate;
  if (delta >= 20)  return "IMPROVING";
  if (delta <= -20) return "DETERIORATING";
  return "STABLE";
}

function predictabilityScore(beatRate, consistency, trend) {
  if (beatRate == null) return null;
  // Base: beat rate mapped to 0–60
  const base = Math.round(beatRate * 0.6);
  // Consistency: low std dev = more predictable (max 25 pts)
  const consistencyPts = consistency == null
    ? 12 // neutral if not enough data
    : Math.max(0, Math.round(25 - consistency * 2));
  // Trend (max ±15)
  const trendPts = trend === "IMPROVING" ? 15 : trend === "DETERIORATING" ? -15 : 0;
  return Math.min(100, Math.max(0, base + consistencyPts + trendPts));
}

function interpretGuidance(label, avgSurprise, predictability) {
  const surpText = avgSurprise != null ? ` by an average of ${Math.abs(avgSurprise)}%` : "";
  const predText = predictability != null ? ` (predictability: ${predictability}/100)` : "";
  switch (label) {
    case "SUPER_BEATER":
      return `Management consistently under-promises and over-delivers${surpText}${predText}. ` +
             `Conservative guidors are rare and prized — their forward estimates have a built-in positive cushion. ` +
             `When modeling DCF scenarios, accept analyst consensus or shade estimates 5–10% above consensus.`;
    case "RELIABLE_BEATER":
      return `Reliable beat track record${surpText}${predText}. ` +
             `Management sets realistic expectations and delivers. ` +
             `Forward analyst estimates are dependable inputs — accept consensus without a large adjustment.`;
    case "INCONSISTENT":
      return `Mixed guidance accuracy${surpText}${predText}. ` +
             `The company's guidance has low informational content — both upside and downside surprises are common. ` +
             `Apply a ±10% uncertainty band around forward estimates when building DCF scenarios.`;
    case "GUIDANCE_RISK":
      return `Repeated guidance misses${surpText}${predText}. ` +
             `Management has a history of over-promising or losing visibility on their own business. ` +
             `Discount forward estimates by 10–20% in base DCF scenarios and validate against FCF, not EPS.`;
    default:
      return "Insufficient historical earnings data to assess guidance quality.";
  }
}

export default {
  name:  "guidance-quality",
  price: "$0.025",

  description:
    "Earnings guidance quality and predictability scoring for any US stock. " +
    "Converts the historical EPS beat/miss record into a label (SUPER_BEATER / " +
    "RELIABLE_BEATER / INCONSISTENT / GUIDANCE_RISK), a predictability score (0–100), " +
    "trend signal (IMPROVING / STABLE / DETERIORATING), and a DCF implication. " +
    "Answers 'how much should I trust this company's forward guidance?' before " +
    "modeling. Slots between earnings-surprises and earnings-estimates in a " +
    "DCF pipeline. Source: Yahoo Finance, no API key.",

  inputSchema: {
    type:       "object",
    required:   ["ticker"],
    properties: {
      ticker: {
        type:        "string",
        description: "US equity ticker symbol (e.g. AAPL, MSFT, NVDA). Case-insensitive.",
      },
      quarters: {
        type:        "integer",
        minimum:     2,
        maximum:     8,
        description: "Number of quarters to analyze (default 6, max 8).",
      },
    },
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:               { type: "string" },
      guidance_quality:     { type: "string", description: "SUPER_BEATER | RELIABLE_BEATER | INCONSISTENT | GUIDANCE_RISK | INSUFFICIENT_DATA" },
      predictability_score: { type: "integer", description: "0–100; higher = more predictable earnings." },
      beat_rate_pct:        { type: "number",  description: "% of quarters where actual EPS > consensus estimate." },
      avg_surprise_pct:     { type: "number",  description: "Average EPS surprise % (positive = beat)." },
      surprise_std_dev:     { type: "number",  description: "Standard deviation of surprise % (lower = more consistent)." },
      quarters_analyzed:    { type: "integer" },
      trend:                { type: "string",  description: "IMPROVING | STABLE | DETERIORATING | INSUFFICIENT_DATA" },
      interpretation:       { type: "string" },
      next_earnings_date:   { type: "string" },
      quarterly_history:    { type: "array" },
    },
  },

  async handler({ ticker, quarters: qParam }) {
    if (!ticker?.trim()) throw new Error("'ticker' is required.");
    const sym   = ticker.trim().toUpperCase();
    const nQtrs = Math.min(8, Math.max(2, Number(qParam) || 6));

    const data = await fetchQS(sym, "earnings,calendarEvents");
    const err  = data?.quoteSummary?.error;
    if (err) throw new Error(`Yahoo Finance error: ${err.description ?? JSON.stringify(err)}`);

    const result = data?.quoteSummary?.result?.[0];
    if (!result) throw new Error(`No data from Yahoo Finance for ${sym}`);

    const earnChart = result.earnings?.earningsChart ?? {};
    const calendar  = result.calendarEvents?.earnings ?? {};

    // Quarterly EPS history — YF returns oldest-first; reverse for newest-first
    const rawQtrs = (earnChart.quarterly ?? []).slice().reverse().slice(0, nQtrs);

    if (rawQtrs.length < 2) {
      return {
        ticker:               sym,
        guidance_quality:     "INSUFFICIENT_DATA",
        predictability_score: null,
        beat_rate_pct:        null,
        avg_surprise_pct:     null,
        surprise_std_dev:     null,
        quarters_analyzed:    rawQtrs.length,
        trend:                "INSUFFICIENT_DATA",
        interpretation:       "Fewer than 2 quarters of EPS history available. Cannot assess guidance quality.",
        next_earnings_date:   isoDate(rawVal((calendar.earningsDate ?? [])[0])),
        quarterly_history:    [],
        source:               "Yahoo Finance quoteSummary (earnings)",
      };
    }

    // Build structured history
    const history = rawQtrs.map(q => {
      const actual   = rawVal(q.actual);
      const estimate = rawVal(q.estimate);
      let surprisePct = rawVal(q.surprisePct);
      if (surprisePct == null && actual != null && estimate != null && estimate !== 0) {
        surprisePct = ((actual - estimate) / Math.abs(estimate)) * 100;
      }
      return {
        period:       q.date ?? null,
        actual_eps:   r2(actual),
        estimate_eps: r2(estimate),
        surprise_pct: surprisePct != null ? r2(surprisePct) : null,
      };
    });

    // Core metrics
    const valid         = history.filter(q => q.surprise_pct != null);
    const beats         = valid.filter(q => q.surprise_pct > 0);
    const surprises     = valid.map(q => q.surprise_pct);
    const beatRate      = valid.length ? r2((beats.length / valid.length) * 100) : null;
    const avgSurprise   = valid.length ? r2(surprises.reduce((a, b) => a + b, 0) / surprises.length) : null;
    const surpriseStdDev = valid.length >= 2 ? r2(stdDev(surprises)) : null;

    // Trend: compare newest 2 quarters vs remainder
    let trend = "INSUFFICIENT_DATA";
    if (valid.length >= 4) {
      const recentBeats = valid.slice(0, 2).filter(q => q.surprise_pct > 0).length;
      const olderBeats  = valid.slice(2).filter(q => q.surprise_pct > 0).length;
      const recentRate  = (recentBeats / 2) * 100;
      const olderRate   = (olderBeats / (valid.length - 2)) * 100;
      trend = trendLabel(recentRate, olderRate);
    }

    const label         = guidanceLabel(beatRate, avgSurprise);
    const predScore     = predictabilityScore(beatRate, surpriseStdDev, trend);
    const interpretation = interpretGuidance(label, avgSurprise, predScore);

    // Next earnings date
    const nextEarningsDate = isoDate(rawVal((calendar.earningsDate ?? [])[0]));

    return {
      ticker:               sym,
      guidance_quality:     label,
      predictability_score: predScore,
      beat_rate_pct:        beatRate,
      avg_surprise_pct:     avgSurprise,
      surprise_std_dev:     surpriseStdDev,
      quarters_analyzed:    valid.length,
      trend,
      interpretation,
      next_earnings_date:   nextEarningsDate,
      quarterly_history:    history,
      source:               "Yahoo Finance quoteSummary (earnings, calendarEvents)",
    };
  },
};
