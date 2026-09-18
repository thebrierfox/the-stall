import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { makeMcpHandler, readMcpPaymentStats } from "../src/mcp.js";

const saved = Object.fromEntries(["MCP_PAYMENT_MODE","MCP_PAYMENT_AUTHORIZED","MCP_FREE_TOOLS","MCP_PAID_TOOLS","WALLET_ADDRESS","X402_NETWORK","FACILITATOR_URL"].map(k=>[k,process.env[k]]));
const originalHandle = StreamableHTTPServerTransport.prototype.handleRequest;
const originalSupported = HTTPFacilitatorClient.prototype.getSupported;
const originalVerify = HTTPFacilitatorClient.prototype.verify;
const originalSettle = HTTPFacilitatorClient.prototype.settle;
const originalFetch = globalThis.fetch;
const address="0x0000000000000000000000000000000000000001";
const network="eip155:8453";
let executed=0, verified=0, settled=0, allowVerify=true, allowSettle=true, throwSettle=false;
const cap={name:"paid-protocol-fixture",price:"$0.010",description:"Synthetic paid transport fixture",
 inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"]},
 async handler(){executed++;return {paid_result:"SYNTHETIC_PAID_OUTPUT"};}};
const caps=[cap];
const startingStats=readMcpPaymentStats();
let requestId=1;
const handler=makeMcpHandler(caps);

// Replace only Node socket I/O with the installed transport's real Web Request
// adapter. Its Accept enforcement, response mode, MCP dispatch and x402 wrapper
// run unchanged. No socket, supplier, credentials or chain is available.
StreamableHTTPServerTransport.prototype.handleRequest=async function(req,res,body) {
 const wireHeaders={};
 for(let i=0;i<req.rawHeaders.length;i+=2)wireHeaders[req.rawHeaders[i]]=req.rawHeaders[i+1];
 const rawAccept=Object.entries(wireHeaders).find(([k])=>k.toLowerCase()==="accept")?.[1];
 assert.equal(rawAccept,req.headers.accept,"Node and raw headers must agree");
 const response=await this._webStandardTransport.handleRequest(new Request("https://stall.invalid/mcp",{
  method:"POST",headers:wireHeaders,body:JSON.stringify(body)
 }),{parsedBody:body});
 res.statusCode=response.status;res.contentType=response.headers.get("content-type");res.body=await response.text();
};
HTTPFacilitatorClient.prototype.getSupported=async()=>({kinds:[{x402Version:2,scheme:"exact",network}],extensions:[],signers:{}});
HTTPFacilitatorClient.prototype.verify=async()=>{verified++;return {isValid:allowVerify,payer:address,...(!allowVerify?{invalidReason:"invalid_signature"}:{})};};
HTTPFacilitatorClient.prototype.settle=async()=>{settled++;if(throwSettle)throw Error("SYNTHETIC_SETTLEMENT_UNAVAILABLE");return {success:allowSettle,payer:address,network,transaction:allowSettle?"0xsynthetic":"",...(!allowSettle?{errorReason:"synthetic_settlement_failed"}:{})};};
globalThis.fetch=async()=>{throw Error("Unexpected network call in isolated protocol fixture");};
process.env.MCP_PAYMENT_MODE="all";process.env.MCP_PAYMENT_AUTHORIZED="D92_LIFTED";
process.env.WALLET_ADDRESS=address;process.env.X402_NETWORK=network;process.env.FACILITATOR_URL="https://facilitator.invalid";
delete process.env.MCP_FREE_TOOLS;delete process.env.MCP_PAID_TOOLS;
test.after(()=>{
 StreamableHTTPServerTransport.prototype.handleRequest=originalHandle;
 HTTPFacilitatorClient.prototype.getSupported=originalSupported;HTTPFacilitatorClient.prototype.verify=originalVerify;HTTPFacilitatorClient.prototype.settle=originalSettle;
 globalThis.fetch=originalFetch;
 for(const[k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;
});
async function request(accept,method,params={}) {
 const id=requestId++,headers={"content-type":"application/json",...(accept===null?{}:{accept})};
 const req={headers,rawHeaders:Object.entries(headers).flat(),body:{jsonrpc:"2.0",id,method,params}};
 const res=new EventEmitter();res.headersSent=false;res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.body=JSON.stringify(value);res.contentType="application/json";return res;};
 await handler(req,res);res.emit("close");
 const raw=res.contentType?.startsWith("text/event-stream")?res.body.split("\n").find(l=>l.startsWith("data: "))?.slice(6):res.body;
 return {status:res.statusCode,type:res.contentType,message:JSON.parse(raw),id};
}
const init={protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"isolated-protocol-fixture",version:"1"}};
for(const[accept,type]of [
 ["application/json","application/json"],
 ["application/json; charset=utf-8","application/json"],
 ["Application/JSON","application/json"],
 ["application/json, text/event-stream;q=0","application/json"],
 ["application/json, text/event-stream","text/event-stream"],
 ["Application/JSON, Text/Event-Stream","text/event-stream"],
 ["application/*","application/json"],
 ["application/json, */*;q=0","application/json"],
 ["*/*","text/event-stream"],
 [null,"text/event-stream"]
])test("initialize negotiates "+String(accept),async()=>{
 const r=await request(accept,"initialize",init);
 assert.equal(r.status,200);assert.ok(r.type.startsWith(type),r.type);assert.equal(r.message.id,r.id);assert.equal(r.message.result.serverInfo.name,"The Stall");assert.equal(executed,0);
});
test("JSON-only buyer lists paid tools with unchanged price and payment boundary",async()=>{
 const r=await request("application/json","tools/list");
 assert.equal(r.status,200);assert.ok(r.type.startsWith("application/json"));
 const tool=r.message.result.tools.find(t=>t.name===cap.name);
 assert.match(tool.description,/PAID MCP TOOL/);assert.match(tool.description,/\$0.010/);assert.equal(executed,0);
});
let challenge;
test("JSON-only unpaid call receives usable native payment challenge, never paid output",async()=>{
 const r=await request("application/json","tools/call",{name:cap.name,arguments:{query:"synthetic"}});
 assert.equal(r.status,200);assert.equal(executed,0);assert.equal(verified,0);assert.equal(settled,0);
 assert.equal(JSON.stringify(r.message).includes("SYNTHETIC_PAID_OUTPUT"),false);
 assert.equal(r.message.result?.isError,true,JSON.stringify(r.message));
 challenge=r.message.result.structuredContent;
 assert.equal(challenge.x402Version,2);assert.equal(challenge.accepts[0].amount,"10000");assert.equal(challenge.accepts[0].payTo,address);
});
test("SSE buyer receives the same unpaid payment challenge",async()=>{
 const r=await request("application/json, text/event-stream","tools/call",{name:cap.name,arguments:{query:"synthetic"}});
 assert.equal(r.status,200);assert.ok(r.type.startsWith("text/event-stream"));
 assert.equal(r.message.result?.isError,true,JSON.stringify(r.message));assert.deepEqual(r.message.result.structuredContent.accepts,challenge.accepts);assert.equal(executed,0);
});
test("invalid JSON-RPC retains protocol rejection",async()=>{
 const r=await request("application/json","unknown-method",{});
 assert.equal(r.message.error.code,-32601);assert.equal(executed,0);
});

function paidParams(){
 return {name:cap.name,arguments:{query:"synthetic"},_meta:{"x402/payment":{
  x402Version:2,resource:challenge.resource,accepted:challenge.accepts[0],
  payload:{signature:"SYNTHETIC_SIGNATURE_NO_REAL_AUTHORIZATION",authorization:{
   from:address,to:address,value:"10000",validAfter:"0",validBefore:"9999999999",nonce:"0x"+"a".repeat(64)
  }}
 }}};
}
test("JSON-only invalid payment cannot execute or return paid output",async()=>{
 allowVerify=false;
 const r=await request("application/json","tools/call",paidParams());
 assert.equal(r.status,200);assert.equal(r.message.result?.isError,true,JSON.stringify(r.message));
 assert.equal(verified,1);assert.equal(executed,0);assert.equal(settled,0);
 assert.equal(JSON.stringify(r.message).includes("SYNTHETIC_PAID_OUTPUT"),false);
 allowVerify=true;
});
test("JSON-only verified and settled synthetic payment returns paid result",async()=>{
 const r=await request("application/json","tools/call",paidParams());
 assert.equal(r.status,200);assert.ok(r.type.startsWith("application/json"));
 assert.notEqual(r.message.result?.isError,true,JSON.stringify(r.message));
 assert.equal(verified,2);assert.equal(executed,1);assert.equal(settled,1);
 assert.ok(JSON.stringify(r.message.result).includes("SYNTHETIC_PAID_OUTPUT"));
});
test("JSON-only failed settlement withholds paid result",async()=>{
 allowSettle=false;
 const r=await request("application/json","tools/call",paidParams());
 assert.equal(r.status,200);assert.equal(r.message.result?.isError,true,JSON.stringify(r.message));
 assert.equal(verified,3);assert.equal(settled,2);
 assert.equal(JSON.stringify(r.message).includes("SYNTHETIC_PAID_OUTPUT"),false);
 allowSettle=true;
});

test("thrown settlement withholds paid content and does not report successful payment",async()=>{
 throwSettle=true;
 const r=await request("application/json","tools/call",paidParams());
 assert.equal(r.status,200);assert.equal(r.message.result?.isError,true,JSON.stringify(r.message));
 assert.equal(verified,4);assert.equal(settled,3);
 assert.equal(JSON.stringify(r.message).includes("SYNTHETIC_PAID_OUTPUT"),false);
 assert.notEqual(r.message.result?._meta?.["x402/payment-response"]?.success,true);
 throwSettle=false;
});
test("SSE failed settlement also withholds paid content",async()=>{
 allowSettle=false;
 const r=await request("application/json, text/event-stream","tools/call",paidParams());
 assert.equal(r.status,200);assert.ok(r.type.startsWith("text/event-stream"));
 assert.equal(r.message.result?.isError,true,JSON.stringify(r.message));
 assert.equal(verified,5);assert.equal(settled,4);
 assert.equal(JSON.stringify(r.message).includes("SYNTHETIC_PAID_OUTPUT"),false);
 allowSettle=true;
});

test("only confirmed synthetic settlement is counted as income",()=>{
 const stats=readMcpPaymentStats();
 assert.equal(stats.settlements-startingStats.settlements,1);
 assert.equal(Number((stats.revenue_usd-startingStats.revenue_usd).toFixed(6)),0.01);
});
