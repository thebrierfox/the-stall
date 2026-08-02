// payment.js — THE ONLY FILE THAT TOUCHES THE x402 PROTOCOL WIRING.
// x402 is moving fast (it just went to the Linux Foundation). Everything that
// can churn is quarantined here so a protocol bump is a one-file edit.
//
// CURRENT: foundation-canonical @x402/express v2 + x402ResourceServer + ExactEvmScheme.
// Migrated from legacy x402-express (v1) on 2026-06-07 per x402scan v2 requirement.

import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { getAuthHeaders } from "@coinbase/cdp-sdk/auth";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

// Directive 103 / STALL_REVENUE_RECOVERY_20260802 P3: the six revenue-front
// routes get a full Bazaar output.example (built from their outputSchema).
// Scoped narrowly — most of the catalog's ~300 outputSchemas contain
// nullable-union or bare-object fields the SDK's own bazaar validator rejects
// as an example, which would spam startup logs / drop the extension for
// routes outside this directive's authorization if applied catalog-wide.
const REVENUE_FRONT_ROUTES = new Set([
  "us-stock-price",
  "earnings-calendar",
  "equity-brief",
  "youtube-transcript",
  "audio-transcribe",
  "vision-analyze",
]);

// Convert legacy network names to CAIP-2 identifiers required by x402 v2.
function toCAIP2(network) {
  if (network === "base") return "eip155:8453";
  if (network === "base-sepolia") return "eip155:84532";
  return network;
}

/**
 * Build the x402 payment middleware from a list of capability modules.
 *
 * @param {object} opts
 * @param {string} opts.payTo        Receiving wallet address (0x... on Base). MUST be verified-owned.
 * @param {string} opts.network      "base-sepolia" (test, default) or "base" (mainnet, live USDC).
 * @param {string} opts.facilitator  Facilitator URL. Testnet: https://x402.org/facilitator.
 *                                    Mainnet auto-catalog into the Bazaar requires the CDP facilitator.
 * @param {Array}  opts.capabilities Loaded capability modules (see capabilities/_TEMPLATE.js).
 * @returns {Function} express middleware
 */
// Build minimal example values for required inputSchema fields.
// The CDP Bazaar validates info.queryParams against the schema's required array —
// an empty {} fails required-field checks, silently excluding caps from indexing.
// Handles pattern, minimum, minLength, minItems, and nested object required fields.
function exampleForProp(prop) {
  // Nullable union types (e.g. `type: ["integer", "null"]`) — recurse on the
  // first non-null branch so the example still matches the declared schema.
  if (Array.isArray(prop.type)) {
    const nonNull = prop.type.find((t) => t !== "null");
    if (nonNull) return exampleForProp({ ...prop, type: nonNull });
    return null;
  }
  if (prop.enum?.length > 0) return prop.enum[0];
  if (prop.type === "number" || prop.type === "integer")
    return typeof prop.minimum === "number" ? prop.minimum : 1;
  if (prop.type === "boolean") return false;
  if (prop.type === "array") {
    const count = Math.max(prop.minItems ?? 0, 1);
    const itemEx = prop.items ? exampleForProp(prop.items) : "example";
    return Array.from({ length: count }, () => itemEx);
  }
  if (prop.type === "object") {
    if (!prop.properties) return {};
    const obj = {};
    const req = new Set(prop.required || Object.keys(prop.properties));
    for (const [k, v] of Object.entries(prop.properties)) {
      if (req.has(k)) obj[k] = exampleForProp(v);
    }
    return obj;
  }
  // EVM address patterns (0x + 40 hex chars) — match any variant of the character class
  if (prop.pattern && prop.pattern.includes("0x") && prop.pattern.includes("{40}"))
    return "0x0000000000000000000000000000000000000000";
  if (prop.minLength && prop.minLength > 7) return "A".repeat(prop.minLength);
  return "example";
}

function buildExampleInput(inputSchema) {
  if (!inputSchema?.properties) return undefined;
  const required = new Set(inputSchema.required || []);
  if (required.size === 0) return undefined;
  const example = {};
  for (const [name, prop] of Object.entries(inputSchema.properties)) {
    if (required.has(name)) example[name] = exampleForProp(prop);
  }
  return Object.keys(example).length > 0 ? example : undefined;
}

// Build a representative output example from a capability's outputSchema so
// Bazaar listings show real response shape, not just the input contract.
function buildExampleOutput(outputSchema) {
  if (!outputSchema?.properties) return undefined;
  const example = {};
  for (const [name, prop] of Object.entries(outputSchema.properties)) {
    example[name] = exampleForProp(prop);
  }
  return Object.keys(example).length > 0 ? example : undefined;
}

export function buildPaymentMiddleware({ payTo, network, facilitator, capabilities }) {
  if (!payTo || !/^0x[a-fA-F0-9]{40}$/.test(payTo)) {
    throw new Error(
      "payment.js: WALLET_ADDRESS (payTo) is missing or not a valid 0x EVM address. " +
      "No payment can settle without a verified-owned wallet. Refusing to boot blind."
    );
  }

  const caip2Network = toCAIP2(network);

  // x402 v2 route config — each cap becomes a paid GET route at /cap/<name>.
  // `accepts.price` uses the human-readable dollar string (e.g. "$0.007"); the
  // scheme server resolves it to token atomic units via getDefaultAsset.
  // Description is capped at 499 chars: CDP facilitator enforces a 500-char max.
  const routeConfig = {};
  for (const cap of capabilities) {
    const capPaymentConfig = {
      accepts: {
        scheme: "exact",
        price: cap.price,
        network: caip2Network,
        payTo,
      },
      description: cap.description.slice(0, 499),
      mimeType: "application/json",
      ...(cap.tags?.length ? { tags: cap.tags } : {}),
      extensions: declareDiscoveryExtension({
        method: "GET",
        inputSchema: cap.inputSchema || { type: "object", properties: {} },
        input: buildExampleInput(cap.inputSchema),
        ...(cap.outputSchema && REVENUE_FRONT_ROUTES.has(cap.name)
          ? { output: { schema: cap.outputSchema, example: buildExampleOutput(cap.outputSchema) } }
          : {}),
      }),
    };
    routeConfig[`GET /cap/${cap.name}`] = capPaymentConfig;
    routeConfig[`POST /cap/${cap.name}`] = capPaymentConfig;
    routeConfig[`HEAD /cap/${cap.name}`] = capPaymentConfig;
  }

  // Build the facilitator config. When CDP credentials are present and the
  // facilitator URL is the CDP endpoint, attach createAuthHeaders so the
  // middleware generates fresh JWTs on each verify/settle call.
  const cdpKeyId = process.env.CDP_API_KEY_ID;
  const cdpKeySecret = process.env.CDP_API_KEY_SECRET;
  const isCdpFacilitator = facilitator?.includes("cdp.coinbase.com");

  let facilitatorConfig = { url: facilitator };

  if (isCdpFacilitator && cdpKeyId && cdpKeySecret) {
    const host = "api.cdp.coinbase.com";
    const basePath = "/platform/v2/x402";

    facilitatorConfig.createAuthHeaders = async () => {
      const [verifyH, settleH, supportedH, listH] = await Promise.all([
        getAuthHeaders({ apiKeyId: cdpKeyId, apiKeySecret: cdpKeySecret, requestMethod: "POST", requestHost: host, requestPath: `${basePath}/verify` }),
        getAuthHeaders({ apiKeyId: cdpKeyId, apiKeySecret: cdpKeySecret, requestMethod: "POST", requestHost: host, requestPath: `${basePath}/settle` }),
        getAuthHeaders({ apiKeyId: cdpKeyId, apiKeySecret: cdpKeySecret, requestMethod: "GET",  requestHost: host, requestPath: `${basePath}/supported` }),
        getAuthHeaders({ apiKeyId: cdpKeyId, apiKeySecret: cdpKeySecret, requestMethod: "GET",  requestHost: host, requestPath: `${basePath}/discovery/resources` }),
      ]);
      return { verify: verifyH, settle: settleH, supported: supportedH, list: listH };
    };
  }

  // x402 v2: ResourceServer registers the ExactEvmScheme for the target network,
  // then paymentMiddleware receives (routes, server) — no payTo/network at top level.
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient(facilitatorConfig))
    .register(caip2Network, new ExactEvmScheme());

  return paymentMiddleware(routeConfig, resourceServer);
}
