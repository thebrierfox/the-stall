import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {hash,canonical,contribution,atoms,validHash} from './commercial-loop-core.mjs';

function schema(store) {
  store.db.exec('CREATE TABLE IF NOT EXISTS execution_costs(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  if(!store.meta('execution-cost-audit-start'))store.setMeta('execution-cost-audit-start',new Date().toISOString());
}

// Trusted local accounting input. A reviewed assertion is not independently verified billing.
export async function importExecutionCosts(store,directory) {
  schema(store);let file;
  try {
    file=await open(join(directory,'execution-cost-proofs.json'),'r');
    if((await file.stat()).size>262144)throw Error('execution_cost_input_limit');
    const input=JSON.parse(await file.readFile('utf8'));
    if(input.reviewed!==true||!Array.isArray(input.proofs)||input.proofs.length>1000)throw Error('execution_cost_review_required');
    store.transaction(()=>{
      for(const p of input.proofs) {
        if(!/^exe_[a-f0-9-]{36}$/.test(p.execution_id||'')||!validHash(p.execution_evidence_sha256))throw Error('execution_cost_binding');
        const transfer={key:p.execution_id,source_row_sha256:p.execution_evidence_sha256,currency:'USDC',amount_atoms:'0'};
        const check=contribution(transfer,{...p,transfer_key:p.execution_id,receipt_evidence_sha256:p.execution_evidence_sha256});
        if(!check.complete)throw Error('execution_cost_incomplete');
        const old=store.db.prepare('SELECT body FROM execution_costs WHERE id=?').get(p.execution_id);
        if(old&&canonical(JSON.parse(old.body))!==canonical(p))throw Error('execution_cost_conflict');
        store.db.prepare('INSERT OR IGNORE INTO execution_costs VALUES(?,?)').run(p.execution_id,JSON.stringify(p));
      }
      const assertions=input.coverage_assertions||[];
      if(!Array.isArray(assertions)||assertions.length>100)throw Error('coverage_assertion_limit');
      for(const a of assertions){
        if(a.reviewed!==true||!validHash(a.evidence_sha256)||typeof a.evidence_ref!=='string'||!a.evidence_ref.trim()
          ||typeof a.experiment_id!=='string'||!Number.isFinite(Date.parse(a.from))||!Number.isFinite(Date.parse(a.through))
          ||Date.parse(a.through)<=Date.parse(a.from)||Date.parse(a.through)>Date.now()
          ||!['fulfillment_attempts','supplier_dispatches','settlement_attempts','refunds','other_variable'].every(k=>a.covers?.includes(k)))throw Error('coverage_assertion_incomplete');
      }
      if(assertions.length)store.setMeta('execution-cost-coverage-assertions',assertions);
    });
  }catch(e){if(e.code!=='ENOENT')throw e;}
  finally{await file?.close();}
}

/** All retained executions, including unsuccessful/unpaid/internal work. No cost is dropped for lack of revenue. */
export function executionCostAudit(store,episodes) {
  schema(store);
  const events=store.db.prepare("SELECT body FROM events WHERE kind='fulfillment' ORDER BY at,id").all().map(r=>JSON.parse(r.body));
  const table=n=>Boolean(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n));
  const purchases=['incumbent_purchases','procurement_orders'].flatMap(n=>table(n)?store.db.prepare('SELECT body FROM '+n).all().map(r=>({...JSON.parse(r.body),ledger:n})):[])
    .filter(p=>!['RESERVED','CANCELLED_BEFORE_DISPATCH'].includes(p.state));
  const ids=new Set([...events.map(e=>e.id),...purchases.map(p=>p.execution_id||p.id)]);
  const rows=[];
  for(const id of ids) {
    const event=events.find(e=>e.id===id),orders=purchases.filter(p=>(p.execution_id||p.id)===id);
    const matches=episodes.filter(e=>e.evidence.some(v=>v.kind==='fulfillment'&&v.event_id===id));
    const episode=matches.length===1?matches[0]:null;
    const paid=episode?.outside_payment_verified===true;
    const transferProof=paid?store.db.prepare('SELECT body FROM costs WHERE transfer_key=?').get(episode.transfer_key):null;
    const local=store.db.prepare('SELECT body FROM execution_costs WHERE id=?').get(id);
    const proof=transferProof?JSON.parse(transferProof.body):local?JSON.parse(local.body):null;
    const sourceHash=event?hash(event):hash(orders.map(p=>({id:p.id,request_sha256:p.request_sha256})));
    const localCheck=proof&&contribution({key:id,source_row_sha256:sourceHash,currency:'USDC',amount_atoms:'0'},
      {...proof,transfer_key:proof.execution_id,receipt_evidence_sha256:proof.execution_evidence_sha256});
    let complete=paid?episode.contribution.complete:localCheck?.complete===true;
    const issues=[];
    if(!event)issues.push('FULFILLMENT_EVENT_MISSING');
    if(matches.length>1||episode?.ambiguous_join)issues.push('AMBIGUOUS_EXECUTION_JOIN');
    if(!complete)issues.push('ALL_VARIABLE_COSTS_REQUIRED');
    for(const kind of ['inference','upstream']) {
      const relevant=orders.filter(p=>(p.ledger==='incumbent_purchases'?'inference':'upstream')===kind);
      if(relevant.some(p=>p.actual_debit_usd_micros==null))issues.push('SUPPLIER_DEBIT_UNRESOLVED:'+kind);
      const known=relevant.reduce((n,p)=>n+atoms(p.actual_debit_usd_micros??'0'),0n);
      if(complete&&known>atoms(proof?.components?.[kind]?.usd_micros??'0'))issues.push('COST_PROOF_BELOW_LEDGER:'+kind);
    }
    complete=complete&&issues.length===0;
    const direct=paid?episode?.contribution.direct_cost_usd_micros:localCheck?.direct_cost_usd_micros;
    rows.push({execution_id:id,capability:event?.cap||orders[0]?.capability||episode?.capability||null,
      at:event?.ts||orders[0]?.dispatched_at,execution_evidence_sha256:sourceHash,
      fulfillment_quality:event?.data?.quality??null,
      capability_source_sha256:event?.data?.capability_source_sha256??null,
      elapsed_ms:Number.isFinite(event?.data?.elapsed_ms)?event.data.elapsed_ms:null,
      upstream_usage:event?.data?.upstream_usage??null,
      outside_payment_verified:paid,internal_or_test: Boolean(event?.excluded),
      transfer_key:paid?episode.transfer_key:null,complete,issues,
      direct_cost_usd_micros:complete?direct:null,
      additional_cost_usd_micros:complete&&!paid?direct:null,
      known_supplier_cost_usd_micros:orders.reduce((n,p)=>n+atoms(p.actual_debit_usd_micros??'0'),0n).toString(),
      supplier_dispatches:orders.length});
  }
  return {schema:'stall-execution-cost-audit/v1',coverage_started_at:store.meta('execution-cost-audit-start'),
    scope:'All retained fulfillment attempts and supplier dispatches; internal/test expense is retained. Historical absence is not zero.',
    usage_scope:'Observed handler counters and wall time are quantities, not tariff or total cost proof; missing usage remains unknown.',
    as_of:new Date().toISOString(),coverage_assertions:store.meta('execution-cost-coverage-assertions')||[],rows};
}

export function applyExecutionCostGate(e,evaluation,audit,now=Date.now()) {
  const start=Date.parse(e.started_at),end=Date.parse(e.deadline_at);
  const rows=audit.rows.filter(r=>(r.capability===e.capability||r.capability==null)&&Date.parse(r.at)>=start&&Date.parse(r.at)<=end);
  // Instrumented fulfillments alone cannot certify failed settlement, refund, or invoice completeness.
  const assertion=(audit.coverage_assertions||[]).find(a=>a.reviewed===true&&a.experiment_id===e.id
    &&Date.parse(a.from)===start&&Date.parse(a.through)===end&&validHash(a.evidence_sha256));
  const covered=Boolean(assertion);
  const unresolved=rows.filter(r=>!r.complete);
  const extra=rows.filter(r=>!r.outside_payment_verified&&r.complete).reduce((n,r)=>n+atoms(r.additional_cost_usd_micros),0n);
  const evidence={window_coverage_complete:covered,executions:rows.length,unresolved_executions:unresolved.length,
    additional_cost_usd_micros:extra.toString(),coverage_started_at:audit.coverage_started_at,
    coverage_evidence_sha256:assertion?.evidence_sha256??null,
    requirement:'Reviewed fixed-window accounting coverage, including failed settlement and refunds; runtime availability alone is insufficient'};
  if(now<end||evaluation.action==='HOLD')return {...evaluation,execution_costs:evidence};
  if(!covered||unresolved.length)return {state:'ALL_EXECUTION_COSTS_UNRESOLVED',action:'RECONCILE',execution_costs:evidence};
  if(evaluation.net_usd_micros!=null) {
    const net=BigInt(evaluation.net_usd_micros)-extra;
    return {...evaluation,net_usd_micros:net.toString(),...(net<=0n?{state:'NONPOSITIVE_ALL_EXECUTION_CONTRIBUTION',action:'RETIRE_EXPERIMENT'}:{}),execution_costs:evidence};
  }
  return {...evaluation,execution_costs:evidence};
}
