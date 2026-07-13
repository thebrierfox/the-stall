// market-intelligence.js
//
// Returns settlement-verified x402 endpoint intelligence: which endpoints have
// organic payer breadth, live prices, and proven usage. Distinct from the Bazaar
// catalog (10k+ listed; most untested) — this data comes from observed on-chain
// settlements only. An agent uses this before wiring a workflow to an external
// endpoint to avoid building on dead or private infrastructure.
//
// Data source: local archive.db accumulated by the signal-intel scout.
// Reads only — never writes.

import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, "..");
const DB_PATH    = process.env.ARCHIVE_DB || join(REPO_ROOT, "archive.db");

const VALID_SORT = new Set(["payers", "settlements", "price_asc", "price_desc", "last_seen"]);

export default {
  name: "market-intelligence",
  price: "$0.390",

  description:
    "Discovers active x402 APIs with verified organic USDC settlements — shows which endpoints have genuine payer breadth across the ecosystem. Sourced from on-chain settlements, not catalog listings. Filter by category, price range, and minimum unique payers. Useful before wiring a workflow to an external x402 endpoint: confirms it is active with multiple independent payers, not private infrastructure or a dead listing.",

  inputSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description: "Filter by endpoint category (e.g., 'ai', 'data', 'finance', 'search'). Omit for all.",
      },
      min_price_usd: {
        type: "number",
        description: "Minimum endpoint price in USD (default 0.01). Use 0.50 to see PRIMARY_RANGE only.",
        default: 0.01,
      },
      max_price_usd: {
        type: "number",
        description: "Maximum endpoint price in USD. Omit for no ceiling.",
      },
      min_payers: {
        type: "integer",
        description: "Minimum unique payer count (default 3). Higher = more proven organic demand.",
        default: 3,
      },
      sort_by: {
        type: "string",
        enum: ["payers", "settlements", "price_asc", "price_desc", "last_seen"],
        description: "Sort order. Default: payers (highest organic breadth first).",
        default: "payers",
      },
      limit: {
        type: "integer",
        description: "Max results (default 20, max 50).",
        default: 20,
      },
    },
  },

  outputSchema: {
    type: "object",
    properties: {
      endpoints: {
        type: "array",
        items: {
          type: "object",
          properties: {
            resource:          { type: "string", description: "Endpoint URL." },
            name:              { type: "string" },
            description:       { type: "string" },
            category:          { type: "string" },
            price_usd:         { type: "number" },
            network:           { type: "string", description: "e.g. base, base-sepolia" },
            pay_to:            { type: "string", description: "Payment wallet address." },
            unique_payers:     { type: "integer", description: "Distinct payer wallets observed (organic breadth signal)." },
            total_settlements: { type: "integer", description: "Total on-chain settled calls." },
            calls_per_payer:   { type: "number", description: "Ratio indicating recurring vs one-time usage." },
            first_seen:        { type: "string", description: "ISO-8601 first settlement observed." },
            last_seen:         { type: "string", description: "ISO-8601 most recent settlement observed." },
            price_tier:        { type: "string", enum: ["COMMODITY", "MICRO", "MARGINAL", "PRIMARY", "HIGH_VALUE"] },
          },
        },
      },
      total_active_endpoints: {
        type: "integer",
        description: "Total endpoints in archive that match query criteria (before limit).",
      },
      archive_settlements:   { type: "integer", description: "Total settlements in archive at query time." },
      window_note:           { type: "string" },
      generated_at:          { type: "string" },
    },
  },

  async handler(query) {
    const {
      category,
      min_price_usd = 0.01,
      max_price_usd,
      min_payers    = 3,
      sort_by       = "payers",
      limit         = 20,
    } = query;

    const safeSort  = VALID_SORT.has(sort_by) ? sort_by : "payers";
    const safeLimit = Math.min(Math.max(parseInt(limit || "20", 10), 1), 50);

    const db = new Database(DB_PATH, { readonly: true });
    try {
      // Price is derived from settlement amounts (endpoints.price_usd is not
      // reliably populated by the bazaar stream). AVG(s.amount_usd) is the
      // observed market price — the amount agents actually paid per call.
      const params = [];
      let havingPriceClause = "avg_price_usd >= ?";
      params.push(min_price_usd);

      if (max_price_usd != null) {
        havingPriceClause += " AND avg_price_usd <= ?";
        params.push(max_price_usd);
      }

      let categoryClause = "";
      if (category) {
        categoryClause = "AND (LOWER(e.category) LIKE ? OR LOWER(e.description) LIKE ?)";
        const pat = `%${category.toLowerCase()}%`;
        params.push(pat, pat);
      }

      const orderMap = {
        payers:      "unique_payers DESC",
        settlements: "total_settlements DESC",
        price_asc:   "avg_price_usd ASC",
        price_desc:  "avg_price_usd DESC",
        last_seen:   "last_settlement DESC",
      };
      const orderBy = orderMap[safeSort];

      params.push(min_payers);

      const rows = db.prepare(`
        SELECT
          s.resource,
          e.name,
          e.description,
          e.category,
          e.network,
          e.pay_to,
          COUNT(DISTINCT s.payer_wallet)                                       AS unique_payers,
          COUNT(*)                                                              AS total_settlements,
          ROUND(CAST(COUNT(*) AS REAL) / NULLIF(COUNT(DISTINCT s.payer_wallet), 0), 2) AS calls_per_payer,
          ROUND(AVG(s.amount_usd), 4)                                          AS avg_price_usd,
          MIN(s.ts)                                                             AS first_settlement,
          MAX(s.ts)                                                             AS last_settlement
        FROM settlements s
        LEFT JOIN endpoints e ON e.resource = s.resource
        WHERE s.resource IS NOT NULL AND s.amount_usd > 0
        ${categoryClause}
        GROUP BY s.resource
        HAVING ${havingPriceClause} AND unique_payers >= ?
        ORDER BY ${orderBy}
        LIMIT ${safeLimit}
      `).all(...params);

      const archiveTotal = db.prepare("SELECT COUNT(*) AS n FROM settlements").get().n;
      const totalCount   = db.prepare(`
        SELECT COUNT(DISTINCT s.resource) AS cnt
        FROM settlements s
        LEFT JOIN endpoints e ON e.resource = s.resource
        WHERE s.resource IS NOT NULL AND s.amount_usd > 0
        ${categoryClause}
        GROUP BY s.resource
        HAVING AVG(s.amount_usd) >= ? AND COUNT(DISTINCT s.payer_wallet) >= ?
      `).all(...params.slice(-2 - (max_price_usd != null ? 1 : 0))).length;

      const endpoints = rows.map((r) => ({
        resource:          r.resource,
        name:              r.name || null,
        description:       r.description || null,
        category:          r.category || null,
        price_usd:         r.avg_price_usd,
        network:           r.network || "base",
        pay_to:            r.pay_to || null,
        unique_payers:     r.unique_payers,
        total_settlements: r.total_settlements,
        calls_per_payer:   r.calls_per_payer,
        first_seen:        r.first_settlement,
        last_seen:         r.last_settlement,
        price_tier:        priceTier(r.avg_price_usd),
      }));

      return {
        endpoints,
        total_active_endpoints: totalCount,
        archive_settlements:    archiveTotal,
        window_note: "Price = avg observed settlement amount (not catalog listing). Archive sources: Base mainnet EIP-3009 events, updates ~10 min.",
        generated_at: new Date().toISOString(),
      };
    } finally {
      db.close();
    }
  },
};

function priceTier(usd) {
  if (!usd || usd < 0.01) return "COMMODITY";
  if (usd < 0.10) return "MICRO";
  if (usd < 0.50) return "MARGINAL";
  if (usd < 5.00) return "PRIMARY";
  return "HIGH_VALUE";
}
