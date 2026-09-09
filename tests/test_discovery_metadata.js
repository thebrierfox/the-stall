import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { loadCapabilities, loadDisabledCapabilities } from '../src/registry.js';
import { applyReviewedDiscoveryMetadata, DISCOVERY_GUIDANCE } from '../src/discovery-metadata.js';
import { openApiPaymentInfo } from '../src/openapi-payment-info.js';

let fetchCalls = 0;
globalThis.fetch = () => { fetchCalls++; throw new Error('network forbidden in metadata tests'); };
const manifest = JSON.parse(readFileSync(new URL('../config/discovery-metadata.v2.json', import.meta.url)));
const changes = manifest.changes.filter(c => c.path);
const disabled = loadDisabledCapabilities();
const rawCaps = [];
for (const file of readdirSync(new URL('../capabilities/', import.meta.url)).filter(f => f.endsWith('.js') && !f.startsWith('_'))) {
  const cap = (await import(new URL(`../capabilities/${file}`, import.meta.url))).default;
  if (!disabled.has(cap.name)) rawCaps.push(cap);
}
const servedCaps = await loadCapabilities();
const raw = new Map(rawCaps.map(c => [c.name, c]));
const served = new Map(servedCaps.map(c => [c.name, c]));
const hash = text => createHash('sha256').update(text).digest('hex');

for (const change of changes) {
  test(`exact reviewed description and immutable contract: ${change.path}`, () => {
    const name = change.path.slice('/cap/'.length), before = raw.get(name), after = served.get(name);
    assert.ok(before && after);
    assert.equal(hash(before.description), change.before_text_sha256);
    assert.equal(before.price, `$${change.expected_declared_price.amount}`);
    assert.equal(after.description, change.after);
    assert.deepEqual({ ...after, description: before.description }, before);
    assert.equal(after.handler, before.handler);
    assert.equal(after.inputSchema, before.inputSchema);
    assert.equal(after.outputSchema, before.outputSchema);
    assert.equal(applyReviewedDiscoveryMetadata(after), after);
  });
}
test('unknown capability and competitor amounts remain byte-for-byte untouched', () => {
  const cap = { name: 'unreviewed-test', price: '$0.021', description: 'Competitor charges $19.99; bare $0.009 is source copy.' };
  assert.equal(applyReviewedDiscoveryMetadata(cap), cap);
});
test('price drift preserves original object and reports exact reason', () => {
  const cap = { ...raw.get('federal-register-search'), price: '$0.777' }, reports=[];
  assert.equal(applyReviewedDiscoveryMetadata(cap, (...r) => reports.push(r)), cap);
  assert.deepEqual(reports, [['federal-register-search','declared price drift']]);
});
test('newer source copy is not overwritten', () => {
  const cap = { ...raw.get('balance-sheet'), description: 'Newer independently reviewed truth.' }, reports=[];
  assert.equal(applyReviewedDiscoveryMetadata(cap, (...r) => reports.push(r)), cap);
  assert.deepEqual(reports, [['balance-sheet','source description drift']]);
});
test('malformed source description does not crash or alter capabilities', () => {
  const cap = { ...raw.get('balance-sheet'), description: null };
  assert.equal(applyReviewedDiscoveryMetadata(cap, () => {}), cap);
});
test('all unlisted capabilities and disabled list remain unchanged', () => {
  assert.deepEqual([...served.keys()], [...raw.keys()]);
  assert.equal(servedCaps.length, 301);
  for (const cap of rawCaps) if (!changes.some(c => c.path === `/cap/${cap.name}`)) assert.equal(served.get(cap.name),cap);
  assert.ok(disabled.has('us-stock-price') && disabled.has('youtube-transcript'));
  assert.ok(!served.has('us-stock-price') && !served.has('youtube-transcript'));
});
function generatedOpenApi(caps) {
  const source = readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const section = source.slice(source.indexOf('function inputSchemaToParams('),source.indexOf('// ── x402 Discovery document'));
  let handler, result;
  const context = { capabilities:caps, DISCOVERY_GUIDANCE, PKG_VERSION:'4.97.0', BASE_URL:'https://the-stall.intuitek.ai', PAY_TO:'test-public-payto',
    RESEARCH_FUNNEL_ROLES: {'research-paper-search':'discovery','github-intel':'discovery','research-synthesis':'synthesis'},
    valueAcceptanceRegistry:{rails:[{status:'VERIFIED_LIVE',protocol:'x402',method_id:'base-usdc',network:'eip155:8453',scheme:'exact',asset_currency:'USDC'}]},
    openApiPaymentInfo, app:{get:(path,fn)=>{assert.equal(path,'/openapi.json');handler=fn;}} };
  vm.runInNewContext(section,context,{timeout:2000});
  handler({}, {json:value=>{result=JSON.parse(JSON.stringify(value));}});
  return result;
}
test('actual serving OpenAPI builder changes exactly 49 summaries plus guidance', () => {
  const before = generatedOpenApi(rawCaps), after = generatedOpenApi(servedCaps);
  delete before.info['x-guidance'];
  assert.equal(Object.keys(after.paths).length,312);
  assert.equal(after.info['x-guidance'],manifest.changes.find(c=>c.kind==='add_usage_guidance').after);
  const expected=structuredClone(before);
  for (const c of changes) expected.paths[c.path].get.summary=c.after;
  expected.info['x-guidance']=DISCOVERY_GUIDANCE;
  assert.deepEqual(after,expected);
  for (const [path,methods] of Object.entries(before.paths)) {
    assert.deepEqual(after.paths[path].get?.['x-payment-info'],methods.get?.['x-payment-info']);
  }
});
test('guidance states polling and citation limits, without new background promises', () => {
  assert.ok(DISCOVERY_GUIDANCE.includes('caller-operated polling'));
  assert.ok(DISCOVERY_GUIDANCE.includes('does not schedule jobs or send notifications'));
  assert.ok(DISCOVERY_GUIDANCE.includes('does not include a claim-to-source citation map'));
});
test('no handler or upstream HTTP execution occurred',()=>assert.equal(fetchCalls,0));
