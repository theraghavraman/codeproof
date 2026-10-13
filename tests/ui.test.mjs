import test from 'node:test';
import assert from 'node:assert/strict';

const root={innerHTML:'',events:new Map(),addEventListener(type,cb){this.events.set(type,cb)}};
const store=new Map();
globalThis.document={querySelector:(s)=>s==='#app'?root:null,getElementById:()=>null};
globalThis.location={hash:''};
globalThis.localStorage={getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value)};
globalThis.window={addEventListener(){}};
globalThis.Worker=class {constructor(){}postMessage(){ }terminate(){ }};
await import('../docs/assets/app.mjs');

test('static UI loads and renders overview without remote dependencies',()=>{
 assert.match(root.innerHTML,/Trust the evidence/);
 assert.match(root.innerHTML,/Code Inspector/);
 assert.match(root.innerHTML,/Test suite|Automated Tests/);
 assert.ok(root.innerHTML.length>4000);
});
test('all eight application sections render without throwing',async()=>{
 const click=root.events.get('click');
 assert.equal(typeof click,'function');
 const routes=['inspector','runner','tests','evidence','fixes','projects','teams','workspace'];
 const match={inspector:'Code Inspector',runner:'Safe Execution Lab',tests:'Automated Test Lab',evidence:'Evidence & Authorship',fixes:'Fix & Verify',projects:'Project Explorer',teams:'Team Policies & PR Checks',workspace:'Trust the evidence'};
 for(const view of routes){
  const node={dataset:{action:'navigate',view},classList:{contains:()=>false},closest:()=>node};
  await click({target:node,preventDefault(){}});
  assert.match(root.innerHTML,new RegExp(match[view].replace(/[.*+?^${}()|[]\]/g,'\$&')),'Render '+view);
 }
});
