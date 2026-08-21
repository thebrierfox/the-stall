// balance-sheet.js
//
// Quarterly or annual balance-sheet history from the SEC's official EDGAR
// Companyfacts API. The API is public, keyless, and designed for automated
// access. Values come from issuer-filed XBRL facts, so some fields may be null
// when a filer uses a different taxonomy extension or does not disclose them.

const UA = "the-stall/4.68 balance-sheet (kyle@intuitek.ai)";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const EFTS_URL = "https://efts.sec.gov/LATEST/search-index";
const COMPANYFACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{CIK}.json";
const TIMEOUT_MS = 14_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const COMPANYFACTS_TTL_MS = 5 * 60 * 1000;

let tickerCache = null;
const companyfactsCache = new Map();
const companyResolutionCache = new Map();

function upstreamError(message) {
  const error = new Error(message);
  error.status = 503;
  return error;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function fetchJson(url, label, attempt = 0) {
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if ([429, 503].includes(response.status) && attempt < 2) {
    const retryHeader = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    const retryMs = Math.min(5_000, Number.isFinite(retryHeader) ? retryHeader * 1000 : 1_000 * (2 ** attempt));
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    return fetchJson(url, label, attempt + 1);
  }
  if (!response.ok) throw upstreamError(`${label} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw upstreamError(`${label} returned invalid JSON`);
  }
}

async function getTickerMap() {
  if (tickerCache && Date.now() - tickerCache.loadedAt < CACHE_TTL_MS) {
    return tickerCache.map;
  }
  const raw = await fetchJson(TICKERS_URL, "SEC ticker map");
  const map = {};
  for (const item of Object.values(raw)) {
    if (!item?.ticker || item?.cik_str == null) continue;
    map[String(item.ticker).toUpperCase()] = {
      cik: String(item.cik_str).padStart(10, "0"),
      title: item.title ?? null,
    };
  }
  tickerCache = { loadedAt: Date.now(), map };
  return map;
}

export function companyFromEftsHits(symbol, hits) {
  const marker = `(${symbol})`;
  for (const hit of Array.isArray(hits) ? hits : []) {
    const source = hit?._source ?? {};
    for (const displayName of source.display_names ?? []) {
      if (!String(displayName).toUpperCase().includes(marker)) continue;
      const cikMatch = String(displayName).match(/\(CIK\s+(\d{1,10})\)/i);
      const cik = cikMatch?.[1] ?? source.ciks?.[0];
      if (!cik) continue;
      return {
        cik: String(cik).padStart(10, "0"),
        title: String(displayName).split(marker)[0].trim() || null,
      };
    }
  }
  return null;
}

async function resolveCompany(symbol) {
  if (companyResolutionCache.has(symbol)) return companyResolutionCache.get(symbol);
  try {
    const tickerMap = await getTickerMap();
    if (tickerMap[symbol]) {
      companyResolutionCache.set(symbol, tickerMap[symbol]);
      return tickerMap[symbol];
    }
  } catch (error) {
    if (error?.status !== 503) throw error;
  }

  const params = new URLSearchParams({
    q: `"${symbol}"`,
    forms: "10-K,10-Q,20-F,40-F",
    from: "0",
    size: "10",
  });
  const data = await fetchJson(`${EFTS_URL}?${params}`, `SEC ticker search for ${symbol}`);
  const company = companyFromEftsHits(symbol, data?.hits?.hits);
  if (!company) throw badRequest(`Ticker not found in SEC filings: ${symbol}`);
  companyResolutionCache.set(symbol, company);
  return company;
}

async function getCompanyFacts(symbol, cik) {
  const cached = companyfactsCache.get(cik);
  if (cached && Date.now() - cached.loadedAt < COMPANYFACTS_TTL_MS) return cached.data;
  const data = await fetchJson(
    COMPANYFACTS_URL.replace("{CIK}", cik),
    `SEC Companyfacts for ${symbol}`,
  );
  companyfactsCache.set(cik, { loadedAt: Date.now(), data });
  return data;
}

function allowedForms(period) {
  return period === "annual"
    ? new Set(["10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"])
    : new Set(["10-Q", "10-Q/A", "10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"]);
}

function valuesForTags(companyfacts, namespace, tags, unit, period) {
  const result = new Map();
  const forms = allowedForms(period);
  const namespaceFacts = companyfacts?.facts?.[namespace] ?? {};

  for (const tag of tags) {
    const fact = namespaceFacts[tag];
    if (!fact?.units) continue;
    const rows = fact.units[unit] ?? [];
    const latestForEnd = new Map();
    for (const row of rows) {
      if (!forms.has(row?.form) || !row?.end || !Number.isFinite(row?.val)) continue;
      const existing = latestForEnd.get(row.end);
      if (!existing || String(row.filed ?? "") > String(existing.filed ?? "")) {
        latestForEnd.set(row.end, row);
      }
    }
    for (const [end, row] of latestForEnd) {
      if (!result.has(end)) result.set(end, row);
    }
  }
  return result;
}

function valueAt(map, end) {
  const value = map.get(end)?.val;
  return Number.isFinite(value) ? value : null;
}

function latestFiledAt(maps, end) {
  const filed = Object.values(maps)
    .map((map) => map.get(end)?.filed)
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a))[0];
  return filed ?? null;
}

function sumAvailable(...values) {
  const present = values.filter(Number.isFinite);
  return present.length ? present.reduce((total, value) => total + value, 0) : null;
}

export function periodsFromCompanyFacts(companyfacts, period = "quarterly", limit = 4) {
  const maps = {
    cash: valuesForTags(companyfacts, "us-gaap", [
      "CashAndCashEquivalentsAtCarryingValue",
      "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ], "USD", period),
    shortInvestments: valuesForTags(companyfacts, "us-gaap", [
      "ShortTermInvestments",
      "MarketableSecuritiesCurrent",
    ], "USD", period),
    currentAssets: valuesForTags(companyfacts, "us-gaap", ["AssetsCurrent"], "USD", period),
    totalAssets: valuesForTags(companyfacts, "us-gaap", ["Assets"], "USD", period),
    currentLiabilities: valuesForTags(companyfacts, "us-gaap", ["LiabilitiesCurrent"], "USD", period),
    debtTotal: valuesForTags(companyfacts, "us-gaap", [
      "LongTermDebtAndFinanceLeaseObligations",
      "LongTermDebtAndCapitalLeaseObligations",
    ], "USD", period),
    debtCurrent: valuesForTags(companyfacts, "us-gaap", [
      "DebtCurrent",
      "LongTermDebtCurrent",
      "ShortTermBorrowings",
    ], "USD", period),
    debtNoncurrent: valuesForTags(companyfacts, "us-gaap", [
      "LongTermDebtAndFinanceLeaseObligationsNoncurrent",
      "LongTermDebtNoncurrent",
    ], "USD", period),
    liabilities: valuesForTags(companyfacts, "us-gaap", ["Liabilities"], "USD", period),
    equity: valuesForTags(companyfacts, "us-gaap", [
      "StockholdersEquity",
      "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ], "USD", period),
    retainedEarnings: valuesForTags(companyfacts, "us-gaap", ["RetainedEarningsAccumulatedDeficit"], "USD", period),
    goodwillIntangibles: valuesForTags(companyfacts, "us-gaap", ["GoodwillAndIntangibleAssetsNet"], "USD", period),
    goodwill: valuesForTags(companyfacts, "us-gaap", ["Goodwill"], "USD", period),
    intangibles: valuesForTags(companyfacts, "us-gaap", [
      "FiniteLivedIntangibleAssetsNet",
      "IndefiniteLivedIntangibleAssetsExcludingGoodwill",
    ], "USD", period),
    shares: valuesForTags(companyfacts, "dei", ["EntityCommonStockSharesOutstanding"], "shares", period),
  };

  const dates = [...new Set([
    ...maps.totalAssets.keys(),
    ...maps.currentAssets.keys(),
    ...maps.equity.keys(),
  ])].sort((a, b) => b.localeCompare(a));

  return dates.slice(0, limit).map((end) => {
    const cash = valueAt(maps.cash, end);
    const shortTermInvestments = valueAt(maps.shortInvestments, end);
    const currentAssets = valueAt(maps.currentAssets, end);
    const currentLiabilities = valueAt(maps.currentLiabilities, end);
    const directDebt = valueAt(maps.debtTotal, end);
    const componentDebt = sumAvailable(valueAt(maps.debtCurrent, end), valueAt(maps.debtNoncurrent, end));
    const totalDebt = directDebt ?? componentDebt;
    const equity = valueAt(maps.equity, end);
    const combinedIntangibles = valueAt(maps.goodwillIntangibles, end);
    const goodwillIntangibles = combinedIntangibles ?? sumAvailable(
      valueAt(maps.goodwill, end),
      valueAt(maps.intangibles, end),
    );
    const netDebt = Number.isFinite(totalDebt)
      ? totalDebt - (cash ?? 0) - (shortTermInvestments ?? 0)
      : null;

    return {
      period_end: end,
      filed_at: latestFiledAt(maps, end),
      cash,
      short_term_investments: shortTermInvestments,
      current_assets: currentAssets,
      total_assets: valueAt(maps.totalAssets, end),
      current_liabilities: currentLiabilities,
      total_debt: totalDebt,
      net_debt: netDebt,
      net_cash: Number.isFinite(netDebt) ? -netDebt : null,
      total_liabilities: valueAt(maps.liabilities, end),
      stockholders_equity: equity,
      book_value: equity,
      retained_earnings: valueAt(maps.retainedEarnings, end),
      goodwill_intangibles: goodwillIntangibles,
      tangible_book_value: Number.isFinite(equity) && Number.isFinite(goodwillIntangibles)
        ? equity - goodwillIntangibles
        : null,
      working_capital: Number.isFinite(currentAssets) && Number.isFinite(currentLiabilities)
        ? currentAssets - currentLiabilities
        : null,
      shares_outstanding: valueAt(maps.shares, end),
    };
  });
}

export function balanceSheetPollingState(periods, knownLatestPeriodEnd, now = new Date()) {
  const latestPeriodEnd = periods[0]?.period_end ?? null;
  return {
    latest_period_end: latestPeriodEnd,
    changed_since_known_period: knownLatestPeriodEnd && latestPeriodEnd
      ? latestPeriodEnd > knownLatestPeriodEnd
      : null,
    recommended_poll_interval_hours: 24,
    next_poll_after_utc: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

export default {
  name: "balance-sheet",
  price: "$0.021",
  description:
    "Quarterly or annual balance-sheet history for a US public company from issuer-filed SEC EDGAR XBRL facts. " +
    "Returns cash, investments, assets, debt, liabilities, equity, retained earnings, tangible book value, " +
    "working capital, and shares outstanding. Source: official SEC Companyfacts API; no API key. " +
    "For automated monitoring, pass known_latest_period_end from the prior response and poll again after next_poll_after_utc.",
  inputSchema: {
    type: "object",
    required: ["ticker"],
    additionalProperties: false,
    properties: {
      ticker: { type: "string", description: "US-listed company ticker, such as AAPL or MSFT." },
      period: {
        type: "string",
        enum: ["quarterly", "annual"],
        description: "Defaults to quarterly. Annual uses annual filing forms only.",
      },
      limit: { type: "integer", minimum: 1, maximum: 8, description: "Periods to return; default 4." },
      known_latest_period_end: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Optional prior latest_period_end. The response reports whether a newer filing period is available.",
      },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      ticker: { type: "string" },
      company_name: { type: ["string", "null"] },
      cik: { type: "string" },
      period_type: { type: "string" },
      currency: { type: "string" },
      periods: { type: "array", items: { type: "object" } },
      source: { type: "string" },
      retrieved_at: { type: "string" },
      latest_period_end: { type: ["string", "null"] },
      changed_since_known_period: { type: ["boolean", "null"] },
      recommended_poll_interval_hours: { type: "integer" },
      next_poll_after_utc: { type: "string" },
    },
  },
  async handler({ ticker, period = "quarterly", limit = 4, known_latest_period_end }) {
    const symbol = String(ticker ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
      throw new Error("ticker is required and must be a valid US-listed symbol");
    }
    if (known_latest_period_end && !/^\d{4}-\d{2}-\d{2}$/.test(known_latest_period_end)) {
      throw new Error("known_latest_period_end must use YYYY-MM-DD format");
    }
    const company = await resolveCompany(symbol);

    const resolvedPeriod = period === "annual" ? "annual" : "quarterly";
    const maxLimit = Math.min(Math.max(1, Number(limit) || 4), resolvedPeriod === "annual" ? 4 : 8);
    const companyfacts = await getCompanyFacts(symbol, company.cik);
    const periods = periodsFromCompanyFacts(companyfacts, resolvedPeriod, maxLimit);
    if (!periods.length) throw new Error(`No SEC balance-sheet facts found for ${symbol}`);

    return {
      ticker: symbol,
      company_name: companyfacts.entityName ?? company.title,
      cik: company.cik,
      period_type: resolvedPeriod,
      currency: "USD",
      periods,
      source: "SEC EDGAR Companyfacts (data.sec.gov)",
      retrieved_at: new Date().toISOString(),
      ...balanceSheetPollingState(periods, known_latest_period_end),
    };
  },
};
