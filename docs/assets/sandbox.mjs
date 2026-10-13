const SIGNAL = 'codeproof.sandbox.v1';
const PY_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/';
const jsWorkerSource = String.raw`
const send=self.postMessage.bind(self);
try{self.postMessage=()=>{throw Error('Host messaging disabled in user code')}}catch(_){}
self.fetch=()=>Promise.reject(Error('Network blocked in sandbox'));
self.XMLHttpRequest=undefined;self.WebSocket=undefined;self.Worker=undefined;
self.importScripts=()=>{throw Error('Imports blocked in sandbox')};
const sanitize=(value)=>{
 if(typeof value==='undefined')return '[undefined]';
 if(typeof value==='bigint')return String(value)+'n';
 if(typeof value==='number'&&!Number.isFinite(value))return String(value);
 try {return JSON.parse(JSON.stringify(value))}catch{return String(value)}
};
self.onmessage=async ({data})=>{
 const {id,source,test}=data;const started=performance.now();
 const logs=[];
 const console={log:(...args)=>{if(logs.length<20)logs.push(args.map(String).join(' ').slice(0,500))},debug:(...args)=>{if(logs.length<20)logs.push(args.map(String).join(' ').slice(0,500))},error:(...args)=>{if(logs.length<20)logs.push(args.map(String).join(' ').slice(0,500))}};
 try{
  if(source.length>250000)throw Error('Source is too large for safe local execution.');
  if(!/^[A-Za-z_$][\w$]*$/.test(test.functionName))throw Error('Invalid function name.');
  const exports={};const module={exports};
  const factory=new Function('exports','module','console','__name', '"use strict";\n'+source+'\n'+
   'let fn = exports[__name] || module.exports[__name]; if (typeof fn !== "function") { try { fn = eval(__name) } catch(_) {} }\n'+
   'if(typeof fn !== "function") throw Error("Function not found: " + __name);\n'+
   'return fn');
  // Evaluate source only once per test. Identifier validation limits dynamic lookup to a callable symbol.
  const fn=factory(exports,module,console,test.functionName);
  const invoke=()=>fn(...JSON.parse(JSON.stringify(test.args)));
  const actual=await invoke();
  let same=true;
  if(test.kind==='determinism')same=JSON.stringify(sanitize(actual))===JSON.stringify(sanitize(await invoke()));
  if(test.kind==='idempotent')same=test.args.length===1&&JSON.stringify(sanitize(actual))===JSON.stringify(sanitize(await fn(actual)));
  send({type:'result',id,output:{ok:true,value:sanitize(actual),same,logs},ms:Math.round(performance.now()-started)});
 }catch(e){send({type:'result',id,output:{ok:false,error:String(e?.message||e),logs},ms:Math.round(performance.now()-started)});}
};
`;
const pyWorkerSource = String.raw`
let py=null;
const send=self.postMessage.bind(self);
self.onmessage=async ({data})=>{
 if(data.type==='init'){
  try{
   importScripts('${PY_CDN}pyodide.js');
   py=await loadPyodide({indexURL:'${PY_CDN}'});
   self.fetch=()=>Promise.reject(Error('Network disabled during user code'));
   self.XMLHttpRequest=undefined;self.WebSocket=undefined;
   self.importScripts=()=>{throw Error('Additional script imports disabled')};
   send({type:'ready'});
  }catch(e){send({type:'init-error',message:String(e?.message||e)})}return;
 }
 if(!py||!['run','syntax'].includes(data.type))return;
 const {id,source,test}=data;const start=performance.now();
 if(data.type==='syntax') {
  try{
   if(source.length>250000)throw Error('Python source exceeds syntax validation limit.');
   py.runPython('import ast\nast.parse('+JSON.stringify(source)+')\n"syntax valid"');
   send({type:'result',id,output:{ok:true,value:'Python grammar valid',logs:[]},ms:Math.round(performance.now()-start)});
  }catch(error){send({type:'result',id,output:{ok:false,error:String(error?.message||error),logs:[]},ms:Math.round(performance.now()-start)});}
  return;
 }
 try{
  if(source.length>250000)throw Error('Python source exceeds execution limit');
  if(!/^[a-zA-Z_]\w*$/.test(test.functionName))throw Error('Invalid function identifier');
  const script=[
   'import json, io, contextlib',
   '__cp_logs = io.StringIO()',
   '__cp_ns = {}',
   'try:',
   '  with contextlib.redirect_stdout(__cp_logs):',
   '    exec('+JSON.stringify(source)+', __cp_ns)',
   '    __cp_fn = __cp_ns['+JSON.stringify(test.functionName)+']',
   '    __cp_args = json.loads('+JSON.stringify(JSON.stringify(test.args))+')',
   '    __cp_out = __cp_fn(*__cp_args)',
   '    __cp_same = True',
   '    if '+JSON.stringify(test.kind)+' == "determinism":',
   '      __cp_same = __cp_out == __cp_fn(*__cp_args)',
   '    if '+JSON.stringify(test.kind)+' == "idempotent":',
   '      __cp_same = len(__cp_args) == 1 and __cp_out == __cp_fn(__cp_out)',
   '  try:',
   '    __cp_val = json.loads(json.dumps(__cp_out,allow_nan=False))',
   '  except (ValueError, TypeError, OverflowError):',
   '    __cp_val = repr(__cp_out)',
   '  __cp_outcome = {"ok":True,"value":__cp_val,"same":bool(__cp_same)}',
   'except BaseException as exc:',
   '  __cp_outcome = {"ok":False,"error":type(exc).__name__+": "+str(exc)}',
   '__cp_outcome["logs"] = __cp_logs.getvalue().splitlines()[:20]',
   'json.dumps(__cp_outcome)'
  ].join('\n');
  const output=JSON.parse(py.runPython(script));
  send({type:'result',id,output,ms:Math.round(performance.now()-start)});
 }catch(e){send({type:'result',id,output:{ok:false,error:String(e?.message||e),logs:[]},ms:Math.round(performance.now()-start)});}
};
`;

function makeSandboxHtml(mode,session){
  const workerSource=mode==='python'?pyWorkerSource:jsWorkerSource;
  const js=`const worker=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSource).replaceAll('<','\\u003c')}],{type:'text/javascript'})));\n`+
  `worker.onmessage=event=>parent.postMessage({signal:${JSON.stringify(SIGNAL)},session:${JSON.stringify(session)},...event.data},'*');\n`+
  `worker.onerror=event=>parent.postMessage({signal:${JSON.stringify(SIGNAL)},session:${JSON.stringify(session)},type:'init-error',message:event.message},'*');\n`+
  `addEventListener('message',event=>{if(event.source===parent&&event.data?.signal===${JSON.stringify(SIGNAL)}&&event.data?.session===${JSON.stringify(session)})worker.postMessage(event.data)});\n`+
  (mode==='python'?'worker.postMessage({type:"init"});':'parent.postMessage({signal:'+JSON.stringify(SIGNAL)+',session:'+JSON.stringify(session)+',type:"ready"},"*");');
  const scriptPolicy = mode==='python' ? "'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net" : "'unsafe-inline' 'unsafe-eval' blob:";
  const connectPolicy = mode==='python' ? 'https://cdn.jsdelivr.net' : "'none'";
  const csp=`default-src 'none'; script-src ${scriptPolicy}; worker-src blob:; connect-src ${connectPolicy}; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>${js}</script></body></html>`;
}

export class ExecutionSandbox {
  constructor(mode){this.mode=mode;this.frame=null;this.session=crypto.randomUUID();this.pending=new Map();this.ready=null;this.listener=this.onMessage.bind(this);}
  onMessage(ev){
    if(ev.source!==this.frame?.contentWindow||ev.data?.signal!==SIGNAL||ev.data?.session!==this.session)return;
    const data=ev.data;
    if(data.type==='ready')this.onReady?.();
    if(data.type==='init-error')this.onError?.(new Error(data.message||'Sandbox initialization failed'));
    if(data.type==='result'){const item=this.pending.get(data.id);if(item){this.pending.delete(data.id);item.resolve(data);}}
  }
  setup(){
    if(this.ready)return this.ready;
    this.ready=new Promise((resolve,reject)=>{
      this.onReady=resolve;this.onError=reject;
      this.frame=document.createElement('iframe');
      this.frame.setAttribute('sandbox','allow-scripts');
      this.frame.setAttribute('aria-hidden','true');this.frame.style.display='none';
      this.frame.srcdoc=makeSandboxHtml(this.mode,this.session);
      window.addEventListener('message',this.listener);
      document.body.appendChild(this.frame);
    });
    return this.ready;
  }
  async run(source,test,limitMs){
    const started=performance.now(),initBudget=this.mode==='python'?45000:4000;
    try{
      await withDeadline(this.setup(),initBudget,'Sandbox engine did not initialize.');
      const id=crypto.randomUUID();
      const out=await withDeadline(new Promise((resolve,reject)=>{
        this.pending.set(id,{resolve,reject});
        this.frame.contentWindow.postMessage({signal:SIGNAL,session:this.session,type:'run',id,source,test},'*');
      }),limitMs,'Execution exceeded time limit; environment terminated.');
      const value=out.output;
      const result={id:test.id,title:test.title,kind:test.kind,file:test.file,functionName:test.functionName,durationMs:out.ms,status:'passed',actual:value.value,expected:test.expected,message:'Executed without throwing. No semantic correctness claim.',logs:value.logs||[]};
      if(!value.ok){result.status=test.kind==='smoke'?'warning':'failed';result.message=value.error||'Exception encountered.';}
      else if(test.kind==='expected'){
        result.status=JSON.stringify(value.value)===JSON.stringify(test.expected)?'passed':'failed';
        result.message=result.status==='passed'?'Output matches the specified expected value.':'Actual output differs from the expected value.';
      }else if(test.kind==='idempotent'||test.kind==='determinism'){
        result.status=value.same?'passed':'failed';
        result.message=value.same?'Property held for the selected input.':'Property did not hold for the selected input.';
      }
      return result;
    }catch(error){this.dispose();return {id:test.id,title:test.title,kind:test.kind,file:test.file,functionName:test.functionName,status:'error',durationMs:Math.round(performance.now()-started),actual:null,message:String(error?.message||error),logs:[]};}
    finally{if(this.mode==='javascript')this.dispose();}
  }
  async checkPythonSyntax(source,limitMs=2000){
    if(this.mode!=='python')throw Error('Python mode required.');
    try{
      await withDeadline(this.setup(),45000,'Python grammar engine could not initialize.');
      const id=crypto.randomUUID();
      const out=await withDeadline(new Promise((resolve,reject)=>{
        this.pending.set(id,{resolve,reject});
        this.frame.contentWindow.postMessage({signal:SIGNAL,session:this.session,type:'syntax',id,source},'*');
      }),limitMs,'Python grammar validation timed out.');
      return {ok:out.output.ok,message:out.output.ok?'Python grammar parsed successfully.':out.output.error};
    }catch(error){this.dispose();return {ok:false,message:String(error?.message||error)};}
  }
  dispose(){
    this.frame?.remove();this.frame=null;
    if(typeof window!=='undefined')window.removeEventListener('message',this.listener);
    for(const item of this.pending.values())item.reject(Error('Environment disposed'));
    this.pending.clear();this.ready=null;this.onReady=null;this.onError=null;this.session=crypto.randomUUID();
  }
}
const withDeadline=(promise,ms,message)=>new Promise((resolve,reject)=>{
  const t=setTimeout(()=>reject(Error(message)),ms);
  Promise.resolve(promise).then(v=>{clearTimeout(t);resolve(v);},e=>{clearTimeout(t);reject(e);});
});
export class LocalTestRunner {
  constructor(){this.python=new ExecutionSandbox('python');}
  async runOne(file,test,timeoutMs=1800,transpile){
    if(file.language==='python')return this.python.run(file.content,test,timeoutMs);
    if(!['javascript','typescript'].includes(file.language))return {id:test.id,title:test.title,kind:test.kind,status:'error',durationMs:0,message:`${file.language} supports static inspection only; browser execution unavailable.`,logs:[]};
    let source=file.content;
    try{source=transpile?transpile(source,file.language):source;}catch(e){return {id:test.id,title:test.title,status:'error',durationMs:0,kind:test.kind,message:'Compilation: '+e.message,logs:[]};}
    const frame=new ExecutionSandbox('javascript');
    return frame.run(source,test,timeoutMs);
  }
  async runAll(files,tests,timeoutMs,transpile,progress){
    const results=[];
    for(let i=0;i<tests.length;i++){
      const test=tests[i],file=files.find(f=>f.path===test.file);
      if(file)results.push(await this.runOne(file,test,timeoutMs,transpile));
      else results.push({id:test.id,title:test.title,status:'error',durationMs:0,message:'Source file was not found.',logs:[]});
      progress?.(i+1,tests.length,results[results.length-1]);
    }return results;
  }
  validatePython(source,limitMs=2000){return this.python.checkPythonSyntax(source,limitMs)}
  dispose(){this.python.dispose();}
}

// Exported for deterministic contract/security regression tests; used by no application UI.
export const sandboxContract = Object.freeze({jsWorkerSource,pyWorkerSource,makeSandboxHtml});
