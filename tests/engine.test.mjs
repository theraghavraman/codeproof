import test from 'node:test';
import assert from 'node:assert/strict';
import { scanFixture, scanEntries, textEntries, runJsJobsInVm, libsAvailable } from './helpers/scan-helpers.mjs';
import { FILE_ANALYZERS } from '../docs/assets/engine/scan.mjs';
import { FindingRegistry, makeFinding, filterFindings } from '../docs/assets/engine/findings.mjs';
import { jsonError, satisfies } from '../docs/assets/engine/config.mjs';
import { analyzePythonFile } from '../docs/assets/engine/python.mjs';
import { buildReport, reportMarkdown, reportSarif } from '../docs/assets/engine/report.mjs';

const skip = libsAvailable ? false : 'TypeScript lib files not restored (node scripts/fetch-pinned-assets.mjs)';
const rules = scan => new Set(scan.findings.map(f => f.rule));
const find = (scan, rule, file) => scan.findings.find(f => f.rule === rule && (!file || f.file === file));

test('known-good fixture: every file analyzed and type-checked, no defects, verdict still scoped', { skip }, async () => {
  const scan = await runJsJobsInVm(await scanFixture('good-project', { runtime: true }));
  const defects = scan.findings.filter(f => ['confirmed-runtime', 'confirmed-static', 'high-confidence', 'potential'].includes(f.verification));
  assert.deepEqual(defects.map(f => `${f.rule} ${f.file}:${f.line}`), []);
  const ratio = id => scan.coverage.ratios.find(r => r.id === id);
  assert.equal(ratio('file-analysis').numerator, ratio('file-analysis').denominator);
  assert.equal(ratio('typecheck').numerator, 4);
  assert.equal(scan.runtime.testsPassed, 5);
  assert.equal(scan.runtime.testsFailed, 0);
  assert.notEqual(scan.coverage.verdict.state, 'defects-found');
  assert.ok(!/bug-free|100% safe|all bugs/i.test(JSON.stringify(scan.coverage.verdict)));
});

test('integration-only defect: each file passes alone, the pair fails together', { skip }, async () => {
  const pricing = 'export function applyDiscount(total: number, percent: number): number { return total - (total * percent) / 100; }\n';
  const checkout = "import { applyDiscount, formatCurrency } from './pricing';\nexport const total = (n: number): string => formatCurrency(applyDiscount(n, 10, 'X'));\n";
  const alone1 = await scanEntries(textEntries({ 'src/pricing.ts': pricing }));
  const alone2 = await scanEntries(textEntries({ 'src/checkout.ts': checkout.replace("from './pricing'", "from './pricing-stub'") + 'export {};\n', 'src/pricing-stub.ts': 'export const applyDiscount = (a: number, b: number, c?: string) => a; export const formatCurrency = (n: number) => String(n);\n' }));
  for (const s of [alone1, alone2]) assert.equal(s.findings.filter(f => f.verification === 'confirmed-static').length, 0);
  const together = await scanEntries(textEntries({ 'src/pricing.ts': pricing, 'src/checkout.ts': checkout }));
  const missing = find(together, 'IMPORT_MISSING_EXPORT', 'src/checkout.ts');
  assert.equal(missing.verification, 'confirmed-static');
  assert.deepEqual(missing.analyzers.sort(), ['integration-graph', 'typescript-compiler']);
  const arity = find(together, 'TS2554', 'src/checkout.ts');
  assert.equal(arity.category, 'integration');
  assert.deepEqual(arity.affected.sort(), ['src/checkout.ts', 'src/pricing.ts']);
});

test('broken-integration fixture: static, graph and runtime-reproduced defects with correct verification classes', { skip }, async () => {
  const scan = await runJsJobsInVm(await scanFixture('broken-integration', { runtime: true }));
  const expect = (rule, file, verification) => { const f = find(scan, rule, file); assert.ok(f, `${rule} in ${file}`); assert.equal(f.verification, verification, `${rule} verification`); return f; };
  expect('IMPORT_MISSING_EXPORT', 'src/checkout.ts', 'confirmed-static');
  expect('IMPORT_CASE_MISMATCH', 'src/server.js', 'confirmed-static');
  expect('MODULE_FORMAT_MISMATCH', 'src/legacy.js', 'high-confidence');
  expect('DEP_UNDECLARED', 'src/server.js', 'high-confidence');
  expect('PKG_SCRIPT_MISSING_FILE', 'package.json', 'high-confidence');
  expect('BROKEN_REFERENCE', 'index.html', 'high-confidence');
  expect('SQL_UNKNOWN_COLUMN', 'src/repository.js', 'high-confidence');
  expect('JS_SQL_INJECTION', 'src/repository.js', 'security-observation');
  expect('JS_OFF_BY_ONE', 'src/stats.js', 'high-confidence');
  expect('ENV_UNDOCUMENTED', 'src/server.js', 'potential');
  const failed = expect('RUNTIME_TEST_FAILED', 'test/stats.test.js', 'confirmed-runtime');
  assert.match(failed.rootCause, /NaN/);
  assert.equal(failed.line, 6);
  expect('RUNTIME_MODULE_LOAD', 'src/normalize.js', 'confirmed-runtime');
  const cycle = expect('IMPORT_CYCLE', 'src/normalize.js', 'confirmed-runtime');
  assert.ok(cycle.related.length >= 1, 'cycle linked to the reproduced load failure');
  expect('RUNTIME_NAN_RESULT', 'src/stats.js', 'potential');
  assert.equal(scan.runtime.testsPassed, 3);
  assert.equal(scan.runtime.testsFailed, 1);
  assert.ok(!rules(scan).has('RUNTIME_PROBE_CRASH'), 'deliberate RangeError and out-of-contract inputs are not reported as defects');
  assert.ok(scan.runtime.blocked.some(b => /Requires "path"/.test(b.reason)), 'Node built-ins are reported as a blocked capability');
});

test('python fixture: tokenizer syntax, cross-module name and signature contracts, logic rules', async () => {
  const scan = await scanFixture('python-project');
  const r = rules(scan);
  for (const rule of ['PY_MISSING_COLON', 'PY_IMPORT_MISSING_NAME', 'PY_CALL_SIGNATURE', 'PY_IS_LITERAL', 'PY_MUTABLE_DEFAULT', 'PY_DEP_UNDECLARED']) assert.ok(r.has(rule), rule);
  const call = find(scan, 'PY_CALL_SIGNATURE');
  assert.match(call.actual, /takes 2 positional arguments but 3 were given/);
  assert.deepEqual(call.affected.sort(), ['inventory/report.py', 'inventory/stock.py']);
  assert.equal(find(scan, 'PY_MISSING_COLON').verification, 'high-confidence', 'tokenizer results are not labeled as compiler-confirmed');
  assert.ok(scan.files.find(f => f.path === 'inventory/stock.py').blocked.some(b => /CPython compile/.test(b)));
});

test('an analyzer crash is isolated: other analyzers and files complete, and the failure is reported', { skip }, async () => {
  const boom = { id: 'boom', label: 'Deliberately failing analyzer', applies: f => f.path === 'b.js', run: () => { throw new Error('kaboom'); } };
  const scan = await scanEntries(textEntries({ 'a.js': 'export const a = 1;', 'b.js': 'export const b = 2;' }), { analyzers: [...FILE_ANALYZERS, boom] });
  const run = scan.analyzerRuns.find(r => r.id === 'boom');
  assert.equal(run.status, 'failed');
  assert.match(run.failures[0].error, /kaboom/);
  assert.ok(scan.diagnostics.some(d => d.file === 'b.js' && d.origin === 'codeproof' && d.scope === 'file'));
  assert.equal(scan.files.find(f => f.path === 'b.js').status, 'partial');
  assert.equal(scan.files.find(f => f.path === 'a.js').status, 'analyzed');
  assert.equal(scan.coverage.verdict.incomplete, true);
  assert.notEqual(scan.coverage.verdict.state, 'no-findings', 'analyzer failure never becomes a clean result');
});

test('"no findings" is distinct from "verification incomplete"', { skip }, async () => {
  const scan = await scanEntries(textEntries({ 'a.js': 'export const add = (a, b) => a + b;\n' }));
  assert.equal(scan.coverage.verdict.state, 'incomplete', 'runtime not run => incomplete');
  const ran = await runJsJobsInVm(await scanEntries(textEntries({ 'a.js': 'export const add = (a, b) => a + b;\n' }), { runtime: true }));
  assert.equal(ran.coverage.verdict.state, 'no-findings');
  assert.match(ran.coverage.verdict.message, /does not prove the absence of defects/);
});

test('findings registry deduplicates across analyzers and keeps the strongest evidence', () => {
  const reg = new FindingRegistry();
  reg.add({ rule: 'JS_PARSE', title: 'a', file: 'x.js', line: 3, verification: 'potential', analyzer: 'one', dedupeKey: 'syntax', severity: 'medium' });
  reg.add({ rule: 'TS1005', title: 'b', file: 'x.js', line: 3, verification: 'confirmed-static', analyzer: 'two', dedupeKey: 'syntax', severity: 'high' });
  const out = reg.finalize();
  assert.equal(out.length, 1);
  assert.equal(out[0].verification, 'confirmed-static');
  assert.deepEqual(out[0].analyzers.sort(), ['one', 'two']);
  assert.equal(makeFinding({ rule: 'Q', verification: 'quality', severity: 'critical' }).severity, 'low', 'style findings cannot outrank defects');
  assert.equal(filterFindings(out, { verification: 'confirmed-static', file: 'x.js', search: 'b' }).length, 1);
});

test('secrets are masked in findings and every export format', async () => {
  // Built at run time so this test file itself does not contain credential-shaped literals.
  const secret = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');
  const password = ['hunter', '2', 'hunter', '2'].join('');
  const scan = await scanEntries(textEntries({ 'config.js': `export const key = "${secret}";\nexport const password = "${password}";\n` }));
  const f = find(scan, 'SECRET_LITERAL', 'config.js');
  assert.equal(f.severity, 'critical');
  for (const out of [JSON.stringify(buildReport(scan)), reportMarkdown(scan), JSON.stringify(reportSarif(scan))]) {
    assert.ok(!out.includes(secret) && !out.includes(password), 'raw secret leaked');
  }
});

test('reports: JSON schema, Markdown and SARIF carry verdict, coverage definitions and provenance', { skip }, async () => {
  const scan = await scanFixture('broken-integration');
  const json = buildReport(scan);
  assert.equal(json.schema, 'codeproof.scan.v2');
  assert.ok(json.coverage.ratios.every(r => r.definition && typeof r.denominator === 'number'));
  assert.ok(json.findings.every(f => f.id && f.analyzers.length && f.verificationLabel));
  const md = reportMarkdown(scan);
  assert.match(md, /## Verdict/); assert.match(md, /## Coverage/); assert.match(md, /Confirmed syntax, compilation or configuration failure/);
  const sarif = reportSarif(scan);
  assert.equal(sarif.version, '2.1.0');
  assert.ok(sarif.runs[0].results.some(r => r.ruleId === 'IMPORT_MISSING_EXPORT' && r.properties.verification === 'confirmed-static'));
});

test('strict JSON validator, semver ranges and lockfile drift', { skip }, async () => {
  assert.equal(jsonError('{"a": 1}'), null);
  assert.match(jsonError('{"a": 1,}').message, /Trailing comma/);
  assert.equal(jsonError('{"a": 1,}').index, 8);
  assert.match(jsonError('{"a": // x\n 1}').message, /Comments are not allowed/);
  assert.equal(satisfies('1.4.2', '^1.2.0'), true);
  assert.equal(satisfies('2.0.0', '^1.2.0'), false);
  assert.equal(satisfies('0.3.9', '~0.3.1'), true);
  assert.equal(satisfies('1.0.0', '>=1.0.0 <2 || ^3'), true);
  assert.equal(satisfies('1.0.0', 'workspace:*'), null);
  const scan = await scanEntries(textEntries({
    'package.json': JSON.stringify({ name: 'x', dependencies: { lodash: '^4.17.0', left: '^1.0.0' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '3.10.1' } } }),
    'index.js': "import _ from 'lodash';\nimport left from 'left';\nexport default _(left);\n",
    'tsconfig.json': '{ "compilerOptions": { "strict": true, }, }',
  }));
  assert.ok(find(scan, 'LOCKFILE_MISMATCH'), 'lodash 3.10.1 does not satisfy ^4.17.0');
  assert.ok(find(scan, 'LOCKFILE_MISSING'), 'left is missing from the lockfile');
  assert.ok(!find(scan, 'JSON_PARSE', 'tsconfig.json'), 'tsconfig tolerates comments and trailing commas');
});

test('python tokenizer: unterminated strings, unbalanced brackets and dedent errors with positions', () => {
  const syntax = content => analyzePythonFile({ path: 'x.py', language: 'python', content }).findings.filter(f => f.category === 'syntax').map(f => `${f.line}:${f.column}:${f.rootCause}`).join('\n');
  assert.match(syntax('x = 1\ns = "abc\ny = 2\n'), /^2:5:.*unterminated string literal/m);
  assert.match(syntax('total = sum([1, 2\nprint(total)\n'), /^1:13:.*'\[' was never closed/m);
  assert.match(syntax('def f():\n        a = 1\n    b = 2\n'), /^3:5:.*unindent does not match any outer indentation level/m);
  assert.match(syntax('if x == 1\n    y = 2\n'), /^1:.*no terminating colon/m);
  assert.equal(syntax('def ok(a, b=(1, 2)) -> dict[str, int]:\n    return {"a": a}\n'), '');
});
