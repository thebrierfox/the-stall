import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EpisodeStore} from '../src/commercial-loop-store.mjs';
import {hash,COST_CLASSES} from '../src/commercial-loop-core.mjs';
import {receiptUsageEvidence,transactionCostCoverage} from '../src/commercial-cost-coverage.mjs';
import {executionCostAudit} from '../src/commercial-execution-costs.mjs';
const id='exe_00000000-0000-0000-0000-000000000001',source=hash('fixture'),tx='0x'+'a'.repeat(64),transfer='eip155:8453:'+tx+':1';
const episode=()=>({transfer_key:transfer,capability:'market-breadth',outside_payment_verified:true,evidence:[{kind:'fulfillment',event_id:id}]});
const audit=()=>({rows:[{execution_id:id,transfer_key:transfer,capability:'market-breadth',outside_payment_verified:true,
 execution_evidence_sha256:source,capability_source_sha256:hash('capability'),fulfillment_quality:'COMPLETE_PAIRS',elapsed_ms:123,
 upstream_usage:{schema:'stall-upstream-usage/v1',capability:'market-breadth',counters:{yahoo_chart_http:{attempted:6,completed:6,successful:5}}}}]});
test('one transfer receives exact execution quantities and retains explicit billing limits',()=>{
 const a=audit(),r=receiptUsageEvidence(episode(),a);
 assert.equal(r.state,'EXECUTION_BOUND');assert.equal(r.measurement.execution_evidence_sha256,source);
 assert.equal(r.measurement.upstream_counters.yahoo_chart_http.attempted,6);
 assert.equal(r.measurement.handler_wall_time_ms,123);assert.match(r.measurement.scope,/not CPU/);
 r.measurement.upstream_counters.yahoo_chart_http.attempted=999;
 assert.equal(a.rows[0].upstream_usage.counters.yahoo_chart_http.attempted,6);
});
test('missing execution or audit stays unknown instead of zero',()=>{
 assert.equal(receiptUsageEvidence({...episode(),evidence:[]},audit()).state,'UNAVAILABLE');
 assert.equal(receiptUsageEvidence(episode(),null).measurement,null);
 const a=audit();a.rows[0].upstream_usage=null;a.rows[0].elapsed_ms=null;
 const r=receiptUsageEvidence(episode(),a);assert.equal(r.state,'EXECUTION_BOUND');
 assert.equal(r.measurement.upstream_counters,null);assert.equal(r.measurement.handler_wall_time_ms,null);
});
test('duplicate references deduplicate but competing execution claims are rejected',()=>{
 const e=episode();e.evidence.push({...e.evidence[0]});
 assert.equal(receiptUsageEvidence(e,audit()).state,'EXECUTION_BOUND');
 e.evidence.push({kind:'fulfillment',event_id:'another'});
 assert.equal(receiptUsageEvidence(e,audit()).reason,'AMBIGUOUS_EXECUTION_JOIN');
 const a=audit();a.rows.push({...a.rows[0]});
 assert.equal(receiptUsageEvidence(episode(),a).reason,'DUPLICATE_EXECUTION_AUDIT');
});
for(const [label,mutate] of [
 ['wrong transfer',r=>r.transfer_key+='wrong'],
 ['wrong capability',r=>r.capability='another'],
 ['unverified payment',r=>r.outside_payment_verified=false],
 ['internal execution',r=>r.internal_or_test=true],
 ['missing evidence hash',r=>r.execution_evidence_sha256=null],
 ['missing capability hash',r=>r.capability_source_sha256=null],
 ['wrong usage capability',r=>r.upstream_usage.capability='another'],
 ['fractional counter',r=>r.upstream_usage.counters.yahoo_chart_http.attempted=6.1],
 ['negative counter',r=>r.upstream_usage.counters.yahoo_chart_http.successful=-1],
 ['completion exceeds attempts',r=>r.upstream_usage.counters.yahoo_chart_http.completed=7],
 ['success exceeds completion',r=>r.upstream_usage.counters.yahoo_chart_http.successful=7]
])test(label+' cannot bind quantities to revenue',()=>{
 const a=audit();mutate(a.rows[0]);const result=receiptUsageEvidence(episode(),a);
 assert.equal(result.state,'REJECTED');assert.equal(result.measurement,null);
});
test('cache-hit zeros remain observations and only permitted source metadata is exposed',()=>{
 const a=audit();a.rows[0].upstream_usage.counters.yahoo_chart_http={attempted:0,completed:0,successful:0};
 a.rows[0].upstream_usage.source_observation={cache_hit:true,cache_age_ms:10,raw_body:'private fixture',unrelated_metadata:'fixture'};
 const r=receiptUsageEvidence(episode(),a);
 assert.equal(r.measurement.upstream_counters.yahoo_chart_http.attempted,0);
 assert.deepEqual(r.measurement.source_observation,{cache_hit:true,cache_age_ms:10});
 assert.match(r.measurement.scope,/No tariff/);
});
test('real store connects receipt to execution without changing gross, cost gaps or reviewed contribution',()=>{
 const s=new EpisodeStore(':memory:'),at='2026-09-18T12:00:00Z',payer='0x'+'9'.repeat(40),request_id='bound-fixture';
 try{
 const a=audit().rows[0];
 s.ingest({id,kind:'fulfillment',ts:at,cap:'market-breadth',request_id,data:{
   quality:'COMPLETE_PAIRS',elapsed_ms:123,capability_source_sha256:a.capability_source_sha256,upstream_usage:a.upstream_usage}});
 s.ingest({id:'payment',kind:'payment_observation',ts:at,cap:'market-breadth',request_id,source:{row_sha256:source},data:{settlement_claimed:true,tx,payer}});
 s.importTransfer({network:'eip155:8453',tx,log_index:1,payer,amount_atoms:'31000',currency:'USDC',outside_verified:true,source_row_sha256:source,receipt_sha256:source});
 let episodes=s.episodes(),auditRows=executionCostAudit(s,episodes);
 let coverage=transactionCostCoverage(s,episodes,null,auditRows),row=coverage.transactions[0];
 assert.equal(row.usage_evidence.state,'EXECUTION_BOUND');assert.equal(row.usage_evidence.measurement.upstream_counters.yahoo_chart_http.attempted,6);
 assert.equal(row.gross_usdc_atoms,'31000');assert.equal(row.complete,false);assert.equal(row.contribution_usd_micros,null);
 assert.equal(row.components.upstream.state,'MISSING');assert.equal(row.quantified_cost_is_total,false);
 assert.equal(coverage.usage_coverage.with_upstream_counters,1);
 const before=JSON.parse(s.db.prepare("SELECT body FROM events WHERE id=?").get(id).body);
 assert.equal(row.usage_evidence.measurement.execution_evidence_sha256,hash(before));
 const proof={transfer_key:transfer,receipt_evidence_sha256:source,reviewed:true,currency:'USD',
 components:Object.fromEntries(COST_CLASSES.map(k=>[k,{usd_micros:'100',basis:'INVOICE_BOUND',evidence_sha256:source,evidence_ref:'fixture invoice:'+k}]))};
 s.importCost(proof);episodes=s.episodes();coverage=transactionCostCoverage(s,episodes,null,executionCostAudit(s,episodes));
 assert.equal(coverage.transactions[0].complete,true);assert.equal(coverage.transactions[0].contribution_usd_micros,'30300');
 assert.deepEqual(JSON.parse(s.db.prepare("SELECT body FROM events WHERE id=?").get(id).body),before);
 }finally{s.close();}
});
