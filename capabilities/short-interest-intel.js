// short-interest-intel.js
//
// Outstanding short interest intelligence for US equities.
// Sourced from Yahoo Finance quoteSummary (free, crumb-auth, no API key).
//
// Distinct from short-volume-intel (which is FINRA daily short-SALE volume).
// This cap returns the outstanding SHORT INTEREST POSITION:
//   - Total shares currently sold short (not yet covered)
//   - Short interest as % of float (the institutional squeeze signal)
//   - Days to cover (short interest / avg daily volume = covering pressure)
//   - Date of last FINRA report (semi-monthly cadence)
//
// Heuristic moat:
//   short_interest_label: EXTREME | HEAVILY_SHORTED | MODERATELY_SHORTED | LIGHTLY_SHORTED
//   squeeze_risk:         EXTREME | HIGH | MODERATE | LOW
//
// Seam: equity-research DCF pipelines need short positioning alongside
// institutional ownership (institutional-ownership-intel) and insider activity
// (insider-trading-intel). High short float + catalyst = forced covering event.
// Completes the "who owns / who's short / who's buying" trifecta.
//
// Price: $0.012 — single YF quoteSummary fetch, crumb-auth.

const UA           = "Mozilla/5.0 (compatible; the-stall/4.75; +https://intuitek.ai)";
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

function shortInterestLabel(shortPctFloat) {
  if (shortPctFloat == null) return null;
  if (shortPctFloat >= 35) return "EXTREME";
  if (shortPctFloat >= 20) return "HEAVILY_SHORTED";
  if (shortPctFloat >= 10) return "MODERATELY_SHORTED";
  return "LIGHTLY_SHORTED";
}

function squeezeRisk(shortPctFloat, daysToCover) {
  if (shortPctFloat == null) return null;
  // Extreme: high % float shorted AND lots of days needed to cover → forced covering is severe
  if (shortPctFloat >= 35 && daysToCover != null && daysToCover >= 5) return "EXTREME";
  if (shortPctFloat >= 25 || (daysToCover != null && daysToCover >= 10)) return "HIGH";
  if (shortPctFloat >= 10 || (daysToCover != null && daysToCover >= 3)) return "MODERATE";
  return "LOW";
}

function squeezeInterpretation(label, risk) {
  if (!label) return null;
  const riskText = {
    EXTREME: "Extreme squeeze setup — forced covering could trigger violent price spike.",
    HIGH:    "High squeeze risk — significant covering pressure on any upside catalyst.",
    MODERATE:"Moderate short positioning — some covering pressure, not dominant.",
    LOW:     "Low short interest — minimal squeeze potential, shorts not a dominant force.",
  }[risk] ?? null;
  const labelText = {
    EXTREME:           "Extremely crowded short — top decile of US equities by float short.",
    HEAVILY_SHORTED:   "Heavily shorted — substantial bearish consensus from short sellers.",
    MODERATELY_SHORTED:"Moderately shorted — below-average conviction short position.",
    LIGHTLY_SHORTED:   "Lightly shorted — broad market agrees; little bearish short pressure.",
  }[label] ?? null;
  return [labelText, riskText].filter(Boolean).join(" ");
}

export default {
  name:  "short-interest-intel",
  price: "$0.021",

  description:
    "Outstanding short interest intelligence for US equities: shares sold short, " +
    "short % of float, days-to-cover (covering pressure), and last FINRA report date. " +
    "Includes heuristic squeeze risk scoring: EXTREME/HIGH/MODERATE/LOW based on " +
    "float short % and days-to-cover. Closes the equity ownership trifecta alongside " +
    "institutional-ownership-intel and insider-trading-intel. Distinct from " +
    "short-volume-intel (daily FINRA trading volume). Source: Yahoo Finance, no API key.",

  inputSchema: {
    type:       "object",
    required:   ["ticker"],
    properties: {
      ticker: {
        type:        "string",
        description: "US equity ticker symbol (e.g. AAPL, TSLA, GME). Case-insensitive.",
      },
    },
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:                 { type: "string" },
      shares_short:           { type: "integer" },
      short_pct_of_float:     { type: "number" },
      days_to_cover:          { type: "number" },
      date_short_interest:    { type: "string" },
      float_shares:           { type: "integer" },
      shares_outstanding:     { type: "integer" },
      short_interest_label:   { type: "string" },
      squeeze_risk:           { type: "string" },
      interpretation:         { type: "string" },
    },
  },

  async handler({ ticker }) {
    if (!ticker?.trim()) throw new Error("'ticker' is required.");
    const sym = ticker.trim().toUpperCase();

    const data = await fetchQS(sym, "defaultKeyStatistics,summaryDetail");
    const err  = data?.quoteSummary?.error;
    if (err) throw new Error(`Yahoo Finance error: ${err.description ?? JSON.stringify(err)}`);

    const qs   = data?.quoteSummary?.result?.[0];
    if (!qs)   throw new Error(`No data returned from Yahoo Finance for ${sym}`);

    const dks = qs.defaultKeyStatistics ?? {};
    const sd  = qs.summaryDetail        ?? {};

    const sharesShort      = rawVal(dks.sharesShort);
    const shortPctFloatRaw = rawVal(dks.shortPercentOfFloat);
    const shortPctFloat    = shortPctFloatRaw != null ? pct(shortPctFloatRaw) : null;
    const daysToCover      = rawVal(dks.shortRatio) != null ? r2(rawVal(dks.shortRatio)) : null;
    const dateShortTs      = rawVal(dks.dateShortInterest);
    const dateShort        = dateShortTs ? new Date(dateShortTs * 1000).toISOString().slice(0, 10) : null;
    const floatShares      = rawVal(dks.floatShares);
    const sharesOut        = rawVal(sd.sharesOutstanding) ?? rawVal(dks.sharesOutstanding);

    const label = shortInterestLabel(shortPctFloat);
    const risk  = squeezeRisk(shortPctFloat, daysToCover);

    return {
      ticker:                sym,
      shares_short:          sharesShort,
      short_pct_of_float:    shortPctFloat,
      days_to_cover:         daysToCover,
      date_short_interest:   dateShort,
      float_shares:          floatShares,
      shares_outstanding:    sharesOut,
      short_interest_label:  label,
      squeeze_risk:          risk,
      interpretation:        squeezeInterpretation(label, risk),
      note:                  "Short interest reported semi-monthly by FINRA. 'Days to cover' = shares_short / avg_daily_volume.",
      source:                "Yahoo Finance quoteSummary (defaultKeyStatistics)",
    };
  },
};
