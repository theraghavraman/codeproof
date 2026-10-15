// Real-browser end-to-end tests (headless Chrome via the DevTools protocol). They exercise the actual
// application, the sandbox isolation claims and the full scan workflow. Run: node --test tests/e2e/
// Requires Chrome/Chromium (set CHROME_PATH if it is not in a standard location) and the restored vendor
// assets (node scripts/restore-vendor.mjs && node scripts/fetch-pinned-assets.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, startServer, launchChrome, openPage } from './cdp.mjs';
import { buildZip, zipDirectory } from '../helpers/zip-writer.mjs';

const ROOT = new URL('../../docs/', import.meta.url).pathname;
const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;
const chrome = findChrome();
const assetsReady = existsSync(join(ROOT, 'vendor/typescript.mjs')) && existsSync(join(ROOT, 'vendor/pyodide/pyodide.asm.wasm'));
const skip = !chrome ? 'Chrome/Chromium not found (set CHROME_PATH)' : !assetsReady ? 'Vendor assets missing (run restore-vendor and fetch-pinned-assets)' : false;

let server, browser, page, work;
test.before(async () => {
  if (skip) return;
  work = mkdtempSync(join(tmpdir(), 'codeproof-e2e-'));
  server = await startServer(ROOT.replace(/\/$/, ''));
  browser = await launchChrome(chrome);
  page = await openPage(browser, server.origin + '/');
});
test.after(async () => {
  if (skip) return;
  await browser?.close();
  await server?.close();
  rmSync(work, { recursive: true, force: true });
});

const exfilHits = () => server.requests.filter(r => r.path.startsWith('/__exfil')).length;
const frames = () => page.evaluate('document.querySelectorAll("iframe").length');

test('application loads under its CSP without errors or third-party requests', { skip }, async () => {
  await page.waitFor('document.querySelector(".nav-item")');
  const title = await page.evaluate('document.title');
  assert.match(title, /CodeProof/);
  const csp = await page.evaluate('window.__cspViolations');
  assert.deepEqual(csp, [], `CSP violations: ${JSON.stringify(csp)}`);
  assert.deepEqual(page.events.exceptions, []);
  const errors = page.events.console.filter(c => c.type === 'error');
  assert.deepEqual(errors, []);
});

test('sandbox executes JavaScript in an opaque-origin frame and cleans up', { skip }, async () => {
  const before = await frames();
  const out = await page.evaluate(`(async () => {
    const m = await import('/assets/sandbox.mjs'); const h = await import('/assets/runtime/js-harness.mjs');
    const s = new m.SandboxSession('javascript'); await s.start(h.jsWorkerSource);
    const opaque = s.frame.contentDocument === null;
    const r = await m.runSandboxJob(s, { id: 'j1', type: 'call', modules: { 'a.js': { kind: 'js', code: 'exports.add=(a,b)=>a+b; exports.origin=()=>self.origin;' } }, entry: 'a.js', functionName: 'add', exportName: 'add', cases: [{ id: 'c1', args: [2, 3] }] }, 5000);
    const o = await m.runSandboxJob(s, { id: 'j2', type: 'call', modules: { 'a.js': { kind: 'js', code: 'exports.origin=()=>[self.origin, typeof indexedDB, typeof caches, typeof localStorage, typeof document, typeof parent].join(",");' } }, entry: 'a.js', functionName: 'origin', exportName: 'origin', cases: [{ id: 'c2', args: [] }] }, 5000);
    s.dispose();
    return { opaque, value: r.result.cases[0].value, env: o.result.cases[0].value };
  })()`);
  assert.equal(out.opaque, true, 'parent cannot read the sandbox document');
  assert.equal(out.value, 5);
  assert.equal(out.env, 'null,undefined,undefined,undefined,undefined,undefined', 'worker runs at an opaque origin without storage, DOM or parent access');
  assert.equal(await frames(), before, 'sandbox iframe removed after dispose');
});

test('the sandbox CSP blocks network access by itself, independent of the harness', { skip }, async () => {
  const before = exfilHits();
  // A raw worker WITHOUT CodeProof's defensive API removal: only the sandbox page's CSP stands in the way.
  const out = await page.evaluate(`(async () => {
    const m = await import('/assets/sandbox.mjs');
    const raw = \`self.onmessage = async ({ data, ports }) => {
      const port = ports[0]; port.postMessage({ type: 'connected' });
      port.onmessage = async ev => {
        const origin = ev.data.payload ? ev.data.payload.origin : ev.data.origin;
        const out = {};
        try { await fetch(origin + '/__exfil/fetch'); out.fetch = 'ok'; } catch (e) { out.fetch = e.name; }
        try { importScripts(origin + '/__exfil/script.js'); out.importScripts = 'ok'; } catch (e) { out.importScripts = e.name; }
        try { const x = new XMLHttpRequest(); x.open('GET', origin + '/__exfil/xhr', false); x.send(); out.xhr = 'ok'; } catch (e) { out.xhr = e.name; }
        out.ws = await new Promise(res => { try { const w = new WebSocket(origin.replace('http', 'ws') + '/__exfil/ws'); w.onerror = () => res('error-event'); w.onopen = () => res('ok'); setTimeout(() => res('no-connection'), 1500); } catch (e) { res(e.name); } });
        out.eventSource = await new Promise(res => { try { const s = new EventSource(origin + '/__exfil/sse'); s.onerror = () => res('error-event'); s.onopen = () => res('ok'); setTimeout(() => res('no-connection'), 1500); } catch (e) { res(e.name); } });
        out.origin = self.origin;
        port.postMessage({ type: 'probe', out });
      };
    };\`;
    const s = new m.SandboxSession('javascript'); await s.start(raw);
    const got = s.waitFor(p => p.type === 'probe', 8000, 'probe timeout');
    s.send({ origin: location.origin });
    const r = await got; s.dispose(); return r.out;
  })()`);
  await new Promise(r => setTimeout(r, 800));
  assert.equal(exfilHits(), before, `no request reached the server; probe results ${JSON.stringify(out)}`);
  assert.equal(out.fetch, 'TypeError');
  assert.notEqual(out.importScripts, 'ok');
  assert.notEqual(out.xhr, 'ok');
  assert.notEqual(out.ws, 'ok');
  assert.notEqual(out.eventSource, 'ok');
  assert.equal(out.origin, 'null');
});

test('the harness additionally removes network APIs from uploaded code', { skip }, async () => {
  const out = await page.evaluate(`(async () => {
    const m = await import('/assets/sandbox.mjs'); const h = await import('/assets/runtime/js-harness.mjs');
    const s = new m.SandboxSession('javascript'); await s.start(h.jsWorkerSource);
    const code = 'exports.f = () => [typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof importScripts, typeof EventSource].join(",")';
    const r = await m.runSandboxJob(s, { id: 'apis', type: 'call', modules: { 'n.js': { kind: 'js', code } }, entry: 'n.js', functionName: 'f', exportName: 'f', cases: [{ id: 'c', args: [] }] }, 5000);
    s.dispose(); return r.result.cases[0].value;
  })()`);
  assert.equal(out, 'undefined,undefined,undefined,undefined,undefined');
});

test('forged worker messages cannot replace real results', { skip }, async () => {
  const out = await page.evaluate(`(async () => {
    const m = await import('/assets/sandbox.mjs'); const h = await import('/assets/runtime/js-harness.mjs');
    const s = new m.SandboxSession('javascript'); await s.start(h.jsWorkerSource);
    const code = "self.postMessage({ type: 'job-done', jobId: 'forge', result: { cases: [{ id: 'c', ok: true, value: 999 }] } }); exports.f = () => 1;";
    const r = await m.runSandboxJob(s, { id: 'forge', type: 'call', modules: { 'f.js': { kind: 'js', code } }, entry: 'f.js', functionName: 'f', exportName: 'f', cases: [{ id: 'c', args: [] }] }, 5000);
    s.dispose();
    return r.result.cases[0].value;
  })()`);
  assert.equal(out, 1);
});

test('infinite loops hit the deadline, the sandbox is torn down, and cancellation stops work', { skip }, async () => {
  const before = await frames();
  const out = await page.evaluate(`(async () => {
    const m = await import('/assets/sandbox.mjs'); const h = await import('/assets/runtime/js-harness.mjs');
    const s = new m.SandboxSession('javascript'); await s.start(h.jsWorkerSource);
    const t0 = performance.now();
    const r = await m.runSandboxJob(s, { id: 'loop', type: 'call', modules: { 'l.js': { kind: 'js', code: 'exports.spin=()=>{for(;;){}}' } }, entry: 'l.js', functionName: 'spin', exportName: 'spin', cases: [{ id: 'c', args: [] }] }, 1000);
    const elapsed = performance.now() - t0;
    const rt = new m.ProjectRuntime({ budgetMs: 60000 });
    const job = { id: 'slow', engine: 'js', type: 'call', entry: 'l.js', functionName: 'spin', exportName: 'spin', cases: [{ id: 'c', args: [] }], deadlineMs: 20000 };
    const p = rt.run({ jobs: [job, { ...job, id: 'slow2' }], modules: { 'l.js': { kind: 'js', code: 'exports.spin=()=>{for(;;){}}' } }, python: { files: {}, roots: [''] } });
    await new Promise(r => setTimeout(r, 400)); rt.cancel();
    const c0 = performance.now(); const res = await p; const cancelMs = performance.now() - c0;
    return { status: r.status, elapsed, caseStarted: r.partial.caseStarted, cancelled: res.cancelled, cancelMs };
  })()`);
  assert.equal(out.status, 'timeout');
  assert.ok(out.elapsed < 3000, `deadline enforced (${out.elapsed} ms)`);
  assert.equal(out.caseStarted, 'c', 'the hanging case is identified');
  assert.equal(out.cancelled, true);
  assert.ok(out.cancelMs < 3000, `cancel returned in ${out.cancelMs} ms`);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(await frames(), before, 'no sandbox frames left behind');
});

test('tampered Pyodide files are refused before anything runs', { skip }, async () => {
  const out = await page.evaluate(`(async () => {
    const m = await import('/assets/sandbox.mjs');
    try { await m.loadVerifiedPyodideAssets({ baseUrl: new URL('/__tampered/pyodide/', location.href), useCache: false }); return 'loaded'; }
    catch (e) { return e.message; }
  })()`);
  assert.match(out, /Integrity check failed for pyodide\.asm\.js/);
});

test('Python runs in Pyodide inside the sandbox with network access disabled', { skip, timeout: 180000 }, async () => {
  const before = exfilHits();
  const out = await page.evaluate(`(async () => {
    const m = await import('/assets/sandbox.mjs');
    const sb = new m.ExecutionSandbox('python');
    const ok = await sb.run('def f(x):\\n    return x + 1', { id: 't', title: 't', file: 'a.py', functionName: 'f', args: [2], kind: 'expected', expected: 3 }, 60000);
    const net = await sb.run('import js\\ndef probe(origin):\\n    out = []\\n    try:\\n        js.fetch(origin + "/__exfil/py")\\n        out.append("fetch-called")\\n    except Exception as e:\\n        out.append(type(e).__name__)\\n    try:\\n        from pyodide.http import open_url\\n        open_url(origin + "/__exfil/xhr")\\n        out.append("xhr-ok")\\n    except Exception as e:\\n        out.append(type(e).__name__)\\n    return ",".join(out)', { id: 'n', title: 'n', file: 'n.py', functionName: 'probe', args: [location.origin], kind: 'smoke' }, 20000);
    sb.dispose();
    return { status: ok.status, actual: ok.actual, net: net.actual, netStatus: net.status, netMessage: net.message };
  })()`, { timeout: 170000 });
  await new Promise(r => setTimeout(r, 800));
  assert.equal(out.status, 'passed', JSON.stringify(out));
  assert.equal(out.actual, 3);
  assert.equal(exfilHits(), before, `no Python network request reached the server (${JSON.stringify(out)})`);
});

async function scanZip(name, zipBuffer, { python = false } = {}) {
  const file = join(work, name);
  writeFileSync(file, zipBuffer);
  await page.goto(`${server.origin}/?run=${Date.now()}#scan`);
  await page.waitFor('document.getElementById("zip-picker")');
  if (!python) await page.evaluate('(() => { const el = document.getElementById("opt-python"); if (el && el.checked) el.click(); })()');
  await page.setFiles('#zip-picker', [file]);
  await page.waitFor('(() => { const badge = document.getElementById("progress-title")?.closest(".panel")?.querySelector(".panel-head .badge")?.textContent || ""; return /^(?:Complete|Cancelled|Failed)$/i.test(badge.trim()) || document.querySelector(".upload-box ~ .warning-callout[role=alert]"); })()', 240000, 500);
  return page.evaluate('document.querySelector("main").innerText');
}
async function tabText(tab) {
  await page.evaluate(`document.getElementById("tab-${tab}")?.click()`);
  await new Promise(r => setTimeout(r, 300));
  return page.evaluate('document.getElementById("scan-panel")?.innerText || ""');
}

test('full scan of a ZIP project finds integration-only, compiler and runtime-reproduced defects', { skip, timeout: 300000 }, async () => {
  const text = await scanZip('broken-integration.zip', zipDirectory(join(FIXTURES, 'broken-integration'), 'broken-integration/'));
  assert.match(text, /Scan complete/, text.slice(0, 2000));
  await page.evaluate('(() => { const s = document.querySelector("[data-filter=verification]"); })()');
  const findings = await tabText('findings');
  for (const expected of [/Imported name "formatCurrency" is not exported/, /Wrong number of arguments \(cross-file contract\)/, /Import path case differs from the file on disk/, /CommonJS code in an ES-module package/, /"express" is imported but not declared/, /Test fails: mean > averages two numbers/, /Module throws while loading/, /Circular import across 2 modules/, /Loop reads one element past the end/, /Query uses column shipped_at/]) assert.match(findings, expected);
  const runtime = await tabText('runtime');
  assert.match(runtime, /mean > averages two numbers/);
  assert.match(runtime, /pricing > applies a percentage discount/);
  const coverage = await tabText('coverage');
  assert.match(coverage, /Type-checked by the TypeScript compiler/);
  assert.match(coverage, /Discovered tests executed/);
  const csp = await page.evaluate('window.__cspViolations');
  assert.deepEqual(csp, []);
});

test('Python project: CPython compile, pytest-style tests, and cross-module contract findings', { skip, timeout: 300000 }, async () => {
  const text = await scanZip('python-project.zip', zipDirectory(join(FIXTURES, 'python-project'), 'python-project/'), { python: true });
  assert.match(text, /Scan complete/, text.slice(0, 2000));
  const findings = await tabText('findings');
  for (const expected of [/CPython SyntaxError|Missing colon after block header/, /"reorder_level" is not defined in inventory\.stock/, /does not match the signature of restock\(\)/, /Mutable default argument/]) assert.match(findings, expected);
  const runtime = await tabText('runtime');
  assert.match(runtime, /test_restock_adds_quantity\s+PASSED/i);
  assert.match(runtime, /CPython compile\(\)\s+\d+\/\d+ files compiled/);
});

test('hostile archives: traversal entries are skipped, zip bombs refused, malformed archives reported', { skip, timeout: 120000 }, async () => {
  const traversal = buildZip([{ name: '../evil.js', data: 'export const x = 1;' }, { name: 'ok/main.js', data: 'export function main() { return 1; }' }, { name: '/abs.js', data: '1' }]);
  await scanZip('traversal.zip', traversal);
  const inventory = await tabText('coverage');
  assert.match(inventory, /\.\.\/evil\.js[\s\S]*Unsafe path: Path traversal/);
  const bomb = buildZip([{ name: 'bomb.txt', data: Buffer.alloc(40_000_000, 0) }, { name: 'src/a.js', data: 'export const a = 1;' }]);
  await scanZip('bomb.zip', bomb);
  const inv2 = await tabText('coverage');
  assert.match(inv2, /bomb\.txt[\s\S]*(?:zip bomb|per-file limit)/i);
  const text = await scanZip('broken.zip', Buffer.from('PK\u0003\u0004 definitely not a real archive'));
  assert.match(text, /Archive rejected \(malformed\)|End of central directory not found/);
});

test('responsive layout: no horizontal page scrolling at phone width', { skip }, async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  for (const hash of ['#scan', '#workspace', '#inspector', '#authorship']) {
    await page.goto(`${server.origin}/?run=${Date.now()}${hash}`);
    await new Promise(r => setTimeout(r, 300));
    const overflow = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    assert.ok(overflow <= 1, `${hash} overflows horizontally by ${overflow}px`);
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
});

test('JSON report export downloads locally and contains no file contents', { skip, timeout: 300000 }, async () => {
  await scanZip('good.zip', zipDirectory(join(FIXTURES, 'good-project'), 'good-project/'));
  const downloads = join(work, 'downloads');
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await tabText('report');
  await page.evaluate('document.querySelector("[data-action=export-scan-json]").click()');
  const end = Date.now() + 10000;
  let file;
  while (Date.now() < end && !file) { await new Promise(r => setTimeout(r, 200)); file = existsSync(downloads) ? readdirSync(downloads).find(f => f.endsWith('.json')) : null; }
  assert.ok(file, 'report downloaded');
  const report = JSON.parse(readFileSync(join(downloads, file), 'utf8'));
  assert.equal(report.schema, 'codeproof.scan.v2');
  assert.ok(report.coverage.ratios.every(r => typeof r.denominator === 'number' && r.definition));
  assert.doesNotMatch(JSON.stringify(report), /values\.reduce\(\(sum, v\) => sum \+ v, 0\)/, 'source text is not embedded');
  assert.equal(report.authorship.estimateType, 'heuristic');
});

test('every request in the session stayed on the CodeProof origin', { skip }, async () => {
  const foreign = page.events.requests.filter(u => !u.startsWith(server.origin) && !u.startsWith('blob:') && !u.startsWith('data:') && u !== 'about:blank');
  assert.deepEqual(foreign, []);
});
