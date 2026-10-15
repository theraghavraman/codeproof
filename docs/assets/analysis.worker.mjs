// Analysis worker: ingestion (including ZIP inflation), static scanning, TypeScript type checking and
// transpilation all run here so the interface never blocks. This worker never executes uploaded code;
// execution happens only in the sandbox iframe. Cancelling a scan terminates this worker.
import { analyzeWorkspace } from './core.mjs';
import { ingestEntries, ingestZip, ingestTextFiles, projectNameFrom } from './engine/ingest.mjs';
import { scanProject, finalizeWithRuntime } from './engine/scan.mjs';
import { loadLibClosure } from './engine/ts-program.mjs';
import { transpileForRuntime } from './engine/transpile.mjs';
import { buildReport } from './engine/report.mjs';

let compiler = null, compilerError = null;
async function typeScript() {
  if (compiler || compilerError) return compiler;
  try {
    const mod = await import('../vendor/typescript.mjs');
    compiler = mod.default;
    if (typeof compiler?.createProgram !== 'function') throw new Error('TypeScript compiler initialization failed');
  } catch (error) {
    compilerError = `TypeScript compiler asset unavailable (${error.message}). Run node scripts/restore-vendor.mjs.`;
    compiler = null;
  }
  return compiler;
}
const libText = new Map();
async function fetchLib(name) {
  if (libText.has(name)) return libText.get(name);
  try {
    const response = await fetch(new URL(`../vendor/typescript-lib/${name}`, import.meta.url));
    const text = response.ok ? await response.text() : null;
    libText.set(name, text);
    return text;
  } catch { return null; }
}

const scans = new Map();
const PYTHON_DATA = /\.(?:py|pyi|json|txt|csv|tsv|ya?ml|toml|ini|cfg|md|sql|xml|html?)$/i;

function runtimePayload(scan) {
  const files = scan.internal.files;
  const { modules } = compiler ? transpileForRuntime(compiler, files) : { modules: {} };
  const python = { files: {}, roots: scan.graph?.pythonRoots || [''] };
  let budget = 8_000_000;
  for (const f of files) if (PYTHON_DATA.test(f.path) && f.content.length < 500_000 && (budget -= f.content.length) > 0) python.files[f.path] = f.content;
  return { jobs: scan.internal.runtimePlan.jobs, modules, python };
}

async function handle(message) {
  const { type, id } = message;
  const progress = p => self.postMessage({ type: 'progress', id, ...p });
  if (type === 'ingest') {
    let project;
    if (message.zip) project = await ingestZip(new Uint8Array(message.zip), { policy: message.policy, onProgress: progress });
    else if (message.texts) project = ingestTextFiles(message.texts, { manifestExtra: message.manifestExtra || [] });
    else project = await ingestEntries(message.entries.map(e => ({ path: e.path, size: e.file?.size ?? e.size, read: async () => new Uint8Array(await e.file.arrayBuffer()), isDirectory: e.isDirectory })), { policy: message.policy, onProgress: progress, source: message.source });
    project.name = message.name || projectNameFrom(project.files, 'Uploaded project');
    return { type: 'ingested', id, project };
  }
  if (type === 'scan') {
    const ts = await typeScript();
    const scan = await scanProject(message.project, {
      ts, policy: message.policy, onProgress: progress, runtimeOptions: message.runtimeOptions || {},
      loadTsLibs: names => loadLibClosure(names, fetchLib),
    });
    if (compilerError) scan.diagnostics.push({ stage: 'TypeScript compiler', scope: 'project', file: null, origin: 'environment', message: compilerError, alternatives: 'Acorn parsing and non-TypeScript checks ran.', action: 'Restore vendor assets and reload.' });
    const scanId = message.scanId;
    scans.set(scanId, scan);
    if (scans.size > 3) scans.delete(scans.keys().next().value);
    return { type: 'scanned', id, scanId, scan, runtime: message.runtimeOptions?.enableJs || message.runtimeOptions?.enablePython ? runtimePayload(scan) : null };
  }
  if (type === 'finalize') {
    const scan = scans.get(message.scanId);
    if (!scan) throw new Error('Scan state expired; rerun the scan.');
    const finalized = finalizeWithRuntime(scan, message.results || [], { cancelled: Boolean(message.cancelled), enabled: message.enabled !== false, blockedExtra: message.blocked || [] });
    scans.set(message.scanId, finalized);
    return { type: 'finalized', id, scan: finalized };
  }
  if (type === 'report') {
    const scan = scans.get(message.scanId);
    if (!scan) throw new Error('Scan state expired; rerun the scan.');
    return { type: 'report', id, report: buildReport(scan) };
  }
  if (type === 'transpile') {
    const ts = await typeScript();
    if (!ts) throw new Error(compilerError || 'TypeScript compiler unavailable');
    return { type: 'transpiled', id, ...transpileForRuntime(ts, message.files.map(f => ({ ...f, kind: f.kind || 'source' }))) };
  }
  // Protocol v1: live inspector analysis for the editor ({ id, files }).
  const ts = message.files.some(f => f.language === 'typescript' || /\.[jt]sx$/.test(f.path)) ? await typeScript() : undefined;
  return { id, analysis: analyzeWorkspace(message.files, { ts }) };
}

self.onmessage = async event => {
  const message = event.data || {};
  try { self.postMessage(await handle(message)); }
  catch (error) { self.postMessage({ type: 'error', id: message.id, error: String(error?.message || error), name: error?.name || 'Error', code: error?.code || null }); }
};
