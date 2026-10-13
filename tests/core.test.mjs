import test from 'node:test';
import assert from 'node:assert/strict';
import ts from '../docs/integrations/typescript.cjs';
import {analyzeWorkspace,defaultPolicy,sampleFiles,generateBoundaryTests,findPatches,applyPatch,acceptedPath,languageFromPath,dependencyEdges,failsPolicy,makeReceipt} from '../docs/assets/core.mjs';
const jf=(content,path='foo.js')=>({path,language:'javascript',content});
test('supported file types and traversal/blocked paths',()=>{
 assert.equal(languageFromPath('src/test.ts'),'typescript');assert.equal(languageFromPath('src/test.py'),'python');assert.equal(acceptedPath('src/app.js'),true);assert.equal(acceptedPath('../secrets.js'),false);assert.equal(acceptedPath('src/../../secret.py'),false);assert.equal(acceptedPath('node_modules/a.js'),false);
});
test('JavaScript parser produces exact syntax issues',()=>{
 const result=analyzeWorkspace([jf('function x( {')]);
 assert.equal(result.parsed,0);assert.ok(result.findings.some(f=>f.rule==='JS_PARSE'));
});
test('security and quality findings and function discovery',()=>{
 const result=analyzeWorkspace(sampleFiles,{ts});
 assert.ok(result.functions.some(f=>f.name==='clamp'&&f.params===3));
 assert.ok(result.functions.some(f=>f.name==='average'));
 assert.ok(result.findings.some(f=>f.rule==='JS_DYNAMIC_EXEC'&&f.severity==='critical'));
 assert.ok(result.findings.some(f=>f.rule==='JS_CONSOLE'));
 assert.ok(failsPolicy(result,defaultPolicy).length>0);
 assert.ok(result.score<100);
});
test('TypeScript parser reports invalid syntax',()=>{
 const bad={path:'src/bad.ts',language:'typescript',content:'export function x(: number) {}'};
 const result=analyzeWorkspace([bad],{ts});
 assert.ok(result.findings.some(f=>f.rule==='TS_PARSE'));
});
test('generated property tests do not invent expected outputs',()=>{
 const tests=generateBoundaryTests({file:'foo.js',name:'x',params:2},{args:[1,2]});
 assert.equal(tests.length,8);assert.equal(tests[0].args.length,2);
 assert.ok(tests.every(t=>t.kind!=='expected'));
 assert.ok(tests.some(t=>t.kind==='determinism'));
});
test('patches only apply to standalone simple console statement and fail closed on stale source',()=>{
 const files=[jf('function demo(){\n  console.log("hello");\n  return 5;\n}\n')];
 const result=analyzeWorkspace(files);const patches=findPatches(files,result.findings);
 assert.equal(patches.length,1);const patched=applyPatch(files,patches[0]);
 assert.ok(!patched[0].content.includes('console.log'));
 assert.throws(()=>applyPatch(patched,patches[0]),/stale/i);
});
test('dependency references are mapped',()=>{
 const result=analyzeWorkspace([jf('import {x} from "./helper.js"; function f(){return x();}', 'src/main.js'),jf('export const x = () => 2;','src/helper.js')]);
 const edges=dependencyEdges(result.dependencies);assert.equal(edges[0].kind,'internal');
});
test('report exports hashes and unverified statements with abstention',async()=>{
 const files=[jf('function add(a,b){return a+b}')];const a=analyzeWorkspace(files);
 const receipt=await makeReceipt(files,a,[],defaultPolicy);
 assert.equal(receipt.hashes[0].sha256.length,64);assert.equal(receipt.authorship.result,'inconclusive');
 assert.ok(receipt.limitations.length>3);
});
test('expanded languages are inventoried as static-only without JS parse errors',()=>{
 const files=[
  {path:'pkg/main.go',language:'go',content:'package main\nimport "fmt"\nfunc main() { fmt.Println("hi") }'},
  {path:'src/main.rs',language:'rust',content:'use std::fs;\nfn main(){println!("Hello");}'},
  {path:'src/main.cpp',language:'cpp',content:'#include <cstdio>\nint main(){ return 0; }'},
  {path:'src/Program.cs',language:'csharp',content:'using System;\nclass A {}'},
 ];
 const a=analyzeWorkspace(files,{ts});
 assert.equal(a.files,4);assert.equal(a.parsed,0);
 assert.ok(a.dependencies['pkg/main.go'].includes('fmt'));
 assert.equal(a.findings.filter(f=>f.rule==='JS_PARSE').length,0);
 assert.equal(languageFromPath('src/Thing.java'),'java');
});
test('Acorn walk finds arrow functions nested in scopes',()=>{
 const a=analyzeWorkspace([jf('function outer(){const inner=(x)=>x+1;return inner(2)}')]);
 assert.ok(a.functions.some(f=>f.name==='inner'));
});
