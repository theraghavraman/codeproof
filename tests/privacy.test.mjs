import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BOOTSTRAP_SOURCE, SANDBOX_CSP } from '../docs/assets/sandbox.mjs';
import { PYODIDE_FILES, PYODIDE_VERSION } from '../docs/assets/runtime/pinned-pyodide.mjs';

const DOCS = new URL('../docs/', import.meta.url).pathname;
const read = p => readFile(join(DOCS, p), 'utf8');
const cspOf = html => Object.fromEntries((html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || '').split(';').map(d => d.trim().split(/\s+/)).filter(d => d[0]).map(([k, ...v]) => [k, v]));

async function appSources(dir = 'assets', out = []) {
  for (const e of await readdir(join(DOCS, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) await appSources(p, out);
    else if (e.name.endsWith('.mjs') && e.name !== 'acorn.mjs') out.push(p);
  }
  return out;
}

test('application page CSP: same-origin scripts and connections only, no inline or eval', async () => {
  const csp = cspOf(await read('index.html'));
  assert.deepEqual(csp['script-src'], ["'self'"]);
  assert.deepEqual(csp['connect-src'], ["'self'"], 'the privileged page can only talk to its own origin');
  assert.deepEqual(csp['default-src'], ["'none'"]);
  assert.deepEqual(csp['object-src'], ["'none'"]);
  assert.deepEqual(csp['base-uri'], ["'none'"]);
  assert.deepEqual(csp['form-action'], ["'none'"]);
  assert.deepEqual(csp['frame-src'], ["'self'"]);
});

test('sandbox page CSP: no network, pinned bootstrap hash, and the iframe is never same-origin', async () => {
  const html = await read('sandbox/run.html');
  const csp = cspOf(html);
  assert.deepEqual(csp['connect-src'], ["'none'"]);
  assert.deepEqual(csp['default-src'], ["'none'"]);
  const hash = createHash('sha256').update(BOOTSTRAP_SOURCE, 'utf8').digest('base64');
  assert.ok(csp['script-src'].includes(`'sha256-${hash}'`), 'docs/sandbox/run.html is current (node scripts/build-sandbox-page.mjs)');
  assert.ok(!csp['script-src'].includes("'unsafe-inline'"));
  assert.ok(html.includes(BOOTSTRAP_SOURCE));
  assert.match(SANDBOX_CSP, /connect-src 'none'/);
  const sandbox = await read('assets/sandbox.mjs');
  assert.match(sandbox, /setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.doesNotMatch(sandbox, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-downloads/);
});

test('application code never sends data off-site and contains no telemetry', async () => {
  const files = await appSources();
  assert.ok(files.length > 25);
  for (const p of files) {
    const src = await read(p);
    assert.doesNotMatch(src, /\b(?:sendBeacon|google-analytics|googletagmanager|segment\.io|sentry|mixpanel|posthog|amplitude)\b/i, `${p}: telemetry`);
    for (const m of src.matchAll(/\bfetch\(\s*([^,)]+)/g)) {
      const arg = m[1].trim();
      assert.ok(/^(?:new URL\(|`?\.\/|'\.\/|url\b|name\b|input\b|origin\b|`\$\{|\(?url)/.test(arg) || /^`\.\.?\//.test(arg), `${p}: fetch target must be same-origin/relative, got ${arg}`);
      assert.doesNotMatch(arg, /https?:\/\//, `${p}: absolute fetch target ${arg}`);
    }
    assert.doesNotMatch(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''), /['"`]https?:\/\/(?!codeproof\.invalid|json\.schemastore\.org|github\.com\/theraghavraman|registry\.npmjs\.org)/, `${p}: unexpected absolute URL`);
  }
});

test('browser-side Pyodide digests match the build manifest exactly', async () => {
  const pinned = JSON.parse(await readFile(new URL('../scripts/pinned-assets.json', import.meta.url), 'utf8'));
  assert.equal(PYODIDE_VERSION, pinned.packages.pyodide.version);
  assert.deepEqual(Object.fromEntries(Object.entries(PYODIDE_FILES).map(([k, v]) => [k, v.sha256])), pinned.packages.pyodide.extract.files);
});

test('uploaded source is not persisted unless the user opts in', async () => {
  const app = await read('assets/app.mjs');
  const persist = app.slice(app.indexOf('function persist(){'), app.indexOf('function clearStoredWorkspace'));
  assert.match(persist, /if\(!S\.persist\)return;/);
  assert.equal((app.match(/localStorage\.setItem/g) || []).length, 1, 'a single, guarded write path');
  const worker = await read('assets/analysis.worker.mjs');
  assert.doesNotMatch(worker, /localStorage|indexedDB|caches\./);
});
