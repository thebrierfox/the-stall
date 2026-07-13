// cot-positioning.js
//
// CFTC Commitment of Traders (COT) weekly positioning report for any futures
// market. Returns large speculator (hedge fund) vs commercial hedger positions
// — the industry-standard lens for reading crowd sentiment in commodities,
// currencies, rates, and equity index futures.
//
// Output: net position (longs - shorts) for each trader class, week-over-week
// change, % of open interest, and a 4-week trend so agents can detect
// positioning shifts before price follows.
//
// Source: CFTC Socrata public API (publicreporting.cftc.gov) — free, no auth.
// Updated every Friday with the previous Tuesday snapshot. The API returns
// legacy-format COT (all futures combined) for the broadest history.
//
// Seam: Quiver Quantitative / Barchart COT subscriptions run $20–50/mo. This
// delivers the same CFTC source data per-call for $0.018 — no account required.
//
// Covers: all 13 commodity sectors reported by CFTC — energy (crude, nat gas,
// gasoline), metals (gold, silver, copper), agricultural (wheat, corn,
// soybeans, coffee, cotton), equity indices (S&P 500, Nasdaq), currencies
// (EUR, JPY, GBP), and rates (Treasury bonds, Eurodollar).

const CFTC_BASE = "https://publicreporting.cftc.gov/resource/jun7-fc8e.json";
const TIMEOUT   = 14_000;
const UA        = "the-stall/4.64 (+https://the-stall.intuitek.ai; cot-positioning)";

function r(n) { return n != null ? Math.round(Number(n)) : null; }
function rPct(n, oi) {
  if (n == null || !oi) return null;
  return Math.round((Number(n) / oi) * 1000) / 10;
}

async function cftcFetch(params) {
  const url = new URL(CFTC_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`CFTC API ${res.status}`);
  return res.json();
}

function pickBestMatch(rows, query) {
  if (!rows.length) return null;
  const q = query.toLowerCase();
  // Prefer exact commodity_name match, then highest OI
  const scored = rows.map(r => {
    const cn = (r.commodity_name || "").toLowerCase();
    const mn = (r.market_and_exchange_names || "").toLowerCase();
    const oi = Number(r.open_interest_all || 0);
    // Exact match bonus
    let score = oi;
    if (cn === q) score += 1e12;
    else if (mn.includes(q)) score += 1e9;
    else if (cn.includes(q.split(" ")[0])) score += 1e6;
    return { row: r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].row;
}

function extractPositioning(row) {
  const oi     = r(row.open_interest_all);
  const spLong = r(row.noncomm_positions_long_all);
  const spShort= r(row.noncomm_positions_short_all);
  const spSprd = r(row.noncomm_positions_spread);
  const spNet  = spLong != null && spShort != null ? spLong - spShort : null;
  const spChgL = r(row.change_in_noncomm_long_all);
  const spChgS = r(row.change_in_noncomm_short_all);
  const spChgNet = spChgL != null && spChgS != null ? spChgL - spChgS : null;

  const cmLong = r(row.comm_positions_long_all);
  const cmShort= r(row.comm_positions_short_all);
  const cmNet  = cmLong != null && cmShort != null ? cmLong - cmShort : null;
  const cmChgL = r(row.change_in_comm_long_all);
  const cmChgS = r(row.change_in_comm_short_all);
  const cmChgNet = cmChgL != null && cmChgS != null ? cmChgL - cmChgS : null;

  const smLong = r(row.nonrept_positions_long_all);
  const smShort= r(row.nonrept_positions_short_all);
  const smNet  = smLong != null && smShort != null ? smLong - smShort : null;

  let signal = "NEUTRAL";
  if (spNet != null && oi) {
    const pct = (spNet / oi) * 100;
    if (pct > 5)  signal = "SPEC_LONG";
    if (pct < -5) signal = "SPEC_SHORT";
  }

  return {
    open_interest: oi,
    large_speculators: {
      long:          spLong,
      short:         spShort,
      spread:        spSprd,
      net:           spNet,
      net_change_wk: spChgNet,
      long_pct_oi:   rPct(spLong, oi),
      short_pct_oi:  rPct(spShort, oi),
    },
    commercial_hedgers: {
      long:          cmLong,
      short:         cmShort,
      net:           cmNet,
      net_change_wk: cmChgNet,
      long_pct_oi:   rPct(cmLong, oi),
      short_pct_oi:  rPct(cmShort, oi),
    },
    small_traders: {
      long:          smLong,
      short:         smShort,
      net:           smNet,
      long_pct_oi:   rPct(smLong, oi),
      short_pct_oi:  rPct(smShort, oi),
    },
    signal,
  };
}

export default {
  name: "cot-positioning",

  price: "$0.021",

  description:
    "CFTC Commitment of Traders weekly positioning: large speculator (hedge fund) vs commercial hedger net long/short, week-over-week change, % of OI, 4-week trend, and a SPEC_LONG/SPEC_SHORT/NEUTRAL signal. Free CFTC source, updated Fridays.",

  inputSchema: {
    type: "object",
    properties: {
      commodity: {
        type: "string",
        description:
          "Commodity or market name to look up (e.g. 'crude oil', 'gold', 'wheat', 'S&P 500', 'euro', 'natural gas', 'soybeans', 'copper')",
      },
    },
    required: ["commodity"],
  },

  outputSchema: {
    type: "object",
    properties: {
      query:       { type: "string" },
      report_date: { type: "string" },
      market:      { type: "string" },
      open_interest: { type: "integer" },
      large_speculators: { type: "object" },
      commercial_hedgers: { type: "object" },
      small_traders: { type: "object" },
      signal: { type: "string", enum: ["SPEC_LONG", "SPEC_SHORT", "NEUTRAL"] },
      trend_4w: { type: "array" },
    },
  },

  async handler({ commodity }) {
    if (!commodity || typeof commodity !== "string") {
      throw new Error("commodity is required");
    }
    const q = commodity.trim();
    if (q.length < 2 || q.length > 80) {
      throw new Error("commodity must be 2–80 characters");
    }

    // Search for matching markets — use Socrata full-text search via $q
    // and filter to the most recent report date
    const [searchRows, latestDate] = await Promise.all([
      cftcFetch({
        $q:     q,
        $order: "report_date_as_yyyy_mm_dd DESC,open_interest_all DESC",
        $limit: "20",
      }),
      // Get the single most recent report date to anchor all queries
      cftcFetch({ $order: "report_date_as_yyyy_mm_dd DESC", $limit: "1" }).then(
        rows => (rows[0] ? rows[0].report_date_as_yyyy_mm_dd.slice(0, 10) : null)
      ),
    ]);

    if (!searchRows.length) {
      throw new Error(`No COT data found for "${q}". Try broader terms like "crude oil", "gold", "S&P 500", "euro".`);
    }

    // Keep only rows from the most recent report date for the match selection
    const latestRows = latestDate
      ? searchRows.filter(r => r.report_date_as_yyyy_mm_dd.slice(0, 10) === latestDate)
      : searchRows;
    const candidates = latestRows.length ? latestRows : searchRows;
    const best = pickBestMatch(candidates, q);
    if (!best) throw new Error(`No matching market for "${q}"`);

    const marketCode = best.cftc_contract_market_code;
    const reportDate = best.report_date_as_yyyy_mm_dd.slice(0, 10);

    // Fetch 4-week history for trend
    const historyRows = await cftcFetch({
      $where: `cftc_contract_market_code='${marketCode}'`,
      $order: "report_date_as_yyyy_mm_dd DESC",
      $limit: "4",
    });

    const trend4w = historyRows.map(row => {
      const spLong  = r(row.noncomm_positions_long_all);
      const spShort = r(row.noncomm_positions_short_all);
      return {
        date:    row.report_date_as_yyyy_mm_dd.slice(0, 10),
        spec_net: spLong != null && spShort != null ? spLong - spShort : null,
        oi:      r(row.open_interest_all),
      };
    });

    const pos = extractPositioning(best);

    return {
      query:       q,
      report_date: reportDate,
      market:      best.market_and_exchange_names,
      ...pos,
      trend_4w: trend4w,
    };
  },
};
