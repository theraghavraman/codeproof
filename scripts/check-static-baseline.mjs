import { readFile } from 'node:fs/promises';

const report = JSON.parse(await readFile('codeproof-report.json', 'utf8'));
const expected = new Map([
  ['docs/assets/analysis.worker.mjs|JS_DYNAMIC_EXEC', 1],
  ['docs/assets/core.mjs|JS_DYNAMIC_EXEC', 1],
  ['docs/assets/sandbox.mjs|JS_DYNAMIC_EXEC', 2],
  // The portable CI kit mirrors the core module under a second entry point.
  ['docs/integrations/core.mjs|JS_DYNAMIC_EXEC', 1],
  // Test fixtures deliberately demonstrate rejecting dynamic code execution.
  ['tests/ci.test.mjs|JS_DYNAMIC_EXEC', 1],
  ['tests/runtime.test.mjs|JS_DYNAMIC_EXEC', 3],
]);
const critical = report.findings.filter((f) => f.severity === 'critical');
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
if (mismatches.length) {
  console.error('Static audit baseline changed. Review the new findings before updating the allowlist:');
  for (const item of mismatches) console.error(`- ${item}`);
  process.exit(1);
}
console.log(`Static audit baseline verified: ${critical.length} critical heuristics are limited to documented source and test paths.`);
