// intl-stock-price.js
//
// International equity price for non-US exchanges (EU, UK, Swiss, JP, AU, CA, HK, IN).
// Accepts exchange-suffixed tickers (MC.PA, SAP.DE, AZN.L) or market+ticker shorthand.
// Sourced from Yahoo Finance v8 — no API key, live during market hours.
// Priced at $0.016 — ~27% below blockrun.ai's $0.022/call for the same data.
//
// Demand signal: 20,146 settlements from 27 unique payers in 7 days on blockrun's
// /api/v1/stocks/fr/price/* endpoint (observed 2026-06-08 via archive.db).

const YF_BASE = "https://query2.finance.yahoo.com/v8/finance/chart";
const UA      = "Mozilla/5.0 (compatible; the-stall/0.4; +https://intuitek.ai)";

const MARKET_SUFFIX = {
  fr: ".PA", paris: ".PA",
  de: ".DE", frankfurt: ".DE", xetra: ".DE",
  gb: ".L",  uk: ".L", london: ".L", lse: ".L",
  ch: ".SW", swiss: ".SW",
  nl: ".AS", amsterdam: ".AS",
  es: ".MC", madrid: ".MC",
  it: ".MI", milan: ".MI",
  pt: ".LS", lisbon: ".LS",
  be: ".BR", brussels: ".BR",
  jp: ".T",  tokyo: ".T",
  au: ".AX", asx: ".AX",
  ca: ".TO", tsx: ".TO",
  hk: ".HK", hongkong: ".HK",
  in: ".BO", bse: ".BO",
  ns: ".NS", nse: ".NS",
  sg: ".SI", singapore: ".SI",
  kr: ".KS", kospi: ".KS",
};

export default {
  name: "intl-stock-price",
  price: "$0.059",

  description:
    "Returns current stock price and intraday metrics for international stocks (EU, UK, Swiss, Japan, Australia, Canada, Hong Kong, India). Accepts exchange-suffixed tickers (MC.PA for LVMH, SAP.DE for SAP, AZN.L for AstraZeneca) or market shorthand (market=fr, ticker=MC). Sourced from Yahoo Finance — no API key, live during market hours. $0.020/call.",

  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description:
          "Full exchange-suffixed ticker (e.g. MC.PA, SAP.DE, AZN.L, NESN.SW, 7203.T) OR base ticker when market is also provided.",
      },
      market: {
        type: "string",
        description:
          "Optional market shorthand to auto-append exchange suffix: fr=Paris, de=Frankfurt, gb=London, ch=Swiss, nl=Amsterdam, es=Madrid, it=Milan, jp=Tokyo, au=ASX, ca=TSX, hk=HongKong, in=BSE. Ignored when ticker already contains a period.",
      },
    },
    required: [],
  },

  outputSchema: {
    type: "object",
    properties: {
      ticker:        { type: "string",  description: "Canonical ticker as reported by the exchange." },
      name:          { type: "string",  description: "Company full name." },
      price:         { type: "number",  description: "Current market price in native currency." },
      currency:      { type: "string",  description: "Quote currency (EUR, GBp, CHF, JPY, etc.)." },
      change_pct:    { type: "number",  description: "Percentage change from previous close." },
      change:        { type: "number",  description: "Absolute change from previous close in native currency." },
      volume:        { type: "integer", description: "Intraday volume (shares traded)." },
      day_high:      { type: "number",  description: "Intraday high in native currency." },
      day_low:       { type: "number",  description: "Intraday low in native currency." },
      week_52_high:  { type: "number",  description: "52-week high in native currency." },
      week_52_low:   { type: "number",  description: "52-week low in native currency." },
      exchange:      { type: "string",  description: "Exchange full name (e.g. PAR, GER, LSE, EBS)." },
      market_time:   { type: "string",  description: "ISO-8601 timestamp of the last market price." },
      ts:            { type: "string",  description: "ISO-8601 timestamp of this response." },
    },
  },

  async handler(query) {
    const rawTicker = (query.ticker || "MC.PA").trim();
    const rawMarket = (query.market || "").trim().toLowerCase();

    let symbol = rawTicker.toUpperCase().replace(/[^A-Z0-9.\-^]/g, "");
    if (!symbol) throw new Error("invalid ticker symbol");

    // Auto-append exchange suffix when market is given and ticker has no period
    if (rawMarket && !symbol.includes(".")) {
      const suffix = MARKET_SUFFIX[rawMarket];
      if (!suffix) throw new Error(`unknown market "${rawMarket}" — use fr, de, gb, ch, nl, es, it, jp, au, ca, hk, in, kr, sg`);
      symbol = symbol + suffix;
    }

    const url = `${YF_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=1d`;

    let data;
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(8000),
      });
      data = await resp.json();
    } catch (err) {
      throw new Error(`upstream fetch failed: ${err.message}`);
    }

    const result = data?.chart?.result?.[0];
    if (!result) {
      const errCode = data?.chart?.error?.code || "not_found";
      throw new Error(`no data for "${symbol}" (${errCode}) — verify the ticker includes the exchange suffix (e.g. MC.PA, SAP.DE, AZN.L)`);
    }

    const meta  = result.meta;
    const prev  = meta.chartPreviousClose ?? meta.regularMarketPrice;
    const price = meta.regularMarketPrice;
    const diff  = price - prev;
    const pct   = prev !== 0 ? (diff / prev) * 100 : 0;

    return {
      ticker:       meta.symbol,
      name:         meta.longName || meta.shortName || null,
      price:        Math.round(price * 10000) / 10000,
      currency:     meta.currency ?? null,
      change_pct:   Math.round(pct  * 10000) / 10000,
      change:       Math.round(diff * 10000) / 10000,
      volume:       meta.regularMarketVolume ?? null,
      day_high:     meta.regularMarketDayHigh ?? null,
      day_low:      meta.regularMarketDayLow  ?? null,
      week_52_high: meta.fiftyTwoWeekHigh     ?? null,
      week_52_low:  meta.fiftyTwoWeekLow      ?? null,
      exchange:     meta.fullExchangeName     ?? meta.exchangeName ?? null,
      market_time:  meta.regularMarketTime
                      ? new Date(meta.regularMarketTime * 1000).toISOString()
                      : null,
      ts:           new Date().toISOString(),
    };
  },
};
