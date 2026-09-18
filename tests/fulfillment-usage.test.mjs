import {test} from 'node:test';
import assert from 'node:assert/strict';
import {instrumentCapability} from '../src/commercial-loop-runtime.mjs';
import {EpisodeStore} from '../src/commercial-loop-store.mjs';
import {executionCostAudit} from '../src/commercial-execution-costs.mjs';
import {hash} from '../src/commercial-loop-core.mjs';
import {beginUsage,recordAttempt,recordResult,currentUsageEvidence} from '../src/fulfillment-usage.js';

const collect=()=>{const events=[];return {events,ingest:e=>events.push(e),issue:()=>{}};};
const cap=(handler,store,name='market-breadth')=>instrumentCapability({name,handler},store,{sourceHash:hash('fixture')});
const attempted=(context,name='market-breadth')=>{
  const usage=beginUsage(context,name);recordAttempt(usage,'fixture_http');return usage;
};

test('a failed call without an HTTP request retains usage and rethrows the original error',async()=>{
  const store=collect(),error=Object.assign(new Error('source unavailable'),{status:503});
  const input={},context={};
  const wrapped=cap(async function(a,b){
    assert.equal(a,input);assert.equal(b,context);
    attempted(b);throw error;
  },store);
  await assert.rejects(wrapped.handler(input,context),e=>e===error);
  assert.equal(store.events.length,1);
  const data=store.events[0].data;
  assert.equal(data.quality,'FAILED');
  assert.deepEqual(data.upstream_usage.counters.fixture_http,{attempted:1,completed:0,successful:0});
  assert.equal(data.direct_cost,null);assert.equal(data.contribution,null);
  assert.equal(currentUsageEvidence(),null);
});

test('concurrent calls retain their own usage, including a call with no context argument',async()=>{
  const store=collect(),error=new Error('second request failed');
  let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  const out={pairs:[{name:'fixture'}]};
  const wrapped=cap(async(mode,context)=>{
    const usage=attempted(context);
    if(mode==='first'){started();await gate;recordResult(usage,'fixture_http',true);return out;}
    recordAttempt(usage,'fixture_http');throw error;
  },store);
  const first=wrapped.handler('first');await ready;
  try{await assert.rejects(wrapped.handler('second',{}),e=>e===error);}finally{release();}
  assert.equal(await first,out);
  assert.equal(store.events.length,2);
  const failed=store.events.find(e=>e.data.quality==='FAILED').data;
  const succeeded=store.events.find(e=>e.data.quality!=='FAILED').data;
  assert.equal(failed.upstream_usage.counters.fixture_http.attempted,2);
  assert.deepEqual(succeeded.upstream_usage.counters.fixture_http,{attempted:1,completed:1,successful:1});
  assert.equal(currentUsageEvidence(),null);
});

test('nested handlers restore parent usage and a subsequent unmeasured call stays unknown',async()=>{
  const store=collect(),error=new Error('nested failed');
  const child=cap(()=>{const u=attempted({},'earnings-calendar');recordAttempt(u,'fixture_http');throw error;},store,'earnings-calendar');
  const out={ok:true};
  const parent=cap(async()=>{
    const usage=attempted({});
    await assert.rejects(child.handler({}),e=>e===error);
    recordResult(usage,'fixture_http',true);return out;
  },store);
  assert.equal(await parent.handler({}),out);
  assert.equal(store.events[0].data.upstream_usage.capability,'earnings-calendar');
  assert.equal(store.events[1].data.upstream_usage.capability,'market-breadth');
  assert.equal(store.events[1].data.upstream_usage.counters.fixture_http.attempted,1);
  await cap(()=>({ok:true}),store,'ping').handler({});
  assert.equal(store.events[2].data.upstream_usage,null);
  assert.equal(currentUsageEvidence(),null);
});

test('audit exposes retained usage with its execution hash but does not certify unknown costs',async()=>{
  const store=new EpisodeStore(':memory:'),error=new Error('failed after source response');
  try {
    const wrapped=cap(async()=>{
      const usage=attempted({});recordResult(usage,'fixture_http',false);throw error;
    },store);
    await assert.rejects(wrapped.handler({}),e=>e===error);
    const event=JSON.parse(store.db.prepare("SELECT body FROM events WHERE kind='fulfillment'").get().body);
    const audit=executionCostAudit(store,store.episodes()),row=audit.rows[0];
    assert.equal(row.execution_evidence_sha256,hash(event));
    assert.equal(row.fulfillment_quality,'FAILED');
    assert.equal(row.capability_source_sha256,hash('fixture'));
    assert.equal(row.elapsed_ms,event.data.elapsed_ms);
    assert.deepEqual(row.upstream_usage.counters.fixture_http,{attempted:1,completed:1,successful:0});
    assert.equal(row.complete,false);assert.equal(row.direct_cost_usd_micros,null);
    assert.equal(row.outside_payment_verified,false);
    assert.ok(row.issues.includes('ALL_VARIABLE_COSTS_REQUIRED'));
    store.ingest({id:'legacy-fixture',kind:'fulfillment',ts:new Date().toISOString(),cap:'ping',data:{quality:'FAILED'}});
    const legacy=executionCostAudit(store,store.episodes()).rows.find(r=>r.execution_id==='legacy-fixture');
    assert.equal(legacy.upstream_usage,null);assert.equal(legacy.elapsed_ms,null);assert.equal(legacy.complete,false);
  } finally {store.close();}
});
