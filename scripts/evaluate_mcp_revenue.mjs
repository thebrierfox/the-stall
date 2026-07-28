#!/usr/bin/env node
import { readFileSync } from "fs";
import { resolve } from "path";

const file = resolve(process.env.MCP_PAYMENT_LOG || "logs/mcp_payments.jsonl");
const selfWallets = new Set(String(process.env.MCP_SELF_WALLETS || "")
  .split(",").map(v => v.trim().toLowerCase()).filter(Boolean));
let rows = [];
try {
  rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
} catch {}
const challenges = rows.filter(r => r.event === "challenge").length;
const settled = rows.filter(r => r.event === "settled");
const organic = settled.filter(r => {
  const payer = typeof r.payer === "string" ? r.payer.toLowerCase() : null;
  return payer && !selfWallets.has(payer);
});
const organicRevenue = organic.reduce((n, r) => n + Number(r.price_usd || 0), 0);
let decision = "KEEP_RUNNING";
let reason = "Insufficient organic conversion evidence yet.";
if (organic.length > 0) {
  decision = "ORGANIC_REVENUE_CONFIRMED";
  reason = "At least one non-self payer settled an MCP tool call.";
} else if (challenges >= 100) {
  decision = "REVIEW_PAYMENT_FRICTION";
  reason = "At least 100 challenges produced no identifiable non-self settlement.";
}
console.log(JSON.stringify({
  decision,
  reason,
  challenges,
  total_settlements: settled.length,
  organic_settlements: organic.length,
  organic_revenue_usd: Number(organicRevenue.toFixed(6)),
  self_wallet_filter_configured: selfWallets.size > 0,
}, null, 2));
