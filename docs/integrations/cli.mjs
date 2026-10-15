#!/usr/bin/env node
/** Portable static PR audit built on the CodeProof engine. It parses, type-checks and analyzes cross-file
 * integration, but never executes repository code and makes no network requests. Node 22+, no npm install.
 * Layouts: integration kit (.codeproof/cli.mjs + engine/ + typescript.cjs + typescript-lib/) or this
 * repository (docs/integrations/cli.mjs + ../assets/engine + ../vendor). */
import { readdir, readFile, writeFile, lstat, appendFile } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exists = async p => Boolean(await lstat(p).catch(() => null));
const firstExisting = async list => { for (const p of list) if (await exists(p)) return p; return null; };
const engineDir = await firstExisting([join(here, 'engine'), join(here, '../assets/engine')]);
if (!engineDir) { console.error('CodeProof engine modules not found next to cli.mjs.'); process.exit(2); }
const engine = await import(pathToFileURL(join(engineDir, 'index.mjs')).href);
const tsPath = await firstExisting([join(here, 'typescript.cjs'), join(here, '../vendor/typescript.js'), join(here, 'typescript.js')]);
let ts = null, tsError = null;
try { ts = tsPath ? createRequire(import.meta.url)(tsPath) : null; if (!ts) tsError = 'TypeScript compiler not found'; } catch (e) { tsError = e.message; }
const libDir = await firstExisting([join(here, 'typescript-lib'), join(here, '../vendor/typescript-lib')]);

const root = process.cwd();
const defaults = { version: 1, maxFiles: 1000, maxFileBytes: 250000, failOnSeverity: 'critical', failOnParseError: true, ignorePaths: ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor', '__pycache__', '.venv', '.codeproof'] };
let policy = structuredClone(defaults);
try {
  const user = JSON.parse(await readFile(join(root, '.codeproof-policy.json'), 'utf8'));
  if (user.version !== 1 || !Number.isInteger(user.maxFiles) || user.maxFiles <= 0 || user.maxFiles > 5000 || !Number.isInteger(user.maxFileBytes) || user.maxFileBytes < 1000 || user.maxFileBytes > 1_000_000 || !Array.isArray(user.ignorePaths) || !['critical', 'high', 'medium', 'low', 'info', 'off'].includes(user.failOnSeverity)) throw Error('Invalid policy schema');
  policy = { ...policy, ...user };
} catch (e) { if (e.code !== 'ENOENT') { console.error('Policy validation failed:', e.message); process.exit(2); } }

// Walk the checkout without following symlinks; excluded directories are recorded, not read.
const entries = [];
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, item.name), p = relative(root, abs).split('\\').join('/');
    if (item.isSymbolicLink()) { entries.push({ path: p, isSymlink: true, size: 0 }); continue; }
    if (item.isDirectory()) {
      if (policy.ignorePaths.some(v => p === v || p.startsWith(v + '/') || p.split('/').includes(v))) { entries.push({ path: p + '/', isDirectory: true, size: 0 }); continue; }
      await walk(abs);
      continue;
    }
    if (!item.isFile()) continue;
    if (p === 'codeproof-report.json') { entries.push({ path: p, size: 0, rejectReason: 'CodeProof\'s own report output from a previous run; not analyzed.' }); continue; }
    const stats = await lstat(abs);
    entries.push({ path: p, size: stats.size, read: () => readFile(abs) });
  }
}
await walk(root);
entries.sort((a, b) => a.path.localeCompare(b.path));
const project = await engine.ingestEntries(entries, { policy, source: 'repository checkout' });
const scan = await engine.scanProject({ ...project, name: engine.projectNameFrom(project.files, relative(dirname(root), root) || 'repository') }, {
  ts, policy, runtimeOptions: { enableJs: false, enablePython: false },
  loadTsLibs: libDir ? names => engine.loadLibClosure(names, n => readFile(join(libDir, n), 'utf8').catch(() => null)) : null,
});
if (tsError) scan.diagnostics.push({ stage: 'TypeScript compiler', scope: 'project', origin: 'environment', message: tsError, alternatives: 'Parsing and integration checks ran.', action: 'Restore the compiler asset.' });

const SEV = ['critical', 'high', 'medium', 'low', 'info'];
const threshold = SEV.indexOf(policy.failOnSeverity);
const blocking = scan.findings.filter(f => (policy.failOnParseError && f.category === 'syntax' && ['confirmed-static', 'high-confidence'].includes(f.verification)) || (threshold !== -1 && SEV.indexOf(f.severity) <= threshold && f.verification !== 'quality'));
const skipped = scan.coverage.files.skipped + scan.coverage.files.failedIngestion;
const payload = {
  schema: 'codeproof.pr-audit.v2', version: engine.ENGINE_VERSION, time: new Date().toISOString(), policy,
  summary: { files: project.files.length, findings: scan.findings.length, blocking: blocking.length, skipped, defects: scan.coverage.findings.defects, verdict: scan.coverage.verdict.state },
  verdict: scan.coverage.verdict,
  coverage: scan.coverage.ratios,
  analyzers: scan.analyzerRuns.map(a => ({ id: a.id, status: a.status, files: a.files, detail: a.detail })),
  diagnostics: scan.diagnostics,
  findings: scan.findings.map(({ dedupeKey, tags, priority, ...f }) => ({ ...f, blocking: blocking.includes(f) })),
  execution: 'not performed (static PR audit only; repository code is never executed in CI by CodeProof)',
  authorship: 'not evaluated (secondary feature available in the web app)',
  limitations: scan.limitations,
};
await writeFile(join(root, 'codeproof-report.json'), JSON.stringify(payload, null, 2), 'utf8');
console.log(`CodeProof: ${project.files.length} files, ${scan.findings.length} findings, ${blocking.length} policy-blocking, ${skipped} skipped.`);
console.log(`Verdict: ${scan.coverage.verdict.message}`);
const clean = s => String(s).replace(/[\r\n]/g, ' ');
for (const f of scan.findings.slice(0, 200)) {
  const file = String(f.file || '').replace(/[\r\n,:]/g, '_');
  const message = clean(`${f.rule}: ${f.title} [${f.verification}] — ${f.remediation || f.rootCause}`).slice(0, 500);
  console.log(`::${blocking.includes(f) ? 'error' : 'warning'} ${file ? `file=${file},line=${f.line || 1},` : ''}title=CodeProof ${f.severity}::${message}`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## CodeProof static PR audit\n\n${scan.coverage.verdict.message}\n\n| Measure | Covered |\n|---|---|\n${scan.coverage.ratios.map(r => `| ${r.label} | ${r.numerator}/${r.denominator} |`).join('\n')}\n\n- Files: ${project.files.length} (skipped ${skipped})\n- Findings: ${scan.findings.length}\n- Blocking: ${blocking.length}\n- Repository code executed: **No**\n\nDetailed JSON is in the workflow artifact.\n`);
}
if (blocking.length) process.exitCode = 1;
