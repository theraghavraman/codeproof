// Compatibility facade used by the live inspector, Execution Lab, Fix & Verify and receipts.
// Per-file analysis delegates to the shared engine (docs/assets/engine) so both paths report identical rules.
import { analyzeJsFile } from './engine/js-rules.mjs';
import { analyzePythonFile } from './engine/python.mjs';
import { analyzeGenericFile } from './engine/generic.mjs';
import { analyzeConfigFile } from './engine/config.mjs';
import { makeFinding, sortFindings } from './engine/findings.mjs';
import { estimateProjectAuthorship } from './engine/authorship.mjs';
import { detectLanguage } from './engine/detect.mjs';

export const APP_VERSION = '2.0.0';
export const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];
export const defaultPolicy = {
  version: 1, maxFiles: 1000, maxFileBytes: 250000, failOnSeverity: 'critical', failOnParseError: true,
  ignorePaths: ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor', '__pycache__', '.venv', '.codeproof'],
};
export const sampleFiles = [
 {path:'src/payment.js',language:'javascript',content:`// Demo: intentionally contains issues to explore\nfunction calculateDiscount(price, percent) {\n  console.log('discount', price, percent);\n  if (percent < 0) return 0;\n  return price - price * percent / 100;\n}\n\nfunction divide(a, b) {\n  return a / b;\n}\n\nfunction cleanName(name) {\n  return name.trim().toLowerCase();\n}\n\nfunction unsafeEvaluate(input) {\n  return eval(input);\n}\n`},
 {path:'src/math.ts',language:'typescript',content:`export function clamp(value: number, min: number, max: number): number {\n  if (min > max) throw new Error('Invalid bounds');\n  return Math.max(min, Math.min(max, value));\n}\n\nexport function greet(name: string): string {\n  return 'Hello, ' + name;\n}\n`},
 {path:'scripts/stats.py',language:'python',content:`def average(numbers):\n    if not numbers:\n        return 0\n    return sum(numbers) / len(numbers)\n\ndef greet(name):\n    return "Hello, " + name.strip()\n\ndef reciprocal(value):\n    return 1 / value\n`}
];
export const sampleTests = [
 {id:'sample1',title:'20% discount',file:'src/payment.js',functionName:'calculateDiscount',args:[100,20],kind:'expected',expected:80,source:'user'},
 {id:'sample2',title:'200% discount should clamp',file:'src/payment.js',functionName:'calculateDiscount',args:[100,200],kind:'expected',expected:0,source:'user'},
 {id:'sample3',title:'12 divided by 3',file:'src/payment.js',functionName:'divide',args:[12,3],kind:'expected',expected:4,source:'user'},
 {id:'sample4',title:'TypeScript clamp',file:'src/math.ts',functionName:'clamp',args:[150,0,100],kind:'expected',expected:100,source:'user'},
 {id:'sample5',title:'Python average',file:'scripts/stats.py',functionName:'average',args:[[2,4,6]],kind:'expected',expected:4,source:'user'}
];
export const languageFromPath = path => /\.(jsx?|mjs|cjs)$/i.test(path)?'javascript':/\.(tsx?|mts|cts)$/i.test(path)?'typescript':/\.py$/i.test(path)?'python':/\.go$/i.test(path)?'go':/\.rs$/i.test(path)?'rust':/\.java$/i.test(path)?'java':/\.(c|cc|cpp|h|hpp)$/i.test(path)?'cpp':/\.cs$/i.test(path)?'csharp':null;
export const lineAt = (source,index) => source.slice(0,Math.max(0,index)).split('\n').length;
export const lengthInBytes = string => new TextEncoder().encode(string).length;
export function acceptedPath(path,policy=defaultPolicy) {
  const p=path.replace(/\\/g,'/').replace(/^\.\//,'');
  if(!p||p.startsWith('/')||/^[A-Za-z]:/.test(p)||p.split('/').includes('..')||p.split('/').includes(''))return false;
  if(policy.ignorePaths.some(part=>p===part||p.startsWith(part+'/')||p.split('/').includes(part)))return false;
  return languageFromPath(p)!==null;
}
export function validateWorkspace(files,policy=defaultPolicy){
  if(files.length>policy.maxFiles)throw Error(`File count exceeds policy limit of ${policy.maxFiles}.`);
  let total=0;
  for(const f of files){if(!acceptedPath(f.path,policy)&&!f.kind)throw Error('Unsafe or unsupported file path: '+f.path);if(lengthInBytes(f.content)>policy.maxFileBytes)throw Error('File exceeds maximum size: '+f.path);total+=lengthInBytes(f.content);if(total>14_000_000)throw Error('Total source exceeds 14 MB.');}
  return true;
}

const GENERIC = new Set(['go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'php', 'ruby', 'shell', 'sql']);
function analyzeOne(file, ts) {
  const language = file.language || detectLanguage(file.path, file.content);
  const f = { ...file, language };
  if (language === 'javascript' || language === 'typescript') return analyzeJsFile(f, { ts });
  if (language === 'python') return analyzePythonFile(f);
  if (GENERIC.has(language)) return analyzeGenericFile(f);
  return analyzeConfigFile(f);
}

// Per-file analysis for the live inspector. Project-level checks (type checking, integration graph,
// runtime) run in the full scan; this function never executes code.
export function analyzeWorkspace(files,{ts}={}) {
  const findings = [], functions = [], dependencies = {};
  let lines = 0, parsed = 0;
  const seen = new Set();
  for (const file of files) {
    lines += file.content.split('\n').length;
    let result;
    try { result = analyzeOne(file, ts); }
    catch (error) {
      result = { findings: [{ rule: 'ANALYZER_FAILURE', title: 'Analyzer failed on this file', category: 'quality', severity: 'info', verification: 'potential', file: file.path, line: 1, rootCause: `CodeProof could not analyze this file: ${error?.message || error}. Other files were analyzed.`, suggestion: 'Review this file manually.', analyzer: 'core' }], parse: { ok: false } };
    }
    if (result.parse?.ok && ['acorn', 'typescript', 'typescript-jsx', 'json-validator'].includes(result.parse.parser)) parsed++;
    for (const raw of result.findings || []) {
      const f = makeFinding(raw);
      const key = `${f.file}|${f.line}|${f.rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(f);
    }
    for (const fn of result.functions || []) functions.push({ name: fn.name, params: fn.params, file: file.path, line: fn.line, paramInfo: fn.paramInfo, topLevel: fn.topLevel, exported: fn.exported });
    const specs = (result.imports || []).map(i => i.specifier).concat((result.outline?.imports || []).map(i => '.'.repeat(i.level || 0) + i.module)).filter(Boolean).map(s => s.replace(/^[<"]|[>"]$/g, ''));
    dependencies[file.path] = [...new Set(specs)];
  }
  let signals = [];
  try {
    const estimate = estimateProjectAuthorship(files.map(f => ({ ...f, language: f.language || detectLanguage(f.path, f.content), kind: f.kind || 'source' })), []);
    signals = estimate.files.flatMap(e => e.indicators.map(i => ({ label: i.label, detail: `${e.path}${i.line ? ':' + i.line : ''} · ${e.note || ''}`.trim(), weight: i.weight })));
  } catch { /* the estimate is optional */ }
  if (!signals.length) signals.push({ label: 'No distinctive authorship evidence', detail: 'Code-only authorship attribution is inconclusive; no reliable probability can be calculated.', weight: 'weak' });
  const impact = { critical: 18, high: 9, medium: 5, low: 2, info: 0 };
  const score = Math.max(0, Math.round(100 - findings.filter(f => f.verification !== 'quality').reduce((n, f) => n + impact[f.severity], 0) / Math.max(1, Math.sqrt(files.length))));
  return { findings: sortFindings(findings), functions, dependencies, signals, files: files.length, lines, parsed, score, inspectedAt: new Date().toISOString() };
}
export function generateBoundaryTests(fn,baseTest){
  const n=Math.min(fn.params,8),pad=value=>Array.from({length:n},()=>value);
  const normal=baseTest?.args?.length===n?baseTest.args:pad(1);
  const variations=[['Normal input',normal,'smoke'],['Zero boundary',pad(0),'smoke'],['Negative boundary',pad(-1),'smoke'],['Null boundary',pad(null),'smoke'],['Empty string boundary',pad(''),'smoke'],['Empty array boundary',pad([]),'smoke'],['Large numeric boundary',pad(1e12),'smoke'],['Repeatability',normal,'determinism']];
  return variations.map(([title,args,kind],idx)=>({id:`auto:${fn.file}:${fn.name}:${idx}`,title,file:fn.file,functionName:fn.name,args,kind,source:'generated'}));
}
export function findPatches(files,findings){
  const out=[];
  for(const f of findings){if(!f.autofix)continue;const file=files.find(x=>x.path===f.file);if(!file)continue;
    const original=file.content.split('\n')[f.line-1];if(original===undefined)continue;
    const safe=f.autofix==='remove-debugger'?/^\s*debugger\s*;?\s*$/.test(original):/^\s*console\.(?:log|debug)\(.*\)\s*;?\s*$/.test(original);
    if(!safe)continue;
    out.push({id:f.id,file:f.file,line:f.line,title:f.autofix==='remove-debugger'?'Remove debugger statement':'Remove standalone console debug',reason:'Deterministic cleanup, but still requires regression testing.',before:original,after:''});
  }
  return out;
}
export function applyPatch(files,patch){
  return files.map(f=>{if(f.path!==patch.file)return f;const rows=f.content.split('\n');if(rows[patch.line-1]!==patch.before)throw Error('Patch is stale; inspect again.');rows.splice(patch.line-1,1);return {...f,content:rows.join('\n')};});
}
export function summarize(results){return {total:results.length,passed:results.filter(x=>x.status==='passed').length,failed:results.filter(x=>x.status==='failed').length,warnings:results.filter(x=>x.status==='warning').length,errors:results.filter(x=>x.status==='error').length};}
export function dependencyEdges(dependencies){
  const paths=Object.keys(dependencies),edges=[];
  for(const [from,toList] of Object.entries(dependencies))for(const target of toList){
    const parts=from.split('/').slice(0,-1);if(target.startsWith('.'))for(const part of target.split('/')){if(part==='..')parts.pop();else if(part!=='.')parts.push(part);}
    const resolved=parts.join('/'),internal=target.startsWith('.')?paths.find(p=>p===resolved||p.replace(/\.(jsx?|tsx?|py)$/,'')===resolved||p.replace(/\.(jsx?|tsx?)$/,'')===resolved.replace(/\.(jsx?|mjs|cjs)$/,'')):null;
    edges.push({from,to:internal|| (target.startsWith('.')?resolved:target),kind:internal?'internal':'external'});
  }return edges;
}
export function failsPolicy(analysis,policy){
  const max=severityOrder.indexOf(policy.failOnSeverity);
  return analysis.findings.filter(f=>(policy.failOnParseError&&f.category==='syntax'&&['confirmed-static','high-confidence'].includes(f.verification ?? 'confirmed-static'))||(max!==-1&&severityOrder.indexOf(f.severity)<=max));
}
export async function makeReceipt(files,analysis,results,policy){
  const hashes=[];
  for(const f of files){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(f.content));hashes.push({path:f.path,sha256:Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('')});}
  return {schema:'codeproof.receipt.v1',version:APP_VERSION,time:new Date().toISOString(),hashes,policy,
    summary:{files:analysis.files,lines:analysis.lines,qualityHeuristic:analysis.score,findings:analysis.findings.length,...summarize(results)},
    findings:analysis.findings,tests:results,authorship:{result:'inconclusive',probability:null,signals:analysis.signals,note:'No validated AI authorship classifier is installed. Style alone cannot prove authorship. See the full project scan for the secondary heuristic estimate.'},
    execution:{js:'Opaque-origin iframe (static sandbox page with CSP connect-src none) and dedicated worker',python:'Pyodide worker in the same sandbox; runtime files integrity-verified and loaded from this site, no network inside the sandbox',coverage:'Only supplied and generated cases executed'},
    limitations:['Tests cannot prove program correctness.','Smoke cases only establish no exception for the specific input.','No native process execution on GitHub Pages.','No verifiable authorship provenance supplied.','Dependency advisories not checked against a live vulnerability database.','An iframe/worker is not a guarantee against browser vulnerabilities.']};
}
export function receiptMarkdown(r){
 return `# CodeProof verification receipt\n\nGenerated: ${r.time}\n\n## Summary\n- Files: ${r.summary.files}\n- Lines: ${r.summary.lines}\n- Findings: ${r.summary.findings}\n- Tests: ${r.summary.passed} pass, ${r.summary.failed} fail, ${r.summary.warnings} caution, ${r.summary.errors} errors\n- AI authorship: inconclusive; no probability claimed\n\n## Findings\n${r.findings.map(f=>`- **${f.severity}** ${f.file}:${f.line} ${f.title} — ${f.remediation}`).join('\n')||'None detected.'}\n\n## Executed tests\n${r.tests.map(t=>`- ${t.status}: ${t.title} — ${t.message}`).join('\n')||'None executed.'}\n\n## Unverified\n${r.limitations.map(x=>'- '+x).join('\n')}\n\n## Source SHA-256\n${r.hashes.map(f=>`- ${f.path}: \`${f.sha256}\``).join('\n')}\n`;
}
