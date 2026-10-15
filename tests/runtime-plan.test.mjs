import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { generateCases, inferType } from '../docs/assets/engine/testgen.mjs';
import { interpretRuntime, jsEnvironmentReason, pythonEnvironmentReason } from '../docs/assets/engine/runtime-plan.mjs';
import { decodeLineMap } from '../docs/assets/engine/transpile.mjs';
import { jsWorkerSource } from '../docs/assets/runtime/js-harness.mjs';

const fn = (name, params, file = 'src/a.js') => ({ name, file, paramInfo: params });

test('generated inputs are deterministic per seed and never carry invented expected values', () => {
  const f = fn('scale', [{ name: 'value', type: 'number' }, { name: 'factor', type: 'number' }]);
  const a = generateCases(f, { seed: 's1' }), b = generateCases(f, { seed: 's1' }), c = generateCases(f, { seed: 's2' });
  assert.deepEqual(a.cases, b.cases);
  assert.notDeepEqual(a.cases, c.cases);
  assert.equal(a.contract, 'declared');
  assert.ok(a.cases.length > 3 && a.cases.length <= 8);
  assert.ok(a.cases.every(x => !('expected' in x)));
  assert.ok(a.cases.some(x => x.args.includes(0)) && a.cases.some(x => x.args.includes(-1)), 'zero and negative boundaries');
});

test('contracts: declared, JSDoc/name-inferred and un-generatable domain types', () => {
  assert.equal(inferType({ name: 'items', type: 'string[]' }).type, 'string[]');
  assert.equal(inferType({ name: 'x', annotation: 'Optional[int]' }).type, 'int');
  assert.equal(inferType({ name: 'count' }).declared, false);
  const domain = generateCases(fn('total', [{ name: 'order', type: 'Order' }]));
  assert.equal(domain.cases.length, 0);
  assert.match(domain.skipReason, /No generator for declared parameter type order: Order/);
});

test('runtime interpretation separates defects, deliberate rejections, observations and environment gaps', () => {
  const job = { entry: 'src/a.js', functionName: 'f', contract: 'declared', parameters: [{ name: 'n', type: 'number' }], seed: 's', fnLine: 3, deadlineMs: 1000, cases: [{ id: 'c1', args: [0], rationale: 'Representative values for every parameter' }, { id: 'c2', args: [1], rationale: 'Boundary' }, { id: 'c3', args: [2], rationale: 'Boundary' }] };
  const res = interpretRuntime([
    { engine: 'js', type: 'call', job, cases: [{ id: 'c1', ok: false, error: { name: 'TypeError', message: "Cannot read properties of undefined (reading 'x')", explicit: false } }, { id: 'c2', ok: false, error: { name: 'RangeError', message: 'n must be positive', explicit: true } }, { id: 'c3', ok: true, value: { __cp: 'NaN' } }] },
    { engine: 'js', type: 'call', job: { ...job, functionName: 'g', contract: 'unknown' }, cases: [{ id: 'c1', ok: false, error: { name: 'TypeError', message: 'x is not a function', explicit: false } }] },
    { engine: 'js', type: 'tests', path: 'test/a.test.js', tests: [{ name: 'adds', status: 'failed', error: { name: 'AssertionError', message: 'Expected: 3 to be 4', actual: '3', expected: '4', file: 'test/a.test.js', line: 9 } }, { name: 'dom', status: 'failed', error: { name: 'ReferenceError', message: 'document is not defined' } }, { name: 'ok', status: 'passed' }] },
    { engine: 'js', type: 'load', modules: [{ path: 'src/b.js', ok: false, error: { code: 'CODEPROOF_UNAVAILABLE_MODULE', specifier: 'express', name: 'CodeProofUnavailableModule', message: 'x' } }] },
    { engine: 'js', type: 'tests', path: 'test/b.test.js', status: 'error', error: 'Sandbox page did not start' },
  ]);
  const rules = res.findings.map(f => f.rule);
  assert.deepEqual(rules.filter(r => r === 'RUNTIME_PROBE_CRASH').length, 1, 'only the engine error on a type-valid input becomes a finding');
  assert.equal(res.findings.find(f => f.rule === 'RUNTIME_PROBE_CRASH').verification, 'confirmed-runtime');
  assert.ok(rules.includes('RUNTIME_NAN_RESULT'));
  assert.equal(res.observations.length, 1, 'crash outside a declared contract is an observation');
  const failed = res.findings.find(f => f.rule === 'RUNTIME_TEST_FAILED');
  assert.equal(failed.line, 9); assert.equal(failed.actual, '3'); assert.equal(failed.expected, '4');
  assert.equal(res.tests.find(t => t.name === 'dom').status, 'blocked');
  assert.ok(res.blocked.some(b => /Requires "express"/.test(b.reason)));
  assert.ok(res.blocked.some(b => b.sandboxFailure && /Sandbox page did not start/.test(b.reason)), 'sandbox failures are visible, not empty results');
  assert.match(jsEnvironmentReason({ name: 'ReferenceError', message: 'window is not defined' }), /does not provide/);
  assert.match(pythonEnvironmentReason({ name: 'ModuleNotFoundError', message: "No module named 'numpy'" }), /third-party module "numpy"/);
  assert.equal(pythonEnvironmentReason({ name: 'ModuleNotFoundError', message: "No module named 'inventory'" }, new Set(['inventory'])), null);
});

test('source-map line decoding maps transpiled lines back to the original source', () => {
  const map = decodeLineMap(';;;AACA,cAEC;AAHD,2BAAsB;AACtB,SAAgB,CAAC,CAAC,CAAS;IACzB,OAAO,IAAA,KAAC,EAAC,CAAC,CAAC,CAAC;AACd,CAAC;AACY,QAAA,CAAC,GAAG,CAAC,CAAC');
  assert.equal(map[6], 2); assert.equal(map[7], 3);
});

test('harness: Jest/Vitest-style suites, hooks, asymmetric matchers, mocks and node:assert', async () => {
  const code = `
    const { describe, it, expect, beforeEach, vi } = require('vitest');
    const assert = require('node:assert/strict');
    let n = 0;
    describe('math', () => {
      beforeEach(() => { n++; });
      it('matches objects', () => expect({ a: 1, b: [2, 3] }).toEqual({ a: 1, b: expect.arrayContaining([3]) }));
      it('mocks', () => { const m = vi.fn().mockReturnValue(4); expect(m(1)).toBe(4); expect(m).toHaveBeenCalledWith(1); });
      it('async rejects', async () => { await expect(Promise.reject(new Error('no'))).rejects.toThrow('no'); });
      it('assert module', () => { assert.deepStrictEqual({ x: [1] }, { x: [1] }); assert.throws(() => { throw new TypeError('t'); }, TypeError); });
      it('fails clearly', () => expect(n).toBe(99));
      it.skip('skipped', () => {});
      it.each([[1, 2], [2, 4]])('doubles %i', (a, b) => expect(a * 2).toBe(b));
    });`;
  const events = [];
  const result = await new Promise(resolve => {
    const self = { postMessage: m => { events.push(m); if (m.type === 'job-done') resolve(m.result); }, performance: { now: () => Date.now() }, setTimeout, clearTimeout, addEventListener() {} };
    vm.runInContext(jsWorkerSource, vm.createContext({ self }));
    self.onmessage({ data: { type: 'job', job: { id: 't', type: 'tests', entry: 't.test.js', framework: 'vitest', modules: { 't.test.js': { kind: 'js', code } }, perTestTimeoutMs: 1000 } } });
  });
  const status = Object.fromEntries(result.tests.map(t => [t.name, t.status]));
  assert.equal(status['math > matches objects'], 'passed');
  assert.equal(status['math > mocks'], 'passed');
  assert.equal(status['math > async rejects'], 'passed');
  assert.equal(status['math > assert module'], 'passed');
  assert.equal(status['math > fails clearly'], 'failed');
  assert.equal(status['math > skipped'], 'skipped');
  assert.equal(status['math > doubles 1'], 'passed');
  assert.equal(status['math > doubles 2'], 'passed');
  assert.match(result.tests.find(t => t.name === 'math > fails clearly').error.message, /Expected: 5 to be 99/);
  assert.ok(events.some(e => e.type === 'test-start'), 'progress is streamed so a hang can be attributed');
});
