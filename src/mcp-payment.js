// mcp-payment.js — Native x402 metering for STALL MCP tools.
//
// This closes the free-execution lane at POST /mcp without moving the endpoint,
// changing DNS, or placing a proxy in front of infrastructure STALL does not own.
// Discovery and tools/list remain free. Only selected tools/call executions are paid.

import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { getAuthHeaders } from "@coinbase/cdp-sdk/auth";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { currentAttribution, observationFields } from "./attribution.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dir, "..", "logs");
const MCP_PAYMENT_LOG = join(LOG_DIR, "mcp_payments.jsonl");
const paymentCallStorage = new AsyncLocalStorage();
mkdirSync(LOG_DIR, { recursive: true });

const VALID_MODES = new Set(["off", "canary", "all"]);
const AUTHORIZATION_SENTINEL = "D92_LIFTED";
const DEFAULT_CANARY_TOOLS = new Set([
  "market-overview",
  "commodity-futures",
  "news-sentiment",
  "page-intel",
  "macro-indicators",
]);
const DEFAULT_FREE_TOOLS = new Set(["ping"]);

function csvSet(value, fallback = []) {
  if (!value) return new Set(fallback);
  return new Set(String(value).split(",").map(v => v.trim()).filter(Boolean));
}

function toCAIP2(network) {
  if (network === "base") return "eip155:8453";
  if (network === "base-sepolia") return "eip155:84532";
  return network;
}

function safePriceNumber(price) {
  const n = Number(String(price ?? "0").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function exampleForProp(prop = {}) {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];
  if (prop.type === "number" || prop.type === "integer") {
    return typeof prop.minimum === "number" ? prop.minimum : 1;
  }
  if (prop.type === "boolean") return false;
  if (prop.type === "array") {
    const count = Math.max(prop.minItems ?? 0, 1);
    return Array.from({ length: count }, () => exampleForProp(prop.items ?? { type: "string" }));
  }
  if (prop.type === "object" && prop.properties) {
    const out = {};
    const required = new Set(prop.required ?? Object.keys(prop.properties));
    for (const [name, child] of Object.entries(prop.properties)) {
      if (required.has(name)) out[name] = exampleForProp(child);
    }
    return out;
  }
  if (prop.pattern?.includes("0x") && prop.pattern?.includes("{40}")) {
    return "0x0000000000000000000000000000000000000000";
  }
  if (prop.format === "uri" || prop.format === "url") return "https://example.com";
  if (prop.format === "email") return "agent@example.com";
  if (prop.minLength && prop.minLength > 7) return "A".repeat(prop.minLength);
  return "example";
}

function buildExampleInput(inputSchema) {
  if (!inputSchema?.properties) return {};
  const required = new Set(inputSchema.required ?? []);
  const out = {};
  for (const [name, prop] of Object.entries(inputSchema.properties)) {
    if (required.has(name)) out[name] = exampleForProp(prop);
  }
  return out;
}

function createFacilitatorConfig(facilitator) {
  const cdpKeyId = process.env.CDP_API_KEY_ID;
  const cdpKeySecret = process.env.CDP_API_KEY_SECRET;
  const isCdp = facilitator?.includes("cdp.coinbase.com");
  const config = { url: facilitator };

  if (isCdp && cdpKeyId && cdpKeySecret) {
    const host = "api.cdp.coinbase.com";
    const basePath = "/platform/v2/x402";
    config.createAuthHeaders = async () => {
      const [verify, settle, supported, list] = await Promise.all([
        getAuthHeaders({ apiKeyId: cdpKeyId, apiKeySecret: cdpKeySecret, requestMethod: "POST", requestHost: host, requestPath: `${basePath}/verify` }),
        getAuthHeaders({ apiKeyId: cdpKeyId, apiKeySecret: cdpKeySecret, requestMethod: "POST", requestHost: host, requestPath: `${basePath}/settle` }),
        getAuthHeaders({ apiKeyId: cdpKeyId, apiKeySecret: cdpKeySecret, requestMethod: "GET", requestHost: host, requestPath: `${basePath}/supported` }),
        getAuthHeaders({ apiKeyId: cdpKeyId, apiKeySecret: cdpKeySecret, requestMethod: "GET", requestHost: host, requestPath: `${basePath}/discovery/resources` }),
      ]);
      return { verify, settle, supported, list };
    };
  }

  return config;
}

function extractPayer(paymentPayload) {
  return paymentPayload?.payload?.authorization?.from
    ?? paymentPayload?.payload?.from
    ?? paymentPayload?.authorization?.from
    ?? paymentPayload?.payer
    ?? paymentPayload?.from
    ?? null;
}

function extractTransaction(settlement) {
  return settlement?.transaction
    ?? settlement?.transactionHash
    ?? settlement?.txHash
    ?? settlement?.tx_hash
    ?? settlement?.receipt?.transactionHash
    ?? null;
}

function writeEvent(event, details = {}) {
  try {
    const context = paymentCallStorage.getStore() || {};
    const record = {
      ts: new Date().toISOString(),
      event,
      ...context,
      ...details,
    };
    if (context.classification === "NON_DEMAND_TEST") {
      record.classification = "NON_DEMAND_TEST";
      record.demand_qualified = false;
    }
    appendFileSync(MCP_PAYMENT_LOG, JSON.stringify(record) + "\n");
  } catch {
    // Metering telemetry must never crash a tool call.
  }
}

function mcpCorrelationKey(tool, attribution) {
  return "mcpcorr_" + createHash("sha256")
    .update([
      tool,
      attribution?.candidate_id || "UNKNOWN",
      attribution?.channel_id || "UNKNOWN",
      attribution?.placement_id || "UNKNOWN",
      attribution?.operator_signal || "UNKNOWN",
    ].join("|"))
    .digest("hex")
    .slice(0, 32);
}

function recentChallenge(tool, correlationKey) {
  const cutoff = Date.now() - (15 * 60 * 1000);
  const rows = readRows();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.event !== "challenge" || row.tool !== tool) continue;
    if (row.correlation_key !== correlationKey || !row.challenge_id) continue;
    const timestamp = Date.parse(row.ts || "");
    if (Number.isFinite(timestamp) && timestamp >= cutoff) {
      return row.challenge_id;
    }
  }
  return null;
}

function buildPaymentCallContext(tool, paymentPayload) {
  const attribution = currentAttribution();
  const correlationKey = mcpCorrelationKey(tool, attribution);
  const priorChallenge = paymentPayload ? recentChallenge(tool, correlationKey) : null;
  const challengeId = priorChallenge || `mcpch_${randomUUID()}`;
  return {
    ...observationFields(attribution),
    request_id: attribution?.request_id || `mcpreq_${randomUUID()}`,
    challenge_id: challengeId,
    correlation_key: correlationKey,
    challenge_correlation_method: priorChallenge
      ? "recent_challenge_same_attribution_and_operator_signal"
      : "new_request_context",
    route: `mcp://tool/${tool}`,
    classification: attribution?.is_test_probe
      ? "NON_DEMAND_TEST"
      : paymentPayload
        ? "PAYMENT_PRESENT_UNVERIFIED"
        : "UNSETTLED_CHALLENGE",
    demand_qualified: false,
  };
}

function readRows() {
  try {
    const raw = readFileSync(MCP_PAYMENT_LOG, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function getMcpPaymentMode() {
  const requested = String(process.env.MCP_PAYMENT_MODE || "off").toLowerCase();
  return VALID_MODES.has(requested) ? requested : "off";
}

export function readMcpPaymentStats() {
  const rows = readRows();
  const counts = {};
  const settledByTool = {};
  const uniquePayers = new Set();
  const selfWallets = csvSet(process.env.MCP_SELF_WALLETS).size
    ? new Set([...csvSet(process.env.MCP_SELF_WALLETS)].map(v => v.toLowerCase()))
    : new Set();
  let revenueUsd = 0;
  let organicRevenueUsd = 0;
  let organicSettlements = 0;
  for (const row of rows) {
    counts[row.event] = (counts[row.event] || 0) + 1;
    if (row.event === "settled") {
      const amount = Number(row.price_usd || 0);
      revenueUsd += amount;
      settledByTool[row.tool] = (settledByTool[row.tool] || 0) + 1;
      const payer = typeof row.payer === "string" ? row.payer.toLowerCase() : null;
      if (payer) uniquePayers.add(payer);
      if (payer && !selfWallets.has(payer)) {
        organicSettlements += 1;
        organicRevenueUsd += amount;
      }
    }
  }
  const challenges = counts.challenge || 0;
  const settlements = counts.settled || 0;
  return {
    mode: getMcpPaymentMode(),
    challenges,
    verified: counts.verified || 0,
    executed: counts.executed || 0,
    settlements,
    rejected: counts.rejected || 0,
    revenue_usd: Number(revenueUsd.toFixed(6)),
    organic_settlements: organicSettlements,
    organic_revenue_usd: Number(organicRevenueUsd.toFixed(6)),
    unique_payers: uniquePayers.size,
    self_wallet_filter_configured: selfWallets.size > 0,
    challenge_to_settlement_ratio: challenges > 0
      ? Number((settlements / challenges).toFixed(6))
      : null,
    verification_to_settlement_rate: (counts.verified || 0) > 0
      ? Number((settlements / counts.verified).toFixed(6))
      : null,
    top_settled_tools: Object.entries(settledByTool)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10),
    log_path: MCP_PAYMENT_LOG,
  };
}

// Shared discovery/execution classification; reads configuration, never initializes
// a facilitator or changes payment authorization and validation gates.
export function createMcpPaidToolPredicate(mode = getMcpPaymentMode()) {
  const freeTools = csvSet(process.env.MCP_FREE_TOOLS, DEFAULT_FREE_TOOLS);
  const canaryTools = csvSet(process.env.MCP_PAID_TOOLS, DEFAULT_CANARY_TOOLS);
  return (capName) => {
    if (mode === "off" || freeTools.has(capName)) return false;
    if (mode === "all") return true;
    return canaryTools.has(capName);
  };
}

export async function createMcpPaymentController(capabilities) {
  const mode = getMcpPaymentMode();
  if (mode !== "off" && process.env.MCP_PAYMENT_AUTHORIZED !== AUTHORIZATION_SENTINEL) {
    throw new Error(
      `MCP payment mode '${mode}' requested without MCP_PAYMENT_AUTHORIZED=${AUTHORIZATION_SENTINEL}. ` +
      "Directive-92 freeze guard refused activation."
    );
  }

  const payTo = process.env.WALLET_ADDRESS;
  const network = toCAIP2(process.env.X402_NETWORK || "base-sepolia");
  const facilitator = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
  const baseUrl = process.env.BASE_URL || "https://the-stall.intuitek.ai";
  const isPaid = createMcpPaidToolPredicate(mode);

  if (mode !== "off" && (!payTo || !/^0x[a-fA-F0-9]{40}$/.test(payTo))) {
    throw new Error("MCP x402 metering requires a valid WALLET_ADDRESS.");
  }

  if (mode === "off") {
    return {
      mode,
      network,
      isPaid: () => false,
      wrap: (_cap, handler) => handler,
    };
  }

  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient(createFacilitatorConfig(facilitator))
  );
  resourceServer.register(network, new ExactEvmScheme());
  if (typeof resourceServer.initialize === "function") await resourceServer.initialize();

  const requirementsByPrice = new Map();
  async function requirementsFor(price) {
    if (!requirementsByPrice.has(price)) {
      requirementsByPrice.set(price, await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        network,
        payTo,
        price,
      }));
    }
    return requirementsByPrice.get(price);
  }

  const paidCapabilities = capabilities.filter(cap => isPaid(cap.name));
  if (paidCapabilities.length === 0) {
    throw new Error(`MCP payment mode '${mode}' resolved to zero paid tools; refusing a silent free-execution configuration.`);
  }

  const wrappers = new Map();
  for (const cap of paidCapabilities) {
    const accepts = await requirementsFor(cap.price);
    const priceUsd = safePriceNumber(cap.price);
    const paid = createPaymentWrapper(resourceServer, {
      accepts,
      resource: {
        url: `mcp://tool/${cap.name}`,
        description: cap.description,
        serviceName: "The Stall",
        tags: ["x402", "mcp", "data", cap.name],
        iconUrl: `${baseUrl}/logo.png`,
      },
      extensions: declareDiscoveryExtension({
        toolName: cap.name,
        description: cap.description,
        transport: "streamable-http",
        inputSchema: cap.inputSchema || { type: "object", properties: {} },
        example: buildExampleInput(cap.inputSchema),
      }),
      hooks: {
        onBeforeExecution: async ({ paymentPayload }) => {
          writeEvent("verified", {
            tool: cap.name,
            price: cap.price,
            price_usd: priceUsd,
            network,
            payer: extractPayer(paymentPayload),
            mode,
            classification: "PAYMENT_VERIFIED",
          });
          return true;
        },
        onAfterExecution: async ({ result, paymentPayload }) => {
          writeEvent("executed", {
            tool: cap.name,
            price: cap.price,
            price_usd: priceUsd,
            network,
            payer: extractPayer(paymentPayload),
            mode,
            is_error: Boolean(result?.isError),
            classification: "EXECUTED_AFTER_VERIFICATION",
          });
        },
        onAfterSettlement: async ({ settlement, paymentPayload }) => {
          // A facilitator response is not itself proof that settlement succeeded.
          if (settlement?.success !== true) return;
          writeEvent("settled", {
            tool: cap.name,
            price: cap.price,
            price_usd: priceUsd,
            network,
            payer: extractPayer(paymentPayload),
            transaction: extractTransaction(settlement),
            settlement_id_if_any: extractTransaction(settlement),
            mode,
            classification: "SETTLED_VERIFIED",
          });
        },
      },
    });
    wrappers.set(cap.name, { paid, priceUsd });
  }

  return {
    mode,
    network,
    isPaid,
    wrap(cap, handler) {
      if (!isPaid(cap.name)) return handler;
      const { paid, priceUsd } = wrappers.get(cap.name);
      const wrapped = paid(handler);
      return async (params, extra = {}) => {
        const paymentPayload = extra?._meta?.["x402/payment"] ?? null;
        const callContext = buildPaymentCallContext(cap.name, paymentPayload);
        return paymentCallStorage.run(callContext, async () => {
          if (!paymentPayload) {
            writeEvent("challenge", {
              tool: cap.name,
              price: cap.price,
              price_usd: priceUsd,
              network,
              mode,
            });
          }
          try {
            let result = await wrapped(params, extra);
            // Some SDK versions return the handler result with success:false in
            // payment metadata. Never deliver that paid content or count it as income.
            if (paymentPayload && !result?.isError
                && result?._meta?.["x402/payment-response"]?.success !== true) {
              result = {
                isError: true,
                content: [{ type: "text", text: "Payment settlement was not confirmed; paid result withheld." }],
                _meta: { "x402/payment-response": {
                  success: false, network, errorReason: "settlement_not_confirmed",
                } },
              };
            }
            if (paymentPayload && result?.isError) {
              writeEvent("rejected", {
                tool: cap.name,
                price: cap.price,
                price_usd: priceUsd,
                network,
                payer: extractPayer(paymentPayload),
                mode,
                classification: "PAYMENT_REJECTED",
              });
            }
            return result;
          } catch (error) {
            writeEvent("rejected", {
              tool: cap.name,
              price: cap.price,
              price_usd: priceUsd,
              network,
              payer: extractPayer(paymentPayload),
              mode,
              classification: "PAYMENT_REJECTED",
              error: String(error?.message || error).slice(0, 240),
            });
            throw error;
          }
        });
      };
    },
  };
}
