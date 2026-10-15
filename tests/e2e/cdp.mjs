// Tiny Chrome DevTools Protocol driver for end-to-end tests: a static file server for docs/, a headless
// Chrome with a throwaway profile, and a page session. No npm packages; Node 22+ (global WebSocket).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, extname } from 'node:path';

const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.cjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.zip': 'application/zip', '.ts': 'text/plain', '.md': 'text/markdown', '.txt': 'text/plain' };

export function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(p => p && existsSync(p)) || null;
}

// Serves docs/ like GitHub Pages (no custom headers). Records every request so tests can prove that
// nothing left the sandbox. /__tampered/pyodide/<file> serves a deliberately corrupted runtime file.
export function startServer(root) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: url.pathname + url.search, time: Date.now() });
    let path = decodeURIComponent(url.pathname);
    let tamper = false;
    if (path.startsWith('/__tampered/pyodide/')) { path = path.replace('/__tampered/pyodide/', '/vendor/pyodide/'); tamper = path.endsWith('pyodide.asm.js'); }
    const file = normalize(join(root, path.endsWith('/') ? path + 'index.html' : path));
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    let body = readFileSync(file);
    if (tamper) { body = Buffer.from(body); body[body.length - 2] ^= 0x01; }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) })));
}

export async function launchChrome(chromePath) {
  const profile = mkdtempSync(join(tmpdir(), 'codeproof-chrome-'));
  // CI runners on recent Ubuntu restrict the user namespaces Chrome's OS sandbox needs; the web-platform
  // isolation these tests verify (origins, CSP, iframe sandboxing) does not depend on that OS sandbox.
  const extra = process.env.CODEPROOF_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : [];
  const proc = spawn(chromePath, [...extra, '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--mute-audio', '--window-size=1366,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chrome did not start within 20 s')), 20000);
    proc.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
    proc.on('exit', code => reject(new Error(`Chrome exited early (${code}): ${buf.slice(-500)}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map(), listeners = new Set();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(`${msg.error.message} ${msg.error.data || ''}`)) : p.resolve(msg.result); }
    else for (const fn of listeners) fn(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const close = async () => { try { await send('Browser.close'); } catch { /* already closed */ } ws.close(); proc.kill('SIGKILL'); try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ } };
  return { send, listeners, close, version: await send('Browser.getVersion') };
}

export async function openPage(browser, url, { width = 1366, height = 900, mobile = false } = {}) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  const events = { console: [], exceptions: [], log: [], requests: [], failed: [] };
  browser.listeners.add(msg => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') events.console.push({ type: msg.params.type, text: msg.params.args.map(a => a.value ?? a.description).join(' ') });
    if (msg.method === 'Runtime.exceptionThrown') events.exceptions.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
    if (msg.method === 'Log.entryAdded') events.log.push(msg.params.entry);
    if (msg.method === 'Network.requestWillBeSent') events.requests.push(msg.params.request.url);
    if (msg.method === 'Network.loadingFailed') events.failed.push(msg.params);
  });
  await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  // Capture CSP violations from the page itself (they are not always surfaced as console messages).
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__cspViolations.push({directive:e.violatedDirective,blocked:e.blockedURI,sample:e.sample}));" });
  const page = {
    sessionId, targetId, send, events,
    async evaluate(expression, { timeout = 120000 } = {}) {
      const r = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }), new Promise((_, rej) => setTimeout(() => rej(new Error(`evaluate timed out after ${timeout} ms`)), timeout))]);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async goto(target) { await send('Page.navigate', { url: target }); await page.waitFor('document.readyState === "complete"', 20000); },
    async waitFor(expression, timeout = 30000, interval = 200) {
      const end = Date.now() + timeout;
      for (;;) {
        let ok = false;
        try { ok = await page.evaluate(`Boolean(${expression})`, { timeout: 5000 }); } catch { ok = false; }
        if (ok) return true;
        if (Date.now() > end) throw new Error(`Timed out waiting for: ${expression}`);
        await new Promise(r => setTimeout(r, interval));
      }
    },
    async setFiles(selector, files) {
      const { root } = await send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`No element for ${selector}`);
      await send('DOM.setFileInputFiles', { nodeId, files });
    },
    close: () => browser.send('Target.closeTarget', { targetId }),
  };
  if (url) await page.goto(url);
  return page;
}
