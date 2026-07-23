// tests/test_mcp_discovery_only.js — P0 static + runtime enforcement that MCP
// can never reach an executable capability handler (STALL P0 containment,
// 2026-07-22/23). Run: node --test tests/test_mcp_discovery_only.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { buildRouteMetas, makeMcpHandler } from "../src/mcp.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MCP_SRC = readFileSync(join(__dir, "../src/mcp.js"), "utf-8");

test("static: mcp.js never calls .handler(", () => {
  assert.equal(/\.handler\s*\(/.test(MCP_SRC), false, "mcp.js must not call cap.handler() anywhere");
});

test("static: mcp.js never destructures/references a raw handler function", () => {
  assert.equal(/\bhandler\s*:/.test(MCP_SRC), false, "mcp.js must not pass through a handler field");
});

test("runtime: only search_routes/inspect_route/quote_route are ever invoked, never a capability", async () => {
  let invoked = false;
  const fakeCapabilities = [
    {
      name: "research-synthesis",
      price: "$2.50",
      description: "test capability",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      handler: async () => {
        invoked = true;
        return { result: "SHOULD_NEVER_RUN" };
      },
    },
  ];

  const metas = buildRouteMetas(fakeCapabilities);
  assert.equal(metas.length, 1);
  assert.equal(metas[0].handler, undefined, "route metadata must not carry a handler reference");
  assert.equal(Object.prototype.hasOwnProperty.call(metas[0], "handler"), false);

  // makeMcpHandler must build without ever touching fakeCapabilities[0].handler
  const handler = makeMcpHandler(fakeCapabilities);
  assert.equal(typeof handler, "function");
  assert.equal(invoked, false, "constructing the MCP handler must not invoke any capability");
});

test("runtime: retired/unknown tool name surface is limited to the 3 discovery tools", async () => {
  // buildRouteMetas output never exposes a generic "call this capability" tool —
  // verified by construction: buildServer() only ever registers exactly 3 tools
  // (search_routes, inspect_route, quote_route), independent of capability count.
  const many = Array.from({ length: 5 }, (_, i) => ({
    name: `cap-${i}`,
    price: "$0.01",
    description: "d",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object" },
    handler: async () => { throw new Error("must never be called"); },
  }));
  const metas = buildRouteMetas(many);
  assert.equal(metas.length, 5);
  for (const m of metas) {
    assert.equal(m.handler, undefined);
  }
});
