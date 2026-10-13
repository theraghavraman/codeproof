import { analyzeWorkspace } from './core.mjs';
let compiler=null;
async function typeScript(){
  if(compiler)return compiler;
  const response=await fetch(new URL('../vendor/typescript.js',import.meta.url));
  if(!response.ok)throw Error('TypeScript compiler asset not available');
  const source=await response.text();
  const module={exports:{}};
  // Evaluates vendored, trusted TypeScript compiler code; submitted source is never evaluated by analysis.
  compiler=new Function('module','exports',source+'\nreturn typeof ts!=="undefined"?ts:module.exports;')(module,module.exports);
  if(typeof compiler.createSourceFile!=='function')throw Error('TypeScript compiler initialization failed');
  return compiler;
}
self.onmessage=async event=>{
  const {id,files}=event.data;
  try{
    const ts=files.some(f=>f.language==='typescript')?await typeScript():undefined;
    self.postMessage({id,analysis:analyzeWorkspace(files,{ts})});
  }catch(error){self.postMessage({id,error:String(error?.message||error)});}
};
