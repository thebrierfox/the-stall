import { COST_CLASSES, atoms, hash } from './commercial-loop-core.mjs';

export const COST_SOURCES = {
  upstream:'Execution-bound supplier receipt or reviewed source contract and usage tariff',
  inference:'Provider usage + admitted model tariff; account invoice for adjustments',
  settlement:'Actual facilitator route + account fee ledger; CDP case 01615635 where applicable',
  chain:'Base receipt L2 gas and L1 fee + receipt-time ETH/USD valuation + payer attribution',
  rpc:'Native RPC account tariff and measured request usage',
  variable_compute:'Measured variable infrastructure usage and tariff or evidenced allocation',
  other_variable:'Reviewed inventory of remaining variable charges, taxes and refunds'
};

/** Exact Base receipt units; USD valuation and cost responsibility are separate facts. */
export function chainFeeEvidence(receipt, owned) {
  try {
    if(![receipt.gasUsed,receipt.effectiveGasPrice,receipt.l1Fee].every(x=>typeof x==='string'&&/^0x[0-9a-f]+$/i.test(x)))return null;
    const execution=BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice),l1=BigInt(receipt.l1Fee);
    const operator=receipt.operatorFee==null?0n:BigInt(receipt.operatorFee);
    if(operator<0n)return null;
    return {schema:'stall-chain-cost/v1',network:'eip155:8453',transaction:receipt.transactionHash.toLowerCase(),
      gas_payer:receipt.from?.toLowerCase()??null,paid_by_registered_wallet:owned.includes(receipt.from?.toLowerCase()),
      gas_used:BigInt(receipt.gasUsed).toString(),effective_gas_price_wei:BigInt(receipt.effectiveGasPrice).toString(),
      execution_fee_wei:execution.toString(),l1_fee_wei:l1.toString(),
      operator_fee_wei:receipt.operatorFee==null?null:operator.toString(),
      base_two_component_fee_wei:(execution+l1+operator).toString(),
      calculation:'Base documented L2 execution + L1 security; explicit operator fee included if supplied',
      receipt_sha256:hash(receipt),source:'https://docs.base.org/specifications/transactions/network-fees',
      usd_micros:null,valuation:'RECEIPT_TIME_FX_REQUIRED; current spot is not historical expense',
      scope:'One chain transaction; failed attempts and facilitator invoice charges remain separate'};
  } catch {return null;}
}

/** Historical valuation policy: opening ETH/USD trade of the receipt's UTC minute. */
export function valueChainFee(cost, block, candles, source) {
  if(!cost || typeof block?.timestamp!=='string' || !Array.isArray(candles))throw new Error('fx_binding_missing');
  const at=Number(BigInt(block.timestamp)),minute=Math.floor(at/60)*60;
  const matches=candles.filter(row=>Array.isArray(row)&&row[0]===minute);
  if(matches.length!==1)throw new Error('historical_candle_missing');
  const candle=matches[0],price=String(candle[3]);
  if(!/^[0-9]{1,9}(\.[0-9]{1,8})?$/.test(price)||!(Number(price)>0)
    || !(candle[1]<=Number(price)&&Number(price)<=candle[2]))throw new Error('historical_price_invalid');
  const [whole,fraction='']=price.split('.'),numerator=BigInt(whole+fraction),scale=10n**BigInt(fraction.length);
  const denom=10n**18n*scale,product=atoms(cost.base_two_component_fee_wei)*numerator*1000000n;
  const micros=((product+denom-1n)/denom).toString();
  return {...cost,network_fee_valued_usd_micros:micros,usd_micros:cost.paid_by_registered_wallet?micros:null,
    valuation:'HISTORICAL_RECEIPT_MINUTE_OPEN; accounting valuation, not an executed FX trade',
    fx:{pair:'ETH-USD',price_decimal:price,bucket_start:minute,block_timestamp:at,
      block_hash:block.hash,block_evidence_sha256:hash({number:block.number,hash:block.hash,timestamp:block.timestamp}),
      source,response_sha256:hash(candles),rounding:'UP_TO_USD_MICRO',observed_at:new Date().toISOString()}};
}

/** Quantities are usable only when one exact paid transfer binds one retained execution. */
export function receiptUsageEvidence(episode, audit) {
  const ids=[...new Set((episode.evidence||[]).filter(v=>v.kind==='fulfillment').map(v=>v.event_id))];
  const unavailable=reason=>({state:'UNAVAILABLE',reason,execution_ids:ids,measurement:null});
  const rejected=reason=>({state:'REJECTED',reason,execution_ids:ids,measurement:null});
  if(!ids.length)return unavailable('FULFILLMENT_EXECUTION_MISSING');
  if(episode.ambiguous_join||ids.length!==1)return rejected('AMBIGUOUS_EXECUTION_JOIN');
  const matches=(audit?.rows||[]).filter(r=>r.execution_id===ids[0]);
  if(!matches.length)return unavailable('EXECUTION_AUDIT_MISSING');
  if(matches.length!==1)return rejected('DUPLICATE_EXECUTION_AUDIT');
  const row=matches[0],validHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  if(row.transfer_key!==episode.transfer_key||row.capability!==episode.capability
    ||row.outside_payment_verified!==true||row.internal_or_test||episode.excluded
    ||!validHash(row.execution_evidence_sha256)||!validHash(row.capability_source_sha256))
    return rejected('EXECUTION_TRANSFER_BINDING_INVALID');
  const usage=row.upstream_usage;
  let counters=null,sourceObservation=null;
  if(usage!=null) {
    if(usage.schema!=='stall-upstream-usage/v1'||usage.capability!==episode.capability
      ||!usage.counters||typeof usage.counters!=='object'||Array.isArray(usage.counters))
      return rejected('USAGE_SCHEMA_INVALID');
    counters={};
    for(const [name,count] of Object.entries(usage.counters)) {
      if(!/^[a-zA-Z0-9_:-]{1,80}$/.test(name)||!count
        ||!['attempted','completed','successful'].every(k=>Number.isSafeInteger(count[k])&&count[k]>=0)
        ||count.completed>count.attempted||count.successful>count.completed)
        return rejected('USAGE_COUNTER_INVALID');
      counters[name]={attempted:count.attempted,completed:count.completed,successful:count.successful};
    }
    if(usage.source_observation)sourceObservation=Object.fromEntries(
      ['cache_hit','fetched_at','cache_age_ms','available_rows','freshness_basis']
      .filter(k=>['string','number','boolean'].includes(typeof usage.source_observation[k]))
      .map(k=>[k,usage.source_observation[k]]));
  }
  return {state:'EXECUTION_BOUND',execution_ids:ids,measurement:{
    execution_id:row.execution_id,execution_evidence_sha256:row.execution_evidence_sha256,
    capability_source_sha256:row.capability_source_sha256,fulfillment_quality:row.fulfillment_quality??null,
    upstream_counters:counters,source_observation:sourceObservation,
    handler_wall_time_ms:Number.isFinite(row.elapsed_ms)&&row.elapsed_ms>=0?row.elapsed_ms:null,
    scope:'Observed handler quantities only. Wall time is not CPU usage or billable compute. No tariff, entitlement, invoice or zero-cost assertion.'}};
}

/** Preserve partial evidence instead of throwing it away when the total is unknown. */
export function transactionCostCoverage(store, episodes, incumbentContract=null, executionAudit=null) {
  const hasPurchases=Boolean(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='incumbent_purchases'").get());
  const rows=[];
  for(const e of episodes.filter(e=>e.outside_payment_verified)) {
    const t=JSON.parse(store.db.prepare('SELECT body FROM transfers WHERE key=?').get(e.transfer_key).body);
    const full=store.db.prepare('SELECT body FROM costs WHERE transfer_key=?').get(e.transfer_key);
    const proof=full?JSON.parse(full.body):null;
    const components=Object.fromEntries(COST_CLASSES.map(k=>[k,proof?.components?.[k]
      ?{state:'EVIDENCED',...proof.components[k]}:{state:'MISSING',obtain_from:COST_SOURCES[k]}]));
    const ids=e.evidence.filter(x=>x.kind==='fulfillment').map(x=>x.event_id);
    const purchases=hasPurchases?ids.flatMap(id=>store.db.prepare('SELECT body FROM incumbent_purchases WHERE id=?').all(id).map(r=>JSON.parse(r.body))):[];
    if(!proof && purchases.length===1 && purchases[0].actual_debit_usd_micros!=null) {
      const p=purchases[0];
      components.inference={state:p.invoice_reconciliation?'INVOICE_BOUND':'TARIFF_ACCRUAL',usd_micros:p.actual_debit_usd_micros,
        basis:p.usage?.basis,evidence_sha256:hash(p),evidence_ref:'incumbent_purchases:'+p.id,
        invoice_reconciled:Boolean(p.invoice_reconciliation),invoice_evidence:p.invoice_reconciliation??null,provider_request_id:p.provider_request_id};
      if(incumbentContract && e.fulfillment?.capability_source_sha256===incumbentContract.source_review.capability_sha256) {
        components.upstream={state:'SOURCE_VERIFIED_ZERO',usd_micros:'0',basis:'SOURCE_VERIFIED_ZERO',
          evidence_sha256:incumbentContract.source_review.capability_sha256,
          evidence_ref:'Reviewed vision handler; the single model supplier is accounted under inference'};
      }
    }
    // Handler-only zero inference evidence is useful but never zeros other costs.
    const model=e.fulfillment?.cost_evidence?.model_inference;
    if(!proof && model?.amount_usd===0 && model.status==='SOURCE_VERIFIED_NO_MODEL_CALL' && /^[a-f0-9]{64}$/.test(model.source_sha256||'')) {
      components.inference={state:'SOURCE_VERIFIED_ZERO',usd_micros:'0',basis:'SOURCE_VERIFIED_ZERO',
        evidence_sha256:model.source_sha256,evidence_ref:'fulfillment.cost_evidence.model_inference',scope:model.scope};
    }
    if(!proof && t.chain_cost)components.chain={state:t.chain_cost.usd_micros==null?'NATIVE_UNITS_EVIDENCED_USD_UNRESOLVED':'CHAIN_RECEIPT_HISTORICAL_FX',...t.chain_cost};
    const quantified=COST_CLASSES.filter(k=>typeof components[k].usd_micros==='string');
    const unresolved=COST_CLASSES.filter(k=>components[k].state==='MISSING'||components[k].usd_micros==null);
    rows.push({transfer_key:e.transfer_key,capability:e.capability,at:e.at,excluded:e.excluded,
      gross_usdc_atoms:t.amount_atoms,components,
      usage_evidence:receiptUsageEvidence(e,executionAudit),
      quantified_cost_usd_micros:quantified.reduce((n,k)=>n+atoms(components[k].usd_micros),0n).toString(),
      quantified_cost_is_total:e.contribution.complete,complete:e.contribution.complete,
      contribution_usd_micros:e.contribution.contribution_usd_micros,unresolved,
      source_row_sha256:t.source_row_sha256,fulfillment_verified:e.fulfillment_verified});
  }
  return {schema:'stall-transaction-cost-coverage/v1',as_of:new Date().toISOString(),transactions:rows,
    usage_coverage:{execution_bound:rows.filter(r=>r.usage_evidence.state==='EXECUTION_BOUND').length,
      with_upstream_counters:rows.filter(r=>r.usage_evidence.measurement?.upstream_counters!=null).length,
      unavailable:rows.filter(r=>r.usage_evidence.state==='UNAVAILABLE').length,
      rejected:rows.filter(r=>r.usage_evidence.state==='REJECTED').length},
    missing_by_class:Object.fromEntries(COST_CLASSES.map(k=>[k,rows.filter(r=>r.components[k].state==='MISSING'||r.components[k].usd_micros==null).length])),
    complete:rows.filter(r=>r.complete).length,scope:'Historical and prospective evidence; no unsupported zero costs. Tariff accrual is distinct from invoice settlement.'};
}

/** Recurrence is dated paid behavior; neither customer identity nor causal preference is inferred. */
export function recurrencePortfolio(episodes, experiments=[], now=Date.now(), controls=[]) {
  const byCap=new Map();
  for(const original of episodes){const e={...original,at:original.payment_at||original.at};if(e.outside_payment_verified&&!e.excluded&&!e.ambiguous_join&&e.payer_token) {
    const list=byCap.get(e.capability)||[];list.push(e);byCap.set(e.capability,list);
  }}
  const results=[];
  for(const [cap,all] of byCap) {
    const seen=new Set(),rows=all.filter(e=>!seen.has(e.transfer_key)&&seen.add(e.transfer_key));
    const cohort=new Map();
    for(const e of rows){const list=cohort.get(e.payer_token)||[];list.push(e);cohort.set(e.payer_token,list);}
    const recurring=[...cohort.values()].map(es=>({payments:es.length,days:[...new Set(es.map(e=>e.at.slice(0,10)))].sort()})).sort((a,b)=>b.days.length-a.days.length||b.payments-a.payments);
    const experiment=experiments.find(x=>x.capability===cap);
    const window=experiment?rows.filter(e=>Date.parse(e.at)>=Date.parse(experiment.started_at)&&Date.parse(e.at)<=Date.parse(experiment.deadline_at)):[];
    const complete=window.length>0&&window.every(e=>e.contribution.complete&&e.fulfillment_verified);
    const net=complete?window.reduce((n,e)=>n+BigInt(e.contribution.contribution_usd_micros),0n):null;
    const returned=new Map();
    for(const e of window)if(e.fulfillment_verified){const d=returned.get(e.payer_token)||new Set();d.add(e.at.slice(0,10));returned.set(e.payer_token,d);}
    const returnDays=Math.max(0,...[...returned.values()].map(x=>x.size));
    let action='DEFINE_BOUNDED_EXPERIMENT';
    if(experiment){
      if(now<Date.parse(experiment.deadline_at)||now<Date.parse(experiment.hold_until||0))action='PRESERVE_CONTROL_WINDOW';
      else if(!complete)action='RECONCILE_COST_AND_FULFILLMENT';
      else if(net<=0n)action='RETIRE_EXPERIMENT';
      else if(returnDays<(experiment.minimum_return_days||3))action='WAIT_FOR_REAL_RETURN_DAYS';
      else action='ELIGIBLE_FOR_BOUNDED_EXPANSION_REVIEW';
    }
    const control=controls.find(c=>c.capability===cap&&Date.parse(c.until)>now);
    if(control)action='PRESERVE_CONTROL_WINDOW';
    results.push({capability:cap,control_until:control?.until??null,verified_payments:rows.length,distinct_payer_tokens:cohort.size,
      strongest_recurrence:recurring[0],payer_identity:'WALLET_NOT_IDENTIFIED_CUSTOMER',usefulness_verified:false,
      experiment_id:experiment?.id??null,experiment_window:experiment?{from:experiment.started_at,until:experiment.deadline_at}:null,
      window_payments:window.length,window_fulfilled_return_days:returnDays,
      window_complete:complete,window_contribution_usd_micros:net?.toString()??null,action,
      automatic_spend_increase_usd_micros:'0'});
  }
  return results.sort((a,b)=>b.strongest_recurrence.days.length-a.strongest_recurrence.days.length||b.verified_payments-a.verified_payments);
}
