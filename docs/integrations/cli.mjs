#!/usr/bin/env node
/** Portable static-only PR audit. No user code execution, no third-party calls. Node 22+. */
import { readdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ts from './typescript.cjs';
import { analyzeWorkspace, defaultPolicy, acceptedPath, languageFromPath, failsPolicy } from './core.mjs';

const root=process.cwd();
let policy=structuredClone(defaultPolicy);
try {
  const user=JSON.parse(await readFile(join(root,'.codeproof-policy.json'),'utf8'));
  if(user.version!==1 || !Number.isInteger(user.maxFiles)||user.maxFiles<=0||user.maxFiles>5000||!Number.isInteger(user.maxFileBytes)||user.maxFileBytes<1000||user.maxFileBytes>1_000_000||!Array.isArray(user.ignorePaths)||!['critical','high','medium','low','info','off'].includes(user.failOnSeverity))throw Error('Invalid policy schema');
  policy={...policy,...user};
}catch(e){if(e.code!=='ENOENT'){console.error('Policy validation failed:',e.message);process.exit(2);}}
const MAX_TOTAL=15_000_000;
let count=0,total=0,skipped=0;
const files=[];
async function walk(dir){
  const items=await readdir(dir,{withFileTypes:true});
  for(const item of items){
    const abs=join(dir,item.name),p=relative(root,abs).replaceAll('\\','/');
    if(item.isSymbolicLink())continue;
    if(item.isDirectory()){
      if(policy.ignorePaths.some(v=>p===v||p.startsWith(v+'/')||p.split('/').includes(v)))continue;
      await walk(abs);continue;
    }
    if(!item.isFile() || !languageFromPath(p) || !acceptedPath(p,policy))continue;
    const stats=await lstat(abs);
    if(stats.size>policy.maxFileBytes){skipped++;continue;}
    if(++count>policy.maxFiles){console.error('Too many files. Raise maxFiles policy cautiously.');process.exit(2);}
    total+=stats.size;if(total>MAX_TOTAL){console.error('Too much source data; 15 MB safety limit exceeded.');process.exit(2);}
    files.push({path:p,language:languageFromPath(p),content:await readFile(abs,'utf8')});
  }
}
await walk(root);
const result=analyzeWorkspace(files,{ts});
const blocking=failsPolicy(result,policy);
const payload={schema:'codeproof.pr-audit.v1',version:'1.0.0',time:new Date().toISOString(),policy,summary:{files:files.length,lines:result.lines,findings:result.findings.length,blocking:blocking.length,skipped},findings:result.findings,authorship:'inconclusive',execution:'not performed (static PR audit only)'};
await writeFile(join(root,'codeproof-report.json'),JSON.stringify(payload,null,2),'utf8');
console.log(`CodeProof: ${files.length} files, ${result.findings.length} findings, ${blocking.length} policy-blocking, ${skipped} skipped.`);
for(const f of result.findings.slice(0,200)){
  const file=f.file.replace(/[\r\n,:]/g,'_');const message=(`${f.rule}: ${f.title} — ${f.remediation}`).replace(/[\r\n]/g,' ').slice(0,500);
  console.log(`::${blocking.includes(f)?'error':'warning'} file=${file},line=${f.line},title=CodeProof ${f.severity}::${message}`);
}
if(process.env.GITHUB_STEP_SUMMARY){
 const {appendFile}=await import('node:fs/promises');
 await appendFile(process.env.GITHUB_STEP_SUMMARY,`## CodeProof static PR audit\n\n- Files: ${files.length}\n- Findings: ${result.findings.length}\n- Blocking: ${blocking.length}\n- User code executed: **No**\n\nDetailed JSON is in the workflow artifact.\n`);
}
if(blocking.length)process.exitCode=1;
