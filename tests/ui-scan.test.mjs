// Drives the real application module through a complete Project Scan, with the real analysis worker
// running in-process (no DOM, no sandbox: runtime checks are switched off in the options).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { libsAvailable } from './helpers/scan-helpers.mjs';
import { findingRow, findingDetail, graphSvg, buildTree, treeHtml } from '../docs/assets/ui/scan-views.mjs';

const skip = libsAvailable ? false : 'TypeScript lib files not restored';
const handlers = new Map();
const root = { innerHTML: '', addEventListener(type, cb) { handlers.set(type, [...(handlers.get(type) || []), cb]); } };
const store = new Map();
globalThis.document = { querySelector: s => (s === '#app' ? root : null), getElementById: () => null, activeElement: null };
globalThis.location = { hash: '' };
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
globalThis.window = { addEventListener() {} };
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).startsWith('file:') ? new Response(await readFile(new URL(url))) : nativeFetch(url, init));
let app = null;
globalThis.self = { postMessage: msg => setTimeout(() => app?.onmessage?.({ data: structuredClone(msg) })) };
globalThis.Worker = class { constructor() { app = this; } postMessage(msg) { setTimeout(() => globalThis.self.onmessage({ data: structuredClone(msg) })); } terminate() {} };
await import('../docs/assets/analysis.worker.mjs');
await import('../docs/assets/app.mjs');

const node = (action, dataset = {}) => { const n = { dataset: { action, ...dataset }, classList: { contains: () => false } }; n.closest = () => n; return n; };
const click = async (action, dataset) => { for (const h of handlers.get('click')) await h({ target: node(action, dataset), preventDefault() {} }); };
const change = async target => { for (const h of handlers.get('change')) await h({ target: { dataset: {}, tagName: 'INPUT', ...target } }); };
const until = async (pred, ms = 60000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 25)); } };

test('a full scan of the editor workspace renders every results view', { skip, timeout: 120000 }, async () => {
  await click('navigate', { view: 'scan' });
  assert.match(root.innerHTML, /Project Scan/);
  assert.match(root.innerHTML, /No scan results yet/);
  await change({ id: 'opt-js', checked: false });
  await change({ id: 'opt-python', checked: false });
  await click('start-scan');
  await until(() => /Scan complete|Scan failed/.test(root.innerHTML));
  const html = root.innerHTML;
  assert.match(html, /Scan complete/);
  assert.match(html, /Verification incomplete|Defects found/);
  assert.match(html, /Runtime checks did not run, so no behavior was executed\./);
  assert.match(html, /Type-checked by the TypeScript compiler/);
  for (const [tab, expected] of [['findings', /Dynamic code execution/], ['integration', /Integration checks/], ['runtime', /no project code was executed/], ['security', /exploitability not established/], ['graph', /External packages/], ['coverage', /Capabilities by language/], ['report', /Export scan report/]]) {
    await click('scan-tab', { tab });
    assert.match(root.innerHTML, expected, tab);
  }
  await click('navigate', { view: 'authorship' });
  assert.match(root.innerHTML, /Heuristic estimate — not a probability, not forensic proof/);
  assert.match(root.innerHTML, /Indeterminate/);
  await click('navigate', { view: 'inspector' });
  assert.match(root.innerHTML, /From the last project scan/);
  assert.equal(store.size, 0, 'nothing was written to browser storage without opt-in');
});

test('results views escape untrusted project text', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const f = { id: 'CP-1', title: evil, severity: 'high', verification: 'potential', verificationLabel: evil, category: 'logic', confidence: 'low', file: `src/${evil}.js`, line: 1, rule: evil, analyzers: [evil], affected: [evil], evidence: [evil], reproduction: [evil], related: [], rootCause: evil, suggestion: evil };
  const html = findingRow(f, false) + findingDetail(f, { files: [{ path: f.file, content: `x\n${evil}\n` }], scan: { result: { findings: [f] } }, dirtyAfterScan: new Set() });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const svg = graphSvg({ edges: [{ from: `a/${evil}.js`, to: 'b.js', status: 'resolved' }], cycles: [] });
  assert.doesNotMatch(svg, /<img/);
  assert.doesNotMatch(treeHtml(buildTree([{ path: `${evil}/x.js`, status: 'ingested' }]), () => 'analyzed', new Map()), /<img/);
});
