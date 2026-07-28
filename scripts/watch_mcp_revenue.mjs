#!/usr/bin/env node
import { readFileSync } from "fs";
import { resolve } from "path";

const file = resolve(process.env.MCP_PAYMENT_LOG || "logs/mcp_payments.jsonl");
const intervalMs = Math.max(500, Number(process.env.WATCH_INTERVAL_MS || 1000));
const selfWallets = new Set(String(process.env.MCP_SELF_WALLETS || "")
  .split(",").map(v => v.trim().toLowerCase()).filter(Boolean));

function rows() {
  try {
    const raw = readFileSync(file, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function snapshot() {
  const data = rows();
  const byEvent = {};
  const byTool = {};
  const organicByTool = {};
  const uniquePayers = new Set();
  let revenue = 0;
  let organicRevenue = 0;
  let organicSettlements = 0;
  let latest = null;
  for (const row of data) {
    byEvent[row.event] = (byEvent[row.event] || 0) + 1;
    if (row.event === "settled") {
      const amount = Number(row.price_usd || 0);
      revenue += amount;
      byTool[row.tool] = (byTool[row.tool] || 0) + 1;
      const payer = typeof row.payer === "string" ? row.payer.toLowerCase() : null;
      if (payer) uniquePayers.add(payer);
      if (payer && !selfWallets.has(payer)) {
        organicRevenue += amount;
        organicSettlements += 1;
        organicByTool[row.tool] = (organicByTool[row.tool] || 0) + 1;
      }
      latest = row;
    }
  }
  const challenges = byEvent.challenge || 0;
  const settlements = byEvent.settled || 0;
  return {
    ts: new Date().toISOString(),
    file,
    challenges,
    verified: byEvent.verified || 0,
    executed: byEvent.executed || 0,
    settlements,
    rejected: byEvent.rejected || 0,
    revenue_usd: Number(revenue.toFixed(6)),
    organic_settlements: organicSettlements,
    organic_revenue_usd: Number(organicRevenue.toFixed(6)),
    unique_payers: uniquePayers.size,
    self_wallet_filter_configured: selfWallets.size > 0,
    challenge_to_settlement_ratio: challenges ? Number((settlements / challenges).toFixed(6)) : null,
    verification_to_settlement_rate: (byEvent.verified || 0) ? Number((settlements / byEvent.verified).toFixed(6)) : null,
    top_settled_tools: Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, 10),
    top_organic_tools: Object.entries(organicByTool).sort((a, b) => b[1] - a[1]).slice(0, 10),
    latest_settlement: latest,
  };
}

process.stdout.write("\x1Bc");
console.log(JSON.stringify(snapshot(), null, 2));
setInterval(() => {
  process.stdout.write("\x1Bc");
  console.log(JSON.stringify(snapshot(), null, 2));
}, intervalMs);
