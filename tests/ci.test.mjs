import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const project = new URL('../', import.meta.url).pathname;
async function withRepo(source, fn) {
 const dir=mkdtempSync(join(tmpdir(),'cp-ci-'));
 try {
  await fs.mkdir(join(dir,'.codeproof')); await fs.mkdir(join(dir,'src'));
  for(const name of ['cli.mjs','core.mjs','acorn.mjs','typescript.cjs']) await fs.copyFile(join(project,'docs','integrations',name),join(dir,'.codeproof',name));
  await fs.writeFile(join(dir,'src','test.js'),source);
  await fs.writeFile(join(dir,'.codeproof-policy.json'),JSON.stringify({version:1,maxFiles:100,maxFileBytes:250000,failOnSeverity:'critical',failOnParseError:true,ignorePaths:['.codeproof','.git','node_modules']}));
  return await fn(dir);
 } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
test('portable CI integration detects risky code and blocks at critical threshold',async()=>withRepo('function unsafe(input){return eval(input)}',async root=>{
 const x=spawnSync(process.execPath,['.codeproof/cli.mjs'],{cwd:root,encoding:'utf8'});
 assert.equal(x.status,1,x.stderr); assert.match(x.stdout,/JS_DYNAMIC_EXEC/);
 const json=JSON.parse(await fs.readFile(join(root,'codeproof-report.json'),'utf8'));
 assert.ok(json.summary.blocking>=1); assert.equal(json.execution.includes('not performed'),true);
}));
test('portable CI integration passes plain code without executing it',async()=>withRepo('export function add(a,b){return a+b;}',async root=>{
 const x=spawnSync(process.execPath,['.codeproof/cli.mjs'],{cwd:root,encoding:'utf8'});
 assert.equal(x.status,0,x.stderr); assert.match(x.stdout,/0 policy-blocking/);
}));
