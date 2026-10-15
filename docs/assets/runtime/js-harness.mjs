// Source of the dedicated worker that executes untrusted JavaScript inside the opaque-origin sandbox iframe.
// The function below is serialized with Function.prototype.toString, so it must not reference anything
// outside its own body. All harness state lives in this closure; uploaded code is compiled with
// new Function in the global scope and cannot reach the message port, the job or other modules' records.
export function codeproofJsWorker() {
  'use strict';
  const scope = typeof self !== 'undefined' ? self : globalThis;
  const postToHost = scope.postMessage.bind(scope);
  let emit = msg => postToHost(msg);
  const clock = () => (scope.performance && scope.performance.now ? scope.performance.now() : Date.now());
  const timer = typeof scope.setTimeout === 'function' ? scope.setTimeout.bind(scope) : null;
  const clearTimer = typeof scope.clearTimeout === 'function' ? scope.clearTimeout.bind(scope) : () => {};
  const MAX_LOGS = 50;

  // Defense in depth only: the Content-Security-Policy inherited from the sandbox document is the actual
  // network boundary. Removing these globals makes accidental use fail fast with a clear message.
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'Worker', 'SharedWorker', 'BroadcastChannel', 'indexedDB', 'caches', 'RTCPeerConnection', 'importScripts']) {
    try { Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false }); } catch (_) { /* already locked */ }
  }

  let currentLogs = [];
  const captured = (level) => (...args) => {
    if (currentLogs.length >= MAX_LOGS) return;
    currentLogs.push((level === 'log' ? '' : `[${level}] `) + args.map(a => { try { return typeof a === 'string' ? a : JSON.stringify(toWire(a)); } catch (_) { return String(a); } }).join(' ').slice(0, 500));
  };
  const fakeConsole = { log: captured('log'), info: captured('info'), warn: captured('warn'), error: captured('error'), debug: captured('debug'), trace: captured('trace'), table: captured('table'), dir: captured('dir'), group: () => {}, groupEnd: () => {}, time: () => {}, timeEnd: () => {}, assert: (c, ...a) => { if (!c) captured('assert')(...a); } };
  for (const target of new Set([scope, globalThis])) { try { Object.defineProperty(target, 'console', { value: fakeConsole, configurable: true, writable: true }); } catch (_) { /* ignore */ } }

  // ---------- value serialization (never throws)
  function toWire(v, seen, depth) {
    seen = seen || new WeakSet(); depth = depth || 0;
    if (v === undefined) return { __cp: 'undefined' };
    if (typeof v === 'number') { if (Number.isNaN(v)) return { __cp: 'NaN' }; if (!Number.isFinite(v)) return { __cp: v > 0 ? 'Infinity' : '-Infinity' }; if (Object.is(v, -0)) return { __cp: '-0' }; return v; }
    if (typeof v === 'bigint') return { __cp: 'bigint', value: String(v) };
    if (typeof v === 'symbol') return { __cp: 'symbol', value: String(v) };
    if (typeof v === 'function') return { __cp: 'function', name: v.name || 'anonymous' };
    if (typeof v === 'string') return v.length > 2000 ? v.slice(0, 2000) + '…' : v;
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return { __cp: 'circular' };
    if (depth > 6) return { __cp: 'truncated' };
    seen.add(v);
    try {
      if (v instanceof Error) return { __cp: 'error', name: v.name, message: String(v.message).slice(0, 500) };
      if (v instanceof Date) return { __cp: 'date', value: Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString() };
      if (v instanceof RegExp) return { __cp: 'regexp', value: String(v) };
      if (v instanceof Map) return { __cp: 'map', entries: Array.from(v).slice(0, 50).map(([k, x]) => [toWire(k, seen, depth + 1), toWire(x, seen, depth + 1)]) };
      if (v instanceof Set) return { __cp: 'set', values: Array.from(v).slice(0, 50).map(x => toWire(x, seen, depth + 1)) };
      if (ArrayBuffer.isView(v)) return { __cp: 'typed', type: v.constructor && v.constructor.name, values: Array.from(v.slice(0, 50)).map(x => (typeof x === 'bigint' ? String(x) : x)) };
      if (typeof v.then === 'function') return { __cp: 'promise' };
      if (Array.isArray(v)) return v.slice(0, 200).map(x => toWire(x, seen, depth + 1));
      const o = {};
      let n = 0;
      for (const k of Object.keys(v)) { if (n++ >= 100) { o.__cp_more = true; break; } try { o[k] = toWire(v[k], seen, depth + 1); } catch (_) { o[k] = { __cp: 'throws' }; } }
      return o;
    } catch (_) { return { __cp: 'unserializable' }; }
  }
  const legacySanitize = value => {
    if (typeof value === 'undefined') return '[undefined]';
    if (typeof value === 'bigint') return String(value) + 'n';
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return String(value); }
  };
  const show = v => { try { const w = toWire(v); return typeof w === 'string' ? JSON.stringify(w) : JSON.stringify(w, (k, x) => (x && x.__cp ? (x.__cp === 'undefined' ? 'undefined' : x.__cp === 'NaN' ? 'NaN' : x.__cp === 'function' ? `[Function ${x.name}]` : x.value !== undefined ? x.value : `[${x.__cp}]`) : x)); } catch (_) { return String(v); } };

  const ENGINE_MESSAGE = /Cannot read propert|Cannot set propert|is not a function|is not iterable|is not defined|is not a constructor|Cannot convert|undefined is not|null is not|Maximum call stack|Invalid array length|Cannot destructure|Assignment to constant|Cannot access .* before initialization|has no properties|Reduce of empty array|toFixed\(\) digits|Invalid time value|Invalid count value|out of range|precision|radix|Unexpected token|in JSON at position|is not valid JSON|Invalid regular expression|Cannot mix BigInt|Do not know how to serialize a BigInt|object is not extensible|read.only|Cannot redefine property|Cannot create property|Converting circular structure/;
  let lineMaps = {};
  let moduleSources = {};
  function errorInfo(e) {
    if (e === null || typeof e !== 'object') return { name: 'NonErrorThrow', message: show(e), explicit: true };
    const name = String(e.name || (e.constructor && e.constructor.name) || 'Error');
    const message = String(e.message === undefined ? show(e) : e.message).slice(0, 2000);
    let stack = typeof e.stack === 'string' ? e.stack : '';
    let line = null, file = null, thrownHere = null;
    stack = stack.split('\n').filter(l => !/codeproof-harness|blob:|<anonymous>:\d|vm:\d|node:internal/.test(l)).slice(0, 8).map(l => l.replace(/codeproof:\/\/module\/([^:)\s]+):(\d+):(\d+)/g, (m, p, ln, col) => {
      const map = lineMaps[p];
      const generated = Number(ln) - 2;
      const original = map && map[generated] ? map[generated] : generated;
      if (!file) {
        file = p; line = original;
        // The innermost user frame of an explicit `throw new X(...)` points at the throw statement itself.
        const src = (moduleSources[p] || [])[generated - 1];
        if (typeof src === 'string') thrownHere = /\bthrow\b/.test(src.slice(0, Number(col) + 40));
      }
      return `${p}:${original}:${col}`;
    })).join('\n').slice(0, 1500);
    const explicit = thrownHere !== null ? thrownHere : name === 'ReferenceError' ? false : (name === 'TypeError' || name === 'RangeError' || name === 'SyntaxError') ? !ENGINE_MESSAGE.test(message) : true;
    const info = { name, message, stack, explicit, file, line };
    if (e.code === 'CODEPROOF_UNAVAILABLE_MODULE' || e.code === 'CODEPROOF_UNSUPPORTED') { info.code = e.code; info.specifier = e.specifier; info.explicit = false; }
    if ('actual' in e || 'expected' in e) { info.actual = show(e.actual); info.expected = show(e.expected); }
    return info;
  }

  // ---------- deep equality
  function equals(a, b, strict, seen) {
    if (Object.is(a, b)) return true;
    if (b && typeof b === 'object' && typeof b.asymmetricMatch === 'function') return b.asymmetricMatch(a);
    if (a && typeof a === 'object' && typeof a.asymmetricMatch === 'function') return a.asymmetricMatch(b);
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    seen = seen || [];
    if (seen.some(([x, y]) => x === a && y === b)) return true;
    seen.push([a, b]);
    if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    if (a instanceof RegExp || b instanceof RegExp) return String(a) === String(b);
    if (a instanceof Error && b instanceof Error) return a.message === b.message && a.name === b.name;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (a instanceof Map && b instanceof Map) { if (a.size !== b.size) return false; for (const [k, v] of a) if (!b.has(k) || !equals(v, b.get(k), strict, seen)) return false; return true; }
    if (a instanceof Set && b instanceof Set) { if (a.size !== b.size) return false; for (const v of a) if (!b.has(v) && ![...b].some(x => equals(v, x, strict, seen))) return false; return true; }
    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) return a.length === b.length && Array.from(a).every((x, i) => Object.is(x, b[i]));
    const keys = o => Object.keys(o).filter(k => strict || o[k] !== undefined);
    const ka = keys(a), kb = keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) { if (!Object.prototype.hasOwnProperty.call(b, k) && !(b[k] && b[k].asymmetricMatch)) { if (strict || b[k] !== undefined) return false; } if (!equals(a[k], b[k], strict, seen)) return false; }
    if (Array.isArray(a) && strict && a.length !== b.length) return false;
    return true;
  }
  function matchObject(actual, expected) {
    if (expected && typeof expected === 'object' && typeof expected.asymmetricMatch === 'function') return expected.asymmetricMatch(actual);
    if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matchObject(actual[i], e));
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && !(expected instanceof RegExp)) return actual !== null && typeof actual === 'object' && Object.keys(expected).every(k => matchObject(actual[k], expected[k]));
    return equals(actual, expected, false);
  }

  class AssertionError extends Error {
    constructor(message, actual, expected) { super(message); this.name = 'AssertionError'; this.actual = actual; this.expected = expected; }
  }
  const unsupported = feature => { const e = new Error(`${feature} is not supported by the CodeProof sandbox harness.`); e.code = 'CODEPROOF_UNSUPPORTED'; e.name = 'CodeProofUnsupported'; return e; };

  // ---------- mocks
  function createMock(impl) {
    let implementation = impl;
    const once = [];
    const mock = { calls: [], results: [], instances: [] };
    const fn = function (...args) {
      mock.calls.push(args); mock.instances.push(this);
      const use = once.length ? once.shift() : implementation;
      try { const value = use ? use.apply(this, args) : undefined; mock.results.push({ type: 'return', value }); return value; }
      catch (e) { mock.results.push({ type: 'throw', value: e }); throw e; }
    };
    fn._isMockFunction = true;
    fn.mock = mock;
    fn.mockImplementation = f => { implementation = f; return fn; };
    fn.mockImplementationOnce = f => { once.push(f); return fn; };
    fn.mockReturnValue = v => fn.mockImplementation(() => v);
    fn.mockReturnValueOnce = v => fn.mockImplementationOnce(() => v);
    fn.mockResolvedValue = v => fn.mockImplementation(() => Promise.resolve(v));
    fn.mockResolvedValueOnce = v => fn.mockImplementationOnce(() => Promise.resolve(v));
    fn.mockRejectedValue = v => fn.mockImplementation(() => Promise.reject(v));
    fn.mockRejectedValueOnce = v => fn.mockImplementationOnce(() => Promise.reject(v));
    fn.mockReturnThis = () => fn.mockImplementation(function () { return this; });
    fn.mockClear = () => { mock.calls.length = 0; mock.results.length = 0; mock.instances.length = 0; return fn; };
    fn.mockReset = () => { fn.mockClear(); implementation = undefined; once.length = 0; return fn; };
    fn.mockName = () => fn;
    fn.getMockName = () => 'mock';
    return fn;
  }
  function spyOn(obj, method) {
    const original = obj[method];
    if (typeof original !== 'function') throw new TypeError(`Cannot spy on ${String(method)}: not a function`);
    const spy = createMock(function (...a) { return original.apply(this, a); });
    spy.mockRestore = () => { obj[method] = original; };
    obj[method] = spy;
    return spy;
  }
  const mockApi = name => ({
    fn: createMock, spyOn, isMockFunction: f => Boolean(f && f._isMockFunction),
    clearAllMocks: () => {}, resetAllMocks: () => {}, restoreAllMocks: () => {},
    mock: () => { throw unsupported(`${name}.mock() module mocking`); }, doMock: () => { throw unsupported(`${name}.doMock()`); },
    useFakeTimers: () => { throw unsupported(`${name}.useFakeTimers()`); }, useRealTimers: () => {}, setSystemTime: () => { throw unsupported(`${name}.setSystemTime()`); },
    stubGlobal: (k, v) => { scope[k] = v; }, unstubAllGlobals: () => {},
  });

  // ---------- expect
  function expect(actual) {
    const make = (negate, mode) => {
      const assert = (pass, message, expected) => {
        if (pass === negate) throw new AssertionError(negate ? `Expected not: ${message}` : `Expected: ${message}`, actual, expected);
      };
      const m = {
        toBe: e => assert(Object.is(actual, e), `${show(actual)} to be ${show(e)}`, e),
        toEqual: e => assert(equals(actual, e, false), `${show(actual)} to equal ${show(e)}`, e),
        toStrictEqual: e => assert(equals(actual, e, true), `${show(actual)} to strictly equal ${show(e)}`, e),
        toBeTruthy: () => assert(Boolean(actual), `${show(actual)} to be truthy`),
        toBeFalsy: () => assert(!actual, `${show(actual)} to be falsy`),
        toBeNull: () => assert(actual === null, `${show(actual)} to be null`, null),
        toBeUndefined: () => assert(actual === undefined, `${show(actual)} to be undefined`),
        toBeDefined: () => assert(actual !== undefined, `value to be defined`),
        toBeNaN: () => assert(Number.isNaN(actual), `${show(actual)} to be NaN`),
        toBeInstanceOf: c => assert(actual instanceof c, `${show(actual)} to be an instance of ${c && c.name}`),
        toBeGreaterThan: n => assert(actual > n, `${show(actual)} > ${show(n)}`, n),
        toBeGreaterThanOrEqual: n => assert(actual >= n, `${show(actual)} >= ${show(n)}`, n),
        toBeLessThan: n => assert(actual < n, `${show(actual)} < ${show(n)}`, n),
        toBeLessThanOrEqual: n => assert(actual <= n, `${show(actual)} <= ${show(n)}`, n),
        toBeCloseTo: (n, digits = 2) => assert(Math.abs(actual - n) < Math.pow(10, -digits) / 2, `${show(actual)} to be close to ${show(n)}`, n),
        toContain: x => assert(actual != null && (typeof actual === 'string' ? actual.includes(x) : Array.from(actual).includes(x)), `${show(actual)} to contain ${show(x)}`, x),
        toContainEqual: x => assert(actual != null && Array.from(actual).some(v => equals(v, x, false)), `${show(actual)} to contain an item equal to ${show(x)}`, x),
        toHaveLength: n => assert(actual != null && actual.length === n, `${show(actual)} to have length ${n}`, n),
        toHaveProperty: (path, value) => {
          const parts = Array.isArray(path) ? path : String(path).split('.');
          let cur = actual, ok = true;
          for (const p of parts) { if (cur == null || !(p in Object(cur))) { ok = false; break; } cur = cur[p]; }
          assert(ok && (value === undefined || equals(cur, value, false)), `${show(actual)} to have property ${parts.join('.')}${value === undefined ? '' : ` = ${show(value)}`}`, value);
        },
        toMatch: re => assert(typeof actual === 'string' && (re instanceof RegExp ? re.test(actual) : actual.includes(re)), `${show(actual)} to match ${String(re)}`, String(re)),
        toMatchObject: o => assert(matchObject(actual, o), `${show(actual)} to match object ${show(o)}`, o),
        toThrow: e => {
          let threw = false, error;
          if (typeof actual === 'function') { try { actual(); } catch (x) { threw = true; error = x; } }
          else if (mode === 'rejects') { threw = true; error = actual; }
          let ok = threw;
          if (ok && e !== undefined) {
            if (typeof e === 'function') ok = error instanceof e;
            else if (e instanceof RegExp) ok = e.test(String(error && error.message));
            else if (typeof e === 'string') ok = String(error && error.message).includes(e);
            else if (e && typeof e === 'object') ok = String(error && error.message) === String(e.message);
          }
          assert(ok, threw ? `thrown ${show(error)} to match ${show(e)}` : 'function to throw', e);
        },
        toHaveBeenCalled: () => assert(actual && actual.mock && actual.mock.calls.length > 0, 'mock to have been called'),
        toHaveBeenCalledTimes: n => assert(actual && actual.mock && actual.mock.calls.length === n, `mock to have been called ${n} times (was ${actual && actual.mock && actual.mock.calls.length})`, n),
        toHaveBeenCalledWith: (...args) => assert(actual && actual.mock && actual.mock.calls.some(c => equals(c, args, false)), `mock to have been called with ${show(args)}`, args),
        toHaveBeenLastCalledWith: (...args) => assert(actual && actual.mock && actual.mock.calls.length && equals(actual.mock.calls[actual.mock.calls.length - 1], args, false), `mock last call to equal ${show(args)}`, args),
        toHaveReturnedWith: v => assert(actual && actual.mock && actual.mock.results.some(r => r.type === 'return' && equals(r.value, v, false)), `mock to have returned ${show(v)}`, v),
        toMatchSnapshot: () => { throw unsupported('Snapshot testing'); },
        toMatchInlineSnapshot: () => { throw unsupported('Snapshot testing'); },
      };
      m.toThrowError = m.toThrow; m.toBeCalled = m.toHaveBeenCalled; m.toBeCalledWith = m.toHaveBeenCalledWith; m.toBeCalledTimes = m.toHaveBeenCalledTimes;
      return m;
    };
    const api = make(false);
    api.not = make(true);
    const settle = (rejects, negate) => new Proxy({}, { get: (_, key) => async (...args) => {
      let value, rejected = false;
      try { value = await actual; } catch (e) { value = e; rejected = true; }
      if (rejected !== rejects) throw new AssertionError(rejects ? `Expected promise to reject, but it resolved with ${show(value)}` : `Expected promise to resolve, but it rejected with ${show(value)}`, value);
      const inner = expect(value);
      return (negate ? inner.not : rejects && key === 'toThrow' ? Object.assign(Object.create(inner), { toThrow: e => { const target = expect(() => { throw value; }); return negate ? target.not.toThrow(e) : target.toThrow(e); } }) : inner)[key](...args);
    } });
    api.resolves = settle(false, false); api.rejects = settle(true, false);
    api.resolves.not = settle(false, true); api.rejects.not = settle(true, true);
    return api;
  }
  const asym = (name, fn) => ({ asymmetricMatch: fn, toString: () => name, toJSON: () => name });
  expect.any = c => asym(`Any<${c && c.name}>`, v => (c === Number ? typeof v === 'number' : c === String ? typeof v === 'string' : c === Boolean ? typeof v === 'boolean' : c === Function ? typeof v === 'function' : c === Object ? v !== null && typeof v === 'object' : v instanceof c));
  expect.anything = () => asym('Anything', v => v !== null && v !== undefined);
  expect.objectContaining = o => asym('ObjectContaining', v => matchObject(v, o));
  expect.arrayContaining = arr => asym('ArrayContaining', v => Array.isArray(v) && arr.every(x => v.some(y => equals(y, x, false))));
  expect.stringContaining = s => asym('StringContaining', v => typeof v === 'string' && v.includes(s));
  expect.stringMatching = re => asym('StringMatching', v => typeof v === 'string' && new RegExp(re).test(v));
  expect.closeTo = (n, d = 2) => asym('CloseTo', v => Math.abs(v - n) < Math.pow(10, -d) / 2);
  expect.assertions = () => {}; expect.hasAssertions = () => {};
  expect.extend = () => { throw unsupported('expect.extend custom matchers'); };

  // ---------- node:assert subset
  const assertModule = (() => {
    const fail = (message, actual, expected, fallback) => { throw new AssertionError(message || fallback, actual, expected); };
    const a = (value, message) => { if (!value) fail(message, value, true, `${show(value)} == true`); };
    a.ok = a;
    a.equal = (x, y, m) => { if (x != y && !(Number.isNaN(x) && Number.isNaN(y))) fail(m, x, y, `${show(x)} == ${show(y)}`); }; // eslint-disable-line eqeqeq
    a.notEqual = (x, y, m) => { if (x == y) fail(m, x, y, `${show(x)} != ${show(y)}`); }; // eslint-disable-line eqeqeq
    a.strictEqual = (x, y, m) => { if (!Object.is(x, y)) fail(m, x, y, `Expected values to be strictly equal: ${show(x)} !== ${show(y)}`); };
    a.notStrictEqual = (x, y, m) => { if (Object.is(x, y)) fail(m, x, y, `Expected values to be not strictly equal: ${show(x)}`); };
    a.deepEqual = (x, y, m) => { if (!equals(x, y, false)) fail(m, x, y, `Expected values to be loosely deep-equal: ${show(x)} vs ${show(y)}`); };
    a.deepStrictEqual = (x, y, m) => { if (!equals(x, y, true)) fail(m, x, y, `Expected values to be strictly deep-equal: ${show(x)} vs ${show(y)}`); };
    a.notDeepStrictEqual = (x, y, m) => { if (equals(x, y, true)) fail(m, x, y, 'Expected values not to be deep-equal'); };
    a.notDeepEqual = (x, y, m) => { if (equals(x, y, false)) fail(m, x, y, 'Expected values not to be deep-equal'); };
    a.match = (s, re, m) => { if (!re.test(s)) fail(m, s, String(re), `The input did not match ${re}`); };
    a.doesNotMatch = (s, re, m) => { if (re.test(s)) fail(m, s, String(re), `The input was expected not to match ${re}`); };
    a.fail = m => fail(m, undefined, undefined, 'Failed');
    const errorMatches = (error, expected) => (expected === undefined ? true : typeof expected === 'function' ? (expected.prototype instanceof Error || expected === Error ? error instanceof expected : expected(error) === true) : expected instanceof RegExp ? expected.test(String(error && error.message)) : typeof expected === 'object' ? Object.keys(expected).every(k => (expected[k] instanceof RegExp ? expected[k].test(error[k]) : equals(error[k], expected[k], false))) : true);
    a.throws = (fn, expected, m) => { try { fn(); } catch (e) { if (!errorMatches(e, expected)) fail(typeof expected === 'string' ? expected : m, e, expected, `The error did not match: ${show(e)}`); return; } fail(typeof expected === 'string' ? expected : m, undefined, expected, 'Missing expected exception.'); };
    a.doesNotThrow = (fn, m) => { try { fn(); } catch (e) { fail(m, e, undefined, `Got unwanted exception: ${show(e)}`); } };
    a.rejects = async (p, expected, m) => { try { await (typeof p === 'function' ? p() : p); } catch (e) { if (!errorMatches(e, expected)) fail(m, e, expected, 'The rejection did not match.'); return; } fail(m, undefined, expected, 'Missing expected rejection.'); };
    a.doesNotReject = async (p, m) => { try { await (typeof p === 'function' ? p() : p); } catch (e) { fail(m, e, undefined, `Got unwanted rejection: ${show(e)}`); } };
    a.AssertionError = AssertionError;
    a.strict = a;
    return a;
  })();

  // ---------- test registration and execution
  function createSuite(name, parent, mode) { return { name, parent, mode: mode || 'run', tests: [], children: [], hooks: { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] } }; }
  function createTestApi(style) {
    const root = createSuite('', null);
    let current = root;
    let hasOnly = false;
    const pending = [];
    const fmt = (title, row, index) => {
      let i = 0;
      const values = Array.isArray(row) ? row : [row];
      let out = String(title).replace(/%[sdifjopc#%]/g, t => (t === '%%' ? '%' : t === '%#' ? String(index) : show(values[i++])));
      if (!Array.isArray(row) && row && typeof row === 'object') out = out.replace(/\$([\w.]+)/g, (_, k) => show(k.split('.').reduce((o, p) => (o == null ? o : o[p]), row)));
      return out;
    };
    const describe = (name, fn, mode) => {
      if (typeof name === 'function') { fn = name; name = '(anonymous)'; }
      const suite = createSuite(String(name), current, mode || (current.mode === 'skip' ? 'skip' : 'run'));
      if (mode === 'only') hasOnly = true;
      current.children.push(suite);
      const prev = current;
      current = suite;
      try { const r = typeof fn === 'function' ? fn() : undefined; if (r && typeof r.then === 'function') pending.push(r); }
      finally { current = prev; }
    };
    const addTest = (name, fn, mode, timeout) => {
      let options = {};
      if (fn && typeof fn === 'object' && !Array.isArray(fn)) { options = fn; fn = timeout; timeout = options.timeout; }
      if (options.skip) mode = 'skip';
      if (options.todo) mode = 'todo';
      if (options.only) mode = 'only';
      if (mode === 'only') hasOnly = true;
      current.tests.push({ name: String(name), fn, mode: mode || (current.mode === 'skip' ? 'skip' : typeof fn === 'function' ? 'run' : 'todo'), timeout: typeof timeout === 'number' ? timeout : null, suite: current });
    };
    const withVariants = (base, kind) => {
      base.skip = (n, f, t) => (kind === 'suite' ? describe(n, f, 'skip') : addTest(n, f, 'skip', t));
      base.only = (n, f, t) => (kind === 'suite' ? describe(n, f, 'only') : addTest(n, f, 'only', t));
      base.todo = n => addTest(n, undefined, 'todo');
      base.skipIf = c => (c ? base.skip : base);
      base.runIf = c => (c ? base : base.skip);
      base.concurrent = base;
      base.sequential = base;
      base.fails = () => { throw unsupported('test.fails'); };
      base.each = table => (name, fn, t) => {
        const rows = Array.isArray(table) ? table : [];
        rows.forEach((row, index) => {
          const title = fmt(name, row, index);
          const args = Array.isArray(row) ? row : [row];
          if (kind === 'suite') describe(title, () => fn(...args));
          else addTest(title, function () { return fn.apply(this, args); }, undefined, t);
        });
      };
      return base;
    };
    const test = withVariants((n, f, t) => addTest(n, f, undefined, t), 'test');
    const suite = withVariants((n, f) => describe(n, f), 'suite');
    const hook = kind => (fn, timeout) => current.hooks[kind].push({ fn, timeout });
    const api = { describe: suite, suite, context: suite, it: test, test, beforeAll: hook('beforeAll'), afterAll: hook('afterAll'), beforeEach: hook('beforeEach'), afterEach: hook('afterEach'), before: hook('beforeAll'), after: hook('afterAll') };
    api.xit = api.it.skip; api.xdescribe = api.describe.skip; api.fit = api.it.only; api.fdescribe = api.describe.only;

    async function callWithTimeout(fn, ctx, ms, label) {
      const usesDone = style !== 'node:test' && fn.length > 0;
      const run = usesDone
        ? new Promise((resolve, reject) => { try { fn.call(ctx, err => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve())); } catch (e) { reject(e); } })
        : Promise.resolve().then(() => fn.call(ctx, ctx));
      if (!timer || !ms) return run;
      let handle;
      const limit = new Promise((_, reject) => { handle = timer(() => reject(Object.assign(new Error(`${label} exceeded ${ms} ms`), { name: 'TimeoutError' })), ms); });
      try { return await Promise.race([run, limit]); } finally { clearTimer(handle); }
    }
    function nodeTestContext(name, results, ancestors) {
      const ctx = {
        name, signal: undefined, assert: assertModule, mock: { fn: createMock, method: spyOn },
        skip: () => { ctx.__skipped = true; }, todo: () => { ctx.__skipped = true; }, diagnostic: () => {}, plan: () => {}, runOnly: () => {},
        test: async (n, o, f) => { if (typeof o === 'function') { f = o; } const sub = `${name} > ${n}`; await runOne({ name: n, fn: f, mode: 'run', suite: null }, [...ancestors], results, sub); },
      };
      return ctx;
    }
    async function runOne(t, chain, results, fullNameOverride, perTestTimeout) {
      const fullName = fullNameOverride || [...chain.map(s => s.name).filter(Boolean), t.name].join(' > ');
      if (t.mode === 'skip' || t.mode === 'todo' || (hasOnly && t.mode !== 'only' && !chain.some(s => s.mode === 'only'))) { results.push({ name: fullName, status: t.mode === 'todo' ? 'todo' : 'skipped', durationMs: 0 }); emit({ type: 'test-result', test: results[results.length - 1] }); return; }
      emit({ type: 'test-start', name: fullName });
      currentLogs = [];
      const started = clock();
      const ctx = style === 'node:test' ? nodeTestContext(fullName, results, chain) : {};
      let error = null;
      try {
        for (const s of chain) for (const h of s.hooks.beforeEach) await callWithTimeout(h.fn, ctx, h.timeout || perTestTimeout, 'beforeEach hook');
        await callWithTimeout(t.fn, ctx, t.timeout || perTestTimeout, `Test "${fullName}"`);
      } catch (e) { error = e; }
      for (const s of [...chain].reverse()) for (const h of s.hooks.afterEach) { try { await callWithTimeout(h.fn, ctx, h.timeout || perTestTimeout, 'afterEach hook'); } catch (e) { error = error || e; } }
      const record = { name: fullName, status: ctx.__skipped ? 'skipped' : error ? 'failed' : 'passed', durationMs: Math.round(clock() - started), logs: currentLogs.slice(0, 20) };
      if (error) record.error = errorInfo(error);
      results.push(record);
      emit({ type: 'test-result', test: record });
    }
    async function runSuite(suite, chain, results, perTestTimeout) {
      const nextChain = suite === root ? [root] : [...chain, suite];
      let hookError = null;
      for (const h of suite.hooks.beforeAll) { try { await callWithTimeout(h.fn, {}, h.timeout || perTestTimeout, 'beforeAll hook'); } catch (e) { hookError = e; break; } }
      const all = [...suite.tests];
      for (const t of all) {
        if (hookError) { const r = { name: [...nextChain.map(s => s.name).filter(Boolean), t.name].join(' > '), status: 'failed', durationMs: 0, error: errorInfo(hookError) }; results.push(r); emit({ type: 'test-result', test: r }); continue; }
        await runOne(t, nextChain, results, null, perTestTimeout);
      }
      for (const child of suite.children) await runSuite(child, nextChain, results, perTestTimeout);
      for (const h of suite.hooks.afterAll) { try { await callWithTimeout(h.fn, {}, h.timeout || perTestTimeout, 'afterAll hook'); } catch (e) { if (!hookError) results.push({ name: `${suite.name || 'root'} > afterAll`, status: 'failed', durationMs: 0, error: errorInfo(e) }); } }
    }
    return { api, root, pending, run: async (perTestTimeout) => { const results = []; await Promise.all(pending); await runSuite(root, [], results, perTestTimeout); return results; } };
  }

  // ---------- module system
  const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
  function dirOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function join(base, spec) {
    const parts = base ? base.split('/') : [];
    for (const part of spec.split('/')) { if (!part || part === '.') continue; if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part); }
    return parts.join('/');
  }
  function createLoader(modules, builtins, exposeFor) {
    const cache = new Map();
    const exposed = {};
    function resolve(from, spec) {
      const clean = spec.replace(/[?#].*$/, '');
      const base = clean.startsWith('/') ? clean.slice(1) : join(dirOf(from), clean);
      if (base === null) return null;
      const ext = (base.match(/\.[^./]+$/) || [''])[0];
      const candidates = [base];
      if (ext === '.js' || ext === '.jsx') candidates.push(base.slice(0, -ext.length) + '.ts', base.slice(0, -ext.length) + '.tsx');
      if (ext === '.mjs') candidates.push(base.slice(0, -4) + '.mts');
      for (const e of EXTENSIONS) candidates.push(base + e);
      for (const e of EXTENSIONS) candidates.push(base + '/index' + e);
      return candidates.find(c => Object.prototype.hasOwnProperty.call(modules, c)) || null;
    }
    function load(path) {
      if (cache.has(path)) return cache.get(path).exports;
      const record = modules[path];
      const module = { exports: {}, id: path, filename: '/' + path, loaded: false, children: [] };
      cache.set(path, module);
      if (record.kind === 'json') { module.exports = JSON.parse(record.code); module.loaded = true; return module.exports; }
      lineMaps[path] = record.lineMap || null;
      moduleSources[path] = String(record.code).split('\n');
      const names = (exposeFor && exposeFor[path]) || [];
      const trailer = names.filter(n => /^[A-Za-z_$][\w$]*$/.test(n)).map(n => `\n;try{__codeproof_expose[${JSON.stringify(n)}]=typeof ${n}==="function"?${n}:undefined}catch(_e){}`).join('');
      const requireFn = spec => requireFrom(path, spec);
      requireFn.resolve = spec => resolve(path, spec);
      const factory = new Function('exports', 'require', 'module', '__filename', '__dirname', '__codeproof_expose', record.code + trailer + `\n//# sourceURL=codeproof://module/${path}`);
      const target = exposed[path] || (exposed[path] = {});
      factory.call(module.exports, module.exports, requireFn, module, '/' + path, '/' + dirOf(path), target);
      module.loaded = true;
      return module.exports;
    }
    function requireFrom(from, spec) {
      if (typeof spec !== 'string') throw new TypeError('require() expects a string specifier');
      const bare = spec.replace(/^node:/, '');
      if (Object.prototype.hasOwnProperty.call(builtins, spec)) return builtins[spec];
      if (Object.prototype.hasOwnProperty.call(builtins, bare)) return builtins[bare];
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const resolved = resolve(from, spec);
        if (resolved) return load(resolved);
        const e = new Error(`Cannot find module '${spec}' from '${from}'`);
        e.code = 'MODULE_NOT_FOUND'; e.name = 'Error';
        throw e;
      }
      const e = new Error(`Module "${spec}" is not available in the CodeProof browser sandbox`);
      e.code = 'CODEPROOF_UNAVAILABLE_MODULE'; e.specifier = spec; e.name = 'CodeProofUnavailableModule';
      throw e;
    }
    return { load, exposed, resolve };
  }

  function builtinsFor(testApi) {
    const vi = mockApi('vi'), jestObj = mockApi('jest');
    const testModule = Object.assign((n, o, f) => testApi.api.test(n, o, f), testApi.api, { mock: { fn: createMock, method: spyOn } });
    const b = {
      assert: assertModule, 'assert/strict': assertModule,
      vitest: Object.assign({}, testApi.api, { expect, vi, vitest: vi }),
      '@jest/globals': Object.assign({}, testApi.api, { expect, jest: jestObj }),
      test: testModule,
    };
    return { builtins: b, vi, jestObj };
  }
  function installGlobals(testApi, vi, jestObj) {
    const g = Object.assign({}, testApi.api, { expect, vi, jest: jestObj });
    for (const [k, v] of Object.entries(g)) { try { Object.defineProperty(scope, k, { value: v, configurable: true, writable: true }); } catch (_) { /* ignore */ } }
  }

  // ---------- job runners
  async function runTests(job) {
    const style = job.framework === 'node:test' ? 'node:test' : 'jest';
    const testApi = createTestApi(style);
    const { builtins, vi, jestObj } = builtinsFor(testApi);
    if (style !== 'node:test') installGlobals(testApi, vi, jestObj);
    const loader = createLoader(job.modules, builtins, null);
    let registrationError = null;
    currentLogs = [];
    try { loader.load(job.entry); } catch (e) { registrationError = errorInfo(e); }
    const tests = registrationError ? [] : await testApi.run(job.perTestTimeoutMs || 2000).catch(e => { registrationError = errorInfo(e); return []; });
    return { tests, registrationError, logs: currentLogs.slice(0, 20) };
  }
  async function runLoad(job) {
    const out = [];
    for (const entry of job.entries) {
      emit({ type: 'progress', label: entry });
      currentLogs = [];
      const testApi = createTestApi('jest');
      const { builtins } = builtinsFor(testApi);
      const loader = createLoader(job.modules, builtins, null);
      const started = clock();
      try { loader.load(entry); out.push({ path: entry, ok: true, durationMs: Math.round(clock() - started) }); }
      catch (e) { out.push({ path: entry, ok: false, error: errorInfo(e), durationMs: Math.round(clock() - started) }); }
    }
    return { modules: out };
  }
  async function runCall(job) {
    const testApi = createTestApi('jest');
    const { builtins } = builtinsFor(testApi);
    const loader = createLoader(job.modules, builtins, job.exposeLocal ? { [job.entry]: [job.functionName] } : null);
    let exportsObj;
    currentLogs = [];
    try { exportsObj = loader.load(job.entry); } catch (e) { return { loadError: errorInfo(e), cases: [] }; }
    const named = job.exportName && job.exportName !== 'default' ? exportsObj[job.exportName] : job.exportName === 'default' ? (exportsObj && exportsObj.default) || exportsObj : undefined;
    const fn = typeof named === 'function' ? named : typeof exportsObj?.[job.functionName] === 'function' ? exportsObj[job.functionName] : typeof exportsObj === 'function' && job.exportName === 'default' ? exportsObj : (loader.exposed[job.entry] || {})[job.functionName];
    if (typeof fn !== 'function') return { loadError: { name: 'CodeProofLookup', message: `Function not found: ${job.functionName}`, explicit: true }, cases: [] };
    const cases = [];
    for (const c of job.cases) {
      emit({ type: 'case-start', caseId: c.id });
      currentLogs = [];
      const started = clock();
      try {
        let value = fn(...c.args);
        if (value && typeof value.then === 'function') value = await value;
        const record = { id: c.id, ok: true, value: toWire(value), durationMs: Math.round(clock() - started), logs: currentLogs.slice(0, 10) };
        if (job.kind === 'determinism') { let again = fn(...c.args); if (again && typeof again.then === 'function') again = await again; record.same = JSON.stringify(toWire(again)) === JSON.stringify(record.value); }
        cases.push(record);
      } catch (e) { cases.push({ id: c.id, ok: false, error: errorInfo(e), durationMs: Math.round(clock() - started), logs: currentLogs.slice(0, 10) }); }
      emit({ type: 'case-result', caseRecord: cases[cases.length - 1] });
    }
    return { cases };
  }
  // Single-function run used by the Execution Lab and Automated Tests views (protocol v1).
  async function runLegacy(data) {
    const { id, source, test } = data;
    const started = clock();
    currentLogs = [];
    try {
      if (typeof source !== 'string' || source.length > 250000) throw new Error('Source is too large for safe local execution.');
      if (!test || !/^[A-Za-z_$][\w$]*$/.test(test.functionName)) throw new Error('Invalid function name.');
      const modules = Object.assign({}, data.modules || {});
      const entry = data.entry && modules[data.entry] ? data.entry : '__entry__.js';
      if (!modules[entry]) modules[entry] = { kind: 'js', code: source };
      const loader = createLoader(modules, builtinsFor(createTestApi('jest')).builtins, { [entry]: [test.functionName] });
      const exp = loader.load(entry);
      const fn = (exp && typeof exp[test.functionName] === 'function' && exp[test.functionName]) || (loader.exposed[entry] || {})[test.functionName];
      if (typeof fn !== 'function') throw new Error('Function not found: ' + test.functionName);
      const args = () => JSON.parse(JSON.stringify(test.args));
      let actual = fn(...args());
      if (actual && typeof actual.then === 'function') actual = await actual;
      let same = true;
      if (test.kind === 'determinism') { let again = fn(...args()); if (again && typeof again.then === 'function') again = await again; same = JSON.stringify(legacySanitize(actual)) === JSON.stringify(legacySanitize(again)); }
      if (test.kind === 'idempotent') { let again = fn(actual); if (again && typeof again.then === 'function') again = await again; same = test.args.length === 1 && JSON.stringify(legacySanitize(actual)) === JSON.stringify(legacySanitize(again)); }
      emit({ type: 'result', id, output: { ok: true, value: legacySanitize(actual), same, logs: currentLogs.slice(0, 20) }, ms: Math.round(clock() - started) });
    } catch (e) {
      emit({ type: 'result', id, output: { ok: false, error: String((e && e.message) || e), errorInfo: errorInfo(e), logs: currentLogs.slice(0, 20) }, ms: Math.round(clock() - started) });
    }
  }

  const validJob = job => job && typeof job === 'object' && ['tests', 'load', 'call'].includes(job.type) && job.modules && typeof job.modules === 'object';
  async function handleJob(job) {
    if (!validJob(job)) { emit({ type: 'job-error', message: 'Malformed job rejected by the sandbox.' }); return; }
    const started = clock();
    try {
      const result = job.type === 'tests' ? await runTests(job) : job.type === 'load' ? await runLoad(job) : await runCall(job);
      emit({ type: 'job-done', jobId: job.id, result, durationMs: Math.round(clock() - started) });
    } catch (e) { emit({ type: 'job-error', jobId: job.id, error: errorInfo(e) }); }
  }
  scope.addEventListener && scope.addEventListener('unhandledrejection', ev => { try { ev.preventDefault(); } catch (_) { /* ignore */ } captured('error')('Unhandled promise rejection:', ev.reason && ev.reason.message ? ev.reason.message : ev.reason); });
  let connected = false;
  scope.onmessage = async ({ data, ports }) => {
    if (!connected && data && data.type === 'connect' && ports && ports[0]) {
      connected = true;
      const port = ports[0];
      emit = msg => port.postMessage(msg);
      port.onmessage = ev => { if (ev.data && ev.data.type === 'job') handleJob(ev.data.job); else if (ev.data && ev.data.type === 'legacy-run') runLegacy(ev.data); };
      scope.onmessage = null;
      emit({ type: 'connected' });
      return;
    }
    if (!connected && data && typeof data.source === 'string' && data.test) return runLegacy(data);
    if (!connected && data && data.type === 'job') return handleJob(data.job);
  };
}

export const jsWorkerSource = `(${codeproofJsWorker.toString()})();\n//# sourceURL=codeproof-harness.js`;
