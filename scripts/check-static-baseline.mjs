import { readFile } from 'node:fs/promises';

// Reviewed critical findings in CodeProof's own source. Each entry is a deliberate use that the audit
// must keep reporting; any new or missing critical finding fails the build until it is reviewed.
const report = JSON.parse(await readFile('codeproof-report.json', 'utf8'));
const expected = new Map([
  // The sandbox worker compiles uploaded modules with new Function inside the opaque-origin sandbox;
  // that is its purpose, and it never runs in the application window.
  ['docs/assets/runtime/js-harness.mjs|JS_DYNAMIC_EXEC', 1],
  // Runtime-contract tests parse the worker sources and evaluate them in a Node vm context.
  ['tests/runtime.test.mjs|JS_DYNAMIC_EXEC', 3],
]);
const critical = report.findings.filter(f => f.severity === 'critical');
const actual = new Map();
for (const finding of critical) {
  const key = `${finding.file}|${finding.rule}`;
  actual.set(key, (actual.get(key) ?? 0) + 1);
}
const mismatches = [];
for (const [key, count] of expected) {
  if ((actual.get(key) ?? 0) !== count) mismatches.push(`${key}: expected ${count}, got ${actual.get(key) ?? 0}`);
}
for (const [key, count] of actual) {
  if (!expected.has(key)) mismatches.push(`${key}: unexpected critical finding count ${count}`);
}
const unexpectedDefects = report.findings.filter(f => ['confirmed-static', 'confirmed-runtime', 'high-confidence'].includes(f.verification) && f.category !== 'quality');
if (unexpectedDefects.length) mismatches.push(...unexpectedDefects.map(f => `${f.file}:${f.line} ${f.rule} (${f.verification}): ${f.title}`));
if (mismatches.length) {
  console.error('Static audit baseline changed. Review the new findings before updating the allowlist:');
  for (const item of mismatches) console.error(`- ${item}`);
  process.exit(1);
}
console.log(`Static audit baseline verified: ${critical.length} reviewed critical observations and no confirmed or high-confidence defects in CodeProof's own source.`);
