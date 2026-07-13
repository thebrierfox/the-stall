// dividend-intel.js
//
// Full dividend intelligence for any dividend-paying US equity. Computes
// trailing 12-month yield, forward annual rate, payout frequency (monthly/
// quarterly/semi-annual/annual), 5-year CAGR, consecutive years paid,
// consecutive years of growth, and full dividend history.
//
// Designed for income-investing agents that need to evaluate dividend safety,
// growth trajectory, and yield-on-cost. Collapses the typical multi-step chain
// (price lookup + dividend history fetch + manual calculation) into one call.
//
// Source: Yahoo Finance v8/finance/chart with events — public, no API key,
// 5-year dividend history. Same endpoint as us-stock-price (proven reliable).

const YF_BASE = "https://query2.finance.yahoo.com/v8/finance/chart";
const UA      = "Mozilla/5.0 (compatible; the-stall/3.63; +https://intuitek.ai)";
const TIMEOUT = 15_000;

function detectFrequency(dividendDates) {
  if (dividendDates.length < 2) return "unknown";
  const sorted = [...dividendDates].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const daysBetween = Math.round((sorted[i] - sorted[i - 1]) / 86400);
    gaps.push(daysBetween);
  }
  const medianGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  if (medianGap <= 35)        return "monthly";
  if (medianGap <= 100)       return "quarterly";
  if (medianGap <= 200)       return "semi-annual";
  return "annual";
}

function groupByYear(dividends) {
  const byYear = {};
  for (const d of dividends) {
    const yr = new Date(d.date * 1000).getFullYear();
    byYear[yr] = (byYear[yr] || 0) + d.amount;
  }
  return byYear;
}

function cagr(startVal, endVal, years) {
  if (!startVal || !endVal || years < 1) return null;
  return Math.round(((endVal / startVal) ** (1 / years) - 1) * 10000) / 100;
}

export default {
  name: "dividend-intel",
  price: "$0.059",

  description:
    "Full dividend intelligence for any US stock: trailing 12-month yield, forward annual rate, payout frequency (monthly/quarterly/semi-annual/annual), 5-year dividend CAGR, consecutive years paid, consecutive years of growth, and complete 5-year dividend history with dates and amounts. Single call — no API key. Ideal for income screening, dividend safety analysis, and yield comparison across a portfolio.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "US stock ticker (e.g. AAPL, JNJ, KO, T, SCHD). Case-insensitive.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:            { type: "string" },
      name:              { type: ["string", "null"] },
      price_usd:         { type: "number",  description: "Current market price." },
      currency:          { type: "string" },
      pays_dividend:     { type: "boolean", description: "False if no dividends found in 5-year history." },
      trailing_yield_pct: {
        type: ["number", "null"],
        description: "Trailing 12-month dividend yield as a percentage of current price.",
      },
      forward_annual_rate: {
        type: ["number", "null"],
        description: "Estimated annual dividend based on most recent declared amount × frequency.",
      },
      forward_yield_pct: {
        type: ["number", "null"],
        description: "forward_annual_rate / current price × 100.",
      },
      payout_frequency: {
        type: "string",
        enum: ["monthly", "quarterly", "semi-annual", "annual", "unknown", "none"],
      },
      consecutive_years_paid: {
        type: ["integer", "null"],
        description: "Number of consecutive years with at least one dividend payment (up to 5-year history).",
      },
      consecutive_years_growth: {
        type: ["integer", "null"],
        description: "Number of consecutive years with annual dividend growth (most recent streak).",
      },
      cagr_5yr_pct: {
        type: ["number", "null"],
        description: "5-year compound annual growth rate of total annual dividends. Null if < 2 years of data.",
      },
      most_recent_dividend: {
        type: ["object", "null"],
        properties: {
          amount:     { type: "number" },
          ex_date:    { type: "string", description: "ISO-8601 ex-dividend date." },
        },
      },
      history: {
        type: "array",
        description: "Dividend payments, most recent first (up to 5 years).",
        items: {
          type: "object",
          properties: {
            ex_date: { type: "string" },
            amount:  { type: "number" },
          },
        },
      },
      ts: { type: "string" },
    },
  },

  async handler(query) {
    const ticker = (query.ticker || "AAPL").trim().toUpperCase();
    if (ticker.length > 12 || !/^[A-Z0-9.\-^=]+$/.test(ticker)) {
      throw new Error("ticker must be 1–12 uppercase alphanumeric characters");
    }

    const url = `${YF_BASE}/${encodeURIComponent(ticker)}?range=5y&interval=1mo&events=div%7Csplit`;
    const resp = await fetch(url, {
      headers: { "User-Agent": UA },
      signal:  AbortSignal.timeout(TIMEOUT),
    });
    if (!resp.ok) throw new Error(`Yahoo Finance HTTP ${resp.status} for ${ticker}`);

    const d = await resp.json();
    const result = d?.chart?.result?.[0];
    if (!result) {
      const err = d?.chart?.error;
      throw new Error(err ? `${err.code}: ${err.description}` : `no data returned for ${ticker}`);
    }

    const meta  = result.meta;
    const price = meta.regularMarketPrice ?? null;
    if (!price) throw new Error(`no price data for ${ticker}`);

    const divMap  = result.events?.dividends ?? {};
    const divList = Object.values(divMap)
      .filter(dv => dv.amount > 0)
      .sort((a, b) => b.date - a.date);

    if (!divList.length) {
      return {
        ticker,
        name:            meta.longName ?? meta.shortName ?? null,
        price_usd:       Math.round(price * 100) / 100,
        currency:        meta.currency ?? "USD",
        pays_dividend:   false,
        trailing_yield_pct:     null,
        forward_annual_rate:    null,
        forward_yield_pct:      null,
        payout_frequency:       "none",
        consecutive_years_paid: 0,
        consecutive_years_growth: null,
        cagr_5yr_pct:           null,
        most_recent_dividend:   null,
        history:                [],
        ts:                     new Date().toISOString(),
      };
    }

    const history = divList.map(dv => ({
      ex_date: new Date(dv.date * 1000).toISOString().slice(0, 10),
      amount:  Math.round(dv.amount * 100000) / 100000,
    }));

    const frequency = detectFrequency(divList.map(dv => dv.date));

    // Trailing 12-month yield (sum of dividends paid in last 365 days)
    const now = Date.now() / 1000;
    const oneYearAgo = now - 365 * 86400;
    const trailing12m = divList
      .filter(dv => dv.date >= oneYearAgo)
      .reduce((s, dv) => s + dv.amount, 0);
    const trailingYield = trailing12m > 0
      ? Math.round((trailing12m / price) * 10000) / 100
      : null;

    // Forward annual rate (most recent × frequency multiplier)
    const freqMultipliers = { monthly: 12, quarterly: 4, "semi-annual": 2, annual: 1, unknown: 4 };
    const mult = freqMultipliers[frequency] ?? 4;
    const mostRecent = divList[0];
    const forwardAnnual = Math.round(mostRecent.amount * mult * 100000) / 100000;
    const forwardYield  = Math.round((forwardAnnual / price) * 10000) / 100;

    // Annual totals by year for growth analysis
    const byYear = groupByYear(divList);
    const years  = Object.keys(byYear).map(Number).sort();

    // Consecutive years paid
    const currentYear = new Date().getFullYear();
    let consecPaid = 0;
    for (let yr = currentYear; yr >= currentYear - 5; yr--) {
      if (byYear[yr]) consecPaid++;
      else break;
    }

    // Consecutive years of growth (most recent streak)
    let consecGrowth = 0;
    if (years.length >= 2) {
      const sortedYears = years.sort((a, b) => b - a);
      for (let i = 0; i < sortedYears.length - 1; i++) {
        const thisYr = sortedYears[i];
        const prevYr = sortedYears[i + 1];
        if (thisYr - prevYr === 1 && byYear[thisYr] > byYear[prevYr]) {
          consecGrowth++;
        } else {
          break;
        }
      }
    }

    // 5yr CAGR (oldest to newest full year)
    const fullYears = years.filter(yr => yr < currentYear);
    const cagrVal = fullYears.length >= 2
      ? cagr(byYear[fullYears[0]], byYear[fullYears[fullYears.length - 1]], fullYears.length - 1)
      : null;

    return {
      ticker,
      name:            meta.longName ?? meta.shortName ?? null,
      price_usd:       Math.round(price * 100) / 100,
      currency:        meta.currency ?? "USD",
      pays_dividend:   true,
      trailing_yield_pct:     trailingYield,
      forward_annual_rate:    forwardAnnual,
      forward_yield_pct:      forwardYield,
      payout_frequency:       frequency,
      consecutive_years_paid: consecPaid,
      consecutive_years_growth: consecGrowth,
      cagr_5yr_pct:           cagrVal,
      most_recent_dividend: {
        amount:  Math.round(mostRecent.amount * 100000) / 100000,
        ex_date: new Date(mostRecent.date * 1000).toISOString().slice(0, 10),
      },
      history,
      ts: new Date().toISOString(),
    };
  },
};
