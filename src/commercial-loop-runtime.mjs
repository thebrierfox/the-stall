import { DreamReplayRuntime } from './dream-runtime.mjs';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { EpisodeStore } from './commercial-loop-store.mjs';
import { VERSION, hash, declaredContext, excluded, resolveRequirements, evaluateExperiment, bounded } from './commercial-loop-core.mjs';
import { ingestLog, importPinnedEvidence, importReviewedCosts, importSupplierEvidence, writeProjection } from './commercial-loop-io.mjs';
import { fulfillmentEvidence } from './fulfillment-evidence.js';
import { usageEvidence, currentUsageEvidence, withUsageContext } from './fulfillment-usage.js';
import { loadDemandClassificationCorrections } from './demand-classification.js';
import { observeDiscovery, observeNextTransfer, observeSearchPositions } from './commercial-loop-observers.mjs';
import { opportunityProof, recordSelection } from './commercial-selection.mjs';
import { ProcurementBook } from './commercial-procurement.mjs';
import { IncumbentSupplierBook, withSupplierContext } from './commercial-incumbent.mjs';
import { transactionCostCoverage, recurrencePortfolio } from './commercial-cost-coverage.mjs';
import { CDP_SETTLEMENT_ACCOUNTING, SETTLEMENT_COST_NEXT_ACTION } from './commercial-settlement-accounting.mjs';
import { importExecutionCosts, executionCostAudit, applyExecutionCostGate } from './commercial-execution-costs.mjs';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
let runtime = null;
const marker = Symbol('commercial-loop-wrapped');
const MAX_BODY = 16384;
const COST_LEDGER_NOTE = SETTLEMENT_COST_NEXT_ACTION;

export function fulfillmentRecord(cap, output, status, req, elapsed, sourceHash) {
  const detailed = fulfillmentEvidence(cap, output, status, req);
  const failed = status !== 200 || Boolean(output && typeof output.error === 'string');
  let resultHash = null;
  try { if (output !== undefined) resultHash = hash(JSON.stringify(output)); } catch {}
  let quality = failed ? 'FAILED' : detailed?.quality || 'PROVIDER_RESULT_ONLY';
  if (!failed && cap === 'vision-analyze') quality = typeof output?.analysis === 'string' && output.analysis.trim() && output.finish_reason === 'stop' ? 'VISION_ANALYSIS_RETURNED' : 'NO_USABLE_DATA';
  if (!failed && cap === 'balance-sheet') quality = Array.isArray(output?.periods) && output.periods.length ? 'BALANCE_SHEET_ROWS_RETURNED' : 'NO_USABLE_DATA';
  return { ...(detailed || {}), schema: 'stall-fulfillment-observation/v1', quality,
    result_sha256: resultHash, capability_source_sha256: sourceHash || null,
    elapsed_ms: elapsed, upstream_usage: currentUsageEvidence() || usageEvidence(req) || usageEvidence(output),
    client_receipt_confirmed: null, usefulness_confirmed: null,
    direct_cost: null, contribution: null, freshness_guaranteed: false };
}

export function instrumentCapability(cap, store, { attribution = () => null, sourceHash = null, supplierBook = null, stopped = () => false } = {}) {
  if (cap[marker]) return cap;
  const original = cap.handler;
  const result = { ...cap, async handler(...args) { return withUsageContext(async () => {
    const req = args[1]?.req, observation = req?._observationContext || attribution() || {};
    const executionId = 'exe_' + randomUUID(), started = Date.now();
    const emit = (output, status) => {
      try { store.ingest({ id: executionId, kind: 'fulfillment', ts: new Date().toISOString(), cap: cap.name,
        request_id: observation.request_id || null, excluded: Boolean(excluded(observation) || req?._internalBypass),
        source: { name: 'handler_instrumentation', source_sha256: sourceHash },
        data: fulfillmentRecord(cap.name, output, status, req, Date.now()-started, sourceHash) }); }
      catch { try { store.issue('instrumentation-write', { kind: 'FULFILLMENT_RECORD_FAILED' }); } catch {} }
    };
    try {
      if (req?.res && !req.res.headersSent) {
        const issued = Date.now().toString();
        req.res.setHeader('X-Stall-Evidence-Token', `${executionId}.${issued}.${store.token(`${executionId}.${issued}`)}`);
      }
    } catch { /* Existing fulfillment remains independent of observation. */ }
    try {
      const run = () => original.apply(cap,args);
      const out = supplierBook && cap.name === 'vision-analyze'
        ? await withSupplierContext({book:supplierBook, execution_id:executionId, capability:cap.name,
            request_id:observation.request_id || null, excluded:Boolean(excluded(observation) || req?._internalBypass),
            customer_price_usd_micros:cap.price === '$0.050' ? '50000' : null, stopped},run)
        : await run();
      emit(out,200); return out;
    }
    catch(e) { emit(undefined, Number.isInteger(e.status) ? e.status : 500); throw e; }
  }); } };
  Object.defineProperty(result, marker, { value: true }); return result;
}

export class CommercialRuntime {
  constructor(caps, config, { projectRoot = project, store, attribution, schedule = true } = {}) {
    this.project = projectRoot; this.root = dirname(projectRoot); this.config = config;
    this.directory = join(projectRoot,'data','commercial-loop');
    mkdirSync(this.directory,{ recursive:true,mode:0o700 });
    this.store = store || new EpisodeStore(join(this.directory,'episodes.sqlite'));
    try { this.dreamReplay = new DreamReplayRuntime(this.store, { projectRoot }); }
    catch (e) { this.store.issue('dream:startup', { kind: 'DREAM_STARTUP_FAILED', code: e.code || e.name }); }
    this.procurement = new ProcurementBook(this.store);
    const contractPath=join(projectRoot,'config','incumbent-supplier.json');
    this.incumbent=existsSync(contractPath)?new IncumbentSupplierBook(this.store,JSON.parse(readFileSync(contractPath,'utf8'))):null;
    this.base = 'https://the-stall.intuitek.ai'; this.busy = false; this.ready = true; this.rate = new Map();
    this.caps = caps.map(c => {
      let sourceHash = null; try { sourceHash = hash(readFileSync(join(projectRoot,'capabilities',c.name+'.js'))); } catch {}
      return instrumentCapability(c,this.store,{ attribution,sourceHash,supplierBook:this.incumbent,
        stopped:()=>existsSync(join(this.root,'state','STOP_ASTRA_WORK'))||existsSync('/var/lib/sol-seat/state/STOP_SOL') });
    });
    for (const e of config.experiments || []) this.store.experiment(e);
    if (schedule) { this.timer = setInterval(() => this.refresh().catch(() => {}),60000); this.timer.unref(); queueMicrotask(() => this.refresh().catch(() => {})); }
  }
  async refresh() {
    if (this.busy) return; this.busy = true;
    try {
      const corrections = loadDemandClassificationCorrections(join(this.project,'data','demand_classification_corrections.jsonl'));
      for (const name of ['settlement.jsonl','mcp_payments.jsonl']) {
        // Up to 4 MiB per source on first import, then 256 KiB per cycle. Bounded and resumable.
        const initial = !this.store.meta('cursor:' + name);
        for (let i=0; i < (initial ? 16 : 1); i++) {
          const c = await ingestLog(this.store,join(this.project,'logs',name),name,{ corrections,ownedPayers:this.config.owned_payers || [] });
          if (c.complete_retained_file || c.state) break;
        }
      }
      await importPinnedEvidence(this.store,this.root,this.config.evidence || []);
      await importReviewedCosts(this.store,this.directory);
      await importExecutionCosts(this.store,this.directory);
      if(this.incumbent){
        const path=join(this.directory,'incumbent-reconciliation.json');
        if(existsSync(path)){
          try {
            const raw=await readFile(path);if(raw.length>262144)throw new Error('reconciliation_limit');
            const proofs=JSON.parse(raw);if(!Array.isArray(proofs)||proofs.length>100)throw new Error('reconciliation_limit');
            for(const proof of proofs)this.incumbent.reconcile(proof);
          } catch {this.store.issue('incumbent-reconciliation',{kind:'INCUMBENT_RECONCILIATION_INVALID_OR_UNBOUND'});}
        }
      }
      try { await importSupplierEvidence(this.procurement,this.directory); }
      catch { this.store.issue('supplier-reconciliation',{kind:'SUPPLIER_EVIDENCE_INVALID_OR_UNBOUND'}); }
      if(this.config.external_observers === true && !existsSync(join(this.root,'state','STOP_ASTRA_WORK')) && !existsSync('/var/lib/sol-seat/state/STOP_SOL')) {
        await observeNextTransfer(this.store,this.config.owned_payers || []);
        await observeDiscovery(this.store);
        await observeSearchPositions(this.store);
      }
      const episodes=this.store.episodes();
      const executionCosts=executionCostAudit(this.store,episodes);
      await writeProjection(join(this.directory,'execution-costs.json'),executionCosts);
      const costCoverage=transactionCostCoverage(this.store,episodes,this.incumbent?.contract,executionCosts);
      await writeProjection(join(this.directory,'transaction-costs.json'),costCoverage);
      const report = this.store.summary();
      report.settlement_accounting_policy = CDP_SETTLEMENT_ACCOUNTING;
      report.incumbent_supplier = this.incumbent?.summary() ?? null;
      report.cost_coverage={source:'transaction-costs.json',sha256:hash(JSON.stringify(costCoverage)),
        complete:costCoverage.complete,transactions:costCoverage.transactions.length,missing_by_class:costCoverage.missing_by_class,
        usage_coverage:costCoverage.usage_coverage};
      report.recurrence_portfolio=recurrencePortfolio(episodes,this.config.experiments||[],Date.now(),this.config.control_windows||[]);
      report.execution_costs={source:'execution-costs.json',sha256:hash(JSON.stringify(executionCosts)),
        coverage_started_at:executionCosts.coverage_started_at,executions:executionCosts.rows.length,
        unresolved:executionCosts.rows.filter(r=>!r.complete).length};
      report.procurement_ledger = this.procurement.summary();
      report.procurement = {admitted_incumbent_suppliers:report.incumbent_supplier?.admission==='ADMITTED_EXISTING_FULFILLMENT'?1:0,
        general_purpose_contracts:report.procurement_ledger.contracts,
        incumbent_requests_dispatched:report.incumbent_supplier?.purchases??0,
        new_discretionary_budget_usd_micros:'0',wallet_payments_issued_by_this_module:0};
      report.model_calls_scope='Observation worker only; incumbent supplier dispatches are reported separately';
      report.control_windows = this.config.control_windows || [];
      try {
        const raw = await readFile(join(this.root,'state','stall_remora_status.json'));
        const hunt = JSON.parse(raw);
        report.hunt = { as_of:hunt.as_of,status:hunt.status,capture_states:hunt.capture_states,
          source_sha256:hash(raw), authority:'EXISTING_REMORA; clocks and admission unchanged' };
      } catch { report.hunt = { state:'UNAVAILABLE' }; }
      const observations = episodes.map(e => ({ capability:e.capability, at:e.payment_at||e.at, excluded:e.excluded,
        payer_token:e.payer_token,
        experiment_id:e.experiment_id, outside_payment_verified:e.outside_payment_verified,
        contribution_usd_micros:e.contribution.contribution_usd_micros, fulfillment_verified:e.fulfillment_verified,
        qualified_exposure:false,buyer_useful:e.usefulness_confirmed }));
      report.experiments = (this.config.experiments || []).map(e => ({ ...e,
        evaluation:applyExecutionCostGate(e,evaluateExperiment(e,observations),executionCosts) }));
      // Both decision surfaces must use the same all-execution accounting gate.
      for(const row of report.recurrence_portfolio){
        const trial=report.experiments.find(e=>e.id===row.experiment_id);
        if(trial){
          row.execution_costs=trial.evaluation.execution_costs;
          if(trial.evaluation.action==='RECONCILE')row.action='RECONCILE_ALL_EXECUTION_COSTS';
          if(trial.evaluation.action==='RETIRE_EXPERIMENT')row.action='RETIRE_EXPERIMENT';
          if(row.action==='ELIGIBLE_FOR_BOUNDED_EXPANSION_REVIEW'&&trial.evaluation.action!=='EXPANSION_REVIEW')row.action='EXPANSION_NOT_ELIGIBLE';
        }
      }
      for(const experiment of report.experiments)this.store.decision(experiment.id,experiment.evaluation);
      report.next_actions = [
        { piece:'costs', action:'RECONCILE_TRANSACTION_COST_COMPONENTS', source:'transaction-costs.json', evidence:COST_LEDGER_NOTE },
        { piece:'selection', action:'COMPARE_QUERY_VISIBILITY_AND_PLAN_LINKED_SELECTION_FEEDBACK', limitation:'Search position is not a buyer impression; no loss reason inferred from silence' },
        { piece:'procurement', action:this.incumbent?'EXISTING_VISION_SUPPLIER_BUDGET_ENFORCED':'SUPPLIER_CONTRACT_REQUIRED',
          per_execution_budget_usd_micros:this.incumbent?.contract.per_execution_budget_usd_micros??'0',new_discretionary_budget_usd_micros:'0' },
        { piece:'retention',action:'USE_VERIFIED_PAYER_RETURN_DAYS_WITHIN_IMMUTABLE_EXPERIMENT_WINDOWS',source:'recurrence_portfolio' }
      ];
      await writeProjection(join(this.directory,'status.json'),report);
      await writeProjection(join(this.directory,'hunt-evidence.json'),{ schema:'stall-commercial-hunt-evidence/v1',as_of:report.as_of,
        source:'data/commercial-loop/status.json', status_sha256:hash(JSON.stringify(report)),
        verified_outside_transfers:report.verified_outside_transfers,cost_complete:report.cost_complete,
        contribution_usd_micros:report.contribution_usd_micros, by_capability:report.by_capability,
        search_visibility:report.search_visibility,selection_feedback:report.selection_feedback,
        procurement_ledger:report.procurement_ledger,incumbent_supplier:report.incumbent_supplier,
        cost_coverage:report.cost_coverage,settlement_accounting_policy:report.settlement_accounting_policy,
        execution_costs:report.execution_costs,recurrence_portfolio:report.recurrence_portfolio,
        decisions:report.experiments, next_actions:report.next_actions,
        authority:'EVIDENCE_ONLY; existing Remora admission/capture remains authoritative' });
      if (this.dreamReplay) {
        try {
          const replayReport = await this.dreamReplay.refresh();
          await writeProjection(join(this.directory, 'dream-replay-status.json'), replayReport);
        } catch (e) { this.dreamReplay.fault('REFRESH', e); }
      }
      this.summary = report; this.lastRefresh = Date.now();
    } catch(e) { this.store.issue('refresh',{ kind:'REFRESH_FAILED',code:e.code || 'ANALYSIS_FAILED' }); }
    finally { this.busy = false; }
  }
  close() { clearInterval(this.timer); this.dreamReplay?.close(); this.store.close(); }
}

export function startCommercialLoop(caps, options = {}) {
  if (runtime) return runtime.caps;
  let config;
  try { config = JSON.parse(readFileSync(join(project,'config','commercial-loop.json'),'utf8')); }
  catch { return caps; }
  if (config.enabled !== true) return caps;
  try { runtime = new CommercialRuntime(caps,config,options); return runtime.caps; }
  catch(e) { console.error('[commercial-loop] initialization failed:',e.code || e.name); return caps; }
}

async function requestJSON(req) {
  if (req.body && typeof req.body === 'object') {
    if (Buffer.byteLength(JSON.stringify(req.body)) > MAX_BODY) throw new Error('body_too_large'); return req.body;
  }
  const chunks=[]; let n=0;
  const timer=setTimeout(() => req.destroy(),5000); timer.unref();
  try { for await (const c of req) { n+=c.length; if(n>MAX_BODY) throw new Error('body_too_large');chunks.push(c); } }
  finally {clearTimeout(timer);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const send = (res,status,body) => { res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body)); };

export function handleCommercialHttp(req,res,context) {
  if (!runtime) return false;
  const path = req.path || String(req.url || '').split('?')[0];
  if (path.startsWith('/cap/')) {
    const cap = path.slice(5);
    if (/^[a-z0-9-]{1,80}$/.test(cap)) {
      const declared = declaredContext(req.headers?.['x-stall-demand-context']);
      // Preserve only buyer-declared context. Unadorned discovery traffic stays in existing bounded logs.
      if (declared) res.once('finish', () => {
        try { runtime.store.ingest({ id:hash(['request',context.request_id,cap]), kind:'request',
          ts:new Date().toISOString(), cap,request_id:context.request_id,excluded:Boolean(excluded(context)),
          data:{context:declared,http_status:res.statusCode} }); } catch {}
      });
    }
    return false;
  }
  if (!['/v1/resolve','/v1/selection-feedback','/v1/fulfillment-feedback','/.well-known/stall-commercial-loop.json'].includes(path)) return false;
  const key=runtime.store.token(req.ip || 'unknown'), minute=Math.floor(Date.now()/60000);
  for (const [k,v] of runtime.rate) if (v.minute!==minute) runtime.rate.delete(k);
  const bucket=runtime.rate.get(key) || {minute,n:0}; bucket.n++;runtime.rate.set(key,bucket);
  if (bucket.n>20 || runtime.rate.size>1000) {send(res,429,{error:'rate_limited'});return true;}
  if (path==='/.well-known/stall-commercial-loop.json' && req.method==='GET') {
    send(res,200,{schema:VERSION,resolve:`${runtime.base}/v1/resolve`,feedback:`${runtime.base}/v1/fulfillment-feedback`,
      selection_feedback:`${runtime.base}/v1/selection-feedback`,
      requirements:['us-market-participation','company-balance-sheet','upcoming-us-earnings'],
      observed_context_header:'X-Stall-Demand-Context: base64 JSON; voluntary buyer declaration',
      feedback_token_header:'X-Stall-Evidence-Token; bearer token for reporting usefulness, not proof of payment',
      state:runtime.lastRefresh?'RUNNING':'STARTING',last_refresh:runtime.lastRefresh?new Date(runtime.lastRefresh).toISOString():null,
      behavior:'Plans reference existing separately paid capabilities; no automatic supplier payments',
      example:{requirements:[{dependency:'company-balance-sheet',params:{ticker:'AAPL',period:'annual'}}]}});return true;
  }
  if(req.method!=='POST'){send(res,405,{error:'method_not_allowed'});return true;}
  Promise.resolve().then(async()=>{
    const body=await requestJSON(req);
    if(path==='/v1/resolve') {
      const plan=resolveRequirements(body,runtime.caps,runtime.base);
      plan.opportunity_id='opp_'+randomUUID();
      plan.opportunity_proof=opportunityProof(runtime.store,plan.opportunity_id);
      plan.selection_feedback={url:`${runtime.base}/v1/selection-feedback`,method:'POST',
        fields:['opportunity_proof','step_id','decision','reason','selected_provider'],
        decisions:['selected','rejected','deferred'],expires_after_seconds:604800,
        verification:'Voluntary bearer report; not independent buyer or payment proof'};
      for(const step of plan.steps) {
        const cap=step.capability || 'unresolved';
        const requestId=plan.opportunity_id+':'+step.id;
        step.demand_episode_id='dep_'+hash([requestId,cap]).slice(0,32);
        step.discovery_evidence=runtime.store.searchEvidence(cap).map(d=>({query:d.query,observed_at:d.observed_at,
          surface:d.surface,position:d.position,listing:d.listing,exact_capability_match:d.exact_capability_match??null,
          stale:d.stale,response_sha256:d.response_sha256,scope:'Provider visibility snapshot; not buyer selection'}));
        runtime.store.ingest({id:hash(['resolution',requestId]),kind:'requirement_resolution',ts:new Date().toISOString(),
          cap,request_id:requestId,excluded:Boolean(excluded(context)),
          data:{context:{objective:bounded(body.objective),missing_dependency:step.dependency,
            opportunity_id:plan.opportunity_id,provenance:'BUYER_DECLARED_UNVERIFIED'},
            resolution:{plan_id:plan.plan_id,status:plan.status,eligible:step.eligible,reasons:step.reasons,
              quoted_price_usd_micros:step.declared_price_usd_micros,selection:'PROVIDER_PROPOSAL; BUYER_SELECTION_UNKNOWN'}}});
      }
      send(res,200,plan);return;
    }
    if(path==='/v1/selection-feedback'){send(res,200,recordSelection(runtime.store,body));return;}
    if(typeof body.evidence_token!=='string'||body.evidence_token.length>180)throw new Error('invalid_evidence_token');
    const [id,at,sig]=body.evidence_token.split('.');
    if(!/^exe_[a-f0-9-]{36}$/.test(id)||!/^\d{13}$/.test(at)||!/^[a-f0-9]{64}$/.test(sig||'')||Date.now()-Number(at)>7*86400000||Number(at)>Date.now()+1000)throw new Error('invalid_evidence_token');
    if(!timingSafeEqual(Buffer.from(sig),Buffer.from(runtime.store.token(`${id}.${at}`))))throw new Error('invalid_evidence_token');
    if(typeof body.useful!=='boolean')throw new Error('useful_must_be_boolean');
    const row=runtime.store.db.prepare('SELECT body FROM events WHERE id=? AND kind=?').get(id,'fulfillment');
    if(!row)throw new Error('execution_not_observed');
    const event=JSON.parse(row.body);
    runtime.store.ingest({id:hash(['feedback',id,body.useful,bounded(body.next_dependency)]),kind:'buyer_feedback',ts:new Date().toISOString(),
      cap:event.cap,request_id:event.request_id,excluded:event.excluded,
      data:{execution_id:id,useful:body.useful,next_dependency:bounded(body.next_dependency),provenance:'TOKEN_BEARER_REPORTED_UNVERIFIED'}});
    send(res,200,{recorded:true,verification:'BUYER_REPORTED; not independent outcome proof'});
  }).catch(e=>{if(!res.writableEnded)send(res,400,{error:['invalid_evidence_token','execution_not_observed','useful_must_be_boolean'].includes(e.message)?e.message:'invalid_request'});});
  return true;
}
