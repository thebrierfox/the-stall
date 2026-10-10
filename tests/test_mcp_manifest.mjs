import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BASELINE, canonicalJson, canonicalTools, compare, observation, recordComparison, toolsFromResponse, validateSnapshot, writeSnapshot } from '../scripts/mcp-manifest.mjs';

const endpoint = 'https://example.invalid/mcp';
const tool = name => ({ name, description: 'PAID — $0.05', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } });
const capture = tools => observation(tools, { endpoint, observedAt: '2026-10-10T00:00:00Z', responseSha256: 'synthetic-response' });
const baseline = tools => ({ ...capture(tools), release: { id: 'synthetic-v1', reason: 'fixture' } });
const response = tools => ({ jsonrpc: '2.0', id: 2, result: { tools } });

test('canonical JSON has a fixed nested UTF-8 vector', () => {
  assert.equal(canonicalJson({ z: 'é —', a: { z: 2, a: 1 }, list: [2, 1] }), '{"a":{"a":1,"z":2},"list":[2,1],"z":"é —"}');
  assert.equal(canonicalJson(JSON.parse('{"10":1,"2":2}')), '{"10":1,"2":2}');
});
test('object keys and tool ordering do not cause false drift', () => {
  const before = baseline([tool('a'), tool('b')]);
  const reordered = [tool('b'), tool('a')].map(t => ({ inputSchema: t.inputSchema, description: t.description, name: t.name }));
  assert.equal(compare(before, capture(reordered)).matches, true);
});
test('same-count replacement reports added and removed names', () => {
  const diff = compare(baseline([tool('a')]), capture([tool('b')]));
  assert.deepEqual(diff.added, ['b']); assert.deepEqual(diff.removed, ['a']);
  assert.equal(diff.status, 'unreviewed-interface-change');
});
for (const [field, mutate, path] of [
  ['description', t => t.description += ' changed', '/description'],
  ['input schema', t => t.inputSchema.properties.symbol.type = 'number', '/inputSchema/properties/symbol/type'],
  ['required array', t => t.inputSchema.required = [], '/inputSchema/required'],
  ['output schema', t => t.outputSchema = { type: 'object' }, '/outputSchema'],
  ['annotations', t => t.annotations = { readOnlyHint: false }, '/annotations'],
  ['execution', t => t.execution = { taskSupport: 'forbidden' }, '/execution'],
  ['unknown metadata', t => t._meta = { new: true }, '/_meta'],
]) test(`${field} drift is detected at unchanged count, with old/new evidence`, () => {
  const changed = tool('a'); mutate(changed);
  const diff = compare(baseline([tool('a')]), capture([changed]));
  assert.equal(diff.matches, false); assert.equal(diff.changed[0].name, 'a');
  assert.equal(diff.changed[0].changes[0].path, path);
  assert.ok(Object.hasOwn(diff.changed[0].changes[0], 'after'));
});
test('missing and null fields are different; pointers escape slash and tilde', () => {
  const before = tool('a'); before._meta = { 'x/y~z': null };
  const after = tool('a'); after._meta = {};
  assert.deepEqual(compare(baseline([before]), capture([after])).changed[0].changes, [{ path: '/_meta/x~1y~0z', kind: 'removed', before: null }]);
});
for (const [name, value] of [['missing', undefined], ['empty', []], ['duplicate', [tool('a'), tool('a')]], ['bad name', [{ ...tool('a'), name: '' }]], ['missing schema', [{ name: 'a', description: 'x' }]]]) {
  test(`reject ${name} tool arrays instead of accepting a new baseline`, () => assert.throws(() => canonicalTools(value)));
}
test('reject JSON-RPC errors, wrong IDs and incomplete paginated captures', () => {
  for (const bad of [{ error: { message: 'failure' } }, { ...response([tool('a')]), id: 99 }, { ...response([tool('a')]), result: { tools: [tool('a')], nextCursor: 'next' } }]) assert.throws(() => toolsFromResponse(bad));
  assert.deepEqual(toolsFromResponse(response([tool('a')])), [tool('a')]);
});
test('reject tampered baseline, wrong endpoint, and silent approval', () => {
  const before = baseline([tool('a')]);
  assert.throws(() => validateSnapshot({ ...before, toolsSha256: 'bad' }), /hash mismatch/);
  assert.throws(() => compare(before, { ...capture([tool('a')]), endpoint: 'https://other.invalid/mcp' }), /different endpoint/);
  assert.throws(() => compare(capture([tool('a')]), capture([tool('a')])), /release id/);
});
test('evidence persists full manifests and differences before a caller fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stall-manifest-'));
  try {
    const changed = tool('a'); changed.description = 'changed';
    const diff = recordComparison(baseline([tool('a')]), capture([changed]), dir);
    assert.equal(diff.matches, false);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'diff.json'), 'utf8')), diff);
    assert.deepEqual(validateSnapshot(JSON.parse(readFileSync(join(dir, 'observed.json'), 'utf8'))).tools, [changed]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('baseline CLI requires a release reason; explicit update preserves the prior snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stall-release-'));
  const script = new URL('../scripts/mcp-manifest.mjs', import.meta.url).pathname;
  try {
    const before = join(dir, 'old.json'), observed = join(dir, 'observed.json'), next = join(dir, 'next.json');
    writeSnapshot(before, baseline([tool('a')]));
    const changed = tool('a'); changed.description = 'intentional release';
    writeSnapshot(observed, capture([changed]));
    assert.equal(spawnSync(process.execPath, [script, 'compare', before, observed]).status, 1);
    assert.notEqual(spawnSync(process.execPath, [script, 'baseline', observed, next, 'v2']).status, 0);
    assert.equal(spawnSync(process.execPath, [script, 'baseline', observed, next, 'v2', 'Reviewed description change']).status, 0);
    assert.equal(spawnSync(process.execPath, [script, 'compare', next, observed]).status, 0);
    assert.equal(JSON.parse(readFileSync(before, 'utf8')).tools[0].description, 'PAID — $0.05');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('checked-in live baseline has intact full definitions and capture provenance', () => {
  const snapshot = validateSnapshot(JSON.parse(readFileSync(BASELINE, 'utf8')));
  assert.equal(snapshot.toolCount, 302);
  assert.equal(snapshot.endpoint, 'https://the-stall.intuitek.ai/mcp');
  assert.ok(snapshot.observedAt && snapshot.responseSha256 && snapshot.release?.reason);
  assert.ok(snapshot.tools.find(t => t.name === 'balance-sheet')?.inputSchema);
});
test('full live verifier fails on same-count drift and retains evidence without calling a tool', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stall-verifier-'));
  try {
    mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'manifests'));
    for (const name of ['verify-live.mjs', 'mcp-manifest.mjs']) copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(dir, 'scripts', name));
    copyFileSync(BASELINE, join(dir, 'manifests', 'mcp-tools.json'));
    const preload = join(dir, 'synthetic-fetch.mjs');
    writeFileSync(preload, `
      import { readFileSync } from 'node:fs';
      const snapshot = JSON.parse(readFileSync(new URL('./manifests/mcp-tools.json', import.meta.url)));
      snapshot.tools[0].description += ' synthetic drift';
      const capabilities = Array.from({length:301}, () => ({name:'balance-sheet',price:'$0.021'}));
      const payment = {x402Version:2,accepts:[{scheme:'exact',network:'eip155:8453',asset:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',payTo:'0x03d773c52b67993e60ecb3134b17436fe03b584c',amount:'21000'}]};
      globalThis.fetch = async (url, options={}) => {
        const path = new URL(url).pathname;
        let body={}, status=200, headers={};
        if (path === '/health') body={ok:true,capabilities};
        else if (path === '/catalog') body={capabilities};
        else if (path === '/.well-known/x402') body={resources:capabilities,payTo:payment.accepts[0].payTo};
        else if (path === '/cap/balance-sheet') {status=402;headers={'payment-required':Buffer.from(JSON.stringify(payment)).toString('base64')};}
        else if (path === '/mcp') {
          const request=JSON.parse(options.body);
          if (request.method === 'tools/call') throw new Error('Unexpected tool execution request');
          body={jsonrpc:'2.0',id:request.id,result:request.method === 'initialize' ? {serverInfo:{name:'The Stall'}} : {tools:snapshot.tools}};
        } else if (path !== '/.well-known/agent.json') throw new Error('Unexpected endpoint');
        return new Response(JSON.stringify(body),{status,headers});
      };
    `);
    const result = spawnSync(process.execPath, ['--import', preload, join(dir, 'scripts', 'verify-live.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MCP interface differs/);
    assert.doesNotMatch(result.stderr, /Unexpected tool execution/);
    const diff = JSON.parse(readFileSync(join(dir, '.artifacts', 'mcp-manifest', 'diff.json'), 'utf8'));
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0].changes[0].path, '/description');
    assert.equal(JSON.parse(readFileSync(join(dir, '.artifacts', 'mcp-manifest', 'observed.json'), 'utf8')).toolCount, 302);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
