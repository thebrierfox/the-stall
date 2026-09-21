// Uses a local in-memory MCP server and a deliberately invalid synthetic signature.
// There is no RPC, facilitator, on-chain transaction or production paid request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as mcp from '@x402/mcp';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { makePaymentGate, validateSettlement, NETWORK, PAYEE, USDC } from './stall-buyer.mjs';
const factory=mcp.createX402MCPClient??mcp.createx402MCPClient;
async function fixture(ceiling) {
  const dir=mkdtempSync(join(tmpdir(),'stall-sdk-test-'));
  let signatures=0,paidCalls=0;
  const paymentRequired={x402Version:2,resource:{url:'mcp://tool/earnings-calendar'},accepts:[{scheme:'exact',network:NETWORK,asset:USDC,payTo:PAYEE,amount:'10000',maxTimeoutSeconds:300,extra:{name:'USD Coin',version:'2'}}]};
  const server=new McpServer({name:'synthetic-stall',version:'1.0.0'});
  server.tool('earnings-calendar','Synthetic paid tool',{},async(args,extra)=>{
    if(!extra?._meta?.['x402/payment'])return {isError:true,structuredContent:paymentRequired,content:[{type:'text',text:JSON.stringify(paymentRequired)}]};
    paidCalls++;
    return {content:[{type:'text',text:'synthetic result'}],_meta:{'x402/payment-response':{success:true,network:NETWORK,transaction:'0x'+'12'.repeat(32)}}};
  });
  const signer={address:'0x'+'11'.repeat(20),signTypedData:async()=>{signatures++;return '0x'+'00'.repeat(65);}};
  const client=factory({name:'synthetic-buyer',version:'1.0.0',schemes:[{network:NETWORK,client:new ExactEvmScheme(signer)}],autoPayment:true,onPaymentRequested:makePaymentGate({tool:'earnings-calendar',ceiling,receiptPath:join(dir,'receipt.jsonl')})});
  const[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(b);await client.connect(a);
  return {client,counters:()=>({signatures,paidCalls}),close:async()=>{await client.close();await server.close();rmSync(dir,{recursive:true,force:true});}};
}
test('installed SDK signs and sends MCP metadata only after budget gate',async()=>{const f=await fixture('0.010');try{const result=await f.client.callTool('earnings-calendar',{});assert.equal(result.paymentMade,true);validateSettlement(result);assert.deepEqual(f.counters(),{signatures:1,paidCalls:1});}finally{await f.close();}});
test('installed SDK cannot sign over-budget or send a paid retry',async()=>{const f=await fixture('0.009');try{await assert.rejects(()=>f.client.callTool('earnings-calendar',{}));assert.deepEqual(f.counters(),{signatures:0,paidCalls:0});}finally{await f.close();}});
