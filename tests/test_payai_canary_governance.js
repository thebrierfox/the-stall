import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Import the real canary module with a deterministic forbidden-rail SDK double.
// Any attempt to load/initialize/use PayAI is observable; no network or payment.
async function loadCanary() {
  const counts = { sdkLoads: 0, sdkInitializations: 0, sdkCalls: 0 };
  const context = vm.createContext({ console: { log() {}, warn() {} } });
  const source = fs.readFileSync(new URL('../src/payai-canary.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, {
    context,
    initializeImportMeta(meta) { meta.url = 'file:///test/payai-canary.js'; },
  });
  await module.link(async (specifier) => {
    assert.equal(specifier, 'module', 'no additional dependency is allowed');
    return new vm.SyntheticModule(['createRequire'], function () {
      this.setExport('createRequire', () => (name) => {
        assert.equal(name, '@payai/agentic-payments/express');
        counts.sdkLoads++;
        return { agentPayments() {
          counts.sdkInitializations++;
          return (_req, res) => {
            counts.sdkCalls++;
            res.status(402).json({ accepts: [
              { network: 'eip155:8453' }, { network: 'eip155:137' },
              { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
            ] });
          };
        } };
      });
    }, { context });
  });
  await module.evaluate();
  return { build: module.namespace.buildPayAICanaryMiddleware, counts };
}

const capabilities = [{ name: 'ping', price: '$0.021', description: 'Synthetic ping' }];
function invoke(middleware, req) {
  let nextCount = 0;
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  // Compatibility callers must still delegate to the canonical x402 gate.
  middleware(req, res, () => {
    nextCount++;
    if (req.payment) return;
    res.status(402).json({ accepts: [{ network: 'eip155:8453', amount: '21000' }] });
  });
  return { nextCount, res };
}

for (const [name, method, path, headers] of [
  ['unpaid GET ping', 'GET', '/cap/ping', {}],
  ['unpaid POST ping', 'POST', '/cap/ping', {}],
  ['unpaid HEAD ping', 'HEAD', '/cap/ping', {}],
  ['OPTIONS ping', 'OPTIONS', '/cap/ping', {}],
  ['ping prefix lookalike', 'GET', '/cap/ping-other', {}],
  ['nested ping path', 'GET', '/cap/ping/child', {}],
  ['unrelated capability', 'GET', '/cap/market-gex', {}],
  ['native payment header', 'GET', '/cap/ping', { 'payment-signature': 'synthetic-only' }],
  ['legacy payment header', 'GET', '/cap/ping', { 'x-payment': 'synthetic-only' }],
]) {
  test(`${name}: no PayAI path and only canonical Base challenge`, async () => {
    const { build, counts } = await loadCanary();
    const req = { method, path, headers };
    const before = structuredClone(req);
    const { nextCount, res } = invoke(build(capabilities, 'synthetic-solana', 'synthetic-evm'), req);
    assert.equal(nextCount, 1);
    assert.equal(res.statusCode, 402);
    assert.deepEqual(res.body.accepts.map(x => x.network), ['eip155:8453']);
    assert.deepEqual(req, before, 'quarantine must not mark a request paid or mutate it');
    assert.deepEqual(counts, { sdkLoads: 0, sdkInitializations: 0, sdkCalls: 0 });
  });
}

test('multiple callers and wallet configurations cannot reactivate canary', async () => {
  const { build, counts } = await loadCanary();
  for (const args of [[capabilities, null, null], [[], 'sol', 'evm'], [capabilities, 'sol', null], [capabilities, null, 'evm']]) {
    const r = invoke(build(...args), { method: 'GET', path: '/cap/ping', headers: {} });
    assert.equal(r.nextCount, 1);
  }
  assert.deepEqual(counts, { sdkLoads: 0, sdkInitializations: 0, sdkCalls: 0 });
});

test('inert builder does not access configuration or request/response properties', async () => {
  const { build, counts } = await loadCanary();
  const inaccessible = new Proxy({}, { get() { throw new Error('unexpected access'); } });
  const middleware = build(inaccessible, inaccessible, inaccessible);
  let n = 0;
  middleware(inaccessible, inaccessible, () => { n++; });
  assert.equal(n, 1);
  assert.deepEqual(counts, { sdkLoads: 0, sdkInitializations: 0, sdkCalls: 0 });
});

test('next errors propagate without fallback retry or response', async () => {
  const { build } = await loadCanary();
  const expected = new Error('downstream-error');
  let n = 0;
  assert.throws(() => build(capabilities, 'sol', 'evm')({}, {}, () => { n++; throw expected; }), error => error === expected);
  assert.equal(n, 1);
});

test('actual server wrapper has no PayAI path and preserves only authorized exemptions', async () => {
  const { build, counts } = await loadCanary();
  const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /import\s*\{\s*buildPayAICanaryMiddleware/);
  assert.doesNotMatch(server, /payAICanaryMiddleware\s*\(/);
  const start = server.indexOf('app.use((req, res, next) => {\n  if (req.fiatPaid) return next();', server.indexOf('const x402Middleware'));
  assert.ok(start >= 0, 'payment-chain anchor must remain explicit');
  const end = server.indexOf('\n});', start) + '\n});'.length;
  assert.ok(end > start);
  let wrapper, x402 = 0, fulfilled = 0, allowInternal = false;
  const base = { accepts: [{ network: 'eip155:8453', amount: '21000' }] };
  vm.runInNewContext(server.slice(start, end), {
    app: { use(fn) { wrapper = fn; } },
    authorizeInternalRequest: () => ({ allowed: allowInternal, principal: 'synthetic-internal' }),
    payAICanaryMiddleware: build(capabilities, 'sol', 'evm'),
    x402Middleware: (_req, res) => { x402++; res.status(402).json(base); },
  });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  const req = { method: 'GET', path: '/cap/ping', headers: {} };
  wrapper(req, res, () => { fulfilled++; });
  assert.equal(x402, 1);
  assert.equal(fulfilled, 0, 'unpaid request must not reach fulfillment');
  assert.equal(res.code, 402);
  assert.deepEqual(res.body, base);
  for (const request of [
    { method: 'GET', path: '/cap/ping', headers: {}, payment: { forged: true } },
    { method: 'GET', path: '/cap/ping', headers: { 'payment-signature': 'synthetic-only' } },
    { method: 'GET', path: '/cap/ping-extra', headers: {} },
  ]) wrapper(request, res, () => { fulfilled++; });
  assert.equal(x402, 4, 'request payment property cannot replace canonical verification');
  assert.equal(fulfilled, 0);
  wrapper({ fiatPaid: true }, res, () => { fulfilled++; });
  assert.equal(x402, 4);
  assert.equal(fulfilled, 1);
  allowInternal = true;
  const internal = {};
  wrapper(internal, res, () => { fulfilled++; });
  assert.equal(x402, 4);
  assert.equal(fulfilled, 2);
  assert.equal(internal._internalBypass, true);
  assert.equal(internal._internalPrincipal, 'synthetic-internal');
  assert.deepEqual(counts, { sdkLoads: 0, sdkInitializations: 0, sdkCalls: 0 });
});
