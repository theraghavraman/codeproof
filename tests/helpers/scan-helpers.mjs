// Node-side helpers that run the real engine (and the real sandbox harness inside node:vm) on fixtures.
import vm from 'node:vm';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from '../../docs/vendor/typescript.mjs';
import { ingestEntries, scanProject, loadLibClosure, finalizeWithRuntime } from '../../docs/assets/engine/index.mjs';
import { transpileForRuntime } from '../../docs/assets/engine/transpile.mjs';
import { jsWorkerSource } from '../../docs/assets/runtime/js-harness.mjs';

export const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;
const LIB_DIR = new URL('../../docs/vendor/typescript-lib/', import.meta.url).pathname;
export const libsAvailable = existsSync(join(LIB_DIR, 'lib.es5.d.ts'));
export { ts };

export async function walkFixture(name) {
  const root = join(FIXTURES, name);
  const out = [];
  const walk = async dir => { for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) await walk(p); else out.push({ path: relative(root, p), read: () => readFile(p) }); } };
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export const loadTsLibs = names => loadLibClosure(names, n => readFile(join(LIB_DIR, n), 'utf8').catch(() => null));

export async function scanEntries(entries, { name = 'fixture', runtime = false, analyzers, policy = {} } = {}) {
  const ingested = await ingestEntries(entries, { policy });
  return scanProject({ ...ingested, name }, { ts, loadTsLibs, analyzers, policy, runtimeOptions: { enableJs: runtime, enablePython: false } });
}

export async function scanFixture(name, options) { return scanEntries(await walkFixture(name), { name, ...options }); }

export const textEntries = files => Object.entries(files).map(([path, content]) => ({ path, size: Buffer.byteLength(content), read: async () => Buffer.from(content) }));

// Executes the planned JavaScript runtime jobs with the real worker harness inside node:vm.
export async function runJsJobsInVm(scan) {
  const { modules } = transpileForRuntime(ts, scan.internal.files);
  const results = [];
  for (const job of scan.internal.runtimePlan.jobs.filter(j => j.engine === 'js')) {
    const message = await new Promise(resolve => {
      const self = { postMessage: m => { if (m.type === 'job-done' || m.type === 'job-error') resolve(m); }, performance: { now: () => Date.now() }, setTimeout, clearTimeout, addEventListener() {} };
      vm.runInContext(jsWorkerSource, vm.createContext({ self }), { timeout: 2000 });
      self.onmessage({ data: { type: 'job', job: { ...job, modules } } });
    });
    const r = message.result || {};
    const base = { engine: 'js', type: job.type, path: job.entry || null, status: message.type === 'job-done' ? 'completed' : 'error', deadlineMs: job.deadlineMs };
    if (job.type === 'tests') results.push({ ...base, tests: r.tests, registrationError: r.registrationError });
    else if (job.type === 'load') results.push({ ...base, modules: r.modules });
    else { const { modules: _m, ...meta } = job; results.push({ ...base, job: meta, cases: r.cases || [], loadError: r.loadError || null }); }
  }
  return finalizeWithRuntime(scan, results);
}
