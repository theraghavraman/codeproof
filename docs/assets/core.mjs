import * as acorn from './acorn.mjs';

export const APP_VERSION = '1.0.0';
export const severityOrder = ['critical','high','medium','low','info'];
export const defaultPolicy = {
  version:1,maxFiles:1000,maxFileBytes:250000,failOnSeverity:'critical',failOnParseError:true,
  ignorePaths:['node_modules','.git','dist','build','coverage','.next','vendor','__pycache__','.venv','.codeproof']
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
  for(const f of files){if(!acceptedPath(f.path,policy))throw Error('Unsafe or unsupported file path: '+f.path);if(lengthInBytes(f.content)>policy.maxFileBytes)throw Error('File exceeds maximum size: '+f.path);total+=lengthInBytes(f.content);if(total>14_000_000)throw Error('Total source exceeds 14 MB.');}
  return true;
}

export function analyzeWorkspace(files,{ts}={}) {
  const findings=[],functions=[],dependencies={},signals=[];
  let lines=0,parsed=0,commentCount=0,logCount=0;
  function add(file,rule,title,message,remediation,severity,category,at,autofix=''){
    const line=lineAt(file.content,at);
    if(findings.some(f=>f.file===file.path&&f.rule===rule&&f.line===line))return;
    findings.push({id:`${file.path}:${line}:${rule}`,file:file.path,line,rule,title,message,remediation,severity,category,autofix});
  }
  for(const file of files){
    const code=file.content;
    lines+=code.split('\n').length;
    dependencies[file.path]=[];
    commentCount+=(code.match(/(^\s*\/\/|^\s*#|\/\*)/gm)||[]).length;
    if(file.language==='python'){
      // Complete Python compilation is performed on request inside Pyodide; regex is preliminary only.
      // Preliminary Python scan is NOT counted as grammar-checked.
      for(const m of code.matchAll(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/gm)){
        functions.push({name:m[1],params:m[2].split(',').map(s=>s.trim()).filter(s=>s&&!['self','cls'].includes(s)).length,file:file.path,line:lineAt(code,m.index)});
      }
      for(const m of code.matchAll(/^\s*(?:import\s+([\w.]+)|from\s+([\w.]+)\s+import)/gm))dependencies[file.path].push(m[1]||m[2]);
      const rules=[
        [/\b(?:eval|exec)\s*\(/g,'PY_DYNAMIC_EXEC','Dynamic Python execution','Evaluation of untrusted input can execute arbitrary code.','Remove dynamic execution or implement explicit dispatch.','critical','security'],
        [/\bpickle\.(?:loads?|Unpickler)\s*\(/g,'PY_PICKLE','Pickle deserialization','Untrusted pickle data can run arbitrary code.','Prefer a data-only format like JSON.','critical','security'],
        [/\b(?:os\.system|subprocess\.(?:run|Popen|call))\s*\(/g,'PY_SHELL','Process execution','Executing processes needs input validation and threat modeling.','Use fixed executables and argument lists; avoid untrusted commands.','high','security'],
        [/\bshell\s*=\s*True\b/g,'PY_SHELL_TRUE','shell=True enabled','Shell execution can be susceptible to injection.','Avoid shell=True and pass arguments as an array.','high','security'],
        [/^\s*except\s*:\s*$/gm,'PY_BARE_EXCEPT','Bare exception handler','Bare except can hide termination or programmer errors.','Catch only expected exception types.','medium','reliability'],
        [/\bprint\s*\(/g,'PY_PRINT','Print statement','Uncontrolled output may expose sensitive values.','Use configurable structured logging.','low','maintainability']
      ];
      for(const [regex,rule,title,msg,fix,sev,cat] of rules)for(const m of code.matchAll(regex)){add(file,rule,title,msg,fix,sev,cat,m.index);if(rule==='PY_PRINT')logCount++;}
      // Heuristic only; compiler-backed Python parsing is not claimed in the initial scan.
      if(/^\s*def\s+\w+\s*\([^)]*\)\s*$/m.test(code))add(file,'PY_DEF_COLON','Possible missing colon','A Python function header appears to be missing a colon.','Add a colon at the end of the def header.','high','syntax',code.search(/^\s*def\s+\w+\s*\([^)]*\)\s*$/m));
    }else if(file.language==='javascript'||file.language==='typescript'){
      let ast=null;
      if(file.language==='javascript'){
        try{ast=acorn.parse(code,{ecmaVersion:'latest',sourceType:'module',allowHashBang:true,locations:true});parsed++;}
        catch(e){add(file,'JS_PARSE','JavaScript parse error',e.message,'Repair syntax errors before execution.','high','syntax',e.pos??0);}
      }else if(ts){
        const sf=ts.createSourceFile(file.path,code,ts.ScriptTarget.Latest,true,file.path.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
        if(!(sf.parseDiagnostics||[]).length)parsed++;
        for(const diag of (sf.parseDiagnostics||[]).slice(0,8))add(file,'TS_PARSE','TypeScript parse error',ts.flattenDiagnosticMessageText(diag.messageText,' '),'Repair syntax errors before execution.','high','syntax',diag.start||0);
        const walk=node=>{
          if(ts.isFunctionDeclaration(node)&&node.name)functions.push({name:node.name.text,params:node.parameters.length,line:lineAt(code,node.getStart(sf)),file:file.path});
          if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer&&(ts.isArrowFunction(node.initializer)||ts.isFunctionExpression(node.initializer)))functions.push({name:node.name.text,params:node.initializer.parameters.length,line:lineAt(code,node.getStart(sf)),file:file.path});
          if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))dependencies[file.path].push(node.moduleSpecifier.text);
          if(ts.isCallExpression(node)&&node.expression.getText(sf)==='require'&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0]))dependencies[file.path].push(node.arguments[0].text);
          if(node.kind===ts.SyntaxKind.AnyKeyword)add(file,'TS_ANY','Explicit any type','any disables meaningful type verification.','Use unknown or a specific validated type.','low','maintainability',node.getStart(sf));
          ts.forEachChild(node,walk);
        };walk(sf);
      }else{
        for(const m of code.matchAll(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g))functions.push({name:m[1],params:m[2].split(',').filter(s=>s.trim()).length,file:file.path,line:lineAt(code,m.index)});
      }
      if(ast){
        const walk=node=>{
          if(!node||typeof node.type!=='string')return;
          if(node.type==='FunctionDeclaration'&&node.id)functions.push({name:node.id.name,params:node.params.length,file:file.path,line:node.loc?.start.line||1});
          if(node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&['ArrowFunctionExpression','FunctionExpression'].includes(node.init?.type))functions.push({name:node.id.name,params:node.init.params.length,file:file.path,line:node.loc?.start.line||1});
          if((node.type==='ImportDeclaration'||node.type==='ExportNamedDeclaration'||node.type==='ExportAllDeclaration')&&node.source?.value)dependencies[file.path].push(node.source.value);
          if(node.type==='CallExpression'&&node.callee?.name==='require'&&typeof node.arguments?.[0]?.value==='string')dependencies[file.path].push(node.arguments[0].value);
          for(const [k,v] of Object.entries(node)){if(k==='start'||k==='end'||k==='loc')continue;if(Array.isArray(v)){for(const c of v)if(c&&typeof c.type==='string')walk(c);}else if(v&&typeof v.type==='string')walk(v);}
        };walk(ast);
      }
      const rules=[
        [/\b(?:eval|new\s+Function)\s*\(/g,'JS_DYNAMIC_EXEC','Dynamic code execution','Dynamic evaluation may execute attacker-controlled input.','Avoid eval and Function on untrusted data.','critical','security'],
        [/\.innerHTML\s*=/g,'JS_INNERHTML','Raw HTML assignment','Untrusted HTML may lead to cross-site scripting.','Prefer textContent; sanitize when HTML is intentionally required.','high','security'],
        [/\bchild_process\b/g,'JS_CHILD_PROCESS','Child process dependency','Process execution requires careful argument handling.','Use fixed executables and validate arguments.','high','security'],
        [/\bdebugger\s*;?/g,'JS_DEBUGGER','Debugger statement','Debugger statements interrupt developer tools.','Remove the standalone debugger statement.','low','maintainability'],
        [/\bconsole\.(?:log|debug)\s*\(/g,'JS_CONSOLE','Debug console output','Unstructured logging can leak data in deployed code.','Remove debug logging or use controlled diagnostics.','low','maintainability'],
        [/\bvar\s+[A-Za-z_$]/g,'JS_VAR','Legacy var declaration','Function-scoped var can be surprising.','Prefer let or const after confirming scoping behavior.','low','maintainability'],
        [/(?<![=!])==(?!=)|(?<![=!])!=(?!=)/g,'JS_LOOSE_EQ','Loose equality','Implicit type coercion can conceal defects.','Evaluate strict equality semantics.','low','correctness']
      ];
      for(const [regex,rule,title,msg,fix,sev,cat] of rules)for(const m of code.matchAll(regex)){
        add(file,rule,title,msg,fix,sev,cat,m.index,rule==='JS_DEBUGGER'?'remove-debugger':rule==='JS_CONSOLE'?'remove-console':'');
        if(rule==='JS_CONSOLE')logCount++;
      }
    }
    else {
      // Wider-language expansion: static-only heuristics, NOT a syntax/semantic parser.
      const importPatterns = {
        go: /(?:^|\n)\s*import\s+(?:\(\s*)?"([^"]+)"/g,
        rust: /(?:^|\n)\s*(?:use|extern\s+crate)\s+([\w:]+)/g,
        java: /(?:^|\n)\s*import\s+([\w.*]+)\s*;/g,
        cpp: /(?:^|\n)\s*#include\s*[<"]([^>"]+)[>"]/g,
        csharp: /(?:^|\n)\s*using\s+([\w.]+)\s*;/g
      };
      for(const m of code.matchAll(importPatterns[file.language]||/(?!)/g))dependencies[file.path].push(m[1]);
      const risky = file.language==='cpp' ? /\b(?:gets|strcpy|strcat|sprintf|system)\s*\(/g :
        file.language==='java' ? /\bRuntime\.getRuntime\(\)\.exec\s*\(/g :
        file.language==='go' ? /\bexec\.Command\s*\(/g :
        file.language==='rust' ? /\bCommand::new\s*\(/g : /\bProcess\.Start\s*\(/g;
      for(const m of code.matchAll(risky))add(file,'NATIVE_RISKY_CALL','Potentially risky system operation','Review input validation, memory safety and access controls around this call.','Use an allowlisted and validated operation; consider static language-specific tooling.','high','security',m.index);
    }
    for(const pattern of [/(?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"\n]{10,}['"]/ig,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g])for(const m of code.matchAll(pattern))add(file,'SECRET_LITERAL','Potential hardcoded secret','Source resembles an embedded credential; inspect the context.','Move secrets to protected configuration and rotate exposed values.','critical','security',m.index);
    for(const m of code.matchAll(/\b(?:TODO|FIXME|HACK)\b/g))add(file,'TODO','Pending work marker','Source includes unfinished-work annotation.','Review whether the annotation indicates missing behavior.','info','maintainability',m.index);
  }
  if(lines>=25 && commentCount/lines>.28)signals.push({label:'Extensive comments',detail:'High comment density is shared by AI outputs, tutorials, templates, and some human code.',weight:'weak'});
  if(lines>=25 && logCount>=3)signals.push({label:'Repeated debug instrumentation',detail:'Repeated logging is a style signal; it is not an authorship fingerprint.',weight:'weak'});
  if(functions.length>=5&&functions.filter(f=>/^(handle|process|calculate|generate|normalize|validate)/i.test(f.name)).length/functions.length>.65)signals.push({label:'Formulaic naming',detail:'Generic names are weak stylistic evidence and common in both human and machine work.',weight:'weak'});
  if(!signals.length)signals.push({label:'No distinctive authorship evidence',detail:'Code-only authorship attribution is inconclusive; no reliable probability can be calculated.',weight:'weak'});
  const impact={critical:18,high:9,medium:5,low:2,info:0};
  const score=Math.max(0,Math.round(100-findings.reduce((n,f)=>n+impact[f.severity],0)/Math.max(1,Math.sqrt(files.length))));
  return {findings,functions,dependencies,signals,files:files.length,lines,parsed,score,inspectedAt:new Date().toISOString()};
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
    const resolved=parts.join('/'),internal=target.startsWith('.')?paths.find(p=>p===resolved||p.replace(/\.(jsx?|tsx?|py)$/,'')===resolved):null;
    edges.push({from,to:internal|| (target.startsWith('.')?resolved:target),kind:internal?'internal':'external'});
  }return edges;
}
export function failsPolicy(analysis,policy){
  const max=severityOrder.indexOf(policy.failOnSeverity);
  return analysis.findings.filter(f=>(policy.failOnParseError&&f.category==='syntax')||(max!==-1&&severityOrder.indexOf(f.severity)<=max));
}
export async function makeReceipt(files,analysis,results,policy){
  const hashes=[];
  for(const f of files){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(f.content));hashes.push({path:f.path,sha256:Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('')});}
  return {schema:'codeproof.receipt.v1',version:APP_VERSION,time:new Date().toISOString(),hashes,policy,
    summary:{files:analysis.files,lines:analysis.lines,qualityHeuristic:analysis.score,findings:analysis.findings.length,...summarize(results)},
    findings:analysis.findings,tests:results,authorship:{result:'inconclusive',probability:null,signals:analysis.signals,note:'No validated AI authorship classifier is installed. Style alone cannot prove authorship.'},
    execution:{js:'Opaque-origin iframe and dedicated worker with network denied',python:'Pyodide worker inside opaque-origin iframe, CDN bootstrap allowlisted; experimental, not hardened',coverage:'Only supplied and generated cases executed'},
    limitations:['Tests cannot prove program correctness.','Smoke cases only establish no exception for the specific input.','No native process execution on GitHub Pages.','No verifiable authorship provenance supplied.','Dependency advisories not checked against a live vulnerability database.','An iframe/worker is not a guarantee against browser vulnerabilities.']};
}
export function receiptMarkdown(r){
 return `# CodeProof verification receipt\n\nGenerated: ${r.time}\n\n## Summary\n- Files: ${r.summary.files}\n- Lines: ${r.summary.lines}\n- Findings: ${r.summary.findings}\n- Tests: ${r.summary.passed} pass, ${r.summary.failed} fail, ${r.summary.warnings} caution, ${r.summary.errors} errors\n- AI authorship: inconclusive; no probability claimed\n\n## Findings\n${r.findings.map(f=>`- **${f.severity}** ${f.file}:${f.line} ${f.title} — ${f.remediation}`).join('\n')||'None detected.'}\n\n## Executed tests\n${r.tests.map(t=>`- ${t.status}: ${t.title} — ${t.message}`).join('\n')||'None executed.'}\n\n## Unverified\n${r.limitations.map(x=>'- '+x).join('\n')}\n\n## Source SHA-256\n${r.hashes.map(f=>`- ${f.path}: \`${f.sha256}\``).join('\n')}\n`;
}
