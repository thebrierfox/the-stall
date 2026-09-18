// mcp.js — MCP transport integration for The Stall.
//
// Discovery and tools/list remain free. Tool execution is routed through the
// native @x402/mcp payment wrapper according to MCP_PAYMENT_MODE.

import { readFileSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { installToolDiscovery, serializeToolDefinitions } from "./mcp-discovery.js";
import { mcpToolDescriptor } from "./commercial-discovery.js";
import { runWithAttribution } from "./attribution.js";
import {
  createMcpPaymentController,
  createMcpPaidToolPredicate,
  getMcpPaymentMode,
  readMcpPaymentStats,
} from "./mcp-payment.js";
import { createValueAcceptanceRegistry } from "./value-acceptance-registry.js";
import {
  negotiateForIncident,
  paymentNegotiationRequestSchema,
} from "./payment-negotiation.js";

const sseSessions = new Map();
const runtimeCache = new WeakMap();
const { version: PKG_VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));

function propToZod(prop = {}) {
  let base;
  if (prop.type === "integer") base = z.number().int();
  else if (prop.type === "number") base = z.number();
  else if (prop.type === "boolean") base = z.boolean();
  else if (prop.type === "array") base = z.array(propToZod(prop.items ?? { type: "string" }));
  else base = z.string();

  if (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.type === "string" && prop.enum.every(v => typeof v === "string")) {
    base = z.enum(prop.enum);
  }
  if (typeof prop.minimum === "number" && typeof base.min === "function") base = base.min(prop.minimum);
  if (typeof prop.maximum === "number" && typeof base.max === "function") base = base.max(prop.maximum);
  if (prop.description && typeof base.describe === "function") base = base.describe(prop.description);
  return base;
}

function buildZodShape(inputSchema) {
  const required = new Set(inputSchema?.required ?? []);
  const shape = {};
  for (const [key, prop] of Object.entries(inputSchema?.properties ?? {})) {
    const base = propToZod(prop);
    shape[key] = required.has(key) ? base : base.optional();
  }
  return shape;
}

async function createRuntime(capabilities) {
  const controller = await createMcpPaymentController(capabilities);
  const tools = [];

  for (const cap of capabilities) {
    const baseHandler = async (params) => {
      try {
        const result = await cap.handler(params, {});
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result && typeof result === "object" ? result : undefined,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${String(err?.message ?? err)}` }],
          isError: true,
        };
      }
    };

    tools.push({
      cap,
      inputSchema: buildZodShape(cap.inputSchema),
      handler: controller.wrap(cap, baseHandler),
      paid: controller.isPaid(cap.name),
    });
  }

  return {
    tools,
    mode: controller.mode,
    network: controller.network,
    capabilities,
    valueAcceptanceRegistry: createValueAcceptanceRegistry(),
  };
}

function getRuntime(capabilities) {
  if (!runtimeCache.has(capabilities)) {
    runtimeCache.set(capabilities, createRuntime(capabilities));
  }
  return runtimeCache.get(capabilities);
}

function buildServer(runtime, onDefinitions) {
  const server = new McpServer({ name: "The Stall", version: PKG_VERSION });
  const discoveryEntries = [];

  for (const { cap, inputSchema, handler, paid } of runtime.tools) {
    const paymentLabel = paid
      ? `PAID MCP TOOL — ${cap.price} USDC per successful call via native x402. Discovery is free.`
      : "FREE MCP TOOL.";
    const registered = server.registerTool(
      cap.name,
      {
        description: `${paymentLabel} ${cap.description}`,
        annotations: mcpToolDescriptor(cap).annotations,
        inputSchema,
      },
      handler,
    );
    discoveryEntries.push({ name: cap.name, registered, outputSchema: cap.outputSchema, rawInputSchema: cap.inputSchema });
  }

  const recoveryTool = server.registerTool(
    "stall-payment-negotiate",
    {
      description: "FREE deterministic payment recovery tool. Submit a rescue_id and only non-secret payment capability facts; receive the next VERIFIED_LIVE settlement challenge. Text cannot alter price, payTo, registry status, or security policy.",
      inputSchema: paymentNegotiationRequestSchema.shape,
    },
    async (params) => {
      const result = negotiateForIncident(params, {
        capabilities: runtime.capabilities,
        registry: runtime.valueAcceptanceRegistry,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.body, null, 2) }],
        structuredContent: result.body,
        isError: result.status !== 200,
      };
    },
  );

  discoveryEntries.push({ name: "stall-payment-negotiate", registered: recoveryTool });
  installToolDiscovery(server, discoveryEntries);
  if (onDefinitions) onDefinitions(serializeToolDefinitions(discoveryEntries));
  return server;
}

// Use the exact registration and serialization path without payment initialization
// or executable handlers. The card cannot invoke a component or recovery action.
export function getMcpToolDefinitions(capabilities) {
  const isPaid = createMcpPaidToolPredicate();
  const unavailable = async () => { throw new Error("Discovery-only registration"); };
  let definitions;
  const server = buildServer({
    capabilities,
    valueAcceptanceRegistry: null,
    tools: capabilities.map(cap => ({
      cap, inputSchema: buildZodShape(cap.inputSchema),
      handler: unavailable, paid: isPaid(cap.name),
    })),
  }, value => { definitions = value; });
  void server.close();
  return definitions;
}

export function makeSSEHandlers(capabilities) {
  async function connect(req, res) {
    try {
      const runtime = await getRuntime(capabilities);
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      const server = buildServer(runtime);
      sseSessions.set(sessionId, { transport, server });
      res.on("close", () => {
        sseSessions.delete(sessionId);
        server.close().catch(() => {});
      });
      await server.connect(transport);
    } catch (err) {
      console.error("[SSE] connect error:", err);
      if (!res.headersSent) res.status(500).end("SSE setup failed");
    }
  }

  async function message(req, res) {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
    const session = sseSessions.get(String(sessionId));
    if (!session) return res.status(404).json({ error: "Unknown session" });
    try {
      await runWithAttribution(
        req._observationContext,
        () => session.transport.handlePostMessage(req, res, req.body),
      );
    } catch (err) {
      console.error("[SSE] message error:", err);
      if (!res.headersSent) res.status(500).end("Message handling failed");
    }
  }

  return { connect, message };
}

export function makeMcpHandler(capabilities) {
  return async (req, res) => {
    const accept = String(req.headers.accept || "").toLowerCase();
    const ranges = accept.split(",").map(part => {
      const [type, ...params] = part.trim().split(";").map(value => value.trim());
      const raw = params.find(value => value.startsWith("q="))?.slice(2);
      const q = raw === undefined ? 1 : Number(raw);
      return { type, q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0 };
    });
    const quality = type => {
      for (const range of [type, type.split("/")[0] + "/*", "*/*"]) {
        const matches = ranges.filter(value => value.type === range);
        if (matches.length) return Math.max(...matches.map(value => value.q));
      }
      return 0;
    };
    const wantsJsonOnly = quality("application/json") > 0 && quality("text/event-stream") === 0;
    // The SDK requires both media types even when its JSON response mode is on.
    // Normalize only the transport-facing header; select the response from the
    // original client's preferences. Payment metadata and handlers are untouched.
    if (req.headers.accept !== "application/json, text/event-stream") {
      const normalized = "application/json, text/event-stream";
      req.headers.accept = normalized;
      const newRaw = [];
      let found = false;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === "accept") {
          newRaw.push("accept", normalized);
          found = true;
        } else {
          newRaw.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
        }
      }
      if (!found) newRaw.push("accept", normalized);
      req.rawHeaders = newRaw;
    }

    let server;
    let transport;
    try {
      const runtime = await getRuntime(capabilities);
      server = buildServer(runtime);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: wantsJsonOnly });
      await server.connect(transport);
      await runWithAttribution(
        req._observationContext,
        () => transport.handleRequest(req, res, req.body),
      );
      res.on("close", () => {
        Promise.resolve(transport.close()).catch(() => {});
        Promise.resolve(server.close()).catch(() => {});
      });
    } catch (err) {
      console.error("[MCP] request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };
}

export { getMcpPaymentMode, readMcpPaymentStats };
