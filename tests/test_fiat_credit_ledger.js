import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createFiatCreditLedger, attachCreditOutcome } from '../src/fiat-credit-ledger.js';
function fixture(t, credits=2) {
  const dir=mkdtempSync(join(tmpdir(),'fiat-credit-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'ledger.json');writeFileSync(path,JSON.stringify({customer:{credits,granted:credits,existing:'preserve'}}));
  return {path,ledger:createFiatCreditLedger(path,{instance:'first'}),read:()=>JSON.parse(readFileSync(path))};
}
function response(status=200) {
  const r=new EventEmitter();r.statusCode=status;r.headersSent=false;r.headers={};
  r.setHeader=(k,v)=>r.headers[k]=v;r.removeHeader=k=>delete r.headers[k];
  r.destroy=()=>r.emit('close');r.end=function(body){r.body=body;r.headersSent=true;r.emit('finish');r.emit('close');return r;};return r;
}
test('one credit reserved and consumed only after successful finish',t=>{
  const f=fixture(t);const reservation=f.ledger.reserve('customer');const r=response();attachCreditOutcome(r,f.ledger,reservation);
  assert.equal(f.read().customer.credits,1);assert.equal(Object.keys(f.read().customer.pending_credit_calls).length,1);
  r.end('ok');assert.equal(f.read().customer.credits,1);assert.deepEqual(f.read().customer.pending_credit_calls,{});
});
for(const status of [400,402,404,422,500,503]) test(`HTTP ${status} releases credit before response`,t=>{
  const f=fixture(t,1);const r=response(status);attachCreditOutcome(r,f.ledger,f.ledger.reserve('customer'));
  r.end('error');assert.equal(f.read().customer.credits,1);assert.equal(r.headers['X-Fiat-Credits-Remaining'],'1');
  assert.equal(f.read().customer.existing,'preserve');
});
test('double close/finish cannot release twice',t=>{
  const f=fixture(t,1);const r=response(500);attachCreditOutcome(r,f.ledger,f.ledger.reserve('customer'));
  r.end();r.emit('close');r.emit('finish');assert.equal(f.read().customer.credits,1);
});
test('disconnect without completion releases the reservation',t=>{
  const f=fixture(t,1);const r=response();attachCreditOutcome(r,f.ledger,f.ledger.reserve('customer'));r.emit('close');assert.equal(f.read().customer.credits,1);
});
test('concurrent calls cannot spend the same last credit',t=>{
  const f=fixture(t,1);const a=f.ledger.reserve('customer');assert.equal(f.ledger.reserve('customer'),null);
  f.ledger.finish(a,false);assert.ok(f.ledger.reserve('customer'));
});
test('out-of-order completion reloads current ledger and preserves unrelated updates',t=>{
  const f=fixture(t,2);const a=f.ledger.reserve('customer'),b=f.ledger.reserve('customer');
  const current=f.read();current.other={credits:8};writeFileSync(f.path,JSON.stringify(current));
  f.ledger.finish(b,true);f.ledger.finish(a,false);assert.equal(f.read().customer.credits,1);assert.equal(f.read().other.credits,8);
});
test('restart recovers only outstanding reservations exactly once',t=>{
  const f=fixture(t,2);const a=f.ledger.reserve('customer'),b=f.ledger.reserve('customer');f.ledger.finish(a,true);
  const next=createFiatCreditLedger(f.path,{instance:'second'});assert.equal(next.recover(),1);assert.equal(next.recover(),0);assert.equal(f.read().customer.credits,1);
});
test('current instance recovery does not steal active reservations',t=>{
  const f=fixture(t,1);f.ledger.reserve('customer');assert.equal(f.ledger.recover(),0);assert.equal(f.read().customer.credits,0);
});
test('corrupt ledger is rejected without rewriting it',t=>{
  const f=fixture(t);writeFileSync(f.path,'broken');assert.throws(()=>f.ledger.reserve('customer'));assert.equal(readFileSync(f.path,'utf8'),'broken');
});
test('invalid credit balances are rejected',t=>{
  const f=fixture(t);writeFileSync(f.path,JSON.stringify({customer:{credits:-1}}));assert.throws(()=>f.ledger.reserve('customer'));
});
test('unknown or exhausted token cannot reserve credit',t=>{
  const f=fixture(t,0);assert.equal(f.ledger.reserve('unknown'),null);assert.equal(f.ledger.reserve('customer'),null);
});
test('failed persistence produces 503 and never claims a refund',()=>{
  const r=response(400);const ledger={finish(){throw new Error('private path');}};const logs=[];
  attachCreditOutcome(r,ledger,{}, {error:x=>logs.push(x)});r.end('old error');
  assert.equal(r.statusCode,503);assert.equal(JSON.parse(r.body).error,'fiat_credit_ledger_unavailable');assert.ok(logs.every(x=>!x.includes('private path')));
});
test('200-shaped explicit error payload also releases its credit',t=>{
  const f=fixture(t,1);const r=response();r.json=function(body){return this.end(JSON.stringify(body));};
  attachCreditOutcome(r,f.ledger,f.ledger.reserve('customer'));r.json({error:'provider_unavailable'});
  assert.equal(f.read().customer.credits,1);assert.equal(r.headers['X-Fiat-Credits-Remaining'],'1');
});
