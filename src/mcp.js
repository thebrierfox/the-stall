// mcp.js — MCP discovery-only transport for The Stall
//
// P0 containment (2026-07-22/23): MCP previously registered every capability
// as an executable tool and invoked its handler function directly with no
// payment gate, bypassing paid REST billing entirely. MCP must NEVER be able
// to reach an executable capability handler again.
//
// This module exposes exactly three read-only discovery tools:
//   search_routes(query?, category?, limit?)
//   inspect_route(name)
//   quote_route(name)
// They return route metadata only (name/path/price/schema/category). They
// never invoke a capability's handler function, never call an upstream provider, never submit or
// verify payment, and never return a capability result. Paid execution stays
// on the existing payment-gated REST endpoints at /cap/:name.

import { readFileSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

// Session store for SSE connections (in-memory, per-process)
const sseSessions = new Map();

const { version: PKG_VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));

const BASE_URL = process.env.BASE_URL || "https://the-stall.intuitek.ai";

// Same grouping used by /llms.txt (src/server.js) for human-facing category
// labels. Kept as a local, sanitized copy — no reference back to server.js
// internals or executable capability objects.
const CATEGORY_DEFS = [
  { name: "Finance & Markets", re: /stock|equity|market|earning|dividend|etf|option|insider|institutional|sector|treasury|credit|hedge|short|fec|ipo|form-144|fomc|fed|fiscal|econ|labor|consumer|housing|intl-stock|global-equity|forex|analyst|income-state|company-|concentration|currency-format|lbo|manufacturing|job-search|intel-pack|limitless|analyst-rating|wacc/i },
  { name: "Crypto & DeFi", re: /crypto|defi|btc|eth|token|wallet|nft|solana|dex|chain|block|tx|evm|erc20|ens|gas|defillama|kimchi|korean|stablecoin|yield-farm|whale|funding|base-season/i },
  { name: "Prediction Markets", re: /polymarket|prediction|sports/i },
  { name: "News & Research", re: /news|research|arxiv|reddit|hn|rss|social|fact-check|wikipedia|stackoverflow|github-repo|github-org|citation/i },
  { name: "AI & Compute", re: /ai-image|audio|vision|meme|generate|hf-model|code|content-|roast|image-detect|document-qa|classic-novel|llm/i },
  { name: "Infrastructure & Data", re: /dns|ip-intel|ssl|http|ping|agent-access|geo|city|place|domain|email-verify|npm|pypi|json|regex|unit|timezone|cron|page-intel|page-links|readable|web-scrape|web-change|web-company|wayback|breadcrumb|dictionary|changelog-gen|db-perf/i },
  { name: "On-chain Risk & Compliance", re: /sanctions|wallet-credit|wallet-screener|address-security|agent-kya|kya|cve|drug-intel|npi|clinical|fda/i },
  { name: "Macro & Alternative Data", re: /macro|imf|world-bank|commodity|energy|solar|earthquake|usgs|weather|air-quality|aviation|flight|legal|gov-vote|congressional|federal-contract|federal-register|country-info|chromatic|sport-predict/i },
  { name: "Social & Video Intelligence", re: /youtube|twitter-intel|github-trending|podcast/i },
];

function categoryFor(name) {
  for (const { name: label, re } of CATEGORY_DEFS) {
    if (re.test(name)) return label;
  }
  return "Other";
}

// Build sanitized, non-executable route metadata from the live capability
// registry. Only plain data crosses this boundary — no `handler` reference,
// no function, nothing MCP could invoke.
export function buildRouteMetas(capabilities) {
  return capabilities.map((c) => ({
    name: c.name,
    path: `/cap/${c.name}`,
    url: `${BASE_URL}/cap/${c.name}`,
    description: c.description,
    category: categoryFor(c.name),
    price: c.price,
    inputSchema: c.inputSchema,
    outputSchema: c.outputSchema,
  }));
}

// Build a fresh McpServer exposing only discovery/inspection/quote tools.
// Called once per request (stateless transport requires fresh server per request).
function buildServer(routeMetas) {
  const server = new McpServer({ name: "The Stall", version: PKG_VERSION });

  server.registerTool(
    "search_routes",
    {
      description:
        "Search The Stall's paid capability catalog by keyword and/or category. Returns route metadata only (name, path, price, schema) — never a capability result. Pay and call the returned path to execute.",
      inputSchema: {
        query: z.string().optional().describe("Keyword to match against route name/description."),
        category: z.string().optional().describe("Optional exact category filter, e.g. 'Finance & Markets'."),
        limit: z.number().int().min(1).max(200).optional().describe("Max results to return. Default 25, max 200."),
      },
    },
    async ({ query, category, limit }) => {
      const q = (query || "").toLowerCase().trim();
      const cat = (category || "").toLowerCase().trim();
      let results = routeMetas.filter((r) => {
        const matchesQuery =
          !q || r.name.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q);
        const matchesCategory = !cat || r.category.toLowerCase() === cat;
        return matchesQuery && matchesCategory;
      });
      const capped = Math.min(200, Math.max(1, Number(limit) || 25));
      results = results.slice(0, capped);
      return {
        content: [{ type: "text", text: JSON.stringify({ count: results.length, routes: results }, null, 2) }],
      };
    }
  );

  server.registerTool(
    "inspect_route",
    {
      description:
        "Get full metadata for one The Stall route by name: description, category, price, input/output schema. Returns metadata only — never a capability result.",
      inputSchema: { name: z.string().describe("Route name, e.g. 'us-stock-price'.") },
    },
    async ({ name }) => {
      const meta = routeMetas.find((r) => r.name === name);
      if (!meta) {
        return { content: [{ type: "text", text: `Route not found: ${name}` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(meta, null, 2) }] };
    }
  );

  server.registerTool(
    "quote_route",
    {
      description:
        "Get the current price and paid-execution URL for one The Stall route. Does not execute the route or return a capability result — pay and call the returned url to execute.",
      inputSchema: { name: z.string().describe("Route name, e.g. 'us-stock-price'.") },
    },
    async ({ name }) => {
      const meta = routeMetas.find((r) => r.name === name);
      if (!meta) {
        return { content: [{ type: "text", text: `Route not found: ${name}` }], isError: true };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { name: meta.name, price: meta.price, path: meta.path, url: meta.url, network: "eip155:8453" },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

// Returns handlers for SSE transport.
//   app.get("/sse", handlers.connect)
//   app.post("/messages", handlers.message)
export function makeSSEHandlers(capabilities) {
  const routeMetas = buildRouteMetas(capabilities);

  async function connect(req, res) {
    try {
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      const server = buildServer(routeMetas);
      sseSessions.set(sessionId, { transport, server });
      res.on("close", () => {
        sseSessions.delete(sessionId);
        server.close().catch(() => {});
      });
      await server.connect(transport); // also calls transport.start()
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
      await session.transport.handlePostMessage(req, res, req.body);
    } catch (err) {
      console.error("[SSE] message error:", err);
      if (!res.headersSent) res.status(500).end("Message handling failed");
    }
  }

  return { connect, message };
}

// Returns an Express request handler for POST /mcp.
// Attach with: app.post("/mcp", makeMcpHandler(capabilities))
export function makeMcpHandler(capabilities) {
  const routeMetas = buildRouteMetas(capabilities);

  return async (req, res) => {
    // Normalize Accept header — the MCP SDK requires both "application/json" and
    // "text/event-stream" as literal substrings (it uses string.includes, not proper
    // content negotiation). Crawlers often send Accept: */* or omit the header entirely.
    // Only normalize when the client does NOT explicitly prefer JSON-only — conformance
    // checkers that send Accept: application/json (no SSE) expect a JSON body response,
    // not SSE. Overriding their preference causes conformance failures.
    const accept = req.headers["accept"] || "";
    const wantsJsonOnly = accept.includes("application/json") && !accept.includes("text/event-stream") && !accept.includes("*/*");
    if (!wantsJsonOnly && (!accept.includes("application/json") || !accept.includes("text/event-stream"))) {
      const normalized = "application/json, text/event-stream";
      req.headers["accept"] = normalized;
      // Replace rawHeaders so @hono/node-server sees the correct Accept value
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
    const server = buildServer(routeMetas);
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
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
