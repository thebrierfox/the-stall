import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const base = 'https://the-stall.intuitek.ai';
const expected = {
  paidCapabilities: 301,
  mcpTools: 302,
  network: 'eip155:8453',
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  payTo: '0x03d773c52b67993e60ecb3134b17436fe03b584c',
  balanceSheetAtoms: '21000',
};

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
    ...options,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let json = null;
  try { json = JSON.parse(bytes.toString('utf8')); } catch {}
  return { response, bytes, json, sha256: hash(bytes) };
}

function decodePaymentRequired(response) {
  const encoded = response.headers.get('payment-required');
  assert.ok(encoded, 'PAYMENT-REQUIRED header is missing');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

async function mcp(id, method, params = {}) {
  const result = await request('/mcp', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  assert.equal(result.response.status, 200, `${method} HTTP status`);
  return result;
}

const health = await request('/health');
assert.equal(health.response.status, 200);
assert.equal(health.json?.ok, true);
assert.equal(health.json?.capabilities?.length, expected.paidCapabilities);

const catalog = await request('/catalog');
assert.equal(catalog.response.status, 200);
assert.equal(catalog.json?.capabilities?.length, expected.paidCapabilities);
const balanceSheet = catalog.json.capabilities.find((capability) => capability.name === 'balance-sheet');
assert.equal(balanceSheet?.price, '$0.021');

const agent = await request('/.well-known/agent.json');
assert.equal(agent.response.status, 200);
const manifest = await request('/.well-known/x402');
assert.equal(manifest.response.status, 200);
assert.equal(manifest.json?.resources?.length, expected.paidCapabilities);
assert.equal(String(manifest.json?.payTo).toLowerCase(), expected.payTo);

const challenge = await request('/cap/balance-sheet?ticker=AAPL');
assert.equal(challenge.response.status, 402);
const payment = decodePaymentRequired(challenge.response);
assert.equal(payment.x402Version, 2);
assert.equal(payment.accepts?.length, 1);
assert.equal(payment.accepts[0].scheme, 'exact');
assert.equal(payment.accepts[0].network, expected.network);
assert.equal(String(payment.accepts[0].asset).toLowerCase(), expected.asset);
assert.equal(String(payment.accepts[0].payTo).toLowerCase(), expected.payTo);
assert.equal(payment.accepts[0].amount, expected.balanceSheetAtoms);

const initialized = await mcp(1, 'initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'stall-public-verifier', version: '1' },
});
assert.equal(initialized.json?.result?.serverInfo?.name, 'The Stall');

const listed = await mcp(2, 'tools/list');
assert.equal(listed.json?.result?.tools?.length, expected.mcpTools);
assert.ok(listed.json.result.tools.some((tool) => tool.name === 'balance-sheet'));

const denied = await mcp(3, 'tools/call', { name: 'balance-sheet', arguments: { ticker: 'AAPL' } });
assert.equal(denied.json?.result?.isError, true);
const mcpPayment = denied.json?.result?.structuredContent;
assert.equal(mcpPayment?.x402Version, 2);
assert.equal(mcpPayment?.accepts?.[0]?.amount, expected.balanceSheetAtoms);
assert.equal(String(mcpPayment?.accepts?.[0]?.payTo).toLowerCase(), expected.payTo);

console.log(JSON.stringify({
  ok: true,
  observedAt: new Date().toISOString(),
  health: { status: health.response.status, sha256: health.sha256, capabilities: expected.paidCapabilities },
  catalog: { status: catalog.response.status, sha256: catalog.sha256, capabilities: expected.paidCapabilities },
  discovery: { agentCard: agent.response.status, x402: manifest.response.status, resources: expected.paidCapabilities },
  unpaidHttp: { status: challenge.response.status, amount: expected.balanceSheetAtoms, payTo: expected.payTo },
  mcp: { initialize: initialized.response.status, tools: expected.mcpTools, unpaidCallIsError: true },
}, null, 2));
