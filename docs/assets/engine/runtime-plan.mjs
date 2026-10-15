// Plans in-browser runtime work (test files, module load checks, generated probes) from a static scan,
// and turns raw sandbox outcomes into findings without inventing expectations.
import { generateCases } from './testgen.mjs';
import { isTestPath } from './detect.mjs';
import { basename } from './paths.mjs';

export const RUNTIME_LIMITS = Object.freeze({ maxTestFiles: 60, maxProbeFunctions: 40, maxCasesPerFunction: 8, maxLoadModules: 120, testFileDeadlineMs: 8000, perTestTimeoutMs: 2000, probeDeadlineMs: 5000, loadDeadlineMs: 4000, pythonJobDeadlineMs: 15000, totalBudgetMs: 150000 });

const JS_TEST_SHIMS = new Set(['vitest', '@jest/globals', 'node:test', 'test', 'assert', 'node:assert', 'assert/strict', 'node:assert/strict']);
const UNSUPPORTED_TEST_FRAMEWORKS = new Set(['ava', 'tap', 'uvu', 'tape', 'jasmine', 'qunit', '@playwright/test', 'cypress', 'puppeteer', 'karma', '@testing-library/react', '@testing-library/vue', 'enzyme', 'supertest']);
const SKIP_PROBE_NAMES = /^(?:main|run|start|init|setup|bootstrap|serve|listen|handler|middleware|app|default|render|mount|connect|cli|exit|shutdown)$/i;
const JS_ENV_GLOBALS = /^(?:document|window|localStorage|sessionStorage|location|alert|confirm|prompt|process|Buffer|__dirname|__filename|global|require|module|exports|jest|React|ReactDOM|HTMLElement|Element|Node|customElements|getComputedStyle|requestAnimationFrame|cancelAnimationFrame|matchMedia|XMLHttpRequest|fetch|WebSocket|EventSource|Worker|indexedDB|caches|Image|Audio|FileReader|MutationObserver|IntersectionObserver|ResizeObserver|DOMParser|chrome|browser|Deno|Bun|setImmediate|structuredClone)$/;

export function jsEnvironmentReason(error) {
  if (!error) return null;
  if (error.code === 'CODEPROOF_UNAVAILABLE_MODULE') return `Requires "${error.specifier}", which is not available in the browser sandbox (npm packages and Node.js built-ins are not installed).`;
  const m = /^(\w+) is not defined$/.exec(error.message || '');
  if (error.name === 'ReferenceError' && m && JS_ENV_GLOBALS.test(m[1])) return `Uses "${m[1]}", which the sandbox does not provide (no DOM, Node.js APIs or network).`;
  if (/Network (?:access )?(?:blocked|disabled)|is not a function/.test(error.message || '') && /\b(?:fetch|XMLHttpRequest|WebSocket|importScripts)\b/.test(error.message || '')) return 'Attempted network access, which the sandbox blocks.';
  if (/Content Security Policy|Refused to (?:connect|load)/i.test(error.message || '')) return 'Blocked by the sandbox Content Security Policy (network or resource access).';
  return null;
}

export function pythonEnvironmentReason(error, localModules = new Set()) {
  if (!error) return null;
  const mod = /^No module named '([^'.]+)/.exec(error.message || '')?.[1];
  if (error.name === 'ModuleNotFoundError' && mod && !localModules.has(mod)) return `Requires the third-party module "${mod}", which is not installed in the Pyodide sandbox.`;
  if (error.name === 'EOFError') return 'Reads interactive input (stdin is not available).';
  if (error.name === 'CodeProofBlocked') return error.message;
  if (/OSError|ConnectionError|socket|urlopen|Errno 23|Errno 138/.test(`${error.name} ${error.message}`) && /socket|connect|network|urlopen|getaddrinfo|Errno 23|Errno 138/i.test(error.message || '')) return 'Attempted network access, which the sandbox does not provide.';
  if (error.name === 'FileNotFoundError') return `Reads a file that is not available in the sandbox file system (${(error.message || '').slice(0, 120)}).`;
  return null;
}

function jsTestFramework(file, perFile, packages) {
  const imports = perFile.get(file.path)?.imports || [];
  const external = imports.map(i => i.specifier).filter(s => s && !s.startsWith('.') && !s.startsWith('/'));
  const unsupported = external.find(s => UNSUPPORTED_TEST_FRAMEWORKS.has(s.split('/').slice(0, s.startsWith('@') ? 2 : 1).join('/')));
  if (unsupported) return { supported: false, reason: `Uses the ${unsupported} test framework, which the CodeProof harness does not emulate.` };
  if (external.includes('vitest')) return { supported: true, framework: 'vitest' };
  if (external.includes('@jest/globals')) return { supported: true, framework: 'jest' };
  if (external.includes('node:test') || external.includes('test')) return { supported: true, framework: 'node:test' };
  if (external.includes('mocha') || external.includes('chai')) return { supported: false, reason: 'Uses mocha/chai imports; only Jest/Vitest-style expect, node:test and node:assert are emulated.' };
  if (/\b(?:describe|it|test)\s*\(/.test(file.content)) {
    const script = packages.map(p => p.json?.scripts?.test || '').join(' ');
    return { supported: true, framework: /vitest/.test(script) ? 'vitest' : /mocha/.test(script) ? 'mocha-globals' : 'jest-globals' };
  }
  return { supported: false, reason: 'No describe/it/test calls or supported test-framework import found.' };
}

export function planRuntime(scan, { enableJs = true, enablePython = false, limits = RUNTIME_LIMITS, seed = 'codeproof' } = {}) {
  const { files, perFile, graph } = scan;
  const jobs = [], blocked = [];
  const runnableJs = files.filter(f => (f.language === 'javascript' || f.language === 'typescript') && f.kind !== 'generated' && !f.path.endsWith('.d.ts') && perFile.get(f.path)?.parse?.ok);
  const externalOf = path => (graph?.edges || []).filter(e => e.from === path && e.status === 'external').map(e => e.package);
  const plan = { jsTestFiles: 0, pyTestFiles: 0, testFilesBlocked: 0, functionsEligible: 0, functionsPlanned: 0, modulesEligible: 0, modulesPlanned: 0 };
  if (enableJs) {
    const packages = (graph?.packages || []).map(p => ({ json: files.find(f => f.path === p.path) ? safeJson(files.find(f => f.path === p.path).content) : null }));
    const testFiles = runnableJs.filter(f => f.kind === 'test' || isTestPath(f.path));
    for (const f of testFiles.slice(0, limits.maxTestFiles)) {
      const fw = jsTestFramework(f, perFile, packages);
      const missing = externalOf(f.path).filter(p => !JS_TEST_SHIMS.has(p));
      if (!fw.supported) { blocked.push({ engine: 'js', type: 'tests', path: f.path, reason: fw.reason }); plan.testFilesBlocked++; continue; }
      if (missing.length) { blocked.push({ engine: 'js', type: 'tests', path: f.path, reason: `Imports ${missing.slice(0, 3).join(', ')}, which cannot be installed in the browser sandbox.` }); plan.testFilesBlocked++; continue; }
      jobs.push({ id: `js-tests:${f.path}`, engine: 'js', type: 'tests', entry: f.path, framework: fw.framework, perTestTimeoutMs: limits.perTestTimeoutMs, deadlineMs: limits.testFileDeadlineMs });
      plan.jsTestFiles++;
    }
    for (const f of testFiles.slice(limits.maxTestFiles)) blocked.push({ engine: 'js', type: 'tests', path: f.path, reason: `Test-file limit of ${limits.maxTestFiles} reached.` });
    const loadable = runnableJs.filter(f => f.kind !== 'test' && !isTestPath(f.path) && f.kind !== 'config' && !/\.config\.[cm]?[jt]s$/.test(f.path));
    plan.modulesEligible = loadable.length;
    const loadList = loadable.slice(0, limits.maxLoadModules).map(f => f.path);
    for (let i = 0; i < loadList.length; i += 20) jobs.push({ id: `js-load:${i}`, engine: 'js', type: 'load', entries: loadList.slice(i, i + 20), deadlineMs: limits.loadDeadlineMs });
    plan.modulesPlanned = loadList.length;
  }
  const pyFiles = files.filter(f => f.language === 'python' && f.kind !== 'generated');
  if (enablePython && pyFiles.length) {
    jobs.push({ id: 'py-compile', engine: 'python', type: 'compile', paths: pyFiles.map(f => f.path), deadlineMs: limits.pythonJobDeadlineMs });
    const moduleNames = graph?.moduleNames || {};
    for (const f of pyFiles.filter(f => /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/.test(f.path)).slice(0, limits.maxTestFiles)) {
      jobs.push({ id: `py-tests:${f.path}`, engine: 'python', type: 'tests', path: f.path, module: moduleNames[f.path], deadlineMs: limits.pythonJobDeadlineMs });
      plan.pyTestFiles++;
    }
    const pyLoad = pyFiles.filter(f => !isTestPath(f.path) && basename(f.path) !== 'conftest.py' && basename(f.path) !== 'setup.py' && !/(?:^|\/)(?:manage|wsgi|asgi)\.py$/.test(f.path)).slice(0, limits.maxLoadModules);
    if (pyLoad.length) jobs.push({ id: 'py-load', engine: 'python', type: 'load', modules: pyLoad.map(f => ({ path: f.path, module: moduleNames[f.path] })), deadlineMs: limits.pythonJobDeadlineMs });
    plan.modulesEligible += pyLoad.length; plan.modulesPlanned += pyLoad.length;
  } else if (pyFiles.length) blocked.push({ engine: 'python', type: 'all', path: null, reason: 'Python runtime checks were not enabled for this scan.' });
  // Generated probes for top-level functions.
  const candidates = [];
  for (const f of files) {
    const isJs = (f.language === 'javascript' || f.language === 'typescript') && runnableJs.includes(f);
    const isPy = f.language === 'python' && enablePython && perFile.get(f.path)?.parse?.ok;
    if ((!isJs || !enableJs) && !isPy) continue;
    if (f.kind === 'test' || isTestPath(f.path) || f.kind === 'config') continue;
    const jsx = /\.[jt]sx$/.test(f.path);
    for (const fn of perFile.get(f.path)?.functions || []) {
      if (!fn.topLevel || !fn.name || fn.name === 'default' || SKIP_PROBE_NAMES.test(fn.name) || fn.generator || (fn.paramInfo || []).length > 5) continue;
      if (jsx && /^[A-Z]/.test(fn.name)) continue;
      if (isPy && (fn.name.startsWith('_') || (fn.decorators || []).length)) continue;
      if (isJs && (fn.paramInfo || []).some(p => p.destructured)) continue;
      candidates.push({ file: f, fn, engine: isJs ? 'js' : 'python' });
    }
  }
  plan.functionsEligible = candidates.length;
  for (const { file, fn, engine } of candidates.slice(0, limits.maxProbeFunctions)) {
    const missing = engine === 'js' ? externalOf(file.path).filter(p => !JS_TEST_SHIMS.has(p)) : [];
    if (missing.length) { blocked.push({ engine, type: 'probe', path: file.path, name: fn.name, reason: `Module imports ${missing.slice(0, 3).join(', ')}, unavailable in the sandbox.` }); continue; }
    const gen = generateCases(fn, { seed, maxCases: limits.maxCasesPerFunction, language: engine === 'js' ? 'javascript' : 'python' });
    if (gen.skipReason) { blocked.push({ engine, type: 'probe', path: file.path, name: fn.name, reason: gen.skipReason }); continue; }
    jobs.push({ id: `${engine}-probe:${file.path}:${fn.name}`, engine, type: 'call', entry: file.path, module: graph?.moduleNames?.[file.path], functionName: fn.name, exportName: fn.exportName || null, exposeLocal: !fn.exported, cases: gen.cases, contract: gen.contract, parameters: gen.parameters, seed: gen.seed, fnLine: fn.line, deadlineMs: limits.probeDeadlineMs });
    plan.functionsPlanned++;
  }
  return { jobs, blocked, plan, limits };
}

function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }

const ENGINE_ERRORS_JS = new Set(['TypeError', 'RangeError', 'ReferenceError', 'InternalError', 'SyntaxError', 'URIError']);
const ENGINE_ERRORS_PY = new Set(['TypeError', 'AttributeError', 'IndexError', 'KeyError', 'ZeroDivisionError', 'RecursionError', 'UnboundLocalError', 'NameError', 'OverflowError', 'ModuleNotFoundError', 'ImportError', 'StopIteration']);
const ALWAYS_DEFECT = new Set(['ReferenceError', 'NameError', 'UnboundLocalError', 'ImportError']);
const fmtArgs = args => args.map(a => (a === undefined ? 'undefined' : JSON.stringify(a)?.slice(0, 80) ?? String(a))).join(', ');

// Converts raw runtime outcomes into registry findings and runtime summaries.
export function interpretRuntime(results, { localPythonModules = new Set() } = {}) {
  const findings = [], tests = [], probes = [], loads = [], blocked = [], observations = [], compile = { total: 0, compiled: 0, failed: 0 };
  let timeouts = 0;
  for (const r of results) {
    if (r.status === 'timeout') timeouts++;
    // A sandbox that could not start or crashed is a visible capability failure, never an empty result.
    if (r.status === 'error' && !(r.tests?.length || r.modules?.length || r.files?.length || r.cases?.some(c => c.ok !== undefined))) {
      blocked.push({ engine: r.engine, type: r.type, path: r.path || r.job?.entry || null, name: r.job?.functionName, reason: `Sandbox error: ${r.error || 'the execution environment failed'}. This check did not run.`, sandboxFailure: true });
      continue;
    }
    const envReason = e => (r.engine === 'python' ? pythonEnvironmentReason(e, localPythonModules) : jsEnvironmentReason(e));
    if (r.type === 'tests') {
      if (r.registrationError) {
        const reason = envReason(r.registrationError);
        if (reason) { blocked.push({ engine: r.engine, type: 'tests', path: r.path, reason }); continue; }
        findings.push({ rule: 'RUNTIME_TEST_FILE_ERROR', title: `Test file fails before any test runs`, category: 'test', severity: 'high', verification: 'confirmed-runtime', file: r.path, line: r.registrationError.line || 1, column: 1, rootCause: `${r.registrationError.name}: ${r.registrationError.message}`, trigger: `Load ${r.path} in the ${r.engine === 'python' ? 'Pyodide' : 'JavaScript'} sandbox.`, reproduction: [`Run the ${r.engine === 'python' ? 'Python' : 'JavaScript'} runtime checks for ${r.path}.`], actual: r.registrationError.message, suggestion: 'Fix the error raised while importing the test file or the modules it imports.', analyzer: 'sandbox-test-runner', evidence: r.registrationError.stack ? [r.registrationError.stack] : [] });
      }
      if (r.status === 'timeout') blocked.push({ engine: r.engine, type: 'tests', path: r.path, reason: `Exceeded the ${r.deadlineMs} ms time limit${r.lastStarted ? ` while running "${r.lastStarted}"` : ''}; remaining tests did not run.` });
      for (const t of r.tests || []) {
        const reason = t.status === 'failed' ? envReason(t.error) : null;
        const status = reason ? 'blocked' : t.status;
        tests.push({ engine: r.engine, path: r.path, name: t.name, status, durationMs: t.durationMs, error: t.error ? `${t.error.name}: ${t.error.message}` : null, blockedReason: reason });
        if (status === 'failed') findings.push({ rule: 'RUNTIME_TEST_FAILED', title: `Test fails: ${t.name}`.slice(0, 180), category: 'test', severity: 'high', verification: 'confirmed-runtime', file: r.path, line: (t.error?.file === r.path && t.error.line) || t.line || 1, affected: t.error?.file && t.error.file !== r.path ? [r.path, t.error.file] : [r.path], column: 1, rootCause: `${t.error?.name || 'Error'}: ${t.error?.message || 'failed'}`, trigger: `Run "${t.name}".`, reproduction: [`Run ${r.path} with CodeProof's ${r.engine === 'python' ? 'Python' : 'JavaScript'} test harness.`, `Test: ${t.name}`], actual: t.error?.actual !== undefined ? t.error.actual : t.error?.message, expected: t.error?.expected, suggestion: 'Determine whether the implementation or the test expectation is wrong; the test encodes the expected contract.', analyzer: 'sandbox-test-runner', evidence: t.error?.stack ? [t.error.stack] : [] });
      }
    } else if (r.type === 'load') {
      for (const m of r.modules || []) {
        const reason = m.ok ? null : envReason(m.error);
        loads.push({ engine: r.engine, path: m.path, ok: m.ok, blockedReason: reason, error: m.error ? `${m.error.name}: ${m.error.message}` : null });
        if (!m.ok && !reason && m.error) findings.push({ rule: 'RUNTIME_MODULE_LOAD', title: `Module throws while loading: ${m.error.name}`, category: 'runtime', severity: 'high', verification: 'confirmed-runtime', confidence: 'medium', file: m.error.file || m.path, line: m.error.line || 1, affected: [...new Set([m.path, m.error.file].filter(Boolean))], column: 1, rootCause: `${m.error.name}: ${m.error.message}`, trigger: `Import ${m.path}.`, reproduction: [`Import ${m.path} (and its local dependencies) in a fresh JavaScript/Python environment without network access.`], actual: `${m.error.name}: ${m.error.message}`, suggestion: 'Fix the top-level code that throws; if it depends on host APIs, guard that access.', analyzer: 'sandbox-module-loader', evidence: m.error.stack ? [m.error.stack] : [] });
        if (reason) blocked.push({ engine: r.engine, type: 'load', path: m.path, reason });
      }
      if (r.status === 'timeout') blocked.push({ engine: r.engine, type: 'load', path: r.lastStarted, reason: `Module loading exceeded ${r.deadlineMs} ms.` });
    } else if (r.type === 'compile') {
      for (const c of r.files || []) {
        compile.total++;
        if (c.ok) compile.compiled++;
        else {
          compile.failed++;
          findings.push({ rule: 'PY_COMPILE', title: `CPython ${c.type || 'SyntaxError'}`, category: 'syntax', severity: 'high', verification: 'confirmed-static', file: c.path, line: c.line || 1, column: c.col || 1, rootCause: `${c.type || 'SyntaxError'}: ${c.message} (CPython 3.13 compile() in Pyodide).`, suggestion: 'Fix the syntax error; the module cannot be imported.', analyzer: 'cpython-compile', dedupeKey: 'syntax' });
        }
      }
    } else if (r.type === 'call') {
      const job = r.job;
      if (r.loadError) { const reason = envReason(r.loadError); blocked.push({ engine: r.engine, type: 'probe', path: job.entry, name: job.functionName, reason: reason || `Module could not be loaded (${r.loadError.name}: ${r.loadError.message}); see the module load results.` }); continue; }
      const grouped = new Map();
      let exercised = false;
      for (const c of r.cases || []) {
        const kase = job.cases.find(x => x.id === c.id) || { args: [] };
        if (c.status === 'not-run') continue;
        exercised = true;
        const outcome = { args: kase.args, rationale: kase.rationale, ok: c.ok, value: c.value, error: c.error, durationMs: c.durationMs, status: c.status };
        probes.push({ engine: r.engine, path: job.entry, name: job.functionName, ...outcome });
        if (c.status === 'timeout') { grouped.set('timeout', { kind: 'timeout', c, kase }); continue; }
        if (c.ok) {
          const tag = c.value && typeof c.value === 'object' ? c.value.__cp : null;
          const finiteNumbers = kase.args.every(a => typeof a !== 'number' || Number.isFinite(a));
          if ((tag === 'NaN' || c.value === 'nan') && finiteNumbers && job.parameters.some(p => /number|int|\[\]/.test(p.type))) if (!grouped.has('nan')) grouped.set('nan', { kind: 'nan', c, kase });
          continue;
        }
        const reason = envReason(c.error);
        if (reason) { blocked.push({ engine: r.engine, type: 'probe', path: job.entry, name: job.functionName, reason }); break; }
        const engineError = (r.engine === 'python' ? ENGINE_ERRORS_PY : ENGINE_ERRORS_JS).has(c.error?.name);
        if (!engineError || c.error?.explicit) continue; // deliberate rejection of an input is not a defect
        const always = ALWAYS_DEFECT.has(c.error.name) || /\b\w+_\d+\.\w+\)? is not a function/.test(c.error.message || '');
        const representative = kase.rationale?.startsWith('Representative');
        // Crashes on inputs outside a declared contract are recorded as observations, not findings.
        if (!always && job.contract !== 'declared' && !(job.contract === 'inferred' && representative)) { observations.push({ path: job.entry, name: job.functionName, args: kase.args, error: `${c.error.name}: ${c.error.message}` }); continue; }
        const key = `${c.error.name}`;
        if (!grouped.has(key)) grouped.set(key, { kind: 'error', c, kase, count: 1, always }); else grouped.get(key).count++;
      }
      if (exercised) job.exercised = true;
      for (const g of grouped.values()) {
        const call = `${job.functionName}(${fmtArgs(g.kase.args)})`;
        const base = { file: job.entry, line: job.fnLine || 1, column: 1, analyzer: 'generated-input-probe', trigger: call, reproduction: [`Load ${job.entry} in the sandbox.`, `Call ${call}.`, `Inputs generated deterministically from seed "${job.seed}" (${g.kase.rationale}).`] };
        if (g.kind === 'timeout') { findings.push({ ...base, rule: 'RUNTIME_PROBE_TIMEOUT', title: `${job.functionName} did not finish within ${job.deadlineMs} ms`, category: 'performance', severity: 'medium', verification: 'potential', rootCause: `The call ${call} exceeded the sandbox time limit; this may be an infinite loop or very slow path for this input.`, actual: 'No result before the deadline; the worker was terminated.', suggestion: 'Check loop termination conditions for this input.' }); continue; }
        if (g.kind === 'nan') { findings.push({ ...base, rule: 'RUNTIME_NAN_RESULT', title: `${job.functionName} returns NaN for finite inputs`, category: 'logic', severity: 'medium', verification: 'potential', confidence: 'medium', rootCause: `${call} returned NaN although every numeric input was finite. NaN usually comes from 0/0, arithmetic on undefined, or averaging an empty collection.`, actual: 'NaN', suggestion: 'Handle the boundary (for example an empty input or zero divisor) explicitly, or document that NaN is intended.' }); continue; }
        const always = g.always;
        const declared = job.contract === 'declared';
        findings.push({ ...base, rule: 'RUNTIME_PROBE_CRASH', title: `${job.functionName} throws ${g.c.error.name} for ${always ? 'a generated input' : declared ? 'a type-valid input' : 'representative inputs'}`, category: 'runtime', severity: always ? 'high' : 'medium', verification: always || declared ? 'confirmed-runtime' : 'potential', confidence: always || declared ? 'high' : 'low', rootCause: `${g.c.error.name}: ${g.c.error.message}${always ? ' — this error does not depend on whether the input is valid.' : declared ? ' — the input matches the declared parameter types.' : ' — the parameter types were inferred from names or defaults, not declared, so confirm the intended contract.'}${g.count > 1 ? ` (${g.count} generated inputs raised the same error type.)` : ''}`, actual: `${g.c.error.name}: ${g.c.error.message}`, suggestion: always ? 'The code path references a name or import that does not exist at run time; fix it.' : 'Validate the input and raise a descriptive error, or handle the boundary case.', evidence: g.c.error.stack ? [g.c.error.stack] : [] });
      }
    }
  }
  return { findings, tests, probes, loads, blocked, observations, compile, timeouts };
}
