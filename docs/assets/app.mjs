import {APP_VERSION,defaultPolicy,sampleFiles,sampleTests,languageFromPath,acceptedPath,analyzeWorkspace,generateBoundaryTests,findPatches,applyPatch,summarize,dependencyEdges,failsPolicy,makeReceipt,receiptMarkdown,validateWorkspace} from './core.mjs';
import {LocalTestRunner,ProjectRuntime} from './sandbox.mjs';
import {icon,h,fmt,badge,btn} from './ui/kit.mjs';
import {scanView,authorshipView,SCAN_TABS,verificationBadge} from './ui/scan-views.mjs';
import {buildReport,reportMarkdown,reportSarif} from './engine/report.mjs';
import {normalizePath} from './engine/paths.mjs';
import {detectLanguage} from './engine/detect.mjs';

const root=document.querySelector('#app');
const now=()=>new Date().toISOString();
const NAV=[['workspace','grid','Overview'],['scan','scan','Project Scan'],['inspector','code','Code Inspector'],['runner','terminal','Execution Lab'],['tests','flask','Automated Tests'],['evidence','file','Evidence Reports'],['fixes','wand','Fix & Verify'],['projects','layers','Project Explorer'],['teams','users','Team & CI'],['authorship','user','Authorship (secondary)']];
const descriptions={scan:'Project Scan',authorship:'Authorship estimate',workspace:'Overview',inspector:'Code Inspector',runner:'Execution Lab',tests:'Automated Tests',evidence:'Evidence Reports',fixes:'Fix & Verify',projects:'Project Explorer',teams:'Team & CI'};
// Workspace persistence is opt-in. A workspace saved by an earlier version keeps being saved until the
// user turns storage off, so existing behavior is preserved; new users start with nothing stored.
const STORE_KEY='codeproof.state.v1';
const saved=(()=>{try{const str=localStorage.getItem(STORE_KEY);const x=JSON.parse(str||'null');return x&&Array.isArray(x.files)&&Array.isArray(x.tests)?x:null;}catch{return null;}})();
const S={files:saved?.files?.length?saved.files:structuredClone(sampleFiles),active:saved?.active||'src/payment.js',tests:saved?.tests||structuredClone(sampleTests),policy:saved?.policy||structuredClone(defaultPolicy),analysis:analyzeWorkspace(saved?.files?.length?saved.files:sampleFiles),view:location.hash.slice(1).split('?')[0]||'workspace',results:[],resultsStale:true,manual:null,filter:'all',search:'',testFilter:'all',selectedFinding:null,busy:false,runProgress:'',timeoutMs:1800,runArgs:'[100, 20]',runFn:'',patchReport:null,revertSnapshot:null,toast:[],modal:'',sideMenu:false,engineError:'',syncDisabled:false,showTestForm:false,aiNotice:false,pythonChecks:{},
 persist:Boolean(saved)&&saved.persist!==false,project:null,ingestError:null,dirtyAfterScan:new Set(),
 scan:{status:'idle',phases:{},result:null},scanTab:'summary',selectedFindingId:null,findingPage:1,inventoryFilter:'all',inventoryPage:1,
 findingFilters:{severity:'all',category:'all',verification:'all',file:'all',analyzer:'all',search:''},
 scanOptions:{js:true,python:true,budgetMs:150000}};
if(!NAV.some(n=>n[0]===S.view))S.view='workspace';
if(!S.files.some(x=>x.path===S.active))S.active=S.files[0]?.path||'';
const runner=new LocalTestRunner();
let analysisWorker=null,analyzeSeq=0,analyzeTimer=null,rpcSeq=0,activeRuntime=null;
const rpcPending=new Map();
function createWorker(){
  analysisWorker=new Worker(new URL('./analysis.worker.mjs',import.meta.url),{type:'module'});
  analysisWorker.onmessage=onWorkerMessage;
  analysisWorker.onerror=ev=>{for(const p of rpcPending.values())p.reject(Object.assign(new Error('Analysis worker failed to start: '+(ev.message||'unknown error')),{stage:'Worker initialization'}));rpcPending.clear();};
}
// Promise-based requests to the analysis worker; progress messages stream to onProgress.
function rpc(message,onProgress,transfer=[]){
  const id='rpc-'+(++rpcSeq);
  return new Promise((resolve,reject)=>{rpcPending.set(id,{resolve,reject,onProgress});analysisWorker.postMessage({...message,id},transfer);});
}
// Hard cancellation: terminating the worker stops parsing/type-checking immediately.
function restartWorker(reason){
  analysisWorker?.terminate();
  for(const p of rpcPending.values())p.reject(Object.assign(new Error(reason),{name:'AbortError'}));
  rpcPending.clear();createWorker();
}
function onWorkerMessage(ev){
  const data=ev.data||{};
  const pending=typeof data.id==='string'?rpcPending.get(data.id):null;
  if(pending){
    if(data.type==='progress'){pending.onProgress?.(data);return;}
    rpcPending.delete(data.id);
    if(data.type==='error')pending.reject(Object.assign(new Error(data.error),{name:data.name,code:data.code}));else pending.resolve(data);
    return;
  }
  onLegacyAnalysis(ev);
}
const onLegacyAnalysis=ev=>{
  if(ev.data.id!==analyzeSeq)return;
  if(ev.data.error){S.engineError=ev.data.error;toast('Inspector: '+ev.data.error,'error');return;}
  S.analysis=ev.data.analysis;S.engineError='';
  if(document.activeElement?.id==='code-editor')refreshInspector();
  else render();
};
function inspect(){clearTimeout(analyzeTimer);analyzeTimer=setTimeout(()=>{analyzeSeq++;analysisWorker.postMessage({id:analyzeSeq,files:S.files});},160);}
createWorker();
inspect();
function persist(){
 if(!S.persist)return;
 try{const data=JSON.stringify({files:S.files,active:S.active,tests:S.tests,policy:S.policy,persist:true});if(data.length<1_500_000){localStorage.setItem(STORE_KEY,data);S.syncDisabled=false;}else S.syncDisabled=true;}catch{S.syncDisabled=true;}
}
function clearStoredWorkspace(){try{localStorage.removeItem(STORE_KEY);}catch{/* storage unavailable */}}
function markModified(){S.resultsStale=true;S.patchReport=null;delete S.pythonChecks[S.active];if(S.scan.result)S.dirtyAfterScan.add(S.active);persist();inspect();}
function toast(message,kind='info'){
  const area=document.querySelector('#toast-wrap');if(!area)return;
  const div=document.createElement('div');div.className=kind==='error'?'toast error':'toast';div.setAttribute('role','status');div.textContent=message;area.append(div);setTimeout(()=>div.remove(),4500);
}
function fileInFocus(){return S.files.find(f=>f.path===S.active)||S.files[0];}
function selectedFunctions(){return S.analysis.functions.filter(f=>f.file===S.active);}
function findingsForCurrent(){return S.analysis.findings.filter(f=>f.file===S.active);}
function statusCounts(){const f=S.analysis.findings;return {critical:f.filter(x=>x.severity==='critical').length,high:f.filter(x=>x.severity==='high').length,medium:f.filter(x=>x.severity==='medium').length};}
function humanDate(s){return s?new Date(s).toLocaleString():'Not run';}
function pageHead(kicker,title,desc){return `<div class="eyebrow">${kicker}</div><h1 class="page-title">${title}</h1><p class="lede">${desc}</p>`;}
function alertBox(text,type='notice'){return `<div class="${type}">${text}</div>`;}
function placeholder(title,detail,i='info'){return `<div class="blank">${icon(i,30)}<strong>${h(title)}</strong>${h(detail)}</div>`;}
function fileOptions(){return S.files.map(f=>`<option value="${h(f.path)}" ${f.path===S.active?'selected':''}>${h(f.path)}</option>`).join('');}
function fileTree(){return `<div class="file-list">${S.files.map(f=>`<div class="row" style="gap:1px"><button class="file-entry ${f.path===S.active?'active':''}" data-action="select-file" data-path="${h(f.path)}">${icon('file',14)}<span class="code-ext ${f.language==='python'?'py':f.language==='typescript'?'ts':''}">${({javascript:'JS',typescript:'TS',python:'PY',go:'GO',rust:'RS',java:'JV',cpp:'C+',csharp:'C#'})[f.language]}</span><span class="file-name" title="${h(f.path)}">${h(f.path)}</span></button><button class="btn-icon" data-action="delete-file" data-path="${h(f.path)}" aria-label="Remove ${h(f.path)}">${icon('trash',13)}</button></div>`).join('')||placeholder('No files','Add a supported source file to begin.')}</div>`;}
function headActions(){return `<div class="top-actions"><span class="status-dot"></span><span class="status-label">Local-first · no source upload</span>${btn(icon('download')+' Export', 'export-json','ghost sm')}</div>`;}
function navButton(key,ico,label,secondary=false){return `<button data-action="navigate" data-view="${key}" class="nav-item ${secondary?'secondary':''} ${S.view===key?'active':''}" ${S.view===key?'aria-current="page"':''}>${icon(ico)}<span>${label}</span>${key==='inspector'?`<span class="nav-small">${S.analysis.findings.length}</span>`:key==='scan'&&S.scan.result?`<span class="nav-small">${S.scan.result.findings.length}</span>`:key==='scan'&&S.scan.status==='running'?'<span class="nav-small">…</span>':''}</button>`;}
function layout(){
 const active=NAV.find(x=>x[0]===S.view)||NAV[0];
 root.innerHTML=`<a class="skip-link" href="#main-content">Skip to content</a><div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">${icon('shield',28)}</span><div><strong>CodeProof</strong><small>VERIFICATION LAB</small></div></div><div class="nav-title">WORKSPACE</div><nav aria-label="Main navigation">${NAV.filter(n=>n[0]!=='authorship').map(([key,ico,label])=>navButton(key,ico,label)).join('')}<div class="nav-title secondary-title">SECONDARY</div>${navButton('authorship','user','Authorship estimate',true)}</nav><div class="sidebar-bottom"><div class="local-pill">${icon('lock',16)} Private browser workspace</div><p>Files are processed in this tab. CodeProof sends no source, findings or telemetry anywhere; the page's Content-Security-Policy only allows requests to this site.</p><label class="check small"><input type="checkbox" id="persist-toggle" ${S.persist?'checked':''}> Keep editor workspace in this browser's storage</label>${S.persist?'<p class="tiny">Stored locally until you untick this box (it is then deleted). Scan results are never stored.</p>':''}</div></aside><div class="content"><header class="topbar"><div class="crumb">CodeProof <span class="sep">/</span><strong>${h(active[2])}</strong></div>${headActions()}</header><main class="main" id="main-content" tabindex="-1">${renderView()}</main></div></div><div class="toast-wrap" id="toast-wrap" aria-live="polite"></div><div id="modal-anchor">${renderModal()}</div>`;
 if(S.view==='inspector')hydrateEditor();
 if(S.modal==='new-file')document.getElementById('new-file-path')?.focus();
 if(S.view==='teams'){const el=document.getElementById('policy-json');if(el)el.value=JSON.stringify(S.policy,null,2);}
 if(S.view==='runner'||S.view==='tests')fillTestForm();
}
function renderView(){switch(S.view){case'scan':return scanView(S,{pageHead});case'authorship':return authorshipView(S,{pageHead});case'workspace':return overview();case'inspector':return inspector();case'runner':return runnerView();case'tests':return testView();case'evidence':return evidenceView();case'fixes':return fixView();case'projects':return projectView();case'teams':return teamView();default:return overview();}}
function overview(){
 const c=statusCounts(),counts=summarize(S.results);
 return `${pageHead('Independent code assurance','Trust the evidence. <span class="gradient">Not the output.</span>','A browser-native verification lab for AI-assisted and human-written code. Inspect source, challenge assumptions, run isolated tests, and export reproducible evidence—without sending your files to a server.')}
 <div class="row wrap mb">${btn(icon('scan')+' Scan a project','go-scan','primary')}${btn(icon('play')+' Run test suite','run-tests')}${btn(icon('code')+' Open inspector','go-inspector','ghost')}${badge('v'+APP_VERSION,'info')}</div>
 ${S.scan.result?`<div class="notice mb"><b>Last project scan:</b> ${h(S.scan.result.project.name)} · ${h(S.scan.result.coverage.verdict.message)} ${btn('Open results '+icon('arrow'),'go-scan','ghost sm')}</div>`:''}
 <section class="stats" aria-label="Workspace metrics">
 ${metric('file',fmt(S.files.length),'Source files','indigo')}${metric('code',fmt(S.analysis.lines),'Lines inspected','')}${metric('alert',fmt(c.critical+c.high),'Major findings','alert')}${metric('flask',S.resultsStale?'—':`${counts.passed}/${counts.total}`,'Tests passed', 'warning')}
 </section>
 <section class="grid-two mb"><div class="panel"><div class="panel-head"><h3>Verification pipeline</h3><span class="meta">5 core engines + extensions</span></div><div class="panel-body compact">${[
 ['Project Scan','Whole-project parsing, type checking, integration graph, sandboxed tests and coverage','scan','scan'],['Code Inspector','Syntax, reliability, security, and maintainability findings','inspector','check'],['Safe Execution Lab','Opaque-origin worker sandboxes and hard timeouts','runner','terminal'],['Automated Tests','Expected results, edge inputs, determinism checks','tests','flask'],['Evidence Reports','File hashes, findings, failures, unverified areas','evidence','file'],['Fix & Verify','Patch, rerun identical tests, flag regressions','fixes','wand'],['Repository and Team Tools','ZIP/folder imports, dependency map and PR checks','projects','branch']
 ].map(([title,desc,key,ico])=>`<div class="cardlink"><div class="row">${icon(ico,18)}<div><h4>${title}</h4><p>${desc}</p></div></div><button class="btn-icon" aria-label="Open ${title}" data-action="navigate" data-view="${key}">${icon('chevron')}</button></div>`).join('')}</div></div>
 <div class="panel"><div class="panel-head"><h3>Current verification status</h3><span class="meta">Heuristic, not a certification</span></div><div class="panel-body"><div class="scoring"><strong>${S.analysis.score}<span style="font-size:20px;color:var(--dim)">/100</span></strong><span>Static findings score · not a correctness guarantee</span></div><hr class="divider"/><div class="bars">${[['Critical',c.critical,'var(--red)'],['High',c.high,'var(--amber)'],['Medium',c.medium,'var(--purple)']].map(([l,n,color])=>`<div class="bar-row"><span>${l}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100,n*12)}%;background:${color}"></div></div><small>${n}</small></div>`).join('')}</div><hr class="divider"/>${alertBox(`${icon('info',14)} &nbsp; <b>AI authorship:</b> a separate, heuristic estimate is available after a project scan. It defaults to "Indeterminate" and never affects findings.`)}<div class="mt">${btn('View evidence '+icon('arrow'),'go-evidence','ghost sm')}</div></div></div></section>
 <section class="grid-two even"><div class="panel"><div class="panel-head"><h3>Most relevant issues</h3>${btn('All findings '+icon('arrow'),'go-inspector','ghost sm')}</div><div class="panel-body compact">${S.analysis.findings.slice(0,4).map(issueCompact).join('')||placeholder('No issues in implemented checks','This is not proof of correctness.')}</div></div><div class="panel"><div class="panel-head"><h3>Your data stays here</h3>${badge('Local-first','passed')}</div><div class="panel-body"><div class="timeline">${[['No source upload','Inspection, tests, patches and reports run in your browser.'],['JS/TS isolated execution','No direct access to the app origin, with network denied inside the execution frame.'],['Python runs from this site','The Pyodide runtime ships with CodeProof, is checked against pinned SHA-256 digests before use, and runs with no network access.'],['Native execution is out of scope','GitHub Pages cannot provide hardened OS containers or a team database.']].map(([a,b],i)=>`<div class="step"><span class="step-number">${i+1}</span><div><strong>${a}</strong><p>${b}</p></div></div>`).join('')}</div></div></div></section><div class="footer-note">Static GitHub Pages deployment · No telemetry · No third-party requests · Authorship estimates are not a verdict.</div>`;
}
function metric(ico,num,label,kind){return `<div class="stat ${kind}"><div class="stat-icon">${icon(ico,18)}</div><strong>${num}</strong><div class="caption">${label}</div></div>`;}
function issueCompact(f){return `<div class="cardlink"><div><div class="row mb-sm" style="gap:8px">${badge(f.severity)}<b class="small">${h(f.title)}</b></div><p class="code-ref">${h(f.file)}:${f.line}</p></div><button class="btn-icon" data-action="open-finding" data-id="${h(f.id)}" aria-label="Open finding">${icon('chevron')}</button></div>`;}
function inspector(){
 const file=fileInFocus();
 return `${pageHead('MVP 01 · Static analysis','Code Inspector','Parse JavaScript and TypeScript with real parsers; scan Python, Go, Rust, Java, C/C++ and C# with limited heuristics; review rule-backed findings with line references and practical remediation.')}
 <div class="toolbar"><div class="row wrap">${btn(icon('plus')+' New file','new-file')}${btn(icon('upload')+' Import / scan','go-scan')}${btn(icon('refresh')+' Reinspect','reinspect','ghost')}</div><div class="row" id="inspector-badges">${inspectorBadges()}</div></div>
 <div class="grid-two"><div><div class="panel mb"><div class="panel-head"><h3>Workspace files</h3><span class="meta">${S.files.length} source files</span></div>${fileTree()}</div><div class="panel"><div class="panel-head"><h3>Source editor</h3><span class="meta" data-live-count>${findingsForCurrent().length} findings</span></div><div class="panel-body"><div class="editor-shell"><div class="editor-top"><span class="language-dot ${file?.language||''}"></span><strong>${h(file?.path||'No source file')}</strong><span style="margin-left:auto;color:var(--dim)">${file?.language||'text'}</span></div><div class="editor-space"><div class="line-gutter" id="line-gutter">1</div><textarea id="code-editor" class="code-area" aria-label="Source code editor" spellcheck="false" placeholder="// Add code here..."></textarea></div></div><div class="row between wrap mt"><span class="tiny muted">Ctrl / Cmd + Enter runs the current function</span>${btn(icon('play')+' Open runner','go-runner','primary sm')}</div></div></div></div>
 <div id="inspector-side">${inspectorSide(file)}</div></div>
 <p class="footer-note">The live inspector runs per-file parsers and rules as you type. Whole-project type checking, cross-file integration checks and sandboxed tests run in Project Scan. Python grammar is fully verified only by CPython (Pyodide). Treat security observations as leads, not proven vulnerabilities.</p>`;
}
// Findings for this file that only a whole-project scan can produce (compiler, integration, runtime).
function projectFindingsPanel(file){
 const r=S.scan.result;if(!r||!file)return '';
 const live=new Set(['acorn-rules','typescript-ast-rules','acorn','typescript-parser','python-tokenizer','delimiter-scanner','native-pattern-rules','secret-scanner','text-rules','json-validator','package-json-rules','config-rules','requirements-parser']);
 const list=r.findings.filter(f=>(f.file===file.path||(f.affected||[]).includes(file.path))&&f.analyzers.some(a=>!live.has(a)));
 return `<div class="panel mb"><div class="panel-head"><h3>From the last project scan</h3><span class="meta">${list.length} cross-file / runtime</span></div><div class="panel-body compact">${S.dirtyAfterScan.has(file.path)?'<p class="form-help">Edited since the scan; rerun it to refresh these results.</p>':''}${list.slice(0,12).map(f=>`<div class="cardlink"><div><div class="row mb-sm" style="gap:6px">${badge(f.severity)}${verificationBadge(f.verification)}</div><b class="small">${h(f.title)}</b><p class="code-ref">${h(f.file)}:${f.line||1}</p></div><button class="btn-icon" data-action="open-scan-finding" data-id="${h(f.id)}" aria-label="Open finding details">${icon('chevron')}</button></div>`).join('')||placeholder('None for this file','The project scan found no compiler, integration or runtime findings here.','check')}</div></div>`;
}
function inspectorBadges(){return `${badge(`${S.analysis.findings.length} findings`,'info')}${badge(`${S.analysis.parsed}/${S.files.length} grammar checked`,'info')}`;}
function inspectorSide(file){
 const current=S.analysis.findings.filter(f=>f.file===file?.path).filter(f=>(S.filter==='all'||f.severity===S.filter)&&(!S.search||`${f.title} ${f.message} ${f.rule}`.toLowerCase().includes(S.search.toLowerCase())));
 return `${file?.language==='python'?`<div class="panel mb"><div class="panel-head"><h3>Python grammar validation</h3>${badge('On demand','warning')}</div><div class="panel-body"><p class="hint">The live scan uses CodeProof's Python tokenizer, not the full grammar. Validate with CPython's own parser in the sandboxed Pyodide runtime (about 12 MB, loaded from this site and integrity-checked).</p>${btn(icon('check')+' Parse Python grammar','validate-python','primary sm',S.busy?'disabled':'')}${S.pythonChecks[file.path]?`<div class="mt ${S.pythonChecks[file.path].ok?'insight':'warning-callout'}">${h(S.pythonChecks[file.path].message)}</div>`:''}</div></div>`:''}<div class="panel mb"><div class="panel-head"><h3>Findings for file</h3><span class="meta">${current.length} shown</span></div><div class="panel-body"><div class="row wrap mb-sm"><select class="form-control" id="severity-filter" aria-label="Filter findings by severity">${['all','critical','high','medium','low','info'].map(x=>`<option value="${x}" ${x===S.filter?'selected':''}>${x==='all'?'All severities':x}</option>`).join('')}</select><div class="finder" style="flex:1"><input id="finding-search" value="${h(S.search)}" placeholder="Search findings" aria-label="Search findings" style="width:100%"></div></div><div id="finding-list">${current.map(issueCard).join('')||placeholder('No matching findings','Try another filter, or inspect a different source file.','search')}</div></div></div>${projectFindingsPanel(file)}<div class="panel"><div class="panel-head"><h3>Discovered functions</h3><span class="meta">${selectedFunctions().length} callable symbols</span></div><div class="panel-body compact">${selectedFunctions().map(fn=>`<div class="cardlink"><div><h4 class="code-ref">${h(fn.name)}(${fn.params} parameter${fn.params!==1?'s':''})</h4><p>Line ${fn.line}</p></div><button class="btn sm" data-action="run-fn" data-fn="${h(fn.name)}">${icon('play',13)} Run</button></div>`).join('')||placeholder('No functions found','Use a named function declaration or arrow function.','code')}</div></div>`;
}
// Refresh the inspector panels around the editor without re-rendering it, so typing keeps focus and caret position.
function refreshInspector(){
 const count=document.querySelector('[data-live-count]');if(count)count.textContent=findingsForCurrent().length+' findings';
 const badges=document.getElementById('inspector-badges');if(badges)badges.innerHTML=inspectorBadges();
 const side=document.getElementById('inspector-side');if(side)side.innerHTML=inspectorSide(fileInFocus());
 const nav=document.querySelector('.nav-item[data-view="inspector"] .nav-small');if(nav)nav.textContent=S.analysis.findings.length;
}
function issueCard(f){return `<article class="issue"><div class="row" style="align-items:start"><span class="issue-icon">${icon(f.category==='security'?'shield':f.category==='syntax'?'alert':'bug',15)}</span><div style="flex:1;min-width:0"><div class="row between wrap"><h4>${h(f.title)}</h4>${badge(f.severity)}</div><p>${h(f.message)}</p><p style="color:var(--text)"><b>Improve:</b> ${h(f.remediation)}</p><div class="issue-foot"><span class="code-ref">${h(f.file)}:${f.line} · ${h(f.rule)}</span>${f.autofix?btn('Suggested patch '+icon('arrow'),'go-fixes','ghost sm'):''}</div></div></div></article>`;}
function runnerView(){
 const file=fileInFocus(),functions=selectedFunctions(),last=S.manual;
 return `${pageHead('MVP 02 · Local execution','Safe Execution Lab','Run selected named functions within a sandboxed iframe and worker with time limits. Test only code you understand; browser isolation is defense-in-depth, not an absolute OS-level guarantee.')}
 <div class="warning-callout mb">${icon('lock',15)} <b>Isolation model.</b> JavaScript runs in an opaque-origin execution worker with network access denied by CSP. Python uses an isolated Pyodide worker with an allowlisted CDN bootstrap and is <b>experimental for untrusted code</b>. Neither mode is equivalent to a hardened native microVM.</div>
 <div class="grid-two"><div class="panel"><div class="panel-head"><h3>Configure a run</h3>${badge('Browser execution','passed')}</div><div class="panel-body"><div class="form-grid"><div class="field full"><label class="form-label" for="run-file">Source file</label><select id="run-file" class="form-control wide">${fileOptions()}</select></div><div class="field"><label class="form-label" for="run-function">Function</label><select id="run-function" class="form-control wide">${functions.map(f=>`<option value="${h(f.name)}" ${f.name===S.runFn?'selected':''}>${h(f.name)} (${f.params} args)</option>`).join('')}</select></div><div class="field"><label class="form-label" for="timeout-select">Execution limit</label><select id="timeout-select" class="form-control wide">${[500,1000,1800,3000,5000].map(ms=>`<option value="${ms}" ${S.timeoutMs===ms?'selected':''}>${ms} ms</option>`).join('')}</select></div><div class="field full"><label for="run-args" class="form-label">Arguments · JSON array</label><textarea class="form-control wide" id="run-args" rows="4">${h(S.runArgs)}</textarea><p class="form-help">Examples: <code>[2, 3]</code>, <code>[[1,2,3]]</code>, <code>["Alice"]</code>. No filesystem, app credentials, or unrestricted network are provided to JS.</p></div></div><div class="row wrap mt">${btn(icon('play')+' Execute function','execute-one','primary',S.busy?'disabled':'')}${btn(icon('flask')+' Build edge tests','generate-for-active','ghost')}</div></div></div>
 <div><div class="panel mb"><div class="panel-head"><h3>Last execution</h3><span class="meta">${last?`${last.durationMs} ms`:'Not executed'}</span></div><div class="panel-body">${last?`<div class="row mb">${badge(last.status)}<b>${h(last.title)}</b></div><p class="hint">${h(last.message)}</p><label class="form-label">Actual result</label><pre class="test-detail" style="white-space:pre-wrap;overflow-wrap:anywhere">${h(JSON.stringify(last.actual,null,2)??'undefined')}</pre>${last.logs?.length?`<label class="form-label mt">Console output</label><pre class="test-detail" style="white-space:pre-wrap">${h(last.logs.join('\n'))}</pre>`:''}`:placeholder('Waiting for execution','Configure a named function and press Execute.','terminal')}</div></div><div class="panel"><div class="panel-head"><h3>Execution policy</h3></div><div class="panel-body"><div class="metric-split"><span>JS network access</span>${badge('Denied','passed')}</div><div class="metric-split"><span>App-origin storage access</span>${badge('Denied','passed')}</div><div class="metric-split"><span>Wall-clock hard timeout</span>${badge('Enabled','passed')}</div><div class="metric-split"><span>Arbitrary native binaries</span>${badge('Unavailable','off')}</div><div class="metric-split"><span>Python runtime download</span>${badge('CDN required','warning')}</div><p class="form-help">Long-running workers are terminated. JS memory has no guaranteed hard quota in this static build; extreme allocation may still destabilize the browser. For hostile repositories use isolated remote microVMs outside GitHub Pages.</p></div></div></div></div>`;
}
function testView(){const summary=summarize(S.results),listed=S.tests.filter(t=>S.testFilter==='all'||t.file===S.active);
 return `${pageHead('MVP 03 · Behavioral verification','Automated Test Lab','Create expected-value tests, generate adversarial inputs, and check determinism or idempotence. Generated smoke tests distinguish an exception from a mismatch—no invented expectations.')}
 <div class="row wrap mb">${btn(icon('play')+' Run all tests','run-tests','primary',S.busy?'disabled':'')}${btn(icon('zap')+' Generate boundary cases','generate-for-active')}${btn(icon('plus')+' Add assertion','toggle-test-form')}<span class="muted small">${S.busy?h(S.runProgress):S.resultsStale?'Results need rerun':'Results current for this session'}</span></div>
 <div class="stats">${metric('flask',S.tests.length,'Configured tests','indigo')}${metric('check',S.resultsStale?'—':summary.passed,'Passed','')}${metric('alert',S.resultsStale?'—':summary.failed,'Failed','alert')}${metric('clock',S.resultsStale?'—':summary.warnings+summary.errors,'Warnings / errors','warning')}</div>
 ${S.showTestForm?`<div class="panel mb"><div class="panel-head"><h3>Add test case</h3>${btn(icon('x')+' Close','toggle-test-form','ghost sm')}</div><div class="panel-body"><form id="test-form" class="form-grid"><div class="field"><label class="form-label" for="test-file">File</label><select id="test-file" class="form-control wide">${fileOptions()}</select></div><div class="field"><label class="form-label" for="test-function">Callable function</label><select id="test-function" class="form-control wide">${selectedFunctions().map(f=>`<option value="${h(f.name)}">${h(f.name)}</option>`).join('')}</select></div><div class="field full"><label class="form-label" for="test-title">Test name</label><input id="test-title" class="form-control wide" required value="Check expected behavior"></div><div class="field"><label class="form-label" for="test-kind">Assertion type</label><select id="test-kind" class="form-control wide"><option value="expected">Expected result</option><option value="smoke">Smoke (no exception only)</option><option value="determinism">Same input, same output</option><option value="idempotent">f(f(x)) equals f(x)</option></select></div><div class="field"><label class="form-label" for="test-args">Args (JSON array)</label><input id="test-args" class="form-control wide" value="[1, 2]"></div><div class="field full"><label class="form-label" for="test-expected">Expected output (JSON; only for expected tests)</label><input id="test-expected" class="form-control wide" value="3"></div><div class="full">${btn(icon('plus')+' Save test','save-test','primary')}</div></form></div></div>`:''}
 <div class="grid-two"><div class="panel"><div class="panel-head"><h3>Test suite</h3><div class="row"><select id="test-filter" class="form-control" aria-label="Test visibility"><option value="all" ${S.testFilter==='all'?'selected':''}>All files</option><option value="active" ${S.testFilter==='active'?'selected':''}>Selected file</option></select><span class="meta">${listed.length} tests</span></div></div><div class="panel-body compact">${listed.map(testCard).join('')||placeholder('No cases selected','Create an expectation or generate boundary cases.','flask')}</div></div><div class="panel"><div class="panel-head"><h3>Results</h3>${badge(S.resultsStale?'Stale':`${summary.total} executed`,S.resultsStale?'warning':'passed')}</div><div class="panel-body compact">${S.results.map(resultCard).join('')||placeholder('No test run yet','Select Run all tests to execute your suite in browser sandboxes.','clock')}</div></div></div><div class="notice mt"><b>Interpreting results:</b> an automatically generated smoke test that throws is shown as a warning, not necessarily a defect. A passed smoke test only means this invocation completed without throwing. User-provided expected outputs are what support a behavioral pass/fail claim.</div>`;
}
function testCard(t){return `<div class="test-row"><div class="test-status">${icon(t.kind==='expected'?'check':'flask',15)}</div><div style="flex:1;min-width:0"><strong>${h(t.title)}</strong><small>${h(t.file)} → <code>${h(t.functionName)}</code> · ${h(t.kind)}</small><div class="test-detail">${h(JSON.stringify(t.args))}${t.kind==='expected'?' → '+h(JSON.stringify(t.expected)):''}</div></div><button class="btn-icon" data-action="remove-test" data-id="${h(t.id)}" title="Delete test">${icon('trash',15)}</button></div>`;}
function resultCard(t){return `<div class="test-row"><div class="test-status" style="color:${t.status==='passed'?'var(--teal)':t.status==='failed'?'var(--red)':'var(--amber)'}">${icon(t.status==='passed'?'check':'alert',15)}</div><div style="min-width:0;flex:1"><div class="row between wrap"><strong>${h(t.title)}</strong>${badge(t.status)}</div><small>${h(t.message)} · ${t.durationMs} ms</small>${t.kind==='expected'?`<div class="test-detail">Expected ${h(JSON.stringify(t.expected))} · Actual ${h(JSON.stringify(t.actual))}</div>`:''}</div></div>`;}
function evidenceView(){const f=S.analysis.findings,results=summarize(S.results);
 return `${pageHead('MVP 04 · Transparent evidence','Evidence & Authorship','Export a verification receipt with SHA-256 source fingerprints, rule-backed findings, recorded test outcomes and explicit unverified areas. Authorship analysis is always separate from software quality.')}
 ${S.scan.result?`<div class="panel mb"><div class="panel-head"><h3>Project scan report</h3>${badge(S.scan.result.coverage.verdict.incomplete?'Verification incomplete':'Scoped to checks that ran',S.scan.result.coverage.verdict.incomplete?'warning':'info')}</div><div class="panel-body"><p class="hint">${h(S.scan.result.project.name)} · ${fmt(S.scan.result.findings.length)} findings · ${h(S.scan.result.coverage.verdict.message)}</p><div class="row wrap">${btn(icon('download')+' Scan report (JSON)','export-scan-json','primary')}${btn(icon('file')+' Scan report (Markdown)','export-scan-md')}${btn(icon('code')+' SARIF','export-scan-sarif')}</div></div></div>`:''}
 <div class="row wrap mb">${btn(icon('download')+' Export JSON receipt','export-json',S.scan.result?'ghost':'primary')}${btn(icon('file')+' Download Markdown','export-markdown')}${btn(icon('copy')+' Copy summary','copy-summary')}</div>
 <div class="grid-two mb"><div class="panel"><div class="panel-head"><h3>Verification snapshot</h3><span class="meta">${humanDate(S.analysis.inspectedAt)}</span></div><div class="panel-body"><div class="kpi-row"><div class="kpi"><strong>${S.analysis.files}</strong><small>Sources</small></div><div class="kpi"><strong>${f.length}</strong><small>Findings</small></div><div class="kpi"><strong>${S.resultsStale?'—':results.passed+'/'+results.total}</strong><small>Passed tests</small></div></div><hr class="divider"/><div class="metric-split"><span>Parsing</span><b>${S.analysis.parsed}/${S.files.length} files</b></div><div class="metric-split"><span>Static findings score</span><b>${S.analysis.score}/100</b></div><div class="metric-split"><span>Execution coverage</span><b>Selected cases only</b></div><div class="metric-split"><span>Verification state</span>${badge(S.resultsStale?'Changed since run':'Session current',S.resultsStale?'warning':'passed')}</div></div></div>
 <div class="panel secondary"><div class="panel-head"><h3>AI authorship evidence</h3>${badge(S.scan.result?.authorship?.label||'Inconclusive',S.scan.result?.authorship?.category==='indeterminate'||!S.scan.result?'warning':'info')}</div><div class="panel-body"><div class="warning-callout mb-sm"><b>No calibrated AI-written probability is produced.</b> The secondary estimate is heuristic, defaults to "Indeterminate" and is never used for findings. Source code alone cannot prove authorship.</div>${S.analysis.signals.slice(0,6).map(x=>`<div class="cardlink"><div><h4>${h(x.label)}</h4><p>${h(x.detail)}</p></div>${badge(x.weight,'low')}</div>`).join('')}<div class="mt">${btn('Open authorship estimate '+icon('arrow'),'go-authorship','ghost sm')}</div></div></div></div>
 <div class="panel"><div class="panel-head"><h3>Not verified by this build</h3><span class="meta">No false certainty</span></div><div class="panel-body"><div class="grid-three">${[['Universal correctness','Passing tests cannot prove the absence of undiscovered bugs.'],['Actual AI authorship','No signed origin metadata or calibrated forensic model is included.'],['Native system isolation','The static site cannot spawn OS microVMs, containers, or kernel sandboxes.'],['Dependency advisories','Packages are extracted but not compared to a live vulnerability feed.'],['End-to-end integrations','Real database/API interactions are not exercised locally.'],['Supply-chain integrity','Source-file hashes support later comparison, not author identity.']].map(([title,desc])=>`<div><b class="small">${h(title)}</b><p class="hint">${h(desc)}</p></div>`).join('')}</div></div></div>`;
}
function fixView(){const patches=findPatches(S.files,S.analysis.findings);const report=S.patchReport;
 return `${pageHead('MVP 05 · Verified improvement','Fix & Verify','Apply limited deterministic cleanup patches, rerun the same tests, and inspect regressions. Complex repairs remain recommendations until a developer reviews them.')}
 <div class="row wrap mb">${btn(icon('refresh')+' Recalculate patches','reinspect')}${S.revertSnapshot?btn(icon('refresh')+' Roll back latest patch','undo-patch','danger'):''}${badge(`${patches.length} safe-shape recipes`,'info')}</div>
 ${report?`<div class="${report.regressions?'warning-callout':'insight'} mb"><b>${h(report.heading)}</b><br>${h(report.description)} ${report.executed?`(${report.beforePass} → ${report.afterPass} passes across ${report.executed} tests)`:'(no matching tests)'}</div>`:''}
 <div class="grid-two"><div class="panel"><div class="panel-head"><h3>Suggested deterministic patches</h3><span class="meta">Requires human review</span></div><div class="panel-body">${patches.map(p=>`<div class="issue"><div class="row between wrap mb-sm"><b>${h(p.title)}</b>${badge('Low-risk shape','low')}</div><p class="code-ref">${h(p.file)}:${p.line}</p><p>${h(p.reason)}</p><div class="diff"><div class="del">- ${h(p.before)}</div><div class="add">+ (line removed)</div></div><div class="mt">${btn(icon('check')+' Apply & retest','apply-patch','primary sm',`data-id="${h(p.id)}" ${S.busy?'disabled':''}`)}</div></div>`).join('')||placeholder('No automatically editable statements','Other findings still have written remediation steps; unsafe rewrites are not automated.','wand')}</div></div>
 <div class="panel"><div class="panel-head"><h3>Review-only recommendations</h3>${badge(`${S.analysis.findings.filter(f=>!f.autofix).length} findings`,'info')}</div><div class="panel-body compact">${S.analysis.findings.filter(f=>!f.autofix).slice(0,8).map(f=>`<div class="cardlink"><div><div class="row mb-sm">${badge(f.severity)}<b>${h(f.title)}</b></div><p>${h(f.remediation)}</p><p class="code-ref">${h(f.file)}:${f.line}</p></div></div>`).join('')||placeholder('No review-only findings','Static checks did not identify additional review items.','check')}</div></div></div><div class="notice mt">CodeProof does not use an external LLM or pretend to generate universally correct fixes. Every patch is shown as a diff; verification only covers the tests actually executed. Add assertions before trusting a change.</div>`;
}
function projectView(){const edges=dependencyEdges(S.analysis.dependencies),external=edges.filter(x=>x.kind==='external');
 return `${pageHead('Expansion · Repository intelligence','Project Explorer','Inspect folders and ZIP repositories locally, build import graphs, detect issues across files, and export edited source as a ZIP. Source-file size and count limits reduce accidental browser overload.')}
 <div class="grid-two mb"><div class="panel"><div class="panel-head"><h3>Import a project</h3>${badge('No upload','passed')}</div><div class="panel-body"><div class="upload-box" id="drop-zone" tabindex="0" role="button" aria-label="Drop files, a folder or a ZIP here" data-action="open-files">${icon('upload',34)}<strong>Drop a ZIP, a folder or source files here</strong><span class="small">Every file is inventoried; up to ${fmt(S.policy.maxFiles)} text files of ${fmt(S.policy.maxFileBytes)} bytes each are loaded</span><div class="row wrap">${btn('Choose ZIP','open-zip','ghost sm')}${btn('Choose folder','open-folder','ghost sm')}${btn('Source files','open-files','ghost sm')}</div></div><input id="zip-picker" class="hidden" type="file" accept=".zip,application/zip"><input id="folder-picker" class="hidden" type="file" webkitdirectory directory multiple><input id="files-picker" class="hidden" type="file" multiple><p class="form-help">Archives are validated (entry count, sizes, compression ratio, path traversal, CRC) and inflated in a worker with hard limits; nothing is written to disk. Imports start a Project Scan automatically.</p><div class="row wrap mt">${btn(icon('scan')+' Open Project Scan','go-scan','primary sm')}${btn(icon('download')+' Export project ZIP','export-project')}${btn(icon('refresh')+' Load demo workspace','reset-demo','ghost')}</div></div></div>
 <div class="panel"><div class="panel-head"><h3>Project structure</h3><span class="meta">${S.files.length} files</span></div><div class="panel-body"><div class="kpi-row"><div class="kpi"><strong>${S.files.length}</strong><small>Source files</small></div><div class="kpi"><strong>${edges.length}</strong><small>Import edges</small></div><div class="kpi"><strong>${external.length}</strong><small>External refs</small></div></div><hr class="divider"/><div style="max-height:280px;overflow:auto">${S.files.map(f=>`<button class="file-entry" data-action="select-project-file" data-path="${h(f.path)}">${icon('file',14)}<span class="file-name">${h(f.path)}</span><span class="code-ext ${f.language==='python'?'py':'ts'}" style="margin-left:auto">${h((f.language||f.kind||'tx').slice(0,2).toUpperCase())}</span></button>`).join('')}</div></div></div></div>
 <div class="panel mb"><div class="panel-head"><h3>Dependency edges</h3><span class="meta">Resolved local paths are matched heuristically</span></div><div class="panel-body"><div class="grid-two even">${edges.slice(0,60).map(e=>`<div class="graph-row"><span>${h(e.from)}</span>${icon('arrow',13)}<b class="${e.kind}">${h(e.to)}</b></div>`).join('')||placeholder('No imports found','Add module imports to view file relationships.','branch')}</div>${edges.length>60?`<p class="form-help">Showing 60 of ${edges.length} edges.</p>`:''}</div></div><div class="notice">${icon('info',14)} <b>Dependency analysis:</b> this quick view lists raw import references from the live inspector. Project Scan resolves modules (extensions, index files, tsconfig paths, workspaces, Python packages), checks exports and call signatures across files, detects cycles and compares imports with manifests and lockfiles. Packages are never downloaded and no CVE feed is consulted.</div>`;
}
function teamView(){return `${pageHead('Expansion · Continuous assurance','Team Policies & PR Checks','Generate a portable integration kit containing a standalone Node CLI, static rules, policy file and GitHub Actions workflow. Commit the kit to any repository for automatic PR scanning.')}
 <div class="grid-two mb"><div class="panel"><div class="panel-head"><h3>Shared policy</h3>${badge('Version 1','info')}</div><div class="panel-body"><label class="form-label" for="policy-json">JSON policy · stored locally until exported</label><textarea id="policy-json" class="form-control wide" rows="13" spellcheck="false"></textarea><p class="form-help">failOnSeverity accepts critical, high, medium, low, info, off. A PR check fails when a finding meets that threshold. Parser errors can be separately blocking.</p><div class="row wrap mt">${btn(icon('check')+' Save policy','save-policy','primary')}${btn(icon('download')+' Download JSON','download-policy','ghost')}</div></div></div>
 <div class="panel"><div class="panel-head"><h3>GitHub Actions integration</h3>${badge('Portable','passed')}</div><div class="panel-body"><div class="timeline">${[['Download integration ZIP','Includes .codeproof/cli.mjs, parser, compiler, policy and workflow.'],['Copy files to your target repository','The ZIP contains paths ready to commit at repo root.'],['Commit and push','Pull requests will receive static checks and a downloadable JSON artifact.'],['Configure protection','Make the CodeProof audit check required in GitHub branch protection.']].map(([a,b],i)=>`<div class="step"><span class="step-number">${i+1}</span><div><strong>${h(a)}</strong><p>${h(b)}</p></div></div>`).join('')}</div><div class="mt">${btn(icon('download')+' Download CI integration ZIP','download-kit','primary')}</div><hr class="divider"/><b class="small">CI workflow scope</b><p class="hint">Scans code without executing submitted functions. Uses repository-owned policy and built-in GitHub authentication for normal workflow permissions. Does not create a SaaS team database, host pull-request previews, or support remote sandboxes.</p></div></div></div>
 <div class="grid-three">${[['No platform secrets needed','The audit reads checked-out source. No personal token or third-party key is required.'],['Auditable rule policy','Your repository contains its scan thresholds and excluded paths.'],['Artifact-based feedback','Download full JSON results and see file/line GitHub Actions annotations.']].map(([title,desc])=>`<div class="panel"><div class="panel-body"><div class="row mb-sm">${icon('shield',19)}<b>${h(title)}</b></div><p class="hint">${h(desc)}</p></div></div>`).join('')}</div>`;}
function renderModal(){if(S.modal!=='new-file')return '';return `<div class="modal-back" role="presentation" data-action="close-modal"><div class="modal" role="dialog" aria-modal="true" aria-label="Add new source file"><h2>New source file</h2><p class="hint">Create a JS, TS or Python file in your in-browser workspace.</p><label class="form-label" for="new-file-path">Path and extension</label><input class="form-control wide" id="new-file-path" value="src/new-function.js" placeholder="src/function.py"><div class="modal-actions">${btn('Cancel','close-modal','ghost')}${btn(icon('plus')+' Create file','create-file','primary')}</div></div></div>`;}
function hydrateEditor(){const editor=document.getElementById('code-editor'),file=fileInFocus();if(!editor)return;editor.value=file?.content||'';editor.disabled=!file;updateGutter(editor);}
function updateGutter(el){const gutter=document.getElementById('line-gutter');if(!gutter)return;const count=Math.min(10000,(el.value.match(/\n/g)||[]).length+1);gutter.textContent=Array.from({length:count},(_,i)=>String(i+1)).join('\n');gutter.scrollTop=el.scrollTop;}
function fillTestForm(){const file=document.querySelector('#test-file');if(file)file.value=S.active;}
// Re-rendering replaces the DOM; keep keyboard focus and caret where the user was.
function render(){
 const active=document.activeElement,id=active?.id,sel=active&&typeof active.selectionStart==='number'?[active.selectionStart,active.selectionEnd]:null;
 layout();
 if(id&&id!=='code-editor'){const el=document.getElementById(id);if(el&&el!==document.activeElement){el.focus?.();if(sel&&typeof el.setSelectionRange==='function')try{el.setSelectionRange(sel[0],sel[1]);}catch{/* not a text field */}}}
}
const slug=s=>String(s||'project').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'project';
function filterMatches(f){const ff=S.findingFilters;return (ff.severity==='all'||f.severity===ff.severity)&&(ff.category==='all'||f.category===ff.category)&&(ff.verification==='all'||f.verification===ff.verification)&&(ff.file==='all'||f.file===ff.file)&&(ff.analyzer==='all'||f.analyzers.includes(ff.analyzer))&&(!ff.search||`${f.title} ${f.rule} ${f.rootCause} ${f.file} ${f.id}`.toLowerCase().includes(ff.search.toLowerCase()));}

// Transpilation happens in the analysis worker; the 9 MB compiler never loads on the main thread.
// Every JS/TS/JSON file of the workspace is prepared so local imports resolve inside the sandbox.
let transpileCache={key:'',value:null};
const transpile=()=>transpileFor(S.files);
async function transpileFor(workspace){
 const files=workspace.filter(f=>['javascript','typescript','json'].includes(f.language)||/\.json$/.test(f.path));
 const key=files.map(f=>f.path+':'+f.content.length+':'+f.content.slice(0,40)+f.content.slice(-40)).join('|');
 if(transpileCache.key===key)return transpileCache.value;
 const out=await rpc({type:'transpile',files:files.map(f=>({path:f.path,language:f.language||detectLanguage(f.path,f.content),content:f.content,kind:f.kind}))});
 const failed=out.errors?.find(e=>e.path===S.active);if(failed)throw Error(failed.message);
 transpileCache={key,value:{modules:out.modules}};
 return transpileCache.value;
}
function setBusy(value,label=''){S.busy=value;S.runProgress=label;render();}
async function runSuite(tests=S.tests,{replace=true,silent=false}={}){
 if(S.busy)return [];
 if(!tests.length){toast('Create a test first.');return []}
 S.busy=true;S.runProgress='Preparing runtimes';if(!silent)render();
 try{
  const outcomes=await runner.runAll(S.files,tests,S.timeoutMs,transpile,(current,total)=>{S.runProgress=`Executed ${current}/${total}`;const progress=document.getElementById('run-progress');if(progress)progress.textContent=S.runProgress;});
  if(replace){S.results=outcomes;S.resultsStale=false;}return outcomes;
 }catch(e){toast('Test execution failed: '+e.message,'error');return []}
 finally{S.busy=false;S.runProgress='';if(!silent)render();}
}
function uniqueTests(tests){const oldIds=new Set(S.tests.map(x=>x.id));let count=0;for(const t of tests){if(!oldIds.has(t.id)){S.tests.push(t);count++;}}return count;}
function generateTests(){const f=selectedFunctions(),base=S.tests;
 if(!f.length){toast('No named functions detected in this file.');return}
 let n=0;for(const fn of f){const existing=base.find(x=>x.file===fn.file&&x.functionName===fn.name&&x.kind==='expected');n+=uniqueTests(generateBoundaryTests(fn,existing));}
 if(n){markModified();toast(`Generated ${n} edge and property tests.`);}else toast('Generated tests already exist.');
}
function copyText(str){navigator.clipboard?.writeText(str).then(()=>toast('Copied to clipboard.')).catch(()=>{downloadText('codeproof-summary.txt',str);});}
function downloadText(name,text,mime='text/plain'){const url=URL.createObjectURL(new Blob([text],{type:mime}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);}
function downloadBinary(name,blob){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);}
async function receipt(){return makeReceipt(S.files,S.analysis,S.resultsStale?[]:S.results,S.policy);}
async function downloadReport(markdown=false){try{const r=await receipt();downloadText(markdown?'codeproof-report.md':'codeproof-report.json',markdown?receiptMarkdown(r):JSON.stringify(r,null,2),markdown?'text/markdown':'application/json');}catch(e){toast('Report export: '+e.message,'error');}}
async function loadZipLib(){if(globalThis.JSZip)return globalThis.JSZip;if(loadZipLib.promise)return loadZipLib.promise;loadZipLib.promise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='./vendor/jszip.min.js';script.onload=()=>resolve(globalThis.JSZip);script.onerror=()=>reject(Error('Bundled ZIP library unavailable'));document.head.appendChild(script);});return loadZipLib.promise;}
// ---------------------------------------------------------------- ingestion and project scan
const SCAN_ORDER=['ingest','files','typecheck','integration','runtime','finalize'];
let lastProgressRender=0;
function updateProgress(p){
 const sc=S.scan;if(sc.status!=='running')return;
 const phase=p.phase==='prepare'?'files':p.phase==='done'?null:p.phase;
 if(phase&&SCAN_ORDER.includes(phase)){for(const k of SCAN_ORDER.slice(0,SCAN_ORDER.indexOf(phase)))if(sc.phases[k]==='running')sc.phases[k]='done';sc.phases[phase]='running';}
 if(p.label)sc.label=p.label;else if(p.phase==='ingest')sc.label=`Read ${fmt(p.done)} of ${fmt(p.total)} entries`;
 sc.done=p.done;sc.total=p.total;
 const label=document.getElementById('scan-progress-label');if(label)label.textContent=sc.label;
 if(Date.now()-lastProgressRender>500&&S.view==='scan'){lastProgressRender=Date.now();render();}
}
function resetForNewProject(project){
 S.project=project;
 S.files=project.files.map(f=>({path:f.path,language:f.language,kind:f.kind,content:f.content}));
 S.active=(project.files.find(f=>['javascript','typescript','python'].includes(f.language)&&f.kind!=='test')||project.files[0])?.path||'';
 S.tests=[];S.results=[];S.manual=null;S.resultsStale=true;S.selectedFindingId=null;S.dirtyAfterScan=new Set();S.ingestError=null;
 S.findingFilters={severity:'all',category:'all',verification:'all',file:'all',analyzer:'all',search:''};
 persist();inspect();
}
async function ingestProject(request,label,transfer=[]){
 if(S.scan.status==='running'){toast('A scan is already running; cancel it first.');return;}
 S.ingestError=null;S.view='scan';location.hash='scan';
 S.scan={status:'running',phases:{ingest:'running'},label,done:0,total:0,startedAt:Date.now(),result:null,error:null};render();
 try{
  const out=await rpc(request,updateProgress,transfer);
  const m=out.project.manifest;
  if(!out.project.files.length){const skipped=m.filter(x=>x.status!=='ingested');throw Object.assign(new Error(`No readable text files were found (${skipped.length} entries skipped or rejected${skipped[0]?`; first: ${skipped[0].path} — ${skipped[0].reason}`:''}).`),{stage:'Ingestion'});}
  resetForNewProject({...out.project,source:request.source||(request.zip?'ZIP archive':'files')});
  S.scan.status='idle';
  await startScan({ingested:true});
 }catch(e){
  S.scan.status=e.name==='AbortError'?'cancelled':'failed';S.scan.phases.ingest='failed';S.scan.finishedAt=Date.now();
  S.ingestError={title:e.code?`Archive rejected (${e.code})`:e.name==='AbortError'?'Import cancelled':'Import failed',message:e.message};
  render();
 }
}
async function importFiles(fileList,source='files'){
 const entries=Array.from(fileList).map(file=>({path:file.webkitRelativePath||file.relativePath||file.name,file,size:file.size}));
 if(!entries.length)throw Error('No files were selected.');
 const roots=new Set(entries.map(e=>e.path.split('/')[0]));
 await ingestProject({type:'ingest',entries,policy:S.policy,source,name:roots.size===1&&entries[0].path.includes('/')?[...roots][0]:undefined},`Reading ${fmt(entries.length)} files`);
}
async function importArchive(file){
 if(file.size>50_000_000)throw Error(`ZIP is ${fmt(file.size)} bytes; the compressed limit is 50,000,000 bytes.`);
 const bytes=await file.arrayBuffer();
 await ingestProject({type:'ingest',zip:bytes,policy:S.policy,source:'ZIP archive',name:file.name.replace(/\.zip$/i,'')},`Validating and inflating ${file.name}`,[bytes]);
}
// Folder drag-and-drop: walk directory entries (skipping policy-excluded directories without reading them).
async function filesFromDrop(dt){
 const roots=[...(dt?.items||[])].map(i=>i.webkitGetAsEntry?.()).filter(Boolean);
 if(!roots.length)return Array.from(dt?.files||[]).map(f=>({path:f.name,file:f,size:f.size}));
 const out=[];
 const walk=async(entry,prefix)=>{
  if(out.length>50000)return;
  if(entry.isFile){const file=await new Promise((res,rej)=>entry.file(res,rej));out.push({path:prefix+entry.name,file,size:file.size});return;}
  if(!entry.isDirectory)return;
  if(S.policy.ignorePaths.includes(entry.name)){out.push({path:prefix+entry.name+'/',isDirectory:true,size:0});return;}
  const reader=entry.createReader();
  for(;;){const batch=await new Promise((res,rej)=>reader.readEntries(res,rej));if(!batch.length)break;for(const e of batch)await walk(e,prefix+entry.name+'/');}
 };
 for(const r of roots)await walk(r,'');
 return out;
}
function setWorkspace(files){validateWorkspace(files,S.policy);resetForNewProject({name:'Demo workspace',source:'demo',files:files.map(f=>({...f,language:f.language||detectLanguage(f.path,f.content),kind:f.kind||'source'})),manifest:files.map(f=>({path:f.path,language:f.language,status:'ingested',reason:'',warnings:[]})),limits:[],caseCollisions:[]});S.scan={status:'idle',phases:{},result:null};render();}
async function startScan({ingested=false}={}){
 if(S.scan.status==='running')return;
 if(!S.files.length){toast('Load files first.');return;}
 const scanId='scan-'+Date.now(),opts={...S.scanOptions};
 S.scan={status:'running',scanId,phases:{ingest:ingested?'done':'running'},label:'Preparing project',startedAt:ingested&&S.scan.startedAt?S.scan.startedAt:Date.now(),result:null,error:null};
 S.selectedFindingId=null;S.findingPage=1;S.inventoryPage=1;S.scanTab='summary';S.view='scan';location.hash='scan';render();
 let stage='Ingestion';
 try{
  const extra=S.project?S.project.manifest.filter(m=>m.status!=='ingested'):[];
  const ing=await rpc({type:'ingest',texts:S.files.map(f=>({path:f.path,content:f.content,language:f.language,kind:f.kind})),manifestExtra:extra});
  const project={...ing.project,name:S.project?.name||'Editor workspace',source:S.project?.source||'editor workspace',limits:S.project?.limits||[],caseCollisions:S.project?.caseCollisions||[],archive:S.project?.archive||null};
  S.scan.phases.ingest='done';stage='Static analysis';
  const hasPython=project.files.some(f=>f.language==='python');
  const scanned=await rpc({type:'scan',scanId,project,policy:S.policy,runtimeOptions:{enableJs:opts.js,enablePython:opts.python&&hasPython}},updateProgress);
  for(const k of ['files','typecheck','integration'])S.scan.phases[k]=S.scan.phases[k]==='running'||S.scan.phases[k]==='done'?'done':'skipped';
  S.scan.result=scanned.scan;S.dirtyAfterScan=new Set();render();
  let results=[],blocked=[],cancelled=false;
  if(scanned.runtime&&scanned.runtime.jobs.length){
   stage='Runtime checks';S.scan.phases.runtime='running';S.scan.label='Running sandboxed tests and generated inputs';render();
   activeRuntime=new ProjectRuntime({budgetMs:opts.budgetMs});
   const out=await activeRuntime.run(scanned.runtime,{onProgress:p=>updateProgress({...p,phase:'runtime'})});
   results=out.results;blocked=out.blocked;cancelled=out.cancelled;
   S.scan.phases.runtime=cancelled?'cancelled':'done';
  }else S.scan.phases.runtime='skipped';
  stage='Finalize';S.scan.phases.finalize='running';
  const fin=await rpc({type:'finalize',scanId,results,blocked,cancelled,enabled:Boolean(scanned.runtime)});
  S.scan.result=fin.scan;S.scan.phases.finalize='done';
  S.scan.status=cancelled?'cancelled':'complete';S.scan.finishedAt=Date.now();
  S.scan.label=cancelled?'Cancelled during runtime checks; results so far are shown and marked incomplete.':'Scan complete';
  toast(cancelled?'Scan cancelled; partial results kept.':`Scan complete: ${fmt(fin.scan.findings.length)} findings.`);
 }catch(e){
  const aborted=e.name==='AbortError';
  S.scan.status=aborted?'cancelled':'failed';S.scan.finishedAt=Date.now();
  S.scan.label=aborted?'Scan cancelled; static analysis was stopped.':'Scan failed';
  if(!aborted)S.scan.error={stage,message:e.message,action:stage==='Runtime checks'?'Static results remain valid; rerun, or disable runtime checks.':'Retry; very large inputs may exceed this browser\'s memory.'};
  for(const k of Object.keys(S.scan.phases))if(S.scan.phases[k]==='running')S.scan.phases[k]=aborted?'cancelled':'failed';
 }finally{activeRuntime=null;render();}
}
function cancelScan(){
 if(S.scan.status!=='running')return;
 if(activeRuntime){activeRuntime.cancel();toast('Stopping sandbox jobs…');return;}
 restartWorker('Scan cancelled by user');
}
function scanSummaryText(){
 const r=S.scan.result;if(!r)return '';
 const c=r.coverage,f=c.findings.byVerification;
 return `CodeProof scan of ${r.project.name}: ${c.verdict.message} Findings — reproduced: ${f['confirmed-runtime']||0}, confirmed static: ${f['confirmed-static']||0}, high-confidence: ${f['high-confidence']||0}, potential: ${f.potential||0}, security observations: ${f['security-observation']||0}. ${c.ratios.map(x=>`${x.label}: ${x.numerator}/${x.denominator}`).join('; ')}.`;
}
function selectEditorLine(line){
 const editor=document.getElementById('code-editor');if(!editor||!line)return;
 const rows=editor.value.split('\n');const start=rows.slice(0,line-1).reduce((n,r)=>n+r.length+1,0);
 editor.focus();editor.setSelectionRange(start,start+(rows[line-1]||'').length);editor.scrollTop=Math.max(0,(line-6)*20);updateGutter(editor);
}
async function exportWorkspace(){const JSZip=await loadZipLib(),zip=new JSZip();for(const f of S.files)zip.file(f.path,f.content);downloadBinary('codeproof-reviewed-source.zip',await zip.generateAsync({type:'blob',compression:'DEFLATE'}));}
const integrateWorkflow=`name: CodeProof static audit\non:\n  pull_request:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  codeproof:\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: '22'\n      - name: Inspect code without executing it\n        run: node .codeproof/cli.mjs\n      - name: Upload evidence artifact\n        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2\n        if: always()\n        with:\n          name: codeproof-evidence\n          path: codeproof-report.json\n          if-no-files-found: ignore\n`;
const ENGINE_MODULES=['util','paths','detect','ingest','zip','findings','text-rules','estree','js-rules','python','generic','catalog','config','ts-program','graph','capabilities','coverage','authorship','testgen','runtime-plan','transpile','scan','report','index'];
async function downloadIntegration(){
 const text=url=>fetch(url).then(r=>{if(!r.ok)throw Error(`${url}: HTTP ${r.status}`);return r.text();});
 const [JSZip,cli,parser,compiler,libList]=await Promise.all([loadZipLib(),text('./integrations/cli.mjs'),text('./assets/acorn.mjs'),fetch('./vendor/typescript.js').then(r=>{if(!r.ok)throw Error('TypeScript compiler asset missing');return r.arrayBuffer();}),fetch('./vendor/typescript-lib/files.json').then(r=>r.ok?r.json():[])]);
 const zip=new JSZip();
 zip.file('.codeproof/cli.mjs',cli);zip.file('.codeproof/acorn.mjs',parser);zip.file('.codeproof/typescript.cjs',compiler);
 for(const name of ENGINE_MODULES)zip.file(`.codeproof/engine/${name}.mjs`,await text(`./assets/engine/${name}.mjs`));
 for(const name of libList)zip.file(`.codeproof/typescript-lib/${name}`,await text(`./vendor/typescript-lib/${name}`));
 zip.file('.codeproof-policy.json',JSON.stringify(S.policy,null,2));zip.file('.github/workflows/codeproof.yml',integrateWorkflow);
 zip.file('CODEPROOF-INTEGRATION.md',`CodeProof PR integration\n\nCopy all files into the root of your repository and commit. The audit is static only: it parses, type-checks and analyzes cross-file integration, and never runs repository code. Adjust .codeproof-policy.json to your standards. The CLI needs Node 22+ and no npm install.\n${libList.length?'':'\\nNote: TypeScript lib declarations were not available on this deployment, so the kit cannot type-check; parsing and integration checks still run.\\n'}`);
 downloadBinary('codeproof-github-integration.zip',await zip.generateAsync({type:'blob',compression:'DEFLATE'}));
}

async function handleAction(action,element){
 switch(action){
 case'navigate':S.view=element.dataset.view;location.hash=S.view;render();break;
 case'go-inspector':S.view='inspector';location.hash='inspector';render();break;
 case'go-scan':S.view='scan';location.hash='scan';render();break;
 case'go-authorship':S.view='authorship';location.hash='authorship';render();break;
 case'start-scan':await startScan();break;
 case'cancel-scan':cancelScan();break;
 case'scan-workspace':S.project=S.project||null;await startScan();break;
 case'scan-tab':S.scanTab=element.dataset.tab;S.findingPage=1;S.inventoryPage=1;render();document.getElementById('tab-'+S.scanTab)?.focus();break;
 case'scan-tab-report':S.scanTab='report';render();break;
 case'select-finding':{S.selectedFindingId=element.dataset.id;if(!['findings','integration','security'].includes(S.scanTab))S.scanTab='findings';const f=S.scan.result?.findings.find(x=>x.id===S.selectedFindingId);if(f&&S.scanTab==='findings'&&!filterMatches(f)){S.findingFilters={severity:'all',category:'all',verification:'all',file:'all',analyzer:'all',search:''};}render();document.getElementById('fd-title')?.focus();break;}
 case'open-scan-finding':S.view='scan';location.hash='scan';S.scanTab='findings';S.selectedFindingId=element.dataset.id;S.findingFilters={severity:'all',category:'all',verification:'all',file:'all',analyzer:'all',search:''};render();break;
 case'findings-more':S.findingPage++;render();break;
 case'inventory-more':S.inventoryPage++;render();break;
 case'tree-file':S.findingFilters={...S.findingFilters,file:element.dataset.path};S.scanTab='findings';S.findingPage=1;render();break;
 case'open-in-editor':{const path=element.dataset.path,line=Number(element.dataset.line)||1;if(!S.files.some(f=>f.path===path)){toast('That file is not in the editor workspace.');break;}S.active=path;S.view='inspector';location.hash='inspector';render();setTimeout(()=>selectEditorLine(line),30);break;}
 case'copy-finding':{const f=S.scan.result?.findings.find(x=>x.id===element.dataset.id);if(f)copyText(`${f.id} ${f.title}\n${f.file||'project'}${f.line?':'+f.line:''}\nVerification: ${f.verificationLabel}\nCause: ${f.rootCause}\n${f.trigger?'Trigger: '+f.trigger+'\n':''}${(f.reproduction||[]).map((r,i)=>`${i+1}. ${r}`).join('\n')}${f.actual?'\nActual: '+f.actual:''}${f.expected?'\nExpected: '+f.expected:''}`);break;}
 case'export-scan-json':if(S.scan.result)downloadText(`codeproof-scan-${slug(S.scan.result.project.name)}.json`,JSON.stringify(buildReport(S.scan.result),null,2),'application/json');break;
 case'export-scan-md':if(S.scan.result)downloadText(`codeproof-scan-${slug(S.scan.result.project.name)}.md`,reportMarkdown(S.scan.result),'text/markdown');break;
 case'export-scan-sarif':if(S.scan.result)downloadText(`codeproof-scan-${slug(S.scan.result.project.name)}.sarif`,JSON.stringify(reportSarif(S.scan.result),null,2),'application/sarif+json');break;
 case'copy-scan-summary':copyText(scanSummaryText());break;
 case'go-projects':S.view='projects';location.hash='projects';render();break;
 case'go-runner':S.view='runner';location.hash='runner';render();break;
 case'go-evidence':S.view='evidence';location.hash='evidence';render();break;
 case'go-fixes':S.view='fixes';location.hash='fixes';render();break;
 case'open-finding':{const f=S.analysis.findings.find(x=>x.id===element.dataset.id);if(f){S.active=f.file;S.filter='all';S.view='inspector';location.hash='inspector';render();setTimeout(()=>{document.getElementById('code-editor')?.focus()},50);}break;}
 case'select-project-file':S.active=element.dataset.path;S.view='inspector';location.hash='inspector';render();break;
 case'select-file':S.active=element.dataset.path;persist();render();break;
 case'delete-file':{
  const path=element.dataset.path;
  if(S.files.length<=1){toast('Keep at least one source file.');break;}
  if(!confirm(`Remove ${path} from this browser workspace?`))break;
  S.files=S.files.filter(f=>f.path!==path);S.tests=S.tests.filter(t=>t.file!==path);if(S.active===path)S.active=S.files[0].path;markModified();render();break;
 }
 case'run-fn':S.runFn=element.dataset.fn;S.view='runner';location.hash='runner';render();break;
 case'reinspect':inspect();toast('Local analysis requested.');break;
 case'new-file':S.modal='new-file';render();break;
 case'close-modal':S.modal='';render();break;
 case'create-file':{
  const norm=normalizePath(document.getElementById('new-file-path')?.value.trim()||'');const path=norm.ok?norm.path:'';
  if(!path||!acceptedPath(path,S.policy)){toast('Use a safe relative path with a supported source extension (.js, .ts, .py, …).','error');break;}
  if(S.files.some(f=>f.path===path)){toast('This file already exists.','error');break;}
  S.files.push({path,language:languageFromPath(path),content:languageFromPath(path)==='python'?'def hello(name):\n    return "Hello, " + name\n':(['javascript','typescript'].includes(languageFromPath(path))?'function hello(name) {\n  return "Hello, " + name;\n}\n':'// Source code here\n')});
  S.active=path;S.modal='';markModified();render();break;
 }
 case'execute-one':{
  if(S.busy)return;
  const file=fileInFocus();const func=document.getElementById('run-function')?.value;
  const argsRaw=document.getElementById('run-args')?.value||'[]';let args;
  S.runFn=func||'';S.runArgs=argsRaw;
  try{args=JSON.parse(argsRaw);if(!Array.isArray(args))throw Error('Arguments must be a JSON array.');}catch(e){toast('Arguments invalid: '+e.message,'error');break;}
  if(!func){toast('No callable function selected.');break;}
  S.timeoutMs=Number(document.getElementById('timeout-select')?.value||1800);
  const test={id:'manual:'+Date.now(),title:'Manual execution: '+func,file:file.path,functionName:func,args,kind:'smoke',source:'user'};
  S.busy=true;render();
  try{S.manual=await runner.runOne(file,test,S.timeoutMs,transpile);S.results.push(S.manual);S.resultsStale=false;}
  catch(e){toast('Execution error: '+e.message,'error');}
  finally{S.busy=false;render();}break;
 }
 case'validate-python':{
  const file=fileInFocus();if(!file||file.language!=='python'||S.busy)return;
  S.busy=true;render();try{S.pythonChecks[file.path]=await runner.validatePython(file.content,3000);toast(S.pythonChecks[file.path].message);}catch(e){toast('Python validation: '+e.message,'error');}finally{S.busy=false;render();}break;
 }
 case'run-tests':{if(!S.busy)await runSuite();break;}
 case'generate-for-active':generateTests();render();break;
 case'toggle-test-form':S.showTestForm=!S.showTestForm;render();break;
 case'save-test':{
  const form=document.getElementById('test-form');if(!form)return;
  const name=document.getElementById('test-function')?.value,file=document.getElementById('test-file')?.value,title=document.getElementById('test-title')?.value.trim(),kind=document.getElementById('test-kind')?.value;
  let args,expected;
  try{args=JSON.parse(document.getElementById('test-args')?.value);if(!Array.isArray(args))throw Error('Arguments must be JSON array');if(kind==='expected')expected=JSON.parse(document.getElementById('test-expected')?.value);}catch(e){toast('Invalid test JSON: '+e.message,'error');break;}
  if(!name||!title){toast('Choose function and title.');break;}
  S.tests.push({id:crypto.randomUUID(),title,file,functionName:name,args,kind,expected,source:'user'});
  S.showTestForm=false;markModified();render();toast('Test saved.');break;
 }
 case'remove-test':S.tests=S.tests.filter(t=>t.id!==element.dataset.id);S.resultsStale=true;persist();render();break;
 case'apply-patch':{
  if(S.busy)return;
  const patch=findPatches(S.files,S.analysis.findings).find(p=>p.id===element.dataset.id);if(!patch)return toast('Patch no longer available.');
  const previous=structuredClone(S.files);const relevant=S.tests.filter(t=>t.file===patch.file);S.busy=true;render();
  let before=[],after=[];
  try{
    if(relevant.length)before=await runner.runAll(previous,relevant,S.timeoutMs,()=>transpileFor(previous));
    const updated=applyPatch(previous,patch);
    if(relevant.length)after=await runner.runAll(updated,relevant,S.timeoutMs,()=>transpileFor(updated));
    const regressions=after.filter((t,i)=>before[i]?.status==='passed'&&t.status!=='passed').length;
    const improved=after.filter((t,i)=>before[i]?.status!=='passed'&&t.status==='passed').length;
    if(regressions){S.patchReport={heading:'Patch automatically rolled back',description:`${regressions} previously passing test(s) regressed. Original source retained.`,regressions,executed:relevant.length,beforePass:before.filter(x=>x.status==='passed').length,afterPass:after.filter(x=>x.status==='passed').length};}
    else{S.files=updated;S.revertSnapshot=previous;S.patchReport={heading:relevant.length?'Patch applied · tests rerun':'Patch applied · unverified',description:relevant.length?`No previously passing tests regressed. ${improved} newly passed. This is not proof of full correctness.`:'There were no matching tests; verification of this change is not possible.',regressions:0,executed:relevant.length,beforePass:before.filter(x=>x.status==='passed').length,afterPass:after.filter(x=>x.status==='passed').length};S.resultsStale=true;persist();inspect();}
  }catch(e){toast('Patch could not be applied: '+e.message,'error');}
  finally{S.busy=false;render();}break;
 }
 case'undo-patch':if(S.revertSnapshot){S.files=S.revertSnapshot;S.revertSnapshot=null;S.patchReport=null;markModified();render();toast('Original source restored.');}break;
 case'export-json':await downloadReport();break;
 case'export-markdown':await downloadReport(true);break;
 case'copy-summary':copyText(`CodeProof: ${S.files.length} files, ${S.analysis.findings.length} static findings, ${S.resultsStale?'no current test run':S.results.filter(x=>x.status==='passed').length+'/'+S.results.length+' passed tests'}. AI authorship inconclusive.`);break;
 case'open-zip':document.getElementById('zip-picker')?.click();break;
 case'open-folder':document.getElementById('folder-picker')?.click();break;
 case'open-files':document.getElementById('files-picker')?.click();break;
 case'export-project':try{await exportWorkspace();}catch(e){toast('Project ZIP: '+e.message,'error');}break;
 case'reset-demo':if(confirm('Replace the current browser workspace with the demo project?')){setWorkspace(structuredClone(sampleFiles));S.tests=structuredClone(sampleTests);persist();render();toast('Demo workspace restored.');}break;
 case'save-policy':{
  try{
    const x=JSON.parse(document.getElementById('policy-json').value);
    if(x.version!==1||!Number.isSafeInteger(x.maxFiles)||x.maxFiles<1||x.maxFiles>5000||!Number.isSafeInteger(x.maxFileBytes)||x.maxFileBytes<1000||x.maxFileBytes>1_000_000||!Array.isArray(x.ignorePaths)||x.ignorePaths.some(v=>typeof v!=='string')||!['critical','high','medium','low','info','off'].includes(x.failOnSeverity)||typeof x.failOnParseError!=='boolean')throw Error('Invalid policy schema or unsupported limits.');
    S.policy=x;persist();render();toast('Policy saved locally.');
  }catch(e){toast('Policy error: '+e.message,'error');}break;
 }
 case'download-policy':downloadText('.codeproof-policy.json',JSON.stringify(S.policy,null,2),'application/json');break;
 case'download-kit':try{await downloadIntegration();toast('Team integration ZIP generated.');}catch(e){toast('Integration export: '+e.message,'error');}break;
 }
}
root.addEventListener('click',async event=>{
 const node=event.target.closest('[data-action]');if(!node)return;
 // Clicking the modal container should not close when clicking inside the dialog.
 if(node.classList.contains('modal-back')&&event.target.closest('.modal'))return;
 event.preventDefault();try{await handleAction(node.dataset.action,node);}catch(e){toast('Action failed: '+e.message,'error');console.error(e);}
});
root.addEventListener('input',event=>{
 if(event.target.id==='run-args')S.runArgs=event.target.value;
 if(event.target.id==='code-editor'){
  const f=fileInFocus();if(f)f.content=event.target.value;
  updateGutter(event.target);markModified();
 }
});
root.addEventListener('scroll',event=>{if(event.target.id==='code-editor')updateGutter(event.target);},true);
root.addEventListener('keydown',event=>{
 // Arrow-key navigation inside tab lists (WAI-ARIA tabs pattern).
 if(event.target.getAttribute?.('role')==='tab'&&['ArrowRight','ArrowLeft','Home','End'].includes(event.key)){
  event.preventDefault();const ids=SCAN_TABS.map(t=>t[0]);let i=ids.indexOf(S.scanTab);
  i=event.key==='Home'?0:event.key==='End'?ids.length-1:(i+(event.key==='ArrowRight'?1:-1)+ids.length)%ids.length;
  handleAction('scan-tab',{dataset:{tab:ids[i]}});return;
 }
 if((event.key==='Enter'||event.key===' ')&&event.target.getAttribute?.('role')==='button'&&event.target.dataset?.action&&event.target.tagName!=='BUTTON'){event.preventDefault();handleAction(event.target.dataset.action,event.target).catch(e=>toast('Action failed: '+e.message,'error'));return;}
 if(event.target.id==='code-editor'&&event.key==='Tab'){
  event.preventDefault();const e=event.target,s=e.selectionStart; e.setRangeText('  ',s,e.selectionEnd,'end');e.dispatchEvent(new Event('input',{bubbles:true}));
 }
 if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){
  event.preventDefault();const run=S.view==='inspector'||S.view==='runner';
  S.view='runner';location.hash='runner';render();
  if(run)handleAction('execute-one').catch(e=>toast('Action failed: '+e.message,'error'));
 }
 if(S.modal==='new-file'&&event.key==='Escape'){S.modal='';render();}
 if(event.target.id==='new-file-path'&&event.key==='Enter'){event.preventDefault();handleAction('create-file').catch(e=>toast('Action failed: '+e.message,'error'));}
});
root.addEventListener('change',async event=>{
 const target=event.target;
 if(target.dataset?.filter&&target.tagName==='SELECT'){S.findingFilters={...S.findingFilters,[target.dataset.filter]:target.value};S.findingPage=1;render();return;}
 if(target.id==='inventory-filter'){S.inventoryFilter=target.value;S.inventoryPage=1;render();return;}
 if(target.id==='opt-js'){S.scanOptions.js=target.checked;return;}
 if(target.id==='opt-python'){S.scanOptions.python=target.checked;return;}
 if(target.id==='persist-toggle'){S.persist=target.checked;if(S.persist){persist();toast('Editor workspace will be kept in this browser.');}else{clearStoredWorkspace();toast('Stored workspace deleted from this browser.');}render();return;}
 if(target.id==='severity-filter'){S.filter=target.value;render();}
 if(target.id==='test-filter'){S.testFilter=target.value;render();}
 if(target.id==='run-function')S.runFn=target.value;
 if(target.id==='run-file'){S.active=target.value;persist();render();}
 if(target.id==='test-file'){
  const draft=['test-title','test-kind','test-args','test-expected'].map(id=>[id,document.getElementById(id)?.value]);
  S.active=target.value;render();S.showTestForm=true;
  for(const [id,value] of draft){const el=document.getElementById(id);if(el&&value!=null)el.value=value;}
 }
 if(target.id==='timeout-select'){S.timeoutMs=Number(target.value);}
 if(['zip-picker','folder-picker','files-picker'].includes(target.id)&&target.files?.length){const list=Array.from(target.files);target.value='';try{if(target.id==='zip-picker'||(list.length===1&&/\.zip$/i.test(list[0].name)))await importArchive(list[0]);else await importFiles(list,target.id==='folder-picker'?'folder':'files');}catch(e){S.ingestError={title:'Import failed',message:e.message};toast('Import failed: '+e.message,'error');render();}}
});
let filterTimer=null;
root.addEventListener('input',event=>{if(event.target.dataset?.filter==='search'){clearTimeout(filterTimer);const value=event.target.value;filterTimer=setTimeout(()=>{S.findingFilters={...S.findingFilters,search:value};S.findingPage=1;render();},220);}});
root.addEventListener('input',event=>{if(event.target.id==='finding-search'){S.search=event.target.value;const list=document.getElementById('finding-list');if(list){const current=S.analysis.findings.filter(f=>f.file===S.active).filter(f=>(S.filter==='all'||f.severity===S.filter)&&(`${f.title} ${f.message} ${f.rule}`.toLowerCase().includes(S.search.toLowerCase())));list.innerHTML=current.map(issueCard).join('')||placeholder('No findings match','Change the search or filter.','search');}}});
window.addEventListener('hashchange',()=>{const hash=location.hash.slice(1);if(NAV.some(([id])=>id===hash)&&S.view!==hash){S.view=hash;render();}});
window.addEventListener('beforeunload',()=>{runner.dispose();activeRuntime?.cancel();});
render();
const drop=()=>document.getElementById('drop-zone');
root.addEventListener('dragover',e=>{if(e.target.closest('#drop-zone')){e.preventDefault();drop()?.classList.add('drag');}});
root.addEventListener('dragleave',e=>{if(e.target.closest('#drop-zone'))drop()?.classList.remove('drag');});
root.addEventListener('drop',async e=>{if(!e.target.closest('#drop-zone'))return;e.preventDefault();drop()?.classList.remove('drag');try{const entries=await filesFromDrop(e.dataTransfer);if(entries.length===1&&/\.zip$/i.test(entries[0].path))await importArchive(entries[0].file);else{entries.forEach(x=>{if(x.file)x.file.relativePath=x.path;});const roots=new Set(entries.map(x=>x.path.split('/')[0]));await ingestProject({type:'ingest',entries:entries.map(x=>({path:x.path,file:x.file,size:x.size,isDirectory:x.isDirectory})),policy:S.policy,source:'drag and drop',name:roots.size===1&&entries[0]?.path.includes('/')?[...roots][0]:undefined},`Reading ${fmt(entries.length)} dropped files`);}}catch(err){S.ingestError={title:'Drop import failed',message:err.message};toast('Drop import: '+err.message,'error');render();}});