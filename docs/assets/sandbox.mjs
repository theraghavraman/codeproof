// Browser execution sandbox. Untrusted code never runs in this (privileged) window:
//  * docs/sandbox/run.html is loaded into an <iframe sandbox="allow-scripts"> (opaque origin: no access to
//    this page's DOM, cookies, storage or same-origin requests);
//  * its Content-Security-Policy (connect-src 'none', no img/style/font/frame sources) applies to the
//    page and to the blob: worker it creates, which is where uploaded code actually executes;
//  * every job has a deadline; on timeout or cancel the iframe is removed, which terminates the worker.
// Python uses Pyodide whose files are fetched here from this origin, verified against pinned SHA-256
// digests, and transferred into the sandbox, so the sandbox itself needs no network access.
import { jsWorkerSource } from './runtime/js-harness.mjs';
import { pyWorkerSource, pythonRunnerSource } from './runtime/py-harness.mjs';
import { PYODIDE_FILES, PYODIDE_VERSION } from './runtime/pinned-pyodide.mjs';

const SIGNAL = 'codeproof.sandbox.v2';
export const SANDBOX_CSP = "default-src 'none'; script-src 'sha256-__BOOT_HASH__' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src blob:; child-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; font-src 'none'; media-src 'none'; manifest-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
// Static bootstrap for docs/sandbox/run.html. Its SHA-256 is pinned in the page's CSP (see tests).
export const BOOTSTRAP_SOURCE = `(() => {
  'use strict';
  const SIGNAL = ${JSON.stringify(SIGNAL)};
  let session = null, port = null;
  const up = payload => parent.postMessage({ signal: SIGNAL, session, payload }, '*');
  addEventListener('message', event => {
    if (event.source !== parent) return;
    const data = event.data;
    if (!data || data.signal !== SIGNAL) return;
    if (data.type === 'init' && session === null && typeof data.session === 'string' && typeof data.workerSource === 'string') {
      session = data.session;
      try {
        const worker = new Worker(URL.createObjectURL(new Blob([data.workerSource], { type: 'text/javascript' })));
        const channel = new MessageChannel();
        port = channel.port1;
        port.onmessage = ev => up(ev.data);
        worker.onerror = ev => up({ type: 'worker-error', message: String(ev.message || 'Worker failed to start') });
        worker.onmessage = () => {};
        worker.postMessage({ type: 'connect' }, [channel.port2]);
      } catch (error) { up({ type: 'worker-error', message: String(error && error.message || error) }); }
      return;
    }
    if (data.session === session && port && data.type === 'forward') port.postMessage(data.payload, Array.isArray(data.transfer) ? data.transfer : []);
  });
  parent.postMessage({ signal: SIGNAL, type: 'booted' }, '*');
})();`;

// The page is identical for both runtimes (mode and session arrive later by message); the parameters
// are kept for the regression tests that call it with a mode and session id.
export function makeSandboxHtml(_mode = 'javascript', _session = '', bootHash = '__BOOT_HASH__') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP.replace('__BOOT_HASH__', bootHash)}"><title>CodeProof sandbox</title></head><body><script>${BOOTSTRAP_SOURCE}</script></body></html>\n`;
}

export const withDeadline = (promise, ms, message) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(Object.assign(new Error(message), { name: 'TimeoutError' })), ms);
  Promise.resolve(promise).then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
});

// Validates and bounds data coming back from the sandbox before the UI touches it.
export function sanitizeFromSandbox(value, depth = 0, budget = { n: 0 }) {
  if (++budget.n > 50000) return '[truncated]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 4000 ? value.slice(0, 4000) + '…' : value;
  if (typeof value !== 'object' || depth > 12) return String(value).slice(0, 200);
  if (Array.isArray(value)) return value.slice(0, 2000).map(v => sanitizeFromSandbox(v, depth + 1, budget));
  const out = {};
  for (const key of Object.keys(value).slice(0, 300)) if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') out[key] = sanitizeFromSandbox(value[key], depth + 1, budget);
  return out;
}

let pyodideAssetCache = null;
export async function loadVerifiedPyodideAssets({ baseUrl = new URL('../vendor/pyodide/', import.meta.url), useCache = true } = {}) {
  if (useCache && pyodideAssetCache) return pyodideAssetCache;
  if (!globalThis.crypto?.subtle) throw Object.assign(new Error('crypto.subtle is unavailable (requires HTTPS or localhost), so the Python runtime cannot be integrity-checked.'), { blocked: true });
  const assets = {};
  for (const [name, pin] of Object.entries(PYODIDE_FILES)) {
    let response;
    try { response = await fetch(new URL(name, baseUrl), { cache: 'force-cache' }); } catch (error) { throw Object.assign(new Error(`Pyodide ${PYODIDE_VERSION} file ${name} could not be fetched: ${error.message}`), { blocked: true }); }
    if (!response.ok) throw Object.assign(new Error(`Pyodide ${PYODIDE_VERSION} is not deployed with this build (${name}: HTTP ${response.status}). Run node scripts/fetch-pinned-assets.mjs.`), { blocked: true });
    const bytes = await response.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (digest !== pin.sha256) throw Object.assign(new Error(`Integrity check failed for ${name}: expected ${pin.sha256}, got ${digest}. The runtime was not started.`), { blocked: true, integrity: true });
    assets[name] = bytes;
  }
  if (useCache) pyodideAssetCache = assets;
  return assets;
}

let sessionCounter = 0;
export class SandboxSession {
  constructor(kind) {
    this.kind = kind;
    this.session = globalThis.crypto?.randomUUID ? crypto.randomUUID() : `s${Date.now()}-${++sessionCounter}`;
    this.frame = null;
    this.listeners = new Set();
    this.onWindowMessage = this.onWindowMessage.bind(this);
    this.disposed = false;
    this.booted = null;
  }
  onWindowMessage(event) {
    if (!this.frame || event.source !== this.frame.contentWindow) return;
    const data = event.data;
    if (!data || data.signal !== SIGNAL) return;
    if (data.type === 'booted') { this.bootResolve?.(); return; }
    if (data.session !== this.session || !data.payload || typeof data.payload.type !== 'string') return;
    const payload = sanitizeFromSandbox(data.payload);
    for (const fn of [...this.listeners]) fn(payload);
  }
  listen(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  waitFor(predicate, ms, message) {
    return withDeadline(new Promise((resolve, reject) => {
      const off = this.listen(p => {
        if (p.type === 'worker-error' || p.type === 'init-error') { off(); reject(new Error(p.message || 'Sandbox worker failed')); }
        else if (predicate(p)) { off(); resolve(p); }
      });
      this.rejectWaiters = reason => { off(); reject(reason); };
    }), ms, message);
  }
  async start(workerSource, { bootMs = 6000 } = {}) {
    if (typeof document === 'undefined') throw new Error('Sandbox requires a browser document.');
    window.addEventListener('message', this.onWindowMessage);
    this.booted = new Promise(resolve => { this.bootResolve = resolve; });
    this.frame = document.createElement('iframe');
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.setAttribute('aria-hidden', 'true');
    this.frame.setAttribute('tabindex', '-1');
    this.frame.setAttribute('referrerpolicy', 'no-referrer');
    this.frame.title = 'CodeProof execution sandbox';
    this.frame.style.display = 'none';
    this.frame.src = new URL('../sandbox/run.html', import.meta.url).href;
    document.body.appendChild(this.frame);
    await withDeadline(this.booted, bootMs, 'Sandbox page did not start (it may be blocked by the browser or missing from the deployment).');
    const connected = this.waitFor(p => p.type === 'connected', bootMs, 'Sandbox worker did not start.');
    this.frame.contentWindow.postMessage({ signal: SIGNAL, type: 'init', session: this.session, workerSource }, '*');
    await connected;
  }
  send(payload, transfer = []) {
    if (!this.frame) throw new Error('Sandbox is not running.');
    this.frame.contentWindow.postMessage({ signal: SIGNAL, type: 'forward', session: this.session, payload, transfer }, '*', transfer);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof window !== 'undefined') window.removeEventListener('message', this.onWindowMessage);
    this.rejectWaiters?.(new Error('Sandbox disposed'));
    this.listeners.clear();
    this.frame?.remove();
    this.frame = null;
  }
}

// Runs one job in a session and collects streamed progress so a timeout still yields partial results.
export async function runSandboxJob(session, job, deadlineMs, onEvent) {
  const started = performance.now();
  const partial = { tests: [], cases: [], lastStarted: null, caseStarted: null };
  const off = session.listen(p => {
    if (p.type === 'test-start') partial.lastStarted = p.name;
    if (p.type === 'test-result' && p.test) partial.tests.push(p.test);
    if (p.type === 'case-start') partial.caseStarted = p.caseId;
    if (p.type === 'case-result' && p.caseRecord) partial.cases.push(p.caseRecord);
    if (p.type === 'progress') partial.lastStarted = p.label;
    onEvent?.(p);
  });
  try {
    const done = session.waitFor(p => (p.type === 'job-done' || p.type === 'job-error') && p.jobId === job.id, deadlineMs, `Job exceeded its ${deadlineMs} ms limit`);
    session.send({ type: 'job', job });
    const p = await done;
    if (p.type === 'job-error') return { status: 'error', error: p.error?.message || 'Sandbox job failed', durationMs: Math.round(performance.now() - started), partial };
    return { status: 'completed', result: p.result, durationMs: Math.round(performance.now() - started), partial };
  } catch (error) {
    session.dispose();
    return { status: error.name === 'TimeoutError' ? 'timeout' : 'error', error: error.message, durationMs: Math.round(performance.now() - started), partial };
  } finally { off(); }
}

// Executes a runtime plan (from the engine's planRuntime) and returns raw results for interpretRuntime().
export class ProjectRuntime {
  constructor({ concurrency = 2, budgetMs = 150000 } = {}) {
    this.concurrency = concurrency;
    this.budgetMs = budgetMs;
    this.sessions = new Set();
    this.cancelled = false;
  }
  cancel() { this.cancelled = true; for (const s of this.sessions) s.dispose(); this.sessions.clear(); }
  track(session) { this.sessions.add(session); return session; }
  async run({ jobs, modules, python }, { onProgress } = {}) {
    const started = performance.now();
    const results = [], extraBlocked = [];
    const overBudget = () => performance.now() - started > this.budgetMs;
    const jsJobs = jobs.filter(j => j.engine === 'js');
    const pyJobs = jobs.filter(j => j.engine === 'python');
    let done = 0;
    const total = jobs.length;
    const tick = label => onProgress?.({ phase: 'runtime', label, done, total });
    const runJs = async job => {
      if (this.cancelled) return;
      if (overBudget()) { extraBlocked.push({ engine: 'js', type: job.type, path: job.entry || null, reason: `Runtime budget of ${Math.round(this.budgetMs / 1000)} s exhausted before this job ran.` }); return; }
      const session = this.track(new SandboxSession('javascript'));
      let outcome;
      try { await session.start(jsWorkerSource); outcome = await runSandboxJob(session, { ...job, modules }, job.deadlineMs, () => {}); }
      catch (error) { outcome = { status: 'error', error: error.message, partial: { tests: [], cases: [] } }; }
      finally { session.dispose(); this.sessions.delete(session); }
      results.push(toResult('js', job, outcome));
      done++; tick(`JavaScript ${job.type}: ${job.entry || job.id}`);
    };
    const queue = [...jsJobs];
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => { while (queue.length && !this.cancelled) await runJs(queue.shift()); }));
    if (pyJobs.length && !this.cancelled) {
      let assets;
      try { assets = await loadVerifiedPyodideAssets(); }
      catch (error) { for (const job of pyJobs) extraBlocked.push({ engine: 'python', type: job.type, path: job.path || job.entry || null, reason: error.message }); return { results, blocked: extraBlocked, cancelled: this.cancelled }; }
      /** @type {SandboxSession|null} */
      let session = null;
      const ensure = async () => {
        if (session && !session.disposed) return session;
        const fresh = this.track(new SandboxSession('python'));
        session = fresh;
        await fresh.start(pyWorkerSource);
        const ready = fresh.waitFor(p => p.type === 'ready', 90000, 'Python runtime did not initialize within 90 s.');
        const copies = Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, v.slice(0)]));
        fresh.send({ type: 'init', assets: copies, runner: pythonRunnerSource }, Object.values(copies));
        await ready;
        const mount = await runSandboxJob(fresh, { id: 'mount', type: 'mount', files: python.files, roots: python.roots }, 30000);
        if (mount.status !== 'completed') throw new Error(`Could not mount project files into Pyodide: ${mount.error}`);
        return fresh;
      };
      for (const job of pyJobs) {
        if (this.cancelled) break;
        if (overBudget()) { extraBlocked.push({ engine: 'python', type: job.type, path: job.path || job.entry || null, reason: 'Runtime budget exhausted before this job ran.' }); continue; }
        let outcome;
        try { const active = await ensure(); tick(`Python ${job.type}: ${job.path || job.entry || ''}`); outcome = await runSandboxJob(active, job, job.deadlineMs, () => {}); }
        catch (error) { outcome = { status: 'error', error: error.message, partial: { tests: [], cases: [] } }; session?.dispose(); }
        results.push(toResult('python', job, outcome));
        done++;
      }
      session?.dispose();
    }
    return { results, blocked: extraBlocked, cancelled: this.cancelled, durationMs: Math.round(performance.now() - started) };
  }
  dispose() { this.cancel(); }
}

function toResult(engine, job, outcome) {
  const base = { engine, type: job.type, path: job.entry || job.path || null, status: outcome.status, durationMs: outcome.durationMs, deadlineMs: job.deadlineMs, error: outcome.error };
  const r = outcome.result || {};
  if (job.type === 'tests') return { ...base, path: job.entry || job.path, tests: r.tests || outcome.partial.tests, registrationError: r.registrationError || (outcome.status === 'error' ? { name: 'SandboxError', message: outcome.error } : null), lastStarted: outcome.partial.lastStarted };
  if (job.type === 'load') return { ...base, modules: r.modules || [], lastStarted: outcome.partial.lastStarted };
  if (job.type === 'compile') return { ...base, files: r.files || [] };
  if (job.type === 'call') {
    const { modules, ...meta } = job;
    void modules;
    let cases = r.cases || outcome.partial.cases;
    if (outcome.status === 'timeout') {
      const doneIds = new Set(cases.map(c => c.id));
      cases = [...cases, ...job.cases.filter(c => !doneIds.has(c.id)).map(c => ({ id: c.id, status: c.id === outcome.partial.caseStarted ? 'timeout' : 'not-run' }))];
    }
    return { ...base, job: meta, cases, loadError: r.loadError || null };
  }
  return base;
}

// ---------------------------------------------------------------------------------------------
// Single-function execution used by the Execution Lab, Automated Tests and Fix & Verify views.
export class ExecutionSandbox {
  constructor(mode) { this.mode = mode; this.session = null; this.ready = null; }
  async setup() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const session = new SandboxSession(this.mode);
      this.session = session;
      await session.start(this.mode === 'python' ? pyWorkerSource : jsWorkerSource);
      if (this.mode === 'python') {
        const assets = await loadVerifiedPyodideAssets();
        const copies = Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, v.slice(0)]));
        const ready = session.waitFor(p => p.type === 'ready', 90000, 'Python runtime did not initialize.');
        session.send({ type: 'init', assets: copies, runner: pythonRunnerSource }, Object.values(copies));
        await ready;
      }
      return session;
    })();
    try { return await this.ready; } catch (error) { this.dispose(); throw error; }
  }
  async request(message, limitMs) {
    const session = await withDeadline(this.setup(), this.mode === 'python' ? 95000 : 8000, 'Sandbox engine did not initialize.');
    const id = globalThis.crypto?.randomUUID ? crypto.randomUUID() : String(Math.random());
    const out = session.waitFor(p => p.type === 'result' && p.id === id, limitMs, 'Execution exceeded time limit; environment terminated.');
    session.send({ ...message, id });
    return out;
  }
  async run(source, test, limitMs, extra = {}) {
    const started = performance.now();
    try {
      const out = await this.request(this.mode === 'python' ? { type: 'run', source, test } : { type: 'legacy-run', source, test, modules: extra.modules, entry: extra.entry }, limitMs);
      const value = out.output || {};
      const result = { id: test.id, title: test.title, kind: test.kind, file: test.file, functionName: test.functionName, durationMs: out.ms, status: 'passed', actual: value.value, expected: test.expected, message: 'Executed without throwing. No semantic correctness claim.', logs: value.logs || [] };
      if (!value.ok) { result.status = test.kind === 'smoke' ? 'warning' : 'failed'; result.message = value.error || 'Exception encountered.'; }
      else if (test.kind === 'expected') {
        result.status = JSON.stringify(value.value) === JSON.stringify(test.expected) ? 'passed' : 'failed';
        result.message = result.status === 'passed' ? 'Output matches the specified expected value.' : 'Actual output differs from the expected value.';
      } else if (test.kind === 'idempotent' || test.kind === 'determinism') {
        result.status = value.same ? 'passed' : 'failed';
        result.message = value.same ? 'Property held for the selected input.' : 'Property did not hold for the selected input.';
      }
      return result;
    } catch (error) {
      this.dispose();
      return { id: test.id, title: test.title, kind: test.kind, file: test.file, functionName: test.functionName, status: 'error', durationMs: Math.round(performance.now() - started), actual: null, message: String(error?.message || error), logs: [] };
    } finally { if (this.mode === 'javascript') this.dispose(); }
  }
  async checkPythonSyntax(source, limitMs = 2000) {
    if (this.mode !== 'python') throw Error('Python mode required.');
    try {
      const out = await this.request({ type: 'syntax', source }, limitMs);
      return { ok: out.output.ok, message: out.output.ok ? 'Python grammar parsed successfully (CPython ast.parse).' : out.output.error };
    } catch (error) { this.dispose(); return { ok: false, message: String(error?.message || error) }; }
  }
  dispose() { this.session?.dispose(); this.session = null; this.ready = null; }
}

export class LocalTestRunner {
  constructor() { this.python = new ExecutionSandbox('python'); }
  async runOne(file, test, timeoutMs = 1800, transpile) {
    if (file.language === 'python') return this.python.run(file.content, test, timeoutMs);
    if (!['javascript', 'typescript'].includes(file.language)) return { id: test.id, title: test.title, kind: test.kind, status: 'error', durationMs: 0, message: `${file.language} supports static inspection only; browser execution unavailable.`, logs: [] };
    let prepared;
    try { prepared = transpile ? await transpile(file) : { modules: null, source: file.content }; }
    catch (e) { return { id: test.id, title: test.title, status: 'error', durationMs: 0, kind: test.kind, message: 'Compilation: ' + e.message, logs: [] }; }
    const source = prepared.modules?.[file.path]?.code ?? prepared.source ?? file.content;
    return new ExecutionSandbox('javascript').run(source, test, timeoutMs, { modules: prepared.modules, entry: file.path });
  }
  async runAll(files, tests, timeoutMs, transpile, progress) {
    const results = [];
    for (let i = 0; i < tests.length; i++) {
      const test = tests[i], file = files.find(f => f.path === test.file);
      if (file) results.push(await this.runOne(file, test, timeoutMs, transpile));
      else results.push({ id: test.id, title: test.title, status: 'error', durationMs: 0, message: 'Source file was not found.', logs: [] });
      progress?.(i + 1, tests.length, results[results.length - 1]);
    }
    return results;
  }
  validatePython(source, limitMs = 2000) { return this.python.checkPythonSyntax(source, limitMs); }
  dispose() { this.python.dispose(); }
}

// Exported for deterministic contract/security regression tests.
export const sandboxContract = Object.freeze({ jsWorkerSource, pyWorkerSource, makeSandboxHtml, bootstrapSource: BOOTSTRAP_SOURCE, csp: SANDBOX_CSP, signal: SIGNAL });
