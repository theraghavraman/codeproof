import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {sandboxContract} from '../docs/assets/sandbox.mjs';

async function simulateWorker(source,testCase){
 const events=[];
 const self={postMessage:payload=>events.push(payload),fetch:()=>{throw Error('Should not call real network')}};
 const context=vm.createContext({self,performance:{now:()=>0},Promise,Error,JSON,Date,String,Array,Boolean,Number,Math,RegExp,Object,console});
 vm.runInContext(sandboxContract.jsWorkerSource,context,{timeout:1000});
 await self.onmessage({data:{id:'id1',source,test:testCase}});
 return events[0];
}
test('browser JS worker source is parseable',()=>{
 assert.doesNotThrow(()=>new Function(sandboxContract.jsWorkerSource));
 assert.doesNotThrow(()=>new Function(sandboxContract.pyWorkerSource));
});
test('sandboxed JS executes named function with arguments',async()=>{
 const result=await simulateWorker('function add(a,b){return a+b}',{functionName:'add',args:[2,3],kind:'expected'});
 assert.equal(result.output.ok,true);assert.equal(result.output.value,5);
});
test('sandboxed JS contains throws and captures printed output',async()=>{
 const result=await simulateWorker('function boom(x){ console.log("called",x);throw Error("bad input")}',{functionName:'boom',args:[2],kind:'smoke'});
 assert.equal(result.output.ok,false);assert.match(result.output.error,/bad input/);
 assert.match(result.output.logs[0],/called 2/);
});
test('sandbox reports unknown functions without leaking runtime errors',async()=>{
 const result=await simulateWorker('function real(){return 1}',{functionName:'missing',args:[],kind:'smoke'});
 assert.equal(result.output.ok,false);
 assert.match(result.output.error,/Function not found/);
});
test('sandbox iframe has opaque-origin policy and explicitly denied JS networking',()=>{
 const h=sandboxContract.makeSandboxHtml('javascript','s1');
 assert.match(h,/connect-src 'none'/);assert.match(h,/worker-src blob:/);
 assert.doesNotMatch(h,/allow-same-origin/);
});
test('python worker uses pinned Pyodide CDN; no native subprocess runner',()=>{
 const h=sandboxContract.makeSandboxHtml('python','s1');
 assert.match(h,/cdn.jsdelivr.net/);assert.match(sandboxContract.pyWorkerSource,/pyodide\.js/);
});
test('iframe bootstrap JavaScript parses for both sandboxes',()=>{
 for(const type of ['javascript','python']){
  const html=sandboxContract.makeSandboxHtml(type,'session');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(()=>new Function(script));
 }
});
test('Python worker produces valid multiline Python script when stubbed',async()=>{
 let captured='';const events=[];
 const self={postMessage:x=>events.push(x),fetch:()=>Promise.reject(Error('no network'))};
 const loadPyodide=async()=>({runPython:(source)=>{captured=source;return JSON.stringify({ok:true,value:3,same:true,logs:[]});}});
 const script=sandboxContract.pyWorkerSource;
 const sandbox={self,importScripts:()=>{},loadPyodide,performance:{now:()=>0},JSON,Error,Promise,String};
 vm.runInNewContext(script,sandbox,{timeout:1000});
 await self.onmessage({data:{type:'init'}});
 assert.equal(events[0].type,'ready');
 await self.onmessage({data:{type:'run',id:'one',source:'def f(x):\n return x + 1',test:{functionName:'f',args:[2],kind:'expected'}}});
 assert.ok(captured.includes('\n'));assert.match(captured,/exec\(/);
 assert.equal(events[1].output.value,3);
});
test('runner rejects unimplemented runtime languages instead of silently evaluating them as JS',async()=>{
 const {LocalTestRunner}=await import('../docs/assets/sandbox.mjs');
 const runner=new LocalTestRunner();
 const result=await runner.runOne({language:'go',content:'package main',path:'main.go'},{id:'a',title:'x',functionName:'main',file:'main.go',args:[],kind:'smoke'},100);
 assert.equal(result.status,'error');assert.match(result.message,/static inspection only/);
 runner.dispose();
});
test('Python worker grammar mode invokes AST parser without executing source',async()=>{
 const reported=[];let script='';
 const self={postMessage:x=>reported.push(x)};
 const sandbox={self,importScripts:()=>{},loadPyodide:async()=>({runPython:s=>{script=s;return 'syntax valid';}}),performance:{now:()=>1},JSON,Promise,Error,String};
 vm.runInNewContext(sandboxContract.pyWorkerSource,sandbox);
 await self.onmessage({data:{type:'init'}});
 await self.onmessage({data:{type:'syntax',id:'t',source:'def f():\n  return 1'}});
 assert.equal(reported[1].output.ok,true);
 assert.match(script,/ast\.parse/);
 assert.doesNotMatch(script,/exec\(/);
});
