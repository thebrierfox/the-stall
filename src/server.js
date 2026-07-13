// server.js — The Stall. A domain-agnostic x402 capability chassis.
//
// What it does, end to end:
//   1. Loads every capability module from /capabilities.
//   2. Puts each behind an x402 paywall at GET /cap/<name>.
//   3. Exposes FREE /health and /catalog (the catalog is self-describing, so
//      both humans and agents can introspect what this stall sells).
//   4. On first settled payment via a cataloging facilitator, the route
//      auto-surfaces in the x402 Bazaar discovery layer.
//
// The call log is the buyer test. Every paid hit is a real agent deciding,
// with its own money, that this capability was worth it. That signal is the
// whole point — it costs ~nothing to list and lets the market answer.

// Prevent crash-restart loops from unhandled body-parser exceptions or async rejections.
// Body-parser throws on malformed JSON; without this, Node exits and EADDRINUSE loops start.
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err?.message, err?.stack?.split('\n')[1] || '');
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason?.message || reason);
});

import "dotenv/config";
import express from "express";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { exec } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadCapabilities } from "./registry.js";

const { version: PKG_VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
import { buildPaymentMiddleware } from "./payment.js";
import { makeMcpHandler, makeSSEHandlers } from "./mcp.js";
import { mountRetainer } from "./retainer/index.js";
import { makeLiveProvider } from "./retainer/risk.js";
import { mountStripeRail } from "./stripe-rail.js";
import { mountThe402Rail } from "./the402-rail.js";
import { loadSigner } from "./retainer/token.js";
import { buildSolanaRailMiddleware, SOLANA_WALLET } from "./solana-rail.js";
import { buildPolygonRailMiddleware, POLYGON_WALLET, POLYGON_USDC } from "./polygon-rail.js";
import { buildPayAICanaryMiddleware } from "./payai-canary.js";

function parseJsonlLog(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function readPaymentStats() {
  try {
    const raw = readFileSync(PAYMENT_LOG, "utf8").trim();
    if (!raw) return { total: 0, uniqueCaps: 0, since: null };
    const lines = raw.split("\n").filter(Boolean);
    const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const caps = new Set(entries.map((e) => e.cap));
    const since = entries[0]?.ts ?? null;
    return { total: entries.length, uniqueCaps: caps.size, since };
  } catch {
    return { total: 0, uniqueCaps: 0, since: null };
  }
}

const __dir = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dir, "..", "logs");
mkdirSync(LOG_DIR, { recursive: true });
const PAYMENT_LOG = join(LOG_DIR, "payments.jsonl");
const REQUEST_LOG = join(LOG_DIR, "requests.jsonl");
const SETTLEMENT_LOG = join(LOG_DIR, "settlement.jsonl");
const SETTLEMENT_CORRECTIONS_LOG = join(LOG_DIR, "settlement_corrections.jsonl");
const CALL_AUDIT_LOG = join(LOG_DIR, "call_audit.jsonl");
const BOUNCE_LOG = join(LOG_DIR, "402_bounces.jsonl");
// W3: Bounce alert — non-seeder bounces fire immediate Telegram (hot-lead capture)
const _SEEDER_BOUNCE_ADDR = (process.env.SEEDER_WALLET_ADDRESS || "0xf615bda54d576e757b51a6128ac8a7c67a1c3d6c").toLowerCase();
const _NOTIFY_SH_PATH = join(process.env.HOME || "/home/aegis", "intuitek", "notify.sh");

// Async post-settlement RPC enrichment: when payer=null but tx_hash is present
// (seeder-relay path), look up Transfer.from on-chain and write a correction entry.
// Section F fix — resolves EIP-3009 authorizer attribution bug (audit 2026-07-03).
const _RPC_BASE = "https://gateway.tenderly.co/public/base";
const _USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const _TRANSFER_T0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
function enrichPayerAsync(txHash, ts) {
  // Fire after 20s to ensure tx is indexed by Tenderly
  setTimeout(async () => {
    try {
      const res = await fetch(_RPC_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
        signal: AbortSignal.timeout(8000)
      });
      const data = await res.json();
      const logs = data?.result?.logs ?? [];
      const transfer = logs.find(l =>
        l.address?.toLowerCase() === _USDC_BASE &&
        l.topics?.[0] === _TRANSFER_T0
      );
      if (!transfer?.topics?.[1]) return;
      const authorizer = "0x" + transfer.topics[1].slice(26);
      const correction = JSON.stringify({ ts, tx_hash: txHash, authorizer, _source: "Transfer.from_rpc" });
      appendFileSync(SETTLEMENT_CORRECTIONS_LOG, correction + "\n");
    } catch { /* never crash on enrichment */ }
  }, 20000);
}

function logPaidCall(capName, price, query, statusCode, ip) {
  try {
    const entry = JSON.stringify({ ts: new Date().toISOString(), cap: capName, price, query, status: statusCode, ip: ip || "unknown" });
    appendFileSync(PAYMENT_LOG, entry + "\n");
  } catch (_) { /* never crash on log failure */ }
}

// Settlement-grade log — payer address + tx hash per paid call.
// xPayment: raw X-PAYMENT request header (base64 JSON, EIP-3009 authorization)
// res:      Express response object — X-PAYMENT-RESPONSE is captured two ways:
//           1. res.setHeader intercept: catches the value the moment the payment
//              middleware calls res.setHeader, regardless of buffering timing.
//           2. res.on('finish') fallback: reads res.getHeader() after response ends.
//           Intercept is primary; getHeader fallback covers non-setHeader write paths.
// ip:       caller IP for debug capture when payer extraction fails
function logSettlement(capName, price, query, statusCode, res, ip, xPayment) {
  try {
    // Extract payer from X-PAYMENT challenge header (available synchronously — it's a
    // request header set before the handler runs). Expands the extraction chain to cover
    // additional x402 v2 payload shapes seen from CDP infrastructure.
    let payer = null;
    if (xPayment) {
      try {
        const decoded = JSON.parse(Buffer.from(String(xPayment), "base64").toString("utf8"));
        payer = decoded?.payload?.authorization?.from
          ?? decoded?.payload?.from
          ?? decoded?.from
          ?? decoded?.payment?.authorization?.from
          ?? decoded?.authorization?.from
          ?? null;
      } catch { /* keep null */ }
    }

    // Capture raw X-Payment for null-payer entries so we can diagnose CDP schema differences.
    const rawXPaymentCapture = (!payer && xPayment) ? String(xPayment) : null;

    // Intercept res.setHeader to capture the payment receipt the moment middleware writes it.
    // @x402/express v2 sets the receipt AFTER next() returns via the buffered-response pattern.
    // CDP facilitator uses "X-PAYMENT-RESPONSE"; the generic x402.org facilitator uses
    // "PAYMENT-RESPONSE" (no X-). We capture both to be facilitator-agnostic.
    let capturedXPayResp = null;
    const origSetHeader = res.setHeader.bind(res);
    res.setHeader = function(name, value) {
      if (typeof name === "string") {
        const lower = name.toLowerCase();
        if (lower === "x-payment-response" || lower === "payment-response") {
          capturedXPayResp = value;
        }
      }
      return origSetHeader(name, value);
    };

    const ts = new Date().toISOString();
    res.on("finish", () => {
      try {
        res.setHeader = origSetHeader;
        let txHash = null;
        let receiptRaw = null;
        const xPayResp = capturedXPayResp
          || res.getHeader("x-payment-response")
          || res.getHeader("payment-response")
          || null;
        if (xPayResp) {
          try {
            receiptRaw = JSON.parse(Buffer.from(String(xPayResp), "base64").toString("utf8"));
            txHash = receiptRaw?.transaction
              ?? receiptRaw?.transactionHash
              ?? receiptRaw?.txHash
              ?? receiptRaw?.tx_hash
              ?? receiptRaw?.receipt?.transactionHash
              ?? null;
            if (!payer) {
              payer = receiptRaw?.payer ?? receiptRaw?.from ?? null;
            }
          } catch { /* receipt format evolving */ }
        }
        const entry = JSON.stringify({
          ts, cap: capName, price, status: statusCode,
          ip: ip || "unknown", payer, tx_hash: txHash, receipt: receiptRaw,
          ...(rawXPaymentCapture ? { _raw_xpayment_debug: rawXPaymentCapture } : {}),
        });
        appendFileSync(SETTLEMENT_LOG, entry + "\n");
        // If payer still null but tx_hash known: schedule async RPC enrichment.
        if (!payer && txHash) enrichPayerAsync(txHash, ts);
      } catch (_) { /* never crash on log failure */ }
    });
  } catch (_) { /* never crash on log failure */ }
}

function logRequest(method, path, statusCode, ip, ua, ms) {
  try {
    const entry = JSON.stringify({ ts: new Date().toISOString(), method, path, status: statusCode, ip: ip || "unknown", ua: (ua || "").slice(0, 200), ms });
    appendFileSync(REQUEST_LOG, entry + "\n");
  } catch (_) {}
}

// Per-call audit log: ts, IP, UA, method, path, payment-status, payer wallet.
// Fires for every /cap/* call that reaches a route handler (post-payment-verification).
function extractPayerFromHeader(xPayment) {
  if (!xPayment) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(xPayment), "base64").toString("utf8"));
    return decoded?.payload?.authorization?.from ?? decoded?.payload?.from ?? decoded?.from ?? null;
  } catch { return null; }
}

function logCallAudit(method, path, statusCode, ip, ua, xPayment, rail = "x402") {
  try {
    const payer = extractPayerFromHeader(xPayment);
    const paymentStatus = statusCode === 200 ? "paid" : statusCode === 400 ? "paid_bad_params" : "paid_error";
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      ip: ip || "unknown",
      ua: (ua || "").slice(0, 200),
      method,
      path,
      payment_status: paymentStatus,
      payer_wallet: payer,
      rail,
      status: statusCode,
    });
    appendFileSync(CALL_AUDIT_LOG, entry + "\n");
  } catch (_) {}
}

// 402 bounce logger — fires when a payment header is present but payment was rejected (demand sensor).
// Handles both x402 v1 (X-PAYMENT) and v2 (PAYMENT-SIGNATURE) header names.
// Appends to logs/402_bounces.jsonl. Zero behavior change to the 402 response itself.
// W3: also fires immediate Telegram for non-seeder bounces (hot-lead capture, 5-second latency).
function log402Bounce(req, res) {
  try {
    // v2 uses "Payment-Signature"; v1 used "X-PAYMENT"
    const xPayment = req.headers['payment-signature'] || req.headers['x-payment'] || null;
    if (!xPayment) return;
    let attempted_chain = "unknown";
    try {
      const decoded = JSON.parse(Buffer.from(xPayment, 'base64').toString('utf8'));
      if (decoded?.network) attempted_chain = decoded.network;
      else if (decoded?.payload?.network) attempted_chain = decoded.payload.network;
    } catch { /* not base64 JSON — leave chain as unknown */ }
    const attempted_rail = attempted_chain.startsWith("solana") ? "solana"
      : attempted_chain.startsWith("eip155") ? "evm"
      : "unknown";
    const payer = extractPayerFromHeader(xPayment);
    appendFileSync(BOUNCE_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      cap: req.path,
      attempted_rail,
      attempted_chain,
      payer: payer || null,
      rejection_reason: "payment_rejected",
    }) + "\n");
    // W3: real-time hot-lead alert — non-seeder bounces only
    if (payer && payer.toLowerCase() !== _SEEDER_BOUNCE_ADDR) {
      try {
        let priceStr = "";
        if (res) {
          const prHdr = res.getHeader('payment-required') || res.getHeader('PAYMENT-REQUIRED');
          if (prHdr) {
            const reqs = JSON.parse(Buffer.from(String(prHdr), 'base64').toString('utf8'));
            const amt = reqs?.accepts?.[0]?.amount;
            if (amt) priceStr = ` $${(Number(amt) / 1e6).toFixed(3)}`;
          }
        }
        const capName = (req.path || "").replace('/cap/', '');
        const msg = `💡 [Bounce] ${payer.slice(0, 14)} tried ${capName}${priceStr} — max-intent lead`;
        exec(`bash '${_NOTIFY_SH_PATH}' '${msg.replace(/'/g, "")}'`, () => {});
      } catch { /* alert never throws */ }
    }
  } catch { /* never throw from bounce logger */ }
}

const PORT = process.env.PORT || 4021;
const PAY_TO = process.env.WALLET_ADDRESS;
const NETWORK = process.env.X402_NETWORK || "base-sepolia";
const FACILITATOR = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
// DISCOVERY_FACILITATOR is what external agents see in /.well-known/x402.
// Kept pointing at CDP even when FACILITATOR_URL is the local bypass proxy.
const DISCOVERY_FACILITATOR = process.env.DISCOVERY_FACILITATOR_URL || FACILITATOR;

const app = express();
app.set("trust proxy", 1);
// Stripe webhook needs the RAW request body for signature verification, so it must
// NOT be pre-parsed by express.json(). Skip JSON parsing for that one path; the
// fiat rail mounts express.raw() on it instead.
app.use((req, res, next) => {
  if (req.path === "/v1/fiat/webhook" || req.path === "/v1/the402-webhook") return next();
  return express.json()(req, res, next);
});
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT, PAYMENT-SIGNATURE, X-PAYMENT-RESPONSE, PAYMENT-REQUIRED, Authorization");
  res.header("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE, PAYMENT-RESPONSE, PAYMENT-REQUIRED, WWW-Authenticate");
  next();
});

// Funnel instrumentation — logs every request on finish for conversion analysis
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    logRequest(req.method, req.path, res.statusCode, req.ip, req.get("user-agent"), Date.now() - start);
  });
  next();
});

// Diagnostic: capture full request headers from null-payer IPs for payment-intent analysis.
// Logging only — no behavior change. Remove after diagnosis.
const GCP_CAPTURE_LOG = join(LOG_DIR, "gcp_capture.jsonl");
const CAPTURE_IPS = new Set(["34.158.104.72", "104.131.41.96"]);
app.use((req, res, next) => {
  try {
    const xfwd = String(req.headers["x-forwarded-for"] || "");
    const isTarget = CAPTURE_IPS.has(req.ip) || xfwd.split(',').map(s => s.trim()).some(ip => CAPTURE_IPS.has(ip));
    if (isTarget) {
      appendFileSync(GCP_CAPTURE_LOG, JSON.stringify({
        ts: new Date().toISOString(),
        method: req.method,
        path: req.path,
        ip: req.ip,
        headers: req.headers,
      }) + "\n");
    }
  } catch (_) {}
  next();
});

const capabilities = await loadCapabilities();

const BASE_URL = process.env.BASE_URL || "https://the-stall.intuitek.ai";

let retainerPlans = {}; // populated by mountRetainer after payment middleware boots

// ── FREE introspection routes (not paywalled) ────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    network: NETWORK,
    capabilities: capabilities.map((c) => c.name),
    rails: {
      x402: true,
      stripe: stripeRail?.enabled
        ? { enabled: true, mode: stripeRail.isTestMode ? "test" : "live" }
        : { enabled: false },
      solana: SOLANA_WALLET ? { enabled: true, address: SOLANA_WALLET } : { enabled: false },
    },
  })
);

app.get("/logo.png", (_req, res) => {
  const logoPath = join(__dir, "../assets/logo.png");
  try {
    const data = readFileSync(logoPath);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(data);
  } catch (_) {
    res.status(404).end();
  }
});

app.get("/avatar.png", (_req, res) => {
  const avatarPath = join(__dir, "../assets/avatar.png");
  try {
    const data = readFileSync(avatarPath);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(data);
  } catch (_) {
    res.status(404).end();
  }
});

app.get("/glama.json", (_req, res) => {
  const glamaPath = join(__dir, "../glama.json");
  try {
    const data = readFileSync(glamaPath, "utf-8");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(data);
  } catch (_) {
    res.status(404).end();
  }
});

app.get("/catalog", (_req, res) =>
  res.json({
    stall: "the-stall",
    network: NETWORK,
    payTo: PAY_TO ? `${PAY_TO.slice(0, 6)}…${PAY_TO.slice(-4)}` : null,
    capabilities: capabilities.map((c) => ({
      name: c.name,
      path: `/cap/${c.name}`,
      price: c.price,
      description: c.description,
      inputSchema: c.inputSchema,
      outputSchema: c.outputSchema,
    })),
  })
);

// ── OpenAPI 3.1.0 spec — required params, schemas, security per endpoint ─────
// Issue constraints addressed here:
//   - Required query params have required:true (per inputSchema.required arrays)
//   - All endpoints include request/response schemas
//   - Free (identity-gated) endpoints declare security:[]
//   - Paid endpoints declare security:[{x402Payment:[]}]
// IMPORTANT: any request-validation middleware added in future MUST be placed
// AFTER app.use(buildPaymentMiddleware(...)) so unauthenticated probes receive
// 402 (not 400/422) and x402scan can detect the paywall correctly.

function inputSchemaToParams(inputSchema) {
  if (!inputSchema?.properties) return [];
  const required = new Set(inputSchema.required || []);
  return Object.entries(inputSchema.properties).map(([name, prop]) => {
    const { description, ...schemaPart } = prop;
    return {
      name,
      in: "query",
      required: required.has(name),
      ...(description ? { description } : {}),
      schema: schemaPart,
    };
  });
}

app.get("/openapi.json", (_req, res) => {
  const freePaths = {
    "/health": {
      get: {
        operationId: "health",
        summary: "Health check",
        description: "Returns network, capability list, and ok:true.",
        security: [],
        responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, network: { type: "string" }, capabilities: { type: "array", items: { type: "string" } } }, required: ["ok", "network", "capabilities"] } } } } },
      },
    },
    "/catalog": {
      get: {
        operationId: "catalog",
        summary: "Full capability catalog",
        description: "Returns all capabilities with names, paths, prices, descriptions, and input/output schemas.",
        security: [],
        responses: { "200": { description: "Catalog", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/stats": {
      get: {
        operationId: "stats",
        summary: "Aggregated usage statistics",
        security: [],
        responses: { "200": { description: "Stats", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/metrics": {
      get: {
        operationId: "metrics",
        summary: "Discovery-to-payment funnel metrics",
        security: [],
        responses: { "200": { description: "Metrics", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/openapi.json": {
      get: {
        operationId: "openapi",
        summary: "This OpenAPI specification",
        security: [],
        responses: { "200": { description: "OpenAPI 3.1.0 spec", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/fiat/checkout": {
      post: {
        operationId: "fiat_checkout",
        summary: "Buy prepaid call credits with a card (Stripe)",
        description: "Creates a Stripe Checkout Session for a prepaid credit bundle. Redirect the buyer to the returned checkout_url. After payment completes, retrieve the bearer token via GET /v1/fiat/token?session_id=. Credits are consumed at 1 per /cap/* call — no wallet, no gas, no per-call signing.",
        tags: ["fiat"],
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  bundle: {
                    type: "string",
                    enum: ["starter", "pro", "scale"],
                    description: "Credit bundle to purchase. starter=$5/100 credits ($0.05/call), pro=$30/1,000 credits ($0.03/call), scale=$200/10,000 credits ($0.02/call).",
                    default: "starter",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Stripe checkout session created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    checkout_url: { type: "string", description: "Redirect buyer to this URL to complete card payment." },
                    session_id: { type: "string", description: "Pass to GET /v1/fiat/token?session_id= after payment to retrieve your bearer token." },
                    bundle: { type: "string" },
                    credits: { type: "integer", description: "Credits included in this bundle." },
                    amount_usd: { type: "number", description: "Price in USD." },
                  },
                  required: ["checkout_url", "session_id", "bundle", "credits", "amount_usd"],
                },
              },
            },
          },
          "400": { description: "Unknown bundle key — use starter, pro, or scale." },
        },
      },
    },
    "/v1/fiat/token": {
      get: {
        operationId: "fiat_token",
        summary: "Retrieve bearer token after Stripe payment",
        description: "Poll after the buyer completes checkout. Returns a bearer token for use as Authorization: Bearer <token> on any /cap/* call. Each call consumes 1 credit.",
        tags: ["fiat"],
        security: [],
        parameters: [
          {
            name: "session_id",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "Stripe session_id returned by POST /v1/fiat/checkout.",
          },
        ],
        responses: {
          "200": {
            description: "Token ready",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { type: "string", description: "Bearer token — use as Authorization: Bearer <token> on any /cap/* endpoint." },
                    credits: { type: "integer", description: "Remaining call credits." },
                    jti: { type: "string" },
                  },
                  required: ["token", "credits"],
                },
              },
            },
          },
          "404": { description: "Payment not yet confirmed. Retry in 2-5 seconds." },
        },
      },
    },
  };

  const capPaths = {};
  for (const cap of capabilities) {
    const params = inputSchemaToParams(cap.inputSchema);
    // Zero-param caps: x402scan requires at least a requestBody or parameter schema.
    // For GET endpoints with no query parameters, include an explicit empty requestBody
    // so discovery scanners know "call this with no body / no query params required."
    const requestBody = params.length === 0 ? {
      required: false,
      description: "No parameters required.",
      content: {
        "application/json": {
          schema: cap.inputSchema ?? { type: "object", properties: {} },
        },
      },
    } : undefined;
    capPaths[`/cap/${cap.name}`] = {
      get: {
        operationId: cap.name,
        summary: cap.description,
        tags: ["capabilities"],
        security: [{ x402Payment: [] }, { bearerToken: [] }],
        "x-payment-info": {
          protocols: ["x402", "fiat-bearer"],
          price: { mode: "fixed", currency: "USD", amount: cap.price.replace("$", "") },
          fiatBundles: { starter: { usd: 5, credits: 100 }, pro: { usd: 30, credits: 1000 }, scale: { usd: 200, credits: 10000 } },
        },
        parameters: params,
        ...(requestBody ? { requestBody } : {}),
        responses: {
          "200": {
            description: "Capability result",
            content: { "application/json": { schema: cap.outputSchema ?? { type: "object" } } },
          },
          "402": {
            description: "Payment required — attach X-PAYMENT header with USDC on Base mainnet",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    x402Version: { type: "integer", example: 2 },
                    error: { type: "string" },
                    accepts: { type: "array", items: { type: "object" } },
                  },
                  required: ["x402Version", "accepts"],
                },
              },
            },
          },
        },
      },
    };
  }

  res.json({
    openapi: "3.1.0",
    info: {
      title: "The Stall",
      description: `Domain-agnostic x402 capability chassis by IntuiTek¹. ${capabilities.length} AI-callable data services — pay USDC on Base mainnet. No accounts or API keys required.`,
      version: PKG_VERSION,
      contact: { url: BASE_URL },
    },
    "x-discovery": { ownershipProofs: PAY_TO ? [PAY_TO] : [] },
    servers: [{ url: BASE_URL, description: "Production (Base mainnet)" }],
    components: {
      securitySchemes: {
        x402Payment: {
          type: "http",
          scheme: "x402",
          description: "Attach X-PAYMENT header containing a signed EIP-3009 USDC transfer authorization on Base mainnet. Payment is verified and settled by the x402 facilitator before the capability handler runs.",
        },
        bearerToken: {
          type: "http",
          scheme: "bearer",
          description: "Bearer token issued after a Stripe card purchase. Buy credits via POST /v1/fiat/checkout, then GET /v1/fiat/token to retrieve your token. Send as Authorization: Bearer <token> on any /cap/* endpoint — 1 credit consumed per call.",
        },
      },
    },
    paths: { ...freePaths, ...capPaths },
  });
});

// ── x402 Discovery document (dual-format: xpaysh/Rug-Munch + official x402) ──
// payTo + accepts[] added for x402scan / CDP Bazaar compatibility.
// paymentAddress kept for xpaysh/awesome-x402 catalog compatibility.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
app.get("/.well-known/x402", (_req, res) =>
  res.json({
    version: "1.0.0",
    name: "The Stall",
    description: `${capabilities.length} pay-per-call AI data tools via MCP + x402 on Base mainnet. Finance, crypto, DeFi, prediction markets, macro, OSINT, research, weather, aviation. No API keys or accounts required — pay USDC per call.`,
    url: BASE_URL,
    network: "base",
    currency: "USDC",
    facilitator: DISCOVERY_FACILITATOR,
    paymentAddress: PAY_TO || null,
    payTo: PAY_TO || null,
    accepts: [
      ...(PAY_TO ? [{
        scheme: "exact",
        network: "base",
        asset: USDC_BASE,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
      }] : []),
      ...(SOLANA_WALLET ? [{
        scheme: "exact",
        network: "solana:mainnet-beta",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        payTo: SOLANA_WALLET,
        maxTimeoutSeconds: 300,
      }] : []),
      ...(POLYGON_WALLET ? [{
        scheme: "exact",
        network: "eip155:137",
        asset: POLYGON_USDC,
        payTo: POLYGON_WALLET,
        maxTimeoutSeconds: 300,
      }] : []),
    ],
    resources: capabilities.map((c) => `${BASE_URL}/cap/${c.name}`),
    endpoints: capabilities.map((c) => ({
      path: `/cap/${c.name}`,
      method: "GET",
      price: {
        amount: c.price.replace("$", ""),
        currency: "USDC",
        network: "base",
        maxAmountRequired: String(Math.round(parseFloat(c.price.replace("$", "")) * 1e6)),
        asset: USDC_BASE,
      },
      description: c.description,
    })),
  })
);

// ── x402.json alias — version:1 integer format for Agentic.Market / CDP crawler ─
// Mirrors the format used by blockrun.ai (version=1 int, resources as "METHOD /path")
// to ensure Agentic.Market's indexer can enumerate all 205 capabilities.
app.get("/.well-known/x402.json", (_req, res) =>
  res.json({
    version: 1,
    name: "The Stall",
    description: `Domain-agnostic x402 capability chassis by IntuiTek¹. ${capabilities.length} AI-callable data services on Base mainnet. No API keys or accounts required.`,
    network: "base",
    currency: "USDC",
    payTo: PAY_TO || null,
    resources: capabilities.map((c) => `GET /cap/${c.name}`),
    endpoints: capabilities.map((c) => ({
      method: "GET",
      path: `/cap/${c.name}`,
      url: `${BASE_URL}/cap/${c.name}`,
      description: c.description,
      price: { amount: c.price.replace("$", ""), currency: "USDC", network: "base" },
    })),
    catalog: `${BASE_URL}/catalog`,
    openapi: `${BASE_URL}/openapi.json`,
  })
);

// ── A2A Agent Card (ACP / Google A2A discovery standard) ─────────────────────
app.get("/.well-known/agent.json", (_req, res) =>
  res.json({
    name: "The Stall",
    description: `Domain-agnostic x402 capability chassis by IntuiTek¹. ${capabilities.length} AI-callable data services for USDC on Base — stock prices, DeFi analytics, token security, prediction markets, macro indicators, research papers, domain WHOIS, company intelligence, weather, flight tracking, and more. MCP interface at /mcp — no wallet, no API keys.`,
    url: BASE_URL,
    version: PKG_VERSION,
    provider: {
      organization: "IntuiTek¹",
      url: "https://intuitek.ai",
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    skills: [
      ...capabilities.map((c) => ({
        id: c.name,
        name: c.name,
        description: c.description,
        inputModes: ["data"],
        outputModes: ["data"],
        tags: ["x402", "mcp", "data", "finance", "base", "solana", "usdc"],
        examples: [],
      })),
      ...Object.entries(retainerPlans).map(([id, cfg]) => ({
        id,
        name: id,
        description: `Counterparty risk retainer — ${cfg.windowSeconds / 86400}d subscription at ${cfg.price}. POST /v1/subscribe/${id} to pay; receive JWT granting access to GET /v1/risk/:address.`,
        inputModes: ["data"],
        outputModes: ["data"],
        tags: ["x402", "risk", "retainer", "subscription", "compliance", "base"],
        examples: [],
      })),
    ],
    authentication: {
      schemes: ["x402", "none"],
    },
    defaultInputModes: ["data"],
    defaultOutputModes: ["data"],
    additionalInterfaces: [
      {
        type: "mcp",
        transport: "streamable-http",
        url: `${BASE_URL}/mcp`,
        description: "MCP Streamable HTTP interface — all capabilities available free, no wallet required",
      },
      {
        type: "mcp",
        transport: "sse",
        url: `${BASE_URL}/sse`,
        description: "MCP SSE interface — legacy SSE transport for clients that require it",
      },
    ],
  })
);

// ── Smithery server card (skip-scan path for capability enumeration) ─────────
app.get("/.well-known/mcp/server-card.json", (_req, res) =>
  res.json({
    name: "The Stall",
    description: `Domain-agnostic x402 capability chassis by IntuiTek¹. ${capabilities.length} AI-callable data tools: stock prices, market overview, DeFi yields, token security, wallet screening, gas prices, macro indicators, prediction markets, company due diligence, research papers, domain WHOIS, email verification, flight tracking, weather, and more. MCP over Streamable HTTP — no wallet, no API keys, no accounts.`,
    version: PKG_VERSION,
    tools: capabilities.map((c) => ({
      name: c.name,
      description: c.description,
      inputSchema: c.inputSchema,
    })),
  })
);

// ── mcpub.dev domain verification ─────────────────────────────────────────────
app.get("/.well-known/mcp.json", (_req, res) =>
  res.json({
    name: "The Stall",
    mcp_endpoint: `${BASE_URL}/mcp`,
    version: PKG_VERSION,
    description: `${capabilities.length} pay-per-call AI capabilities via x402 on Base mainnet. Finance, crypto, DeFi, macro, compliance, OSINT. No API keys.`,
    provider: "IntuiTek¹",
    contact: "kyle@intuitek.ai",
  })
);

// ── Hermes Agent skill discovery (/.well-known/skills/) ───────────────────────
// Serves the stall-market-data skill for `hermes skills install well-known:URL`.
// Files live at skills/stall-market-data/ and are read from disk so they can be
// updated independently of this server.
const SKILLS_DIR = join(__dir, "..", "skills");
const SKILL_NAME = "stall-market-data";
const SKILL_MD_PATH = join(SKILLS_DIR, SKILL_NAME, "SKILL.md");
const SKILL_PY_PATH = join(SKILLS_DIR, SKILL_NAME, "scripts", "stall_client.py");

app.get("/.well-known/skills/index.json", (_req, res) =>
  res.json({
    skills: [{
      name: SKILL_NAME,
      description: `Live stock prices, earnings, analyst & crypto market data`,
      files: ["SKILL.md", "scripts/stall_client.py"],
    }],
  })
);

app.get(`/.well-known/skills/${SKILL_NAME}/SKILL.md`, (_req, res) => {
  try {
    const content = readFileSync(SKILL_MD_PATH, "utf8");
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.send(content);
  } catch (_) {
    res.status(404).json({ error: "SKILL.md not found" });
  }
});

app.get(`/.well-known/skills/${SKILL_NAME}/scripts/stall_client.py`, (_req, res) => {
  try {
    const content = readFileSync(SKILL_PY_PATH, "utf8");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(content);
  } catch (_) {
    res.status(404).json({ error: "stall_client.py not found" });
  }
});

// ── Public landing page — live traction signal ────────────────────────────────
app.get("/", (_req, res) => {
  const stats = readPaymentStats();
  const sinceStr = stats.since
    ? new Date(stats.since).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : "N/A";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>The Stall — x402 Intelligence Marketplace</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#e2e8f0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem}
    .brand{font-size:0.75rem;letter-spacing:0.2em;text-transform:uppercase;color:#6366f1;margin-bottom:1rem}
    h1{font-size:2.5rem;font-weight:700;margin-bottom:0.5rem}
    .tagline{color:#94a3b8;margin-bottom:3rem;font-size:1.1rem}
    .stats{display:flex;gap:3rem;margin-bottom:3rem;flex-wrap:wrap;justify-content:center}
    .stat{text-align:center}
    .num{display:block;font-size:3rem;font-weight:800;color:#6366f1;line-height:1}
    .label{display:block;font-size:0.8rem;letter-spacing:0.1em;text-transform:uppercase;color:#64748b;margin-top:0.25rem}
    .since{font-size:0.65rem;color:#475569;margin-top:0.15rem}
    .links{display:flex;gap:1rem;flex-wrap:wrap;justify-content:center}
    a{color:#818cf8;text-decoration:none;padding:0.5rem 1.25rem;border:1px solid #312e81;border-radius:0.5rem;font-size:0.9rem;transition:border-color 0.15s}
    a:hover{border-color:#6366f1}
    .footer{margin-top:4rem;font-size:0.75rem;color:#334155;text-align:center}
    .dot{display:inline-block;width:7px;height:7px;background:#22c55e;border-radius:50%;margin-right:0.4rem;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
  </style>
</head>
<body>
  <div class="brand">IntuiTek¹</div>
  <h1>The Stall</h1>
  <p class="tagline">AI-callable data services. Pay USDC on Base. No accounts.</p>
  <div class="stats">
    <div class="stat">
      <span class="num">${capabilities.length}</span>
      <span class="label">capabilities</span>
    </div>
    <div class="stat">
      <span class="num">${stats.total}</span>
      <span class="label">API calls served</span>
      ${stats.since ? `<span class="since">since ${sinceStr}</span>` : ""}
    </div>
    <div class="stat">
      <span class="num">${stats.uniqueCaps}</span>
      <span class="label">caps called</span>
    </div>
  </div>
  <div class="links">
    <a href="/catalog">Browse catalog</a>
    <a href="/.well-known/x402">x402 manifest</a>
    <a href="/.well-known/agent.json">Agent card</a>
    <a href="/stats">Stats JSON</a>
  </div>
  <div class="footer">
    <span class="dot"></span>Live · Base mainnet · x402 · MCP
    <br><br>
    Built by <a href="https://intuitek.ai" style="border:none;padding:0">IntuiTek¹</a>
  </div>
</body>
</html>`);
});

// ── llms.txt — agent/registry discovery file ─────────────────────────────────
app.get("/llms.txt", (_req, res) => {
  // Revenue-proven caps — ordered by actual USDC organic earnings (settlement.jsonl, automaton-filtered per gate-zero 2026-06-27).
  // Last updated: 2026-07-13. 7-day organic (Jul 6-13): research-synthesis #1 ($12.50/5), us-stock-price #2 ($10.15/100), github-repo-intel #3 ($1.84/54), wikipedia-intel #4 ($1.67/49), equity-brief #5 ($1.48/4), income-statements #6 ($1.19/34), earnings-calendar #7 ($0.35/6), stock-brief #8 ($0.32/9), defi-portfolio #9 ($0.30/5), reddit-intel #10 ($0.28/7), fact-check #11 ($0.47/2-high-per-call), crypto-top-movers #12 (historical). Dropped: stock-price-multi/earnings-surprises/equity-fundamentals/fomc-tracker/credit-spreads/sector-rotation (0 organic 7d).
  const PRIORITY_CAPS = ['research-synthesis','us-stock-price','github-repo-intel','wikipedia-intel','equity-brief',
    'income-statements','earnings-calendar','stock-brief','defi-portfolio','reddit-intel','fact-check','crypto-top-movers'];
  // Build categories with first-match-wins — prevent duplicates across overlapping regexes.
  // PRIORITY_CAPS are pre-seeded so they never appear in a category section (handled in prioritySection).
  const assignedNames = new Set(PRIORITY_CAPS);
  const catDefs = [
    { name: "Finance & Markets", re: /stock|equity|market|earning|dividend|etf|option|insider|institutional|sector|treasury|credit|hedge|short|fec|ipo|form-144|fomc|fed|fiscal|econ|labor|consumer|housing|intl-stock|global-equity|forex|analyst|income-state|company-|concentration|currency-format|lbo|manufacturing|job-search|intel-pack|limitless|analyst-rating|wacc/i },
    { name: "Crypto & DeFi", re: /crypto|defi|btc|eth|token|wallet|nft|solana|dex|chain|block|tx|evm|erc20|ens|gas|defillama|kimchi|korean|stablecoin|yield-farm|whale|funding|base-season/i },
    { name: "Prediction Markets", re: /polymarket|prediction|sports/i },
    { name: "News & Research", re: /news|research|arxiv|reddit|hn|rss|social|fact-check|wikipedia|stackoverflow|github-repo|github-org|citation/i },
    { name: "AI & Compute", re: /ai-image|audio|vision|meme|generate|hf-model|code|content-|roast|image-detect|document-qa|classic-novel/i },
    { name: "Infrastructure & Data", re: /dns|ip-intel|ssl|http|ping|agent-access|geo|city|place|domain|email-verify|npm|pypi|json|regex|unit|timezone|cron|page-intel|page-links|readable|web-scrape|web-change|web-company|wayback|breadcrumb|dictionary|changelog-gen|db-perf/i },
    { name: "On-chain Risk & Compliance", re: /sanctions|wallet-credit|wallet-screener|address-security|agent-kya|kya|cve|drug-intel|npi|clinical|fda/i },
    { name: "Macro & Alternative Data", re: /macro|imf|world-bank|commodity|energy|solar|earthquake|usgs|weather|air-quality|aviation|flight|legal|gov-vote|congressional|federal-contract|federal-register|country-info|chromatic|sport-predict/i },
    { name: "Social & Video Intelligence", re: /youtube|twitter-intel|github-trending|podcast/i },
  ];
  const cats = catDefs.map(({ name, re }) => {
    const caps = capabilities
      .filter(c => re.test(c.name) && !assignedNames.has(c.name))
      .map(c => { assignedNames.add(c.name); return c.name; });
    return { name, caps };
  });
  // Extract a short example value from a property description
  function exampleFromDesc(desc = '') {
    // Match "e.g. X", "e.g., X", "Example: X", or "Example: 'X'"
    const m = desc.match(/(?:e\.g\.[\s,]+|[Ee]xample:\s+)['"]?([^'")\n,\.]{2,40})/i);
    if (!m) return null;
    return m[1].trim().replace(/['"]/g, '').split(/\s*,\s*/)[0];
  }
  // Build a ?param=example hint string for caps that have required params
  function paramHint(cap) {
    const required = cap?.inputSchema?.required || [];
    if (!required.length) return '';
    const props = cap?.inputSchema?.properties || {};
    const parts = required.map(p => {
      const ex = exampleFromDesc(props[p]?.description || '') || p;
      return `${p}=${ex}`;
    });
    return ` | ?${parts.join('&')}`;
  }
  const prioritySection = `## Highest-Value Caps — Proven x402 Conversions\n\n${PRIORITY_CAPS.map(n => {
    const cap = capabilities.find(c => c.name === n);
    if (!cap) return null;
    const price = cap.price?.replace('$','') || '?';
    // research-synthesis: special hint since query is optional
    const hint = n === 'research-synthesis'
      ? ' | ?query=your+topic (query optional — finance, macro, tech, research; defaults to AI agents report)'
      : paramHint(cap);
    // Add a short description for value clarity on high-ticket synthesis caps
    const firstSentence = (cap.description || '').split(/(?<=[.!?])\s+/)[0] || '';
    const shortDesc = firstSentence ? ` — ${firstSentence.length > 220 ? firstSentence.slice(0, firstSentence.lastIndexOf(' ', 220)) + '…' : firstSentence}` : '';
    return `  - [${n}](${BASE_URL}/cap/${n}): $${price} USDC${hint}${shortDesc}`;
  }).filter(Boolean).join('\n')}\n\n> **research-synthesis** delivers multi-source AI synthesis at ~1/5th the cost of premium alternatives ($${(() => { const c = capabilities.find(x => x.name === 'research-synthesis'); return c?.price?.replace('$','') || '0.309'; })()}/call). For agent research pipelines, start here before reaching for higher-cost services.`;
  // assignedNames now contains PRIORITY_CAPS + all category-assigned caps — anything left is uncategorized
  const uncategorized = capabilities.filter(c => !assignedNames.has(c.name)).map(c => c.name);
  const allCats = uncategorized.length
    ? [...cats, { name: 'Other Tools', caps: uncategorized }]
    : cats;
  const capLines = [prioritySection, ...allCats.map(cat => {
    const names = cat.caps.map(n => {
      const cap = capabilities.find(c => c.name === n);
      const price = cap?.price?.replace('$','') || '?';
      return `  - [${n}](${BASE_URL}/cap/${n}): $${price} USDC${paramHint(cap)}`;
    }).join('\n');
    return names ? `## ${cat.name}\n\n${names}` : null;
  }).filter(Boolean)].join('\n\n');
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(`# The Stall

> ${capabilities.length} AI-callable pay-per-call data tools. No API keys. Pay USDC on Base or Solana. MCP + REST.

The Stall is an x402-native capability chassis by IntuiTek¹. Every capability is a GET endpoint — agents probe, receive a 402 Payment Required with the exact USDC price, pay on Base mainnet (Coinbase CDP facilitator) or Solana mainnet (direct USDC transfer to EairXDfN79D5cw8tYuqmSfFKjYr4jmpPezXCxmd9nztF), and receive the result. No accounts, no subscriptions required.

**Prefer to pay by card (no crypto wallet)?** Buy prepaid credits and call any cap with an "Authorization: Bearer <token>" header — 1 credit per call, no gas, no per-call signing:
- Buy credits: POST ${BASE_URL}/v1/fiat/checkout with JSON body {"bundle":"starter"} → returns a Stripe checkout URL. Bundles: starter $5 (100 credits), pro $30 (1,000 credits), scale $200 (10,000 credits).
- After paying: GET ${BASE_URL}/v1/fiat/token?session_id=... returns your bearer token; send it as "Authorization: Bearer <token>" on any /cap/<name> call.

- MCP endpoint: ${BASE_URL}/mcp (streamable-http)
- SSE endpoint: ${BASE_URL}/sse
- x402 manifest: ${BASE_URL}/.well-known/x402
- Agent card: ${BASE_URL}/.well-known/agent.json
- Full catalog: ${BASE_URL}/catalog
- OpenAPI spec: ${BASE_URL}/openapi.json
- Builder guide: ${BASE_URL}/integrators

${capLines}

## Retainer Plans

Counterparty-risk monitoring subscribers get unlimited /v1/risk/{address} calls:
- 7-day plan: $10 USDC
- 30-day plan: $25 USDC
`);
});

// ── Integrator guide — production workflow patterns for agent builders ────────
app.get("/integrators", (_req, res) => {
  try {
    const content = readFileSync(new URL("../STALL_INTEGRATORS.md", import.meta.url), "utf8");
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.send(content);
  } catch {
    res.status(404).send("Integrator guide not found");
  }
});

// ── Machine-readable stats endpoint ──────────────────────────────────────────
app.get("/stats", (_req, res) => {
  const stats = readPaymentStats();
  res.json({
    capabilities: capabilities.length,
    paid_calls_total: stats.total,
    unique_caps_called: stats.uniqueCaps,
    first_call_at: stats.since,
    network: NETWORK,
    base_url: BASE_URL,
    ts: new Date().toISOString(),
  });
});

// ── Funnel metrics — full discovery → probe → pay conversion view ─────────────
app.get("/metrics", (_req, res) => {
  const requests = parseJsonlLog(REQUEST_LOG);
  const payments = parseJsonlLog(PAYMENT_LOG);

  const catalogHits = requests.filter(r => r.path === "/catalog").length;
  const healthHits = requests.filter(r => r.path === "/health").length;
  const mcpCalls = requests.filter(r => r.path === "/mcp").length;
  const probes = requests.filter(r => r.path?.startsWith("/cap/") && r.status === 402);
  const uniqueIPs = new Set(requests.map(r => r.ip)).size;
  const uniqueProbeIPs = new Set(probes.map(r => r.ip)).size;

  const probesByCap = {};
  for (const r of probes) {
    const cap = r.path.replace("/cap/", "");
    probesByCap[cap] = (probesByCap[cap] || 0) + 1;
  }

  const paidByCap = {};
  for (const r of payments) {
    const cap = (r.cap || r.path?.replace("/cap/", "") || r.capability || "unknown");
    paidByCap[cap] = (paidByCap[cap] || 0) + 1;
  }

  const uaGroups = {};
  for (const r of requests) {
    const ua = r.ua?.slice(0, 60) || "unknown";
    uaGroups[ua] = (uaGroups[ua] || 0) + 1;
  }

  res.json({
    funnel: {
      catalog_hits: catalogHits,
      health_hits: healthHits,
      mcp_calls: mcpCalls,
      cap_probes_402: probes.length,
      paid_calls: payments.length,
    },
    conversion: {
      probe_to_pay_rate: probes.length > 0 ? (payments.length / probes.length).toFixed(4) : null,
      catalog_to_probe_rate: catalogHits > 0 ? (probes.length / catalogHits).toFixed(4) : null,
    },
    unique_ips: uniqueIPs,
    unique_probe_ips: uniqueProbeIPs,
    top_probed_caps: Object.entries(probesByCap).sort((a, b) => b[1] - a[1]).slice(0, 15),
    top_paid_caps: Object.entries(paidByCap).sort((a, b) => b[1] - a[1]).slice(0, 15),
    top_user_agents: Object.entries(uaGroups).sort((a, b) => b[1] - a[1]).slice(0, 10),
    request_total: requests.length,
    ts: new Date().toISOString(),
  });
});

// ── MCP Streamable HTTP endpoint (free — handlers called directly, no x402) ──
app.post("/mcp", makeMcpHandler(capabilities));
app.get("/mcp", (_req, res) =>
  res.status(200).json({
    jsonrpc: "2.0",
    result: {
      serverInfo: { name: "The Stall", version: PKG_VERSION },
      capabilities: { tools: {} },
      protocolVersion: "2024-11-05",
      capabilityCount: capabilities.length,
      endpoint: `${BASE_URL}/mcp`,
      note: "POST to this endpoint to send MCP messages",
    },
    id: null,
  })
);

// ── MCP SSE transport (legacy — for clients that require SSE over streamable-http) ──
const { connect: sseConnect, message: sseMessage } = makeSSEHandlers(capabilities);
app.get("/sse", sseConnect);
app.post("/messages", sseMessage);

// ── Query param coercion — REST callers pass everything as strings ─────────────
// For fields with type: "array" in inputSchema, accept comma-separated strings
// and coerce them to arrays. Numeric array items are parsed as floats.
function coerceQuery(query, inputSchema) {
  if (!inputSchema?.properties) return query;
  const out = { ...query };
  for (const [key, prop] of Object.entries(inputSchema.properties)) {
    if (prop.type !== "array" || !(key in out)) continue;
    const val = out[key];
    if (Array.isArray(val)) continue; // already an array (e.g. ?a=1&a=2)
    if (typeof val !== "string") continue;
    const items = val.split(",").map(s => s.trim()).filter(Boolean);
    const itemType = prop.items?.type ?? "string";
    out[key] = itemType === "number" || itemType === "integer"
      ? items.map(Number)
      : items;
  }
  return out;
}

// ── PAID capability routes (x402-gated) ───────────────────────────────────────
// ORDERING CONSTRAINT: x402 middleware MUST run before any request validation.
// Do NOT add body/query validation middleware above this line — unauthenticated
// probes would receive 400/422 instead of 402, breaking x402scan detection.
// Validation that rejects for missing params belongs inside the route handlers,
// which only run after x402 has verified and settled the payment.

// x402 body-mirror middleware — belts + suspenders for v1 x402 clients.
// @x402/express puts requirements only in PAYMENT-REQUIRED header (valid x402 v2).
// Body-only clients (legacy x402-fetch/axios) parse the body, not the header,
// and silently fail to pay when they see {}. QuickNode fills both. We do too now.
// Strictly additive: only fires when status=402 + header present + header decodes.
app.use((_req, res, next) => {
  const _origJson = res.json.bind(res);
  res.json = function (body) {
    if (res.statusCode === 402) {
      // Inject WWW-Authenticate advertising both payment rails to MPP-aware agents.
      // Stripe (primary): credit bundles via /v1/fiat/checkout (no wallet/gas required).
      // x402 (secondary): EIP-3009 USDC on Base — full challenge in PAYMENT-REQUIRED header.
      if (!res.getHeader('WWW-Authenticate')) {
        const parts = [];
        if (stripeRail?.enabled) parts.push(stripeRail.getStripeChallenge());
        if (PAY_TO) {
          const chainId = (NETWORK === "base" || NETWORK === "eip155:8453") ? "eip155:8453" : "eip155:84532";
          parts.push(`x402 network="${chainId}" to="${PAY_TO}" scheme="exact"`);
        }
        if (stripeRail?.getMppChallenge) { const _mppCh = stripeRail.getMppChallenge(); if (_mppCh) parts.push(_mppCh); }
        if (parts.length) res.setHeader('WWW-Authenticate', parts.join(', '));
      }
      // Log bounce if payment header present — payer attempted a rejected rail (demand sensor)
      if (_req.headers['x-payment'] || _req.headers['payment-signature']) log402Bounce(_req, res);
      const prHeader = res.getHeader('PAYMENT-REQUIRED') || res.getHeader('payment-required');
      if (prHeader) {
        try {
          const requirements = JSON.parse(Buffer.from(String(prHeader), 'base64').toString('utf8'));
          return _origJson(requirements);
        } catch (_) { /* header malformed — fall through */ }
      }
    }
    return _origJson(body);
  };
  next();
});

// ── FIAT RAIL (Stripe) ────────────────────────────────────────────────────────
// Mounts /v1/fiat/* routes and returns a gate middleware. The gate runs BEFORE the
// x402 paywall: a valid fiat bearer token with remaining credits sets req.fiatPaid,
// which causes the x402 middleware below to be skipped. Self-disables if no key.
const tokenSigner = loadSigner();
const stripeRail = mountStripeRail(app, {
  signer: tokenSigner,
  baseUrl: BASE_URL,
  ledgerPath: join(LOG_DIR, "fiat_credits.json"),
});
app.use(stripeRail.mppGate);
app.use(stripeRail.fiatGate);

// x402 paywall — fiat-gated or internal-key requests bypass entirely.
// Order: PayAI canary (ping only) → Polygon rail → Solana rail → EVM x402 paywall.
// POLYGON-PILOT-01 (003-B, 2026-07-08): Polygon rail added; kill window 2026-08-08.
const x402Middleware = buildPaymentMiddleware({ payTo: PAY_TO, network: NETWORK, facilitator: FACILITATOR, capabilities });
const solanaRailMiddleware = buildSolanaRailMiddleware(capabilities);
const polygonRailMiddleware = buildPolygonRailMiddleware(capabilities);
// T3-1 Move #3: PayAI facilitator canary (ping cap, 30d window 2026-07-07→2026-08-06)
const payAICanaryMiddleware = buildPayAICanaryMiddleware(capabilities, SOLANA_WALLET, PAY_TO);
const STALL_INTERNAL_KEY = process.env.STALL_INTERNAL_KEY || null;
app.use((req, res, next) => {
  if (req.fiatPaid) return next();
  if (STALL_INTERNAL_KEY && req.headers["x-internal-key"] === STALL_INTERNAL_KEY) return next();
  // PayAI canary intercepts /cap/ping only; falls through to next() for all other paths
  payAICanaryMiddleware(req, res, () => {
    if (req.payment) return next(); // PayAI canary already verified + settling — skip downstream paywalls
    polygonRailMiddleware(req, res, () => {
      if (req._polygonRail) return next(); // Polygon payment verified upstream
      solanaRailMiddleware(req, res, () => {
        if (req._solanaRail) return next(); // Solana payment verified upstream
        return x402Middleware(req, res, next);
      });
    });
  });
});

// ── Retainer mount (subscription shape — POST /v1/subscribe/:plan + GET /v1/risk/:address) ──
const { plans } = mountRetainer(app, {
  payTo: PAY_TO,
  network: NETWORK,
  facilitator: FACILITATOR,
  provider: makeLiveProvider(),
});
retainerPlans = plans;

// Cross-cap recommendation map — machine-readable upsell via X-Stall-Related header on 200 responses.
// Spray-and-pay agents that call one cap discover adjacent caps in the same session without a separate catalog fetch.
// Based on organic settlement patterns (2026-07-09 analysis): 54% of payers call exactly once; this converts them to multi-cap.
const CROSS_CAP_MAP = {
  'us-stock-price':       ['stock-price-multi','equity-brief','earnings-calendar','earnings-surprises'],
  'stock-price-multi':    ['us-stock-price','equity-fundamentals','earnings-calendar','sector-rotation'],
  'earnings-calendar':    ['earnings-surprises','earnings-intel-bundle','equity-brief','equity-fundamentals'],
  'earnings-surprises':   ['earnings-calendar','earnings-quality','earnings-reaction','earnings-intel-bundle'],
  'equity-brief':         ['research-synthesis','stock-price-multi','company-due-diligence','peer-benchmarking'],
  'research-synthesis':   ['equity-brief','fact-check','company-due-diligence','market-intelligence'],
  'github-repo-intel':    ['company-intel','web-company-intel','sec-insider-trades','npm-lookup'],
  'wikipedia-intel':      ['fact-check','web-reader','research-synthesis','company-intel'],
  'youtube-intel':        ['youtube-transcript','reddit-intel','web-reader','fact-check'],
  'youtube-transcript':   ['youtube-intel','fact-check','research-synthesis'],
  'crypto-top-movers':    ['crypto-fear-greed','defi-market-pulse','funding-rates','defi-portfolio'],
  'crypto-fear-greed':    ['crypto-top-movers','defi-market-pulse','funding-rates'],
  'defi-portfolio':       ['funding-rates','crypto-top-movers','cdp-market-depth','defi-market-pulse'],
  'income-statements':    ['equity-fundamentals','earnings-quality','company-due-diligence'],
  'market-intelligence':  ['research-synthesis','equity-brief','sector-rotation','market-overview'],
  'sector-rotation':      ['market-overview','market-breadth','equity-brief','market-intelligence'],
  'peer-benchmarking':    ['equity-brief','equity-fundamentals','company-due-diligence'],
  'cdp-market-depth':     ['defi-portfolio','funding-rates','defi-market-pulse'],
  'market-sentiment':     ['market-overview','sector-rotation','crypto-fear-greed'],
  'fact-check':           ['research-synthesis','wikipedia-intel','web-reader'],
  'stock-brief':          ['equity-brief','us-stock-price','earnings-calendar','earnings-surprises'],
  'reddit-intel':         ['research-synthesis','fact-check','market-intelligence'],
  'defi-market-pulse':    ['crypto-top-movers','funding-rates','cdp-market-depth'],
};

for (const cap of capabilities) {
  // Shared handler factory — GET reads params from req.query; POST merges req.body + req.query
  // (body takes precedence so structured JSON clients can pass params naturally).
  function makeCapHandler(paramSource) {
    return async (req, res) => {
      const xPayment = req.headers["payment-signature"] || req.headers["x-payment"] || null;
      const params = paramSource(req);

      const required = cap.inputSchema?.required || [];
      const missing = required.filter(p => params[p] === undefined || params[p] === "");
      if (missing.length > 0) {
        logPaidCall(cap.name, cap.price, params, 400, req.ip);
        logSettlement(cap.name, cap.price, params, 400, res, req.ip, xPayment);
        logCallAudit(req.method, req.path, 400, req.ip, req.get("user-agent"), xPayment, req.fiatPaid ? "fiat" : req._polygonRail ? "polygon" : req._solanaRail ? "solana" : "x402");
        // Build a ready-to-use example query string from inputSchema descriptions
        const props = cap.inputSchema?.properties || {};
        const exParts = missing.map(p => {
          const desc = props[p]?.description || '';
          const m = desc.match(/e\.g\.[\s,]+['"]?([^'")\n,\.]{2,40})/i);
          const ex = m ? m[1].trim().replace(/['"]/g, '').split(/[,\s]+/)[0] : p;
          return `${p}=${encodeURIComponent(ex)}`;
        });
        const exampleUrl = `${BASE_URL}/cap/${cap.name}?${exParts.join('&')}`;
        return res.status(400).json({
          error: "missing_required_params",
          capability: cap.name,
          missing,
          message: `Required parameters: ${missing.join(", ")}`,
          example: exampleUrl,
          schema: cap.inputSchema,
          catalog: `${BASE_URL}/catalog`,
        });
      }

      try {
        const out = await cap.handler(coerceQuery(params, cap.inputSchema), { req });
        logPaidCall(cap.name, cap.price, params, 200, req.ip);
        logSettlement(cap.name, cap.price, params, 200, res, req.ip, xPayment);
        logCallAudit(req.method, req.path, 200, req.ip, req.get("user-agent"), xPayment, req.fiatPaid ? "fiat" : req._polygonRail ? "polygon" : req._solanaRail ? "solana" : "x402");
        const relatedCaps = CROSS_CAP_MAP[cap.name];
        if (relatedCaps && relatedCaps.length > 0) {
          res.setHeader('X-Stall-Related', relatedCaps.map(r => `${BASE_URL}/cap/${r}`).join(', '));
        }
        res.json(out);
      } catch (err) {
        const isValidationError = err.status === 400 ||
          /^(provide |at least one|lat and lon are required)/i.test(err.message || "");
        const isUpstreamUnavailable = err.status === 503;
        const status = isValidationError ? 400 : isUpstreamUnavailable ? 503 : 500;
        const errorCode = isValidationError ? "bad_request" : isUpstreamUnavailable ? "upstream_unavailable" : "capability_error";
        logPaidCall(cap.name, cap.price, params, status, req.ip);
        logSettlement(cap.name, cap.price, params, status, res, req.ip, xPayment);
        logCallAudit(req.method, req.path, status, req.ip, req.get("user-agent"), xPayment, req.fiatPaid ? "fiat" : req._polygonRail ? "polygon" : req._solanaRail ? "solana" : "x402");
        if (isUpstreamUnavailable) res.setHeader("Retry-After", "5");
        res.status(status).json({ error: errorCode, capability: cap.name, message: String(err?.message || err) });
      }
    };
  }

  app.get(`/cap/${cap.name}`, makeCapHandler(req => req.query));
  // POST: body params take precedence over query params for structured JSON clients.
  app.post(`/cap/${cap.name}`, makeCapHandler(req => ({
    ...req.query,
    ...(req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {}),
  })));
}

mountThe402Rail(app, capabilities);

// Express error middleware — catches body-parser parse failures and other route errors
// before they propagate to uncaughtException. Must be declared after all routes.
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed' || err?.status === 400) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  console.error('[server] unhandled route error:', err?.message);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(PORT, () => {
  console.log(`\n  THE STALL  ·  open on :${PORT}  ·  network: ${NETWORK}`);
  console.log(`  facilitator: ${FACILITATOR}`);
  console.log(`  payTo: ${PAY_TO || "⚠ NOT SET — paid routes will refuse to boot"}`);
  console.log(`  capabilities (${capabilities.length}): ${capabilities.map((c) => c.name).join(", ") || "none"}`);
  console.log(`  free:  GET /health   GET /catalog`);
  console.log(`  paid:  ${capabilities.map((c) => `GET /cap/${c.name}`).join("   ") || "(none yet — add a capability module)"}\n`);
});
