#!/usr/bin/env node
// Run after deployment. The default path performs a zero-spend challenge test.
// A real settlement test requires MCP_LIVE_TEST=1 and EVM_PRIVATE_KEY.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { extractPaymentRequired } from "./lib/payment-required.mjs";

const base = process.env.STALL_BASE_URL || "https://the-stall.intuitek.ai";
const toolName = process.env.MCP_TEST_TOOL || "market-overview";
const args = JSON.parse(process.env.MCP_TEST_ARGS || "{}");

async function noSpendTest() {
  const client = new Client({ name: "stall-floodgate-verifier", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  await client.connect(transport);
  const listed = await client.listTools();
  const target = listed.tools.find(t => t.name === toolName);
  if (!target) throw new Error(`tool not discoverable: ${toolName}`);
  const result = await client.callTool({ name: toolName, arguments: args });
  const paymentRequired = extractPaymentRequired(result);
  if (!result.isError || !Array.isArray(paymentRequired?.accepts) || paymentRequired.accepts.length === 0) {
    throw new Error(`expected native x402 payment requirement for ${toolName}`);
  }
  await client.close();
  return { discovery_free: true, paid_tool_challenge: true, tool: toolName };
}

const first = await noSpendTest();
console.log(JSON.stringify(first, null, 2));

if (process.env.MCP_LIVE_TEST === "1") {
  if (!process.env.EVM_PRIVATE_KEY) throw new Error("EVM_PRIVATE_KEY required for MCP_LIVE_TEST=1");
  const [mcpModule, { ExactEvmScheme }, { privateKeyToAccount }] = await Promise.all([
    import("@x402/mcp"),
    import("@x402/evm/exact/client"),
    import("viem/accounts"),
  ]);
  const createPaidMcpClient = mcpModule.createx402MCPClient ?? mcpModule.createX402MCPClient;
  if (!createPaidMcpClient) throw new Error("@x402/mcp paid client factory export not found");
  const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
  const paidClient = createPaidMcpClient({
    name: "stall-funded-verifier",
    version: "1.0.0",
    schemes: [{
      network: process.env.MCP_TEST_NETWORK || "eip155:8453",
      client: new ExactEvmScheme(account),
    }],
    autoPayment: true,
    onPaymentRequested: async () => true,
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  await paidClient.connect(transport);
  const result = await paidClient.callTool(toolName, args);
  if (!result.paymentMade) throw new Error("tool returned without a recorded x402 payment");
  console.log(JSON.stringify({
    paid_tool: toolName,
    payment_made: result.paymentMade,
    transaction: result.paymentResponse?.transaction || null,
    network: result.paymentResponse?.network || null,
  }, null, 2));
  await paidClient.close();
}
