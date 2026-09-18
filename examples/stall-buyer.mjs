#!/usr/bin/env node
// IntuiTek¹ / W. Kyle Million. Client-side entry point; never changes seller gates.
// Quote mode creates no signer. Paid mode requires an operator-owned wallet,
// a fixed ceiling and an exclusive durable receipt file for this logical call.
import { openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const BASE = 'https://the-stall.intuitek.ai';
export const PAYEE = '0x03d773c52b67993e60ecb3134b17436fe03b584c';
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const NETWORK = 'eip155:8453';
function fail(code) { const error = new Error(code); error.code = code; throw error; }
export function atoms(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) fail('INVALID_USDC_CEILING');
  const [whole, part = ''] = value.split('.');
  const amount = BigInt(whole) * 1000000n + BigInt(part.padEnd(6, '0'));
  if (amount <= 0n) fail('INVALID_USDC_CEILING');
  return amount;
}
export function validateQuote(paymentRequired, tool, ceiling) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tool)) fail('INVALID_TOOL');
  if (paymentRequired?.x402Version !== 2) fail('UNSUPPORTED_PAYMENT_VERSION');
  if (paymentRequired?.resource?.url !== `mcp://tool/${tool}`) fail('RESOURCE_MISMATCH');
  if (!Array.isArray(paymentRequired.accepts) || paymentRequired.accepts.length !== 1) fail('AMBIGUOUS_PAYMENT_OFFERS');
  const offer = paymentRequired.accepts[0];
  if (offer.scheme !== 'exact' || offer.network !== NETWORK) fail('UNSUPPORTED_SCHEME_OR_NETWORK');
  if (String(offer.asset).toLowerCase() !== USDC || String(offer.payTo).toLowerCase() !== PAYEE) fail('ASSET_OR_RECIPIENT_MISMATCH');
  if (typeof offer.amount !== 'string' || !/^[1-9]\d*$/.test(offer.amount)) fail('INVALID_PAYMENT_AMOUNT');
  if (BigInt(offer.amount) > atoms(ceiling)) fail('BUDGET_EXCEEDED');
  if (!Number.isInteger(offer.maxTimeoutSeconds) || offer.maxTimeoutSeconds <= 0 || offer.maxTimeoutSeconds > 300) fail('UNSUPPORTED_AUTHORIZATION_WINDOW');
  if (offer.extra?.name !== 'USD Coin' || offer.extra?.version !== '2') fail('UNSUPPORTED_TOKEN_DOMAIN');
  return { amount_atoms: offer.amount, asset: USDC, payee: PAYEE, network: NETWORK, tool };
}
export function extractQuote(result) {
  if (result?.structuredContent?.x402Version === 2) return result.structuredContent;
  for (const entry of result?.content ?? []) {
    if (entry.type !== 'text') continue;
    try { const value = JSON.parse(entry.text); if (value?.x402Version === 2) return value; } catch {}
  }
  fail('PAYMENT_CHALLENGE_NOT_FOUND');
}
export function reserveReceipt(path, facts) {
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') fail('RECEIPT_EXISTS_NO_AUTOMATIC_RETRY'); throw e; }
  try { writeFileSync(fd, JSON.stringify({ phase: 'authorization_reserved', ...facts, observed_at: new Date().toISOString() }) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
}
export function makePaymentGate({ tool, ceiling, receiptPath }) {
  atoms(ceiling);
  if (typeof receiptPath !== 'string' || !receiptPath) fail('RECEIPT_PATH_REQUIRED');
  let reserved = false;
  return async ({ paymentRequired }) => {
    if (reserved) fail('SECOND_AUTHORIZATION_BLOCKED');
    const facts = validateQuote(paymentRequired, tool, ceiling);
    reserveReceipt(receiptPath, facts);
    reserved = true;
    return true;
  };
}
export function validateSettlement(result) {
  const receipt = result?.paymentResponse;
  if (result?.paymentMade !== true || receipt?.success !== true || receipt?.network !== NETWORK || !/^0x[0-9a-fA-F]{64}$/.test(receipt?.transaction ?? '')) fail('SETTLEMENT_NOT_CONFIRMED_NO_AUTOMATIC_RETRY');
  if (result.isError === true) fail('PAID_TOOL_ERROR_NO_AUTOMATIC_RETRY');
  return { phase: 'settlement_reported', transaction: receipt.transaction, network: receipt.network,
    independently_chain_verified: false, observed_at: new Date().toISOString() };
}
export async function quote(tool, args) {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  const client = new Client({ name: 'stall-buyer-quote', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
    const result = await client.callTool({ name: tool, arguments: args });
    if (result.isError !== true) fail('EXPECTED_UNPAID_CHALLENGE');
    return { mode: 'quote', payment_made: false, paymentRequired: extractQuote(result) };
  } finally { await client.close(); }
}
export async function buy(tool, args, { ceiling, receiptPath, privateKey }) {
  const gate = makePaymentGate({ tool, ceiling, receiptPath });
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '')) fail('BUYER_PRIVATE_KEY_REQUIRED');
  const [mcp, { ExactEvmScheme }, { privateKeyToAccount }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@x402/mcp'), import('@x402/evm/exact/client'), import('viem/accounts'), import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  const factory = mcp.createX402MCPClient ?? mcp.createx402MCPClient;
  if (!factory) fail('SDK_FACTORY_UNAVAILABLE');
  const client = factory({ name: 'stall-budgeted-buyer', version: '1.0.0',
    schemes: [{ network: NETWORK, client: new ExactEvmScheme(privateKeyToAccount(privateKey)) }],
    autoPayment: true, onPaymentRequested: gate });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
    const result = await client.callTool(tool, args);
    const receipt = validateSettlement(result);
    // Keep the reservation file intact even if receipt writing or network completion fails.
    const fd = openSync(receiptPath, 'a');
    try { writeFileSync(fd, JSON.stringify(receipt) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    return { receipt, content: result.content, structuredContent: result.structuredContent };
  } finally { await client.close(); }
}
async function main() {
  const [mode = 'quote', tool = 'earnings-calendar', argText = '{}', ceiling, receiptPath] = process.argv.slice(2);
  if (!['quote', 'pay'].includes(mode) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tool)) fail('INVALID_COMMAND');
  if (Buffer.byteLength(argText) > 16384) fail('ARGUMENTS_TOO_LARGE');
  const args = JSON.parse(argText);
  if (!args || Array.isArray(args) || typeof args !== 'object') fail('ARGUMENTS_MUST_BE_OBJECT');
  const result = mode === 'quote' ? await quote(tool, args) : await buy(tool, args, {
    ceiling, receiptPath, privateKey: process.env.STALL_BUYER_PRIVATE_KEY,
  });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ error: error.code ?? 'BUYER_OPERATION_FAILED',
    automatic_retry: false, note: 'After any payment attempt, reconcile the existing receipt and wallet before retrying. Never log signing material.' })); process.exitCode = 1; });
}
