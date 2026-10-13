import {APP_VERSION,defaultPolicy,sampleFiles,sampleTests,languageFromPath,acceptedPath,analyzeWorkspace,generateBoundaryTests,findPatches,applyPatch,summarize,dependencyEdges,failsPolicy,makeReceipt,receiptMarkdown,validateWorkspace} from './core.mjs';
import {LocalTestRunner} from './sandbox.mjs';

const root=document.querySelector('#app');
const iconPaths={shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',code:'<path d="m8 17-5-5 5-5m8 0 5 5-5 5M14 4l-4 16"/>',play:'<path d="m8 5 12 7-12 7V5Z"/>',flask:'<path d="M9 3h6m-5 0v7l-6 9a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-6-9V3M7 16h10"/>',file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8m-8 4h8"/>',wand:'<path d="m3 21 9-9m2-9 1.6 3.4L19 8l-3.4 1.6L14 13l-1.6-3.4L9 8l3.4-1.6L14 3Zm6 11 .9 2.1L23 17l-2.1.9L20 20l-.9-2.1L17 17l2.1-.9L20 14Z"/>',layers:'<path d="m12 2 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m9-18a4 4 0 1 1-8 0m13 18v-2a4 4 0 0 0-3-3.87m1-11.26a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',arrow:'<path d="M5 12h14m-7-7 7 7-7 7"/>',upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',check:'<path d="m5 12 4 4L19 6"/>',alert:'<path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 21h15.8a2 2 0 0 0 1.7-3.4L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4m0 4h.01"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',terminal:'<rect x="2" y="3" width="20" height="18" rx="2"/><path d="m6 9 3 3-3 3m6 0h5"/>',bug:'<path d="M8 7V5a4 4 0 0 1 8 0v2m-10 4H3m3 5H3m18-5h-3m3 5h-3M7 7h10v10a5 5 0 0 1-10 0V7Zm5 0v14M3 5l4 3m14-3-4 3"/>',search:'<circle cx="11" cy="11" r="8"/><path d="m17 17 4 4"/>',plus:'<path d="M12 5v14M5 12h14"/>',trash:'<path d="M3 6h18m-2 0-1 14H6L5 6m4 0V4h6v2M10 10v7m4-7v7"/>',refresh:'<path d="M20 11a8 8 0 1 0-2 6m2-12v6h-6"/>',branch:'<circle cx="6" cy="3" r="2"/><path d="M6 5v12a4 4 0 0 0 4 4h3"/><circle cx="16" cy="21" r="2"/><circle cx="17" cy="6" r="2"/><path d="M6 13h7a4 4 0 0 0 4-4V8"/>',lock:'<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/>',settings:'<circle cx="12" cy="12" r="3"/><path d="M20 12a8 8 0 0 0-.2-2l2-1.6-2-3.5-2.4 1A9 9 0 0 0 14 4l-.4-2h-4L9 4a9 9 0 0 0-3.3 1.9l-2.4-1-2 3.5L3.3 10A8 8 0 0 0 3 12a8 8 0 0 0 .3 2l-2 1.6 2 3.5 2.4-1A9 9 0 0 0 9 20l.6 2h4l.4-2a9 9 0 0 0 3.4-1.9l2.4 1 2-3.5-2-1.6A8 8 0 0 0 20 12Z"/>',chevron:'<path d="m9 18 6-6-6-6"/>',copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',info:'<circle cx="12" cy="12" r="10"/><path d="M12 11v5m0-8h.01"/>',x:'<path d="M18 6 6 18M6 6l12 12"/>',zap:'<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',chart:'<path d="M4 20V4m0 16h16M8 15l4-5 4 3 4-7"/>',globe:'<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>'};
const icon=(name,size=18)=>`<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name]||iconPaths.code}</svg>`;
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>Number(n||0).toLocaleString('en-US');
const badge=(txt,cls=txt)=>`<span class="badge ${h(cls)}">${h(txt)}</span>`;
const btn=(text,action,cls='ghost',extra='')=>`<button type="button" class="btn ${cls}" data-action="${h(action)}" ${extra}>${text}</button>`;
const now=()=>new Date().toISOString();
const NAV=[['workspace','grid','Overview'],['inspector','code','Code Inspector'],['runner','terminal','Execution Lab'],['tests','flask','Automated Tests'],['evidence','file','Evidence Reports'],['fixes','wand','Fix & Verify'],['projects','layers','Project Explorer'],['teams','users','Team & CI']];
const descriptions={workspace:'Overview',inspector:'Code Inspector',runner:'Execution Lab',tests:'Automated Tests',evidence:'Evidence Reports',fixes:'Fix & Verify',projects:'Project Explorer',teams:'Team & CI'};
const saved=(()=>{try{const str=localStorage.getItem('codeproof.state.v1');const x=JSON.parse(str||'null');return x&&Array.isArray(x.files)&&Array.isArray(x.tests)?x:null;}catch{return null;}})();
const S={files:saved?.files?.length?saved.files:structuredClone(sampleFiles),active:saved?.active||'src/payment.js',tests:saved?.tests||structuredClone(sampleTests),policy:saved?.policy||structuredClone(defaultPolicy),analysis:analyzeWorkspace(saved?.files?.length?saved.files:sampleFiles),view:location.hash.slice(1).split('?')[0]||'workspace',results:[],resultsStale:true,manual:null,filter:'all',search:'',testFilter:'all',selectedFinding:null,busy:false,runProgress:'',timeoutMs:1800,runArgs:'[100, 20]',runFn:'',patchReport:null,revertSnapshot:null,toast:[],modal:'',sideMenu:false,engineError:'',syncDisabled:false,showTestForm:false,aiNotice:false,pythonChecks:{}};
if(!NAV.some(n=>n[0]===S.view))S.view='workspace';
if(!S.files.some(x=>x.path===S.active))S.active=S.files[0]?.path||'';
const runner=new LocalTestRunner();
const analysisWorker=new Worker(new URL('./analysis.worker.mjs',import.meta.url),{type:'module'});
let analyzeSeq=0,analyzeTimer=null;
analysisWorker.onmessage=ev=>{
  if(ev.data.id!==analyzeSeq)return;
  if(ev.data.error){S.engineError=ev.data.error;toast('Inspector: '+ev.data.error,'error');return;}
  S.analysis=ev.data.analysis;S.engineError='';
  if(document.activeElement?.id==='code-editor')refreshInspector();
  else render();
};
function inspect(){clearTimeout(analyzeTimer);analyzeTimer=setTimeout(()=>{analyzeSeq++;analysisWorker.postMessage({id:analyzeSeq,files:S.files});},160);}
inspect();
function persist(){
 try{const data=JSON.stringify({files:S.files,active:S.active,tests:S.tests,policy:S.policy});if(data.length<1_500_000){localStorage.setItem('codeproof.state.v1',data);S.syncDisabled=false;}else S.syncDisabled=true;}catch{S.syncDisabled=true;}
}
function markModified(){S.resultsStale=true;S.patchReport=null;delete S.pythonChecks[S.active];persist();inspect();}
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
function layout(){
 const active=NAV.find(x=>x[0]===S.view)||NAV[0];
 root.innerHTML=`<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">${icon('shield',28)}</span><div><strong>CodeProof</strong><small>VERIFICATION LAB</small></div></div><div class="nav-title">WORKSPACE</div><nav aria-label="Main navigation">${NAV.map(([key,ico,label])=>`<button data-action="navigate" data-view="${key}" class="nav-item ${S.view===key?'active':''}">${icon(ico)}<span>${label}</span>${key==='inspector'?`<span class="nav-small">${S.analysis.findings.length}</span>`:''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="local-pill">${icon('lock',16)} Private browser workspace</div><p>No account, server, tracking or API key is needed for inspection. Downloaded Python runtime is optional.</p></div></aside><div class="content"><header class="topbar"><div class="crumb">CodeProof <span class="sep">/</span><strong>${h(active[2])}</strong></div>${headActions()}</header><main class="main">${renderView()}</main></div></div><div class="toast-wrap" id="toast-wrap" aria-live="polite"></div><div id="modal-anchor">${renderModal()}</div>`;
 if(S.view==='inspector')hydrateEditor();
 if(S.modal==='new-file')document.getElementById('new-file-path')?.focus();
 if(S.view==='teams'){const el=document.getElementById('policy-json');if(el)el.value=JSON.stringify(S.policy,null,2);}
 if(S.view==='runner'||S.view==='tests')fillTestForm();
}
function renderView(){switch(S.view){case'workspace':return overview();case'inspector':return inspector();case'runner':return runnerView();case'tests':return testView();case'evidence':return evidenceView();case'fixes':return fixView();case'projects':return projectView();case'teams':return teamView();default:return overview();}}
function overview(){
 const c=statusCounts(),counts=summarize(S.results);
 return `${pageHead('Independent code assurance','Trust the evidence. <span class="gradient">Not the output.</span>','A browser-native verification lab for AI-assisted and human-written code. Inspect source, challenge assumptions, run isolated tests, and export reproducible evidence—without sending your files to a server.')}
 <div class="row wrap mb">${btn(icon('play')+' Run test suite','run-tests','primary')}${btn(icon('code')+' Open inspector','go-inspector')}${btn(icon('upload')+' Import repository','go-projects','ghost')}${badge('v'+APP_VERSION,'info')}</div>
 <section class="stats" aria-label="Workspace metrics">
 ${metric('file',fmt(S.files.length),'Source files','indigo')}${metric('code',fmt(S.analysis.lines),'Lines inspected','')}${metric('alert',fmt(c.critical+c.high),'Major findings','alert')}${metric('flask',S.resultsStale?'—':`${counts.passed}/${counts.total}`,'Tests passed', 'warning')}
 </section>
 <section class="grid-two mb"><div class="panel"><div class="panel-head"><h3>Verification pipeline</h3><span class="meta">5 core engines + extensions</span></div><div class="panel-body compact">${[
 ['Code Inspector','Syntax, reliability, security, and maintainability findings','inspector','check'],['Safe Execution Lab','Opaque-origin worker sandboxes and hard timeouts','runner','terminal'],['Automated Tests','Expected results, edge inputs, determinism checks','tests','flask'],['Evidence Reports','File hashes, findings, failures, unverified areas','evidence','file'],['Fix & Verify','Patch, rerun identical tests, flag regressions','fixes','wand'],['Repository and Team Tools','ZIP/folder imports, dependency map and PR checks','projects','branch']
 ].map(([title,desc,key,ico])=>`<div class="cardlink"><div class="row">${icon(ico,18)}<div><h4>${title}</h4><p>${desc}</p></div></div><button class="btn-icon" aria-label="Open ${title}" data-action="navigate" data-view="${key}">${icon('chevron')}</button></div>`).join('')}</div></div>
 <div class="panel"><div class="panel-head"><h3>Current verification status</h3><span class="meta">Heuristic, not a certification</span></div><div class="panel-body"><div class="scoring"><strong>${S.analysis.score}<span style="font-size:20px;color:var(--dim)">/100</span></strong><span>Static findings score · not a correctness guarantee</span></div><hr class="divider"/><div class="bars">${[['Critical',c.critical,'var(--red)'],['High',c.high,'var(--amber)'],['Medium',c.medium,'var(--purple)']].map(([l,n,color])=>`<div class="bar-row"><span>${l}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100,n*12)}%;background:${color}"></div></div><small>${n}</small></div>`).join('')}</div><hr class="divider"/>${alertBox(`${icon('info',14)} &nbsp; <b>AI authorship:</b> inconclusive. No calibrated probability is claimed from code style alone.`)}<div class="mt">${btn('View evidence '+icon('arrow'),'go-evidence','ghost sm')}</div></div></div></section>
 <section class="grid-two even"><div class="panel"><div class="panel-head"><h3>Most relevant issues</h3>${btn('All findings '+icon('arrow'),'go-inspector','ghost sm')}</div><div class="panel-body compact">${S.analysis.findings.slice(0,4).map(issueCompact).join('')||placeholder('No issues in implemented checks','This is not proof of correctness.')}</div></div><div class="panel"><div class="panel-head"><h3>Your data stays here</h3>${badge('Local-first','passed')}</div><div class="panel-body"><div class="timeline">${[['No source upload','Inspection, tests, patches and reports run in your browser.'],['JS/TS isolated execution','No direct access to the app origin, with network denied inside the execution frame.'],['Python needs runtime download','Pyodide is fetched from an allowlisted CDN when first used; Python execution remains experimental.'],['Native execution is out of scope','GitHub Pages cannot provide hardened OS containers or a team database.']].map(([a,b],i)=>`<div class="step"><span class="step-number">${i+1}</span><div><strong>${a}</strong><p>${b}</p></div></div>`).join('')}</div></div></div></section><div class="footer-note">Static GitHub Pages deployment · No telemetry · Open-source-ready foundations · Authorship estimates are not a verdict.</div>`;
}
function metric(ico,num,label,kind){return `<div class="stat ${kind}"><div class="stat-icon">${icon(ico,18)}</div><strong>${num}</strong><div class="caption">${label}</div></div>`;}
function issueCompact(f){return `<div class="cardlink"><div><div class="row mb-sm" style="gap:8px">${badge(f.severity)}<b class="small">${h(f.title)}</b></div><p class="code-ref">${h(f.file)}:${f.line}</p></div><button class="btn-icon" data-action="open-finding" data-id="${h(f.id)}" aria-label="Open finding">${icon('chevron')}</button></div>`;}
function inspector(){
 const file=fileInFocus();
 return `${pageHead('MVP 01 · Static analysis','Code Inspector','Parse JavaScript and TypeScript with real parsers; scan Python, Go, Rust, Java, C/C++ and C# with limited heuristics; review rule-backed findings with line references and practical remediation.')}
 <div class="toolbar"><div class="row wrap">${btn(icon('plus')+' New file','new-file')}${btn(icon('upload')+' Import','go-projects')}${btn(icon('refresh')+' Reinspect','reinspect','ghost')}</div><div class="row" id="inspector-badges">${inspectorBadges()}</div></div>
 <div class="grid-two"><div><div class="panel mb"><div class="panel-head"><h3>Workspace files</h3><span class="meta">${S.files.length} source files</span></div>${fileTree()}</div><div class="panel"><div class="panel-head"><h3>Source editor</h3><span class="meta" data-live-count>${findingsForCurrent().length} findings</span></div><div class="panel-body"><div class="editor-shell"><div class="editor-top"><span class="language-dot ${file?.language||''}"></span><strong>${h(file?.path||'No source file')}</strong><span style="margin-left:auto;color:var(--dim)">${file?.language||'text'}</span></div><div class="editor-space"><div class="line-gutter" id="line-gutter">1</div><textarea id="code-editor" class="code-area" aria-label="Source code editor" spellcheck="false" placeholder="// Add code here..."></textarea></div></div><div class="row between wrap mt"><span class="tiny muted">Ctrl / Cmd + Enter runs the current function</span>${btn(icon('play')+' Open runner','go-runner','primary sm')}</div></div></div></div>
 <div id="inspector-side">${inspectorSide(file)}</div></div>
 <p class="footer-note">Detection is rule-based and intentionally limited. Python syntax is verified fully only when using the optional Pyodide execution runtime. Treat warnings as leads, not definitive security findings.</p>`;
}
function inspectorBadges(){return `${badge(`${S.analysis.findings.length} findings`,'info')}${badge(`${S.analysis.parsed}/${S.files.length} grammar checked`,'info')}`;}
function inspectorSide(file){
 const current=S.analysis.findings.filter(f=>f.file===file?.path).filter(f=>(S.filter==='all'||f.severity===S.filter)&&(!S.search||`${f.title} ${f.message} ${f.rule}`.toLowerCase().includes(S.search.toLowerCase())));
 return `${file?.language==='python'?`<div class="panel mb"><div class="panel-head"><h3>Python grammar validation</h3>${badge('On demand','warning')}</div><div class="panel-body"><p class="hint">The preliminary scan does not parse the full Python grammar. Validate using Python's AST parser inside the isolated Pyodide runtime (first load needs CDN access).</p>${btn(icon('check')+' Parse Python grammar','validate-python','primary sm',S.busy?'disabled':'')}${S.pythonChecks[file.path]?`<div class="mt ${S.pythonChecks[file.path].ok?'insight':'warning-callout'}">${h(S.pythonChecks[file.path].message)}</div>`:''}</div></div>`:''}<div class="panel mb"><div class="panel-head"><h3>Findings for file</h3><span class="meta">${current.length} shown</span></div><div class="panel-body"><div class="row wrap mb-sm"><select class="form-control" id="severity-filter" aria-label="Filter findings by severity">${['all','critical','high','medium','low','info'].map(x=>`<option value="${x}" ${x===S.filter?'selected':''}>${x==='all'?'All severities':x}</option>`).join('')}</select><div class="finder" style="flex:1"><input id="finding-search" value="${h(S.search)}" placeholder="Search findings" aria-label="Search findings" style="width:100%"></div></div><div id="finding-list">${current.map(issueCard).join('')||placeholder('No matching findings','Try another filter, or inspect a different source file.','search')}</div></div></div><div class="panel"><div class="panel-head"><h3>Discovered functions</h3><span class="meta">${selectedFunctions().length} callable symbols</span></div><div class="panel-body compact">${selectedFunctions().map(fn=>`<div class="cardlink"><div><h4 class="code-ref">${h(fn.name)}(${fn.params} parameter${fn.params!==1?'s':''})</h4><p>Line ${fn.line}</p></div><button class="btn sm" data-action="run-fn" data-fn="${h(fn.name)}">${icon('play',13)} Run</button></div>`).join('')||placeholder('No functions found','Use a named function declaration or arrow function.','code')}</div></div>`;
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
 <div class="row wrap mb">${btn(icon('download')+' Export JSON receipt','export-json','primary')}${btn(icon('file')+' Download Markdown','export-markdown')}${btn(icon('copy')+' Copy summary','copy-summary')}</div>
 <div class="grid-two mb"><div class="panel"><div class="panel-head"><h3>Verification snapshot</h3><span class="meta">${humanDate(S.analysis.inspectedAt)}</span></div><div class="panel-body"><div class="kpi-row"><div class="kpi"><strong>${S.analysis.files}</strong><small>Sources</small></div><div class="kpi"><strong>${f.length}</strong><small>Findings</small></div><div class="kpi"><strong>${S.resultsStale?'—':results.passed+'/'+results.total}</strong><small>Passed tests</small></div></div><hr class="divider"/><div class="metric-split"><span>Parsing</span><b>${S.analysis.parsed}/${S.files.length} files</b></div><div class="metric-split"><span>Static findings score</span><b>${S.analysis.score}/100</b></div><div class="metric-split"><span>Execution coverage</span><b>Selected cases only</b></div><div class="metric-split"><span>Verification state</span>${badge(S.resultsStale?'Changed since run':'Session current',S.resultsStale?'warning':'passed')}</div></div></div>
 <div class="panel"><div class="panel-head"><h3>AI authorship evidence</h3>${badge('Inconclusive','warning')}</div><div class="panel-body"><div class="warning-callout mb-sm"><b>No reliable AI-written probability is available.</b> A code-only classifier can have significant false positives; style clues are not a provenance verdict. CodeProof intentionally returns "Inconclusive" until independently validated author/provenance evidence is available.</div>${S.analysis.signals.map(x=>`<div class="cardlink"><div><h4>${h(x.label)}</h4><p>${h(x.detail)}</p></div>${badge(x.weight,'low')}</div>`).join('')}<p class="form-help">Future research module: calibrated model with abstention, multi-language test sets, verified signatures and voluntary provenance metadata. No fake 72% confidence badge.</p></div></div></div>
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
 <div class="grid-two mb"><div class="panel"><div class="panel-head"><h3>Import a project</h3>${badge('No upload','passed')}</div><div class="panel-body"><div class="upload-box" id="drop-zone">${icon('upload',34)}<strong>Drop a ZIP or source files here</strong><span class="small">JS, TS, Python, Go, Rust, Java, C/C++, C# · up to ${S.policy.maxFiles} files</span><div class="row wrap">${btn('Choose ZIP','open-zip','ghost sm')}${btn('Choose folder','open-folder','ghost sm')}${btn('Source files','open-files','ghost sm')}</div></div><input id="zip-picker" class="hidden" type="file" accept=".zip"><input id="folder-picker" class="hidden" type="file" webkitdirectory directory multiple><input id="files-picker" class="hidden" type="file" accept=".js,.jsx,.ts,.tsx,.mjs,.cjs,.py,.go,.rs,.java,.cpp,.c,.h,.cs" multiple><p class="form-help">ZIP is parsed locally. Entries with traversal paths, unwanted directories, unsupported extensions, or oversized contents are ignored. A small local-workspace snapshot is kept in browser storage when capacity permits.</p><div class="row wrap mt">${btn(icon('download')+' Export project ZIP','export-project')}${btn(icon('refresh')+' Load demo workspace','reset-demo','ghost')}</div></div></div>
 <div class="panel"><div class="panel-head"><h3>Project structure</h3><span class="meta">${S.files.length} files</span></div><div class="panel-body"><div class="kpi-row"><div class="kpi"><strong>${S.files.length}</strong><small>Source files</small></div><div class="kpi"><strong>${edges.length}</strong><small>Import edges</small></div><div class="kpi"><strong>${external.length}</strong><small>External refs</small></div></div><hr class="divider"/><div style="max-height:280px;overflow:auto">${S.files.map(f=>`<button class="file-entry" data-action="select-project-file" data-path="${h(f.path)}">${icon('file',14)}<span class="file-name">${h(f.path)}</span><span class="code-ext ${f.language==='python'?'py':'ts'}" style="margin-left:auto">${f.language.slice(0,2).toUpperCase()}</span></button>`).join('')}</div></div></div></div>
 <div class="panel mb"><div class="panel-head"><h3>Dependency edges</h3><span class="meta">Resolved local paths are matched heuristically</span></div><div class="panel-body"><div class="grid-two even">${edges.slice(0,60).map(e=>`<div class="graph-row"><span>${h(e.from)}</span>${icon('arrow',13)}<b class="${e.kind}">${h(e.to)}</b></div>`).join('')||placeholder('No imports found','Add module imports to view file relationships.','branch')}</div>${edges.length>60?`<p class="form-help">Showing 60 of ${edges.length} edges.</p>`:''}</div></div><div class="notice">${icon('info',14)} <b>Dependency analysis:</b> references are not the same as installed packages; this explorer does not resolve dynamic imports, lockfiles, TS path aliases, or dependency CVEs. PR checks and shared policy setup are under Team & CI.</div>`;
}
function teamView(){return `${pageHead('Expansion · Continuous assurance','Team Policies & PR Checks','Generate a portable integration kit containing a standalone Node CLI, static rules, policy file and GitHub Actions workflow. Commit the kit to any repository for automatic PR scanning.')}
 <div class="grid-two mb"><div class="panel"><div class="panel-head"><h3>Shared policy</h3>${badge('Version 1','info')}</div><div class="panel-body"><label class="form-label" for="policy-json">JSON policy · stored locally until exported</label><textarea id="policy-json" class="form-control wide" rows="13" spellcheck="false"></textarea><p class="form-help">failOnSeverity accepts critical, high, medium, low, info, off. A PR check fails when a finding meets that threshold. Parser errors can be separately blocking.</p><div class="row wrap mt">${btn(icon('check')+' Save policy','save-policy','primary')}${btn(icon('download')+' Download JSON','download-policy','ghost')}</div></div></div>
 <div class="panel"><div class="panel-head"><h3>GitHub Actions integration</h3>${badge('Portable','passed')}</div><div class="panel-body"><div class="timeline">${[['Download integration ZIP','Includes .codeproof/cli.mjs, parser, compiler, policy and workflow.'],['Copy files to your target repository','The ZIP contains paths ready to commit at repo root.'],['Commit and push','Pull requests will receive static checks and a downloadable JSON artifact.'],['Configure protection','Make the CodeProof audit check required in GitHub branch protection.']].map(([a,b],i)=>`<div class="step"><span class="step-number">${i+1}</span><div><strong>${h(a)}</strong><p>${h(b)}</p></div></div>`).join('')}</div><div class="mt">${btn(icon('download')+' Download CI integration ZIP','download-kit','primary')}</div><hr class="divider"/><b class="small">CI workflow scope</b><p class="hint">Scans code without executing submitted functions. Uses repository-owned policy and built-in GitHub authentication for normal workflow permissions. Does not create a SaaS team database, host pull-request previews, or support remote sandboxes.</p></div></div></div>
 <div class="grid-three">${[['No platform secrets needed','The audit reads checked-out source. No personal token or third-party key is required.'],['Auditable rule policy','Your repository contains its scan thresholds and excluded paths.'],['Artifact-based feedback','Download full JSON results and see file/line GitHub Actions annotations.']].map(([title,desc])=>`<div class="panel"><div class="panel-body"><div class="row mb-sm">${icon('shield',19)}<b>${h(title)}</b></div><p class="hint">${h(desc)}</p></div></div>`).join('')}</div>`;}
function renderModal(){if(S.modal!=='new-file')return '';return `<div class="modal-back" role="presentation" data-action="close-modal"><div class="modal" role="dialog" aria-modal="true" aria-label="Add new source file"><h2>New source file</h2><p class="hint">Create a JS, TS or Python file in your in-browser workspace.</p><label class="form-label" for="new-file-path">Path and extension</label><input class="form-control wide" id="new-file-path" value="src/new-function.js" placeholder="src/function.py"><div class="modal-actions">${btn('Cancel','close-modal','ghost')}${btn(icon('plus')+' Create file','create-file','primary')}</div></div></div>`;}
function hydrateEditor(){const editor=document.getElementById('code-editor'),file=fileInFocus();if(!editor)return;editor.value=file?.content||'';editor.disabled=!file;updateGutter(editor);}
function updateGutter(el){const gutter=document.getElementById('line-gutter');if(!gutter)return;const count=Math.min(10000,(el.value.match(/\n/g)||[]).length+1);gutter.textContent=Array.from({length:count},(_,i)=>String(i+1)).join('\n');gutter.scrollTop=el.scrollTop;}
function fillTestForm(){const file=document.querySelector('#test-file');if(file)file.value=S.active;}
function render(){layout();}

async function loadCompiler(){
 if(globalThis.ts?.transpileModule)return globalThis.ts;
 if(loadCompiler.promise)return loadCompiler.promise;
 loadCompiler.promise=new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.src='./vendor/typescript.js';script.onload=()=>globalThis.ts?.transpileModule?resolve(globalThis.ts):reject(Error('TypeScript compiler unavailable.'));script.onerror=()=>reject(Error('Unable to load bundled TypeScript compiler.'));document.head.appendChild(script);
 });return loadCompiler.promise;
}
function transpile(source,language){
 const ts=globalThis.ts;
 if(!ts)throw Error('TypeScript compiler not loaded.');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React},reportDiagnostics:true,fileName:language==='typescript'?'input.ts':'input.js'});
 const errors=(output.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error);
 if(errors.length)throw Error(ts.flattenDiagnosticMessageText(errors[0].messageText,' '));
 return output.outputText;
}
function setBusy(value,label=''){S.busy=value;S.runProgress=label;render();}
async function runSuite(tests=S.tests,{replace=true,silent=false}={}){
 if(S.busy)return [];
 if(!tests.length){toast('Create a test first.');return []}
 S.busy=true;S.runProgress='Preparing runtimes';if(!silent)render();
 try{
  if(tests.some(t=>S.files.find(f=>f.path===t.file)?.language!=='python'))await loadCompiler();
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
async function importFiles(files){
 const accepted=[];let totalBytes=0;
 for(const file of Array.from(files)){
  const path=(file.webkitRelativePath||file.name).replaceAll('\\','/');
  if(!acceptedPath(path,S.policy)||file.size>S.policy.maxFileBytes)continue;
  if(accepted.length>=S.policy.maxFiles)throw Error('Source count exceeds policy.');
  totalBytes+=file.size;if(totalBytes>14_000_000)throw Error('Source data exceeds 14 MB.');
  accepted.push({path,language:languageFromPath(path),content:await file.text()});
 }
 if(!accepted.length)throw Error('No supported source files found.');
 setWorkspace(accepted);toast(`Imported ${accepted.length} files.`);
}
function setWorkspace(files){validateWorkspace(files,S.policy);S.files=files;S.active=files[0]?.path||'';S.tests=[];S.results=[];S.manual=null;S.resultsStale=true;persist();inspect();render();}
async function importArchive(file){
 if(file.size>15_000_000)throw Error('ZIP is over the 15 MB compressed limit.');
 const JSZip=await loadZipLib();const zip=await JSZip.loadAsync(file,{checkCRC32:true});
 const entries=Object.values(zip.files).filter(z=>!z.dir&&acceptedPath(z.name,S.policy));
 if(entries.length>S.policy.maxFiles)throw Error('Source file count exceeds configured limit.');
 let total=0;const files=[];
 for(const e of entries){
  const size=e._data?.uncompressedSize||0;
  if(size>S.policy.maxFileBytes)continue;
  total+=size;if(total>14_000_000)throw Error('ZIP expands past the 14 MB extraction limit.');
  const bytes=await e.async('uint8array');if(bytes.byteLength>S.policy.maxFileBytes)continue;
  files.push({path:e.name,language:languageFromPath(e.name),content:new TextDecoder('utf-8',{fatal:false}).decode(bytes)});
 }
 if(!files.length)throw Error('ZIP contained no supported source files.');
 setWorkspace(files);toast(`Imported ${files.length} files from ZIP.`);
}
async function exportWorkspace(){const JSZip=await loadZipLib(),zip=new JSZip();for(const f of S.files)zip.file(f.path,f.content);downloadBinary('codeproof-reviewed-source.zip',await zip.generateAsync({type:'blob',compression:'DEFLATE'}));}
const integrateWorkflow=`name: CodeProof source policy\non:\n  pull_request:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  codeproof:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '22'\n      - name: Inspect code without executing it\n        run: node .codeproof/cli.mjs\n      - name: Upload evidence artifact\n        uses: actions/upload-artifact@v4\n        if: always()\n        with:\n          name: codeproof-evidence\n          path: codeproof-report.json\n          if-no-files-found: ignore\n`;
async function downloadIntegration(){
 const [JSZip,cli,core,parser,compiler]=await Promise.all([loadZipLib(),fetch('./integrations/cli.mjs').then(r=>r.text()),fetch('./integrations/core.mjs').then(r=>r.text()),fetch('./integrations/acorn.mjs').then(r=>r.text()),fetch('./integrations/typescript.cjs').then(r=>r.arrayBuffer())]);
 const zip=new JSZip();zip.file('.codeproof/cli.mjs',cli);zip.file('.codeproof/core.mjs',core);zip.file('.codeproof/acorn.mjs',parser);zip.file('.codeproof/typescript.cjs',compiler);zip.file('.codeproof-policy.json',JSON.stringify(S.policy,null,2));zip.file('.github/workflows/codeproof.yml',integrateWorkflow);zip.file('CODEPROOF-INTEGRATION.md','CodeProof PR integration\n\nCopy all files into the root of your repository and commit. The audit is static only; it does not run user code. Adjust .codeproof-policy.json to your standards. The CLI needs Node 22+ and no npm install.\n');downloadBinary('codeproof-github-integration.zip',await zip.generateAsync({type:'blob',compression:'DEFLATE'}));
}

async function handleAction(action,element){
 switch(action){
 case'navigate':S.view=element.dataset.view;location.hash=S.view;render();break;
 case'go-inspector':S.view='inspector';location.hash='inspector';render();break;
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
  const path=document.getElementById('new-file-path')?.value.trim().replaceAll('\\','/');
  if(!path||!acceptedPath(path,S.policy)){toast('Use a safe .js, .ts, .jsx, .tsx, or .py path.','error');break;}
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
  try{if(file.language!=='python')await loadCompiler();S.manual=await runner.runOne(file,test,S.timeoutMs,transpile);S.results.push(S.manual);S.resultsStale=false;}
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
    if(relevant.length&&S.files.some(f=>f.language!=='python'))await loadCompiler();
    if(relevant.length)before=await runner.runAll(previous,relevant,S.timeoutMs,transpile);
    const updated=applyPatch(previous,patch);
    if(relevant.length)after=await runner.runAll(updated,relevant,S.timeoutMs,transpile);
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
 if(['zip-picker','folder-picker','files-picker'].includes(target.id)&&target.files?.length){try{if(target.id==='zip-picker')await importArchive(target.files[0]);else await importFiles(target.files);}catch(e){toast('Import failed: '+e.message,'error');}target.value='';}
});
root.addEventListener('input',event=>{if(event.target.id==='finding-search'){S.search=event.target.value;const list=document.getElementById('finding-list');if(list){const current=S.analysis.findings.filter(f=>f.file===S.active).filter(f=>(S.filter==='all'||f.severity===S.filter)&&(`${f.title} ${f.message} ${f.rule}`.toLowerCase().includes(S.search.toLowerCase())));list.innerHTML=current.map(issueCard).join('')||placeholder('No findings match','Change the search or filter.','search');}}});
window.addEventListener('hashchange',()=>{const hash=location.hash.slice(1);if(NAV.some(([id])=>id===hash)&&S.view!==hash){S.view=hash;render();}});
window.addEventListener('beforeunload',()=>runner.dispose());
render();
const drop=()=>document.getElementById('drop-zone');
root.addEventListener('dragover',e=>{if(e.target.closest('#drop-zone')){e.preventDefault();drop()?.classList.add('drag');}});
root.addEventListener('dragleave',e=>{if(e.target.closest('#drop-zone'))drop()?.classList.remove('drag');});
root.addEventListener('drop',async e=>{if(!e.target.closest('#drop-zone'))return;e.preventDefault();drop()?.classList.remove('drag');const files=Array.from(e.dataTransfer?.files||[]);try{if(files.length===1&&files[0].name.endsWith('.zip'))await importArchive(files[0]);else await importFiles(files);}catch(err){toast('Drop import: '+err.message,'error');}});