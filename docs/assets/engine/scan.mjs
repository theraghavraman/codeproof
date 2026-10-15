// Scan orchestration: per-file analyzers (isolated so one failure never aborts the scan), whole-program
// type checking, project integration analysis, findings normalization, coverage and the secondary
// authorship estimate. Runtime results from the browser sandbox are merged in with finalizeWithRuntime().
import { analyzeJsFile } from './js-rules.mjs';
import { analyzePythonFile } from './python.mjs';
import { analyzeGenericFile } from './generic.mjs';
import { analyzeConfigFile } from './config.mjs';
import { runTypeScriptProgram, libFileNamesFor, DEFAULT_LIBS } from './ts-program.mjs';
import { analyzeIntegration, buildProjectIndex, resolveJsSpecifier } from './graph.mjs';
import { FindingRegistry, makeFinding } from './findings.mjs';
import { computeCoverage } from './coverage.mjs';
import { capabilityMatrix } from './capabilities.mjs';
import { estimateProjectAuthorship } from './authorship.mjs';
import { planRuntime, interpretRuntime } from './runtime-plan.mjs';
import { SOURCE_LANGUAGES, languageLabel } from './detect.mjs';
import { basename } from './paths.mjs';
import { sha256Hex, throwIfAborted, nowMs } from './util.mjs';

export const SCAN_SCHEMA = 'codeproof.scan.v2';
export const ENGINE_VERSION = '2.0.0';

const GENERIC_LANGS = new Set(['go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'php', 'ruby', 'shell', 'sql']);
export const FILE_ANALYZERS = [
  { id: 'js-ast', label: 'JavaScript/TypeScript parser and AST rules', applies: f => f.language === 'javascript' || f.language === 'typescript', run: (f, ctx) => analyzeJsFile(f, { ts: ctx.ts }) },
  { id: 'python-tokenizer', label: 'Python tokenizer, structure and rules', applies: f => f.language === 'python', run: f => analyzePythonFile(f) },
  { id: 'native-scanner', label: 'Native-language delimiter scanner and pattern rules', applies: f => GENERIC_LANGS.has(f.language), run: f => analyzeGenericFile(f) },
  { id: 'config', label: 'Manifest, JSON and configuration rules', applies: f => !SOURCE_LANGUAGES.has(f.language), run: f => analyzeConfigFile(f) },
];

const cache = new Map();
export function clearAnalysisCache() { cache.clear(); }

export async function scanProject(input, options = {}) {
  const t0 = nowMs();
  const { ts = null, signal, onProgress = () => {}, analyzers = FILE_ANALYZERS, loadTsLibs = null, tsLibs = null, runtimeOptions = {} } = options;
  const files = input.files.filter(f => f.kind !== 'generated');
  const generated = input.files.filter(f => f.kind === 'generated');
  const manifest = input.manifest.map(m => (generated.some(g => g.path === m.path) ? { ...m, status: 'skipped', reason: m.reason || 'Minified, vendored or build-output code; excluded from defect analysis.' } : m));
  const diagnostics = [], analyzerRuns = [], perFile = new Map(), fileStatus = new Map();
  const registry = new FindingRegistry();
  const progress = (phase, label, done, total) => onProgress({ phase, label, done, total });

  // Phase 1: fingerprints.
  progress('prepare', 'Fingerprinting files', 0, files.length);
  const hashes = new Map();
  try { for (const f of files) hashes.set(f.path, await sha256Hex(f.content)); }
  catch (error) { diagnostics.push({ stage: 'fingerprint', scope: 'project', file: null, origin: 'environment', message: `SHA-256 unavailable: ${error.message}. File fingerprints are omitted (crypto.subtle requires HTTPS or localhost).`, alternatives: 'All analyzers still ran.', action: 'Serve CodeProof over HTTPS or from localhost.' }); }

  // Phase 2: per-file analyzers, each isolated.
  const runStats = new Map(analyzers.map(a => [a.id, { id: a.id, label: a.label, status: 'completed', files: 0, failures: [], durationMs: 0, scope: 'file' }]));
  let done = 0;
  for (const f of files) {
    throwIfAborted(signal);
    const result = { findings: [], parse: null };
    const applicable = analyzers.filter(a => a.applies(f));
    const failed = [];
    for (const a of applicable) {
      const stat = runStats.get(a.id);
      const key = `${a.id}|${hashes.get(f.path) || f.content.length + ':' + f.content.slice(0, 64)}|${f.path}|${Boolean(ts)}`;
      const started = nowMs();
      try {
        let r = cache.get(key);
        if (!r) { r = a.run(f, { ts }); cache.set(key, r); if (cache.size > 4000) cache.delete(cache.keys().next().value); }
        Object.assign(result, { ...r, findings: [...result.findings, ...(r.findings || [])], parse: r.parse || result.parse });
        stat.files++;
      } catch (error) {
        failed.push(a.id);
        stat.failures.push({ file: f.path, error: String(error?.message || error) });
        diagnostics.push({ stage: a.label, scope: 'file', file: f.path, origin: 'codeproof', message: `Analyzer crashed: ${error?.message || error}`, alternatives: 'Other analyzers, secret scanning and project-level checks continued.', action: 'Report this file shape to CodeProof maintainers; review the file manually meanwhile.' });
      } finally { stat.durationMs += nowMs() - started; }
    }
    for (const finding of result.findings) registry.add(finding);
    perFile.set(f.path, result);
    fileStatus.set(f.path, statusFor(f, result, failed, applicable));
    if (++done % 20 === 0 || done === files.length) progress('files', `Analyzed ${done} of ${files.length} files`, done, files.length);
  }
  for (const stat of runStats.values()) {
    if (!stat.files && !stat.failures.length) stat.status = 'not-applicable';
    else if (stat.failures.length) stat.status = stat.files ? 'partial' : 'failed';
    analyzerRuns.push(stat);
  }

  // Phase 3: whole-program TypeScript checking.
  const jsTs = files.filter(f => f.language === 'javascript' || f.language === 'typescript');
  let typecheck = null;
  if (jsTs.length) {
    throwIfAborted(signal);
    progress('typecheck', 'Type-checking JavaScript/TypeScript with the TypeScript compiler', 0, jsTs.length);
    const run = { id: 'typescript-program', label: 'TypeScript 5.8 whole-program type check', status: 'completed', files: 0, failures: [], durationMs: 0, scope: 'project' };
    const started = nowMs();
    if (!ts) {
      run.status = 'blocked'; run.detail = 'TypeScript compiler not loaded.';
      diagnostics.push({ stage: run.label, scope: 'project', file: null, origin: 'environment', message: 'The TypeScript compiler could not be loaded, so no type checking ran.', alternatives: 'Acorn parsing, AST rules and graph checks ran.', action: 'Ensure docs/vendor/typescript.mjs was restored (node scripts/restore-vendor.mjs).' });
    } else {
      try {
        const tsconfig = files.find(f => /^tsconfig\.json$/.test(f.path)) || files.filter(f => basename(f.path) === 'tsconfig.json').sort((a, b) => a.path.length - b.path.length)[0];
        let libs = tsLibs;
        if (!libs && loadTsLibs) libs = await loadTsLibs(tsconfigLibNames(ts, tsconfig) || DEFAULT_LIBS);
        if (!libs?.size) throw Object.assign(new Error('TypeScript standard library declarations are unavailable.'), { origin: 'environment' });
        const index = buildProjectIndex(input.files, manifest);
        const isKnownElsewhere = (from, spec) => { const r = resolveJsSpecifier(index, from, spec); return r.status === 'resolved-unanalyzed' || r.status === 'resolved' || r.status === 'directory'; };
        const r = runTypeScriptProgram(ts, files, { libs, signal, tsconfigPath: tsconfig?.path, existingPaths: new Set(manifest.map(m => m.path)), deadlineMs: options.typecheckDeadlineMs ?? 90000, hostFiles: input.files, isKnownElsewhere });
        typecheck = r.stats;
        run.files = r.stats.filesChecked;
        run.detail = `${r.stats.tsFiles} TS + ${r.stats.jsFiles} JS files; ${r.stats.suppressedJs} low-signal JS diagnostics withheld; ${r.stats.environment} environment-typing diagnostics treated as capability gaps.`;
        if (r.stats.timedOut) { run.status = 'timeout'; diagnostics.push({ stage: run.label, scope: 'project', file: null, origin: 'resource-limit', message: `Type checking stopped at its time limit after ${r.stats.filesChecked} of ${r.stats.files} files.`, alternatives: 'Per-file rules and graph checks completed for every file.', action: 'Scan a smaller subset of the project to type-check the rest.' }); }
        for (const finding of r.findings) registry.add(finding);
        for (const f of jsTs) { const st = fileStatus.get(f.path); if (st) st.typeChecked = r.stats.filesChecked > 0; }
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        run.status = 'failed';
        run.failures.push({ file: null, error: String(error?.message || error) });
        diagnostics.push({ stage: run.label, scope: 'project', file: null, origin: error.origin || 'codeproof', message: String(error?.message || error), alternatives: 'Per-file parsing, AST rules and integration graph checks still ran.', action: error.origin === 'environment' ? 'Restore the pinned TypeScript lib files (node scripts/fetch-pinned-assets.mjs).' : 'Report the failure; results exclude compiler type diagnostics.' });
        for (const f of jsTs) fileStatus.get(f.path)?.blocked.push('TypeScript type checking (failed)');
      }
    }
    run.durationMs = nowMs() - started;
    analyzerRuns.push(run);
  }

  // Phase 4: project integration analysis.
  throwIfAborted(signal);
  progress('integration', 'Analyzing cross-file integration', 0, 1);
  let integration = { findings: [], graph: { nodes: [], edges: [], cycles: [], entryPoints: [], frameworks: [], packages: [], externalPackages: [] }, checks: [] };
  const intRun = { id: 'integration-graph', label: 'Dependency graph and integration checks', status: 'completed', files: files.length, failures: [], durationMs: 0, scope: 'project' };
  const intStart = nowMs();
  try {
    integration = analyzeIntegration({ files, manifest, perFile });
    for (const finding of integration.findings) registry.add(finding);
  } catch (error) {
    intRun.status = 'failed';
    intRun.failures.push({ file: null, error: String(error?.message || error) });
    diagnostics.push({ stage: intRun.label, scope: 'project', file: null, origin: 'codeproof', message: String(error?.message || error), alternatives: 'Per-file analysis and type checking results are unaffected.', action: 'Report the failure; cross-file findings are missing from this scan.' });
  }
  intRun.durationMs = nowMs() - intStart;
  analyzerRuns.push(intRun);

  // Phase 5: ingestion-level observations become findings too (never silent).
  for (const m of manifest) {
    if (m.misleadingExtension) registry.add({ rule: 'INGEST_MISLEADING_EXTENSION', title: 'File content does not match its extension', category: 'security', severity: 'medium', verification: 'security-observation', file: m.path, rootCause: m.reason, suggestion: 'Rename the file or remove it; disguised binaries can hide payloads from reviewers.', analyzer: 'ingestion' });
  }
  for (const list of input.caseCollisions || []) registry.add({ rule: 'INGEST_CASE_COLLISION', title: 'Paths differ only by letter case', category: 'integration', severity: 'medium', verification: 'high-confidence', file: list[0], affected: list, rootCause: `${list.join(' and ')} cannot coexist on case-insensitive file systems (default macOS and Windows); a checkout there silently keeps one of them.`, suggestion: 'Rename one of the files.', analyzer: 'ingestion' });

  // Phase 6: secondary authorship estimate (independent of findings).
  let authorship = null;
  try { authorship = estimateProjectAuthorship(files, manifest); }
  catch (error) { diagnostics.push({ stage: 'Authorship estimate', scope: 'project', file: null, origin: 'codeproof', message: String(error?.message || error), alternatives: 'Defect analysis is unaffected.', action: 'None required.' }); }

  const findings = registry.finalize();
  const languages = summarizeLanguages(files, manifest);
  const runtimePlan = planRuntime({ files, perFile, graph: integration.graph }, runtimeOptions);
  const result = {
    schema: SCAN_SCHEMA, engineVersion: ENGINE_VERSION, generatedAt: new Date().toISOString(),
    project: { name: input.name || 'Untitled project', source: input.source || 'upload', languages, frameworks: integration.graph.frameworks, entryPoints: integration.graph.entryPoints, packages: integration.graph.packages, archive: input.archive || null },
    manifest,
    files: files.map(f => ({ path: f.path, language: f.language, kind: f.kind, size: f.size, lines: f.content.split('\n').length, sha256: hashes.get(f.path) || null, ...publicStatus(fileStatus.get(f.path)) })),
    findings,
    functions: [...perFile.entries()].flatMap(([, r]) => (r.functions || []).map(fn => ({ name: fn.name, file: fn.file, line: fn.line, params: fn.params, topLevel: fn.topLevel, exported: fn.exported, complexity: fn.complexity }))),
    graph: integration.graph,
    integrationChecks: integration.checks,
    analyzerRuns, diagnostics,
    capabilities: capabilityMatrix(languages.map(l => l.language)),
    typecheck,
    authorship,
    runtime: { enabled: false, plan: runtimePlan.plan, blocked: runtimePlan.blocked, results: null },
    limits: input.limits || [],
    timing: { staticMs: Math.round(nowMs() - t0) },
  };
  result.coverage = computeCoverage({ manifest, fileStatus, analyzerRuns, integrationChecks: integration.checks, runtime: null, limits: result.limits, findings, typecheck, cancelled: false });
  result.limitations = baseLimitations(result);
  Object.defineProperty(result, 'internal', { value: { perFile, fileStatus, runtimePlan, files }, enumerable: false });
  progress('done', 'Static analysis complete', 1, 1);
  return result;
}

function tsconfigLibNames(ts, tsconfig) {
  if (!tsconfig) return null;
  try {
    const json = ts.parseConfigFileTextToJson(tsconfig.path, tsconfig.content).config;
    const lib = json?.compilerOptions?.lib;
    return Array.isArray(lib) && lib.length ? libFileNamesFor(ts, { lib }) : null;
  } catch { return null; }
}

function statusFor(file, result, failedAnalyzers, applicable) {
  const source = SOURCE_LANGUAGES.has(file.language);
  const parser = result.parse?.parser || 'none';
  const depth = parser === 'typescript' ? 'compiler' : ['acorn', 'typescript-jsx', 'json-validator'].includes(parser) ? 'parser' : ['python-tokenizer', 'delimiter-scanner', 'requirements-parser', 'toml-subset'].includes(parser) ? 'heuristic' : 'inventory';
  const blocked = [];
  if (file.language === 'python') blocked.push('CPython compile() (Pyodide runtime not run yet)', 'Python type checking (no type checker bundled)');
  if (['go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'php', 'ruby', 'shell'].includes(file.language)) blocked.push(`${languageLabel(file.language)} compiler`, `${languageLabel(file.language)} test execution`);
  if (parser === 'none' && (file.language === 'typescript' || /\.[jt]sx$/.test(file.path))) blocked.push('TypeScript parser (not loaded)');
  let status;
  if (failedAnalyzers.length && failedAnalyzers.length === applicable.length) status = 'failed';
  else if (result.parse && !result.parse.ok && (depth === 'parser' || depth === 'compiler')) status = 'parse-failed';
  else if (result.parse && !result.parse.ok && depth === 'heuristic') status = 'parse-failed';
  else if (failedAnalyzers.length || depth === 'heuristic' || depth === 'inventory' || result.parse?.notes?.some(n => /incomplete|not loaded|requires/.test(n))) status = 'partial';
  else status = 'analyzed';
  return { source, language: file.language, status, depth, parser, parseOk: Boolean(result.parse?.ok), notes: result.parse?.notes || [], blocked, failedAnalyzers, typeChecked: false };
}

const publicStatus = s => (s ? { status: s.status, depth: s.depth, parser: s.parser, notes: s.notes, blocked: s.blocked, failedAnalyzers: s.failedAnalyzers, typeChecked: s.typeChecked } : { status: 'unknown' });

function summarizeLanguages(files, manifest) {
  const map = new Map();
  for (const f of files) {
    if (!f.language) continue;
    const e = map.get(f.language) || { language: f.language, label: languageLabel(f.language), files: 0, lines: 0, skipped: 0 };
    e.files++; e.lines += f.content.split('\n').length;
    map.set(f.language, e);
  }
  for (const m of manifest) if (m.status !== 'ingested' && m.language && map.has(m.language)) map.get(m.language).skipped++;
  return [...map.values()].sort((a, b) => b.lines - a.lines);
}

function baseLimitations(result) {
  const out = [
    'Static rules and type checks find defect classes they model; they cannot prove the absence of other defects.',
    'Security observations identify risky patterns; exploitability depends on data flow that was not proven unless stated.',
    'Runtime checks execute only the tests and generated inputs listed, inside a browser sandbox without Node.js APIs, the DOM, databases or network.',
  ];
  if (result.files.some(f => f.depth === 'heuristic')) out.push('Some languages are checked only by heuristic scanners (no compiler, type checker or test runner in the browser); their results are marked as heuristic.');
  if (result.typecheck?.unresolvedExternal && Object.keys(result.typecheck.unresolvedExternal).length) out.push(`Type information for ${Object.keys(result.typecheck.unresolvedExternal).length} third-party package(s) was unavailable because dependencies are never downloaded; code using them was type-checked as "any".`);
  return out;
}

// Merges runtime outcomes from the sandbox and recomputes findings and coverage.
export function finalizeWithRuntime(scan, runtimeResults, { cancelled = false, enabled = true, blockedExtra = [] } = {}) {
  const internal = scan.internal;
  const localPythonModules = new Set(Object.values(scan.graph?.moduleNames || {}).map(m => String(m).split('.')[0]));
  const interpreted = interpretRuntime(runtimeResults || [], { localPythonModules });
  const registry = new FindingRegistry();
  for (const f of scan.findings) registry.add(f);
  // A module that fails during initialization while it is part of an import cycle confirms the cycle hazard.
  for (const f of interpreted.findings.filter(x => x.rule === 'RUNTIME_MODULE_LOAD' && /before initialization|Cannot read properties of undefined|is not a function|is not a constructor/.test(x.rootCause))) {
    const cycle = (scan.graph?.cycles || []).find(c => c.includes(f.file));
    if (cycle) f.relatedKeys = [`cycle:${cycle.join('|')}`];
  }
  for (const f of interpreted.findings) registry.add(makeFinding(f));
  const findings = registry.finalize();
  for (const f of findings.filter(x => x.rule === 'IMPORT_CYCLE')) {
    const reproduced = findings.find(r => r.rule === 'RUNTIME_MODULE_LOAD' && r.related.includes(f.id));
    if (reproduced) { f.verification = 'confirmed-runtime'; f.verificationLabel = 'Confirmed defect reproduced during execution'; f.severity = 'high'; f.evidence = [...f.evidence, `Reproduced: loading ${reproduced.file} first fails with ${reproduced.rootCause}`]; f.related = [...new Set([...f.related, reproduced.id])]; reproduced.related = [...new Set([...reproduced.related, f.id])]; }
  }
  const plan = internal?.runtimePlan?.plan || scan.runtime.plan;
  const jobs = internal?.runtimePlan?.jobs || [];
  const tests = interpreted.tests;
  const blocked = [...(scan.runtime.blocked || []), ...interpreted.blocked, ...blockedExtra];
  const runtime = {
    enabled,
    testsDiscovered: tests.length,
    testsExecuted: tests.filter(t => t.status === 'passed' || t.status === 'failed').length,
    testsPassed: tests.filter(t => t.status === 'passed').length,
    testsFailed: tests.filter(t => t.status === 'failed').length,
    testsSkipped: tests.filter(t => t.status === 'skipped' || t.status === 'todo').length,
    testsBlocked: blocked.filter(b => b.type === 'tests').length + tests.filter(t => t.status === 'blocked').length,
    testFilesRun: new Set(tests.map(t => t.path)).size,
    testsGenerated: jobs.filter(j => j.type === 'call').reduce((n, j) => n + j.cases.length, 0),
    generatedExecuted: interpreted.probes.length,
    functionsEligible: plan?.functionsEligible || 0,
    functionsProbed: new Set(interpreted.probes.map(p => `${p.path}:${p.name}`)).size,
    modulesEligible: plan?.modulesEligible || 0,
    modulesLoaded: interpreted.loads.filter(l => l.ok).length,
    modulesFailed: interpreted.loads.filter(l => !l.ok && !l.blockedReason).length,
    timeouts: interpreted.timeouts,
    blocked: dedupeBlocked(blocked).map(b => ({ capability: `${b.engine === 'python' ? 'Python' : 'JavaScript'} ${b.type}${b.path ? ` · ${b.path}` : ''}${b.name ? ` · ${b.name}` : ''}`, files: b.path ? 1 : 0, reason: b.reason })),
    cancelled,
  };
  const fileStatus = internal?.fileStatus || new Map();
  if (interpreted.compile.total) {
    for (const r of (runtimeResults || []).filter(x => x.type === 'compile')) for (const c of r.files || []) {
      const st = fileStatus.get(c.path);
      if (!st) continue;
      st.blocked = st.blocked.filter(b => !b.startsWith('CPython compile'));
      st.depth = 'compiler'; st.parser = 'cpython-compile'; st.parseOk = c.ok;
      st.status = c.ok ? (st.failedAnalyzers.length ? 'partial' : 'analyzed') : 'parse-failed';
    }
  }
  const analyzerRuns = [...scan.analyzerRuns.filter(r => r.scope !== 'runtime'), ...runtimeRuns(runtimeResults || [])];
  const coverage = computeCoverage({ manifest: scan.manifest, fileStatus, analyzerRuns, integrationChecks: scan.integrationChecks, runtime, limits: scan.limits, findings, typecheck: scan.typecheck, pythonCompile: interpreted.compile.total ? interpreted.compile : null, cancelled });
  const sandboxFailures = interpreted.blocked.filter(b => b.sandboxFailure);
  const diagnostics = [...scan.diagnostics.filter(d => d.stage !== 'Browser sandbox'), ...(sandboxFailures.length ? [{ stage: 'Browser sandbox', scope: 'project', file: null, origin: 'environment', message: `${sandboxFailures.length} runtime job(s) could not run: ${sandboxFailures[0].reason}`, alternatives: 'All static analysis results are unaffected.', action: 'Use a current Chrome, Edge, Firefox or Safari; embedded browsers or extensions that block sandboxed frames prevent execution.' }] : [])];
  const next = { ...scan, analyzerRuns, diagnostics, findings, coverage, files: scan.files.map(f => ({ ...f, ...publicStatus(fileStatus.get(f.path)) })), runtime: { ...scan.runtime, ...runtime, results: { tests, probes: interpreted.probes.slice(0, 500), observations: interpreted.observations.slice(0, 300), loads: interpreted.loads, compile: interpreted.compile } } };
  Object.defineProperty(next, 'internal', { value: internal, enumerable: false });
  return next;
}

function dedupeBlocked(list) {
  const seen = new Set();
  return list.filter(b => { const k = `${b.engine}|${b.type}|${b.path}|${b.name}|${b.reason}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function runtimeRuns(results) {
  const groups = new Map();
  for (const r of results) {
    const id = `${r.engine}-${r.type}`;
    const label = { 'js-tests': 'JavaScript test harness (sandbox)', 'js-load': 'JavaScript module loader (sandbox)', 'js-call': 'JavaScript generated-input probes (sandbox)', 'python-compile': 'CPython compile() (Pyodide)', 'python-tests': 'Python test collector (Pyodide)', 'python-load': 'Python module import (Pyodide)', 'python-call': 'Python generated-input probes (Pyodide)' }[id] || id;
    const g = groups.get(id) || { id, label, status: 'completed', files: 0, failures: [], durationMs: 0, scope: 'runtime' };
    g.files++;
    g.durationMs += r.durationMs || 0;
    if (r.status === 'timeout') { g.status = g.status === 'completed' ? 'partial' : g.status; g.failures.push({ file: r.path || r.lastStarted || null, error: 'Time limit exceeded' }); }
    if (r.status === 'error') { g.status = 'partial'; g.failures.push({ file: r.path || null, error: r.error || 'Sandbox error' }); }
    groups.set(id, g);
  }
  return [...groups.values()];
}
