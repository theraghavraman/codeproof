// Source of the dedicated worker that runs CPython (Pyodide 0.28.3) inside the opaque-origin sandbox.
// The runtime files are fetched by the host page from its own origin, verified against pinned SHA-256
// digests, and transferred in; inside the sandbox there is no network at all (CSP connect-src 'none'),
// so Pyodide's internal fetch/importScripts calls are served only from those verified bytes.
const RUNNER = String.raw`
import sys, os, io, json, math, types, inspect, traceback, importlib, importlib.util, contextlib, unittest, tempfile, pathlib
ROOT = '/project'
sys.dont_write_bytecode = True

def _cp_wire(v, depth=0):
    if isinstance(v, float):
        if math.isnan(v): return {'__cp': 'NaN'}
        if math.isinf(v): return {'__cp': 'Infinity' if v > 0 else '-Infinity'}
        return v
    if v is None or isinstance(v, (bool, int, str)):
        return v if not isinstance(v, str) or len(v) < 2000 else v[:2000] + '…'
    if depth > 5: return {'__cp': 'truncated'}
    if isinstance(v, (list, tuple)): return [_cp_wire(x, depth + 1) for x in list(v)[:200]]
    if isinstance(v, dict): return {str(k): _cp_wire(x, depth + 1) for k, x in list(v.items())[:100]}
    if isinstance(v, (set, frozenset)): return {'__cp': 'set', 'values': [_cp_wire(x, depth + 1) for x in list(v)[:50]]}
    return {'__cp': 'repr', 'value': repr(v)[:500]}

def _cp_err(e):
    tb = traceback.extract_tb(e.__traceback__)
    frames = [f for f in tb if f.filename.startswith(ROOT)]
    last = frames[-1] if frames else None
    info = {'name': type(e).__name__, 'message': str(e)[:2000], 'explicit': bool(last and (last.line or '').strip().startswith('raise')),
            'file': last.filename[len(ROOT) + 1:] if last else None, 'line': last.lineno if last else None}
    if isinstance(e, SyntaxError):
        info.update({'file': (e.filename or '')[len(ROOT) + 1:] or info['file'], 'line': e.lineno, 'explicit': False})
    if isinstance(e, AssertionError) and not str(e) and last is not None:
        info['message'] = 'assert failed: ' + (last.line or '').strip()[:300]
    info['stack'] = ''.join(traceback.format_exception(type(e), e, e.__traceback__)[-6:])[-1500:]
    return info

def _cp_local_tops():
    tops = set()
    for name in os.listdir(ROOT):
        if name.endswith('.py'): tops.add(name[:-3])
        elif os.path.isdir(os.path.join(ROOT, name)): tops.add(name)
    return tops

def _cp_fresh(paths):
    for name in list(sys.modules):
        if name.split('.')[0] in _cp_local_tops() or name.startswith('conftest'): sys.modules.pop(name, None)
    for p in reversed(paths):
        full = os.path.join(ROOT, p) if p else ROOT
        if full not in sys.path: sys.path.insert(0, full)

def cp_mount(files_json, roots_json):
    files = json.loads(files_json)
    for rel, content in files.items():
        full = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, 'w', encoding='utf-8') as fh: fh.write(content)
    global _CP_ROOTS
    _CP_ROOTS = json.loads(roots_json)
    os.chdir(ROOT)
    return json.dumps({'mounted': len(files)})

def cp_compile(paths_json):
    out = []
    for p in json.loads(paths_json):
        try:
            with open(os.path.join(ROOT, p), encoding='utf-8') as fh: src = fh.read()
            compile(src, os.path.join(ROOT, p), 'exec', dont_inherit=True)
            out.append({'path': p, 'ok': True})
        except SyntaxError as e:
            out.append({'path': p, 'ok': False, 'type': type(e).__name__, 'message': e.msg, 'line': e.lineno, 'col': e.offset})
        except Exception as e:
            out.append({'path': p, 'ok': False, 'type': type(e).__name__, 'message': str(e)[:500], 'line': 1, 'col': 1})
    return json.dumps(out)

def _cp_import(module, path):
    _cp_fresh(_CP_ROOTS + [os.path.dirname(path)])
    if module:
        return importlib.import_module(module)
    spec = importlib.util.spec_from_file_location('__cp_' + path.replace('/', '_').replace('.', '_'), os.path.join(ROOT, path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def cp_load(job_json):
    job = json.loads(job_json)
    out = []
    for m in job['modules']:
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                _cp_import(m.get('module'), m['path'])
            out.append({'path': m['path'], 'ok': True})
        except BaseException as e:
            if isinstance(e, (KeyboardInterrupt,)): raise
            out.append({'path': m['path'], 'ok': False, 'error': _cp_err(e)})
    return json.dumps({'modules': out})

def cp_call(job_json):
    job = json.loads(job_json)
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            mod = _cp_import(job.get('module'), job['entry'])
        fn = getattr(mod, job['functionName'])
    except BaseException as e:
        return json.dumps({'loadError': _cp_err(e), 'cases': []})
    cases = []
    for c in job['cases']:
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                value = fn(*c['args'])
            cases.append({'id': c['id'], 'ok': True, 'value': _cp_wire(value), 'logs': buf.getvalue().splitlines()[:10]})
        except BaseException as e:
            if isinstance(e, KeyboardInterrupt): raise
            cases.append({'id': c['id'], 'ok': False, 'error': _cp_err(e), 'logs': buf.getvalue().splitlines()[:10]})
    return json.dumps({'cases': cases})

# ---- minimal pytest-compatible API (not pytest itself)
class _Skip(Exception): pass
class _XFail(Exception): pass
class _Raises:
    def __init__(self, exc, match=None): self.exc, self.match, self.value = exc, match, None
    def __enter__(self): return self
    def __exit__(self, et, ev, tb):
        if et is None: raise AssertionError('DID NOT RAISE ' + getattr(self.exc, '__name__', str(self.exc)))
        if not issubclass(et, self.exc): return False
        import re
        if self.match is not None and not re.search(self.match, str(ev)): raise AssertionError('Regex pattern did not match: ' + str(self.match))
        self.value = ev
        return True
class _Approx:
    def __init__(self, expected, rel=None, abs=None): self.expected, self.rel, self.abs = expected, rel, abs
    def _close(self, a, b):
        tol = max((self.rel if self.rel is not None else 1e-6) * builtins_abs(b), self.abs if self.abs is not None else 1e-12)
        return builtins_abs(a - b) <= tol
    def __eq__(self, other):
        e = self.expected
        if isinstance(e, (list, tuple)): return len(other) == len(e) and all(self._close(a, b) for a, b in zip(other, e))
        if isinstance(e, dict): return set(other) == set(e) and all(self._close(other[k], e[k]) for k in e)
        return self._close(other, e)
    def __repr__(self): return 'approx(%r)' % (self.expected,)
import builtins as _b
builtins_abs = _b.abs
class _Mark:
    def __getattr__(self, name):
        def factory(*args, **kwargs):
            def deco(fn):
                fn.__dict__.setdefault('_cp_marks', []).append((name, args, kwargs))
                return fn
            if name not in ('parametrize', 'skip', 'skipif', 'xfail', 'usefixtures', 'filterwarnings', 'timeout', 'asyncio', 'slow') and len(args) == 1 and callable(args[0]) and not kwargs:
                return deco(args[0])
            return deco
        return factory
class _Param:
    def __init__(self, *values, id=None, marks=()): self.values, self.id, self.marks = values, id, marks
def _fixture(fn=None, **kw):
    def deco(f):
        f._cp_fixture = kw
        return f
    return deco(fn) if callable(fn) else deco
def _raises(exc, *args, match=None, **kwargs):
    if args:
        with _Raises(exc, match): args[0](*args[1:], **kwargs)
        return None
    return _Raises(exc, match)
@contextlib.contextmanager
def _warns(*a, **k): yield
def _importorskip(name, *a, **k):
    try: return importlib.import_module(name)
    except ImportError: raise _Skip('could not import ' + name)
def _cp_install_pytest():
    if importlib.util.find_spec('pytest') is not None: return
    m = types.ModuleType('pytest')
    m.mark = _Mark(); m.param = _Param; m.fixture = _fixture; m.raises = _raises; m.approx = _Approx; m.warns = _warns; m.deprecated_call = _warns
    m.skip = lambda msg='', **k: (_ for _ in ()).throw(_Skip(msg)); m.fail = lambda msg='', **k: (_ for _ in ()).throw(AssertionError(msg))
    m.xfail = lambda msg='', **k: (_ for _ in ()).throw(_XFail(msg)); m.importorskip = _importorskip; m.__codeproof_shim__ = True
    sys.modules['pytest'] = m

class _MonkeyPatch:
    def __init__(self): self._undo = []
    def setattr(self, target, name, value=None, raising=True):
        if isinstance(target, str):
            mod, _, attr = target.rpartition('.')
            target, value, name = importlib.import_module(mod), name, attr
        old = getattr(target, name, None)
        self._undo.append(lambda: setattr(target, name, old))
        setattr(target, name, value)
    def setenv(self, k, v):
        old = os.environ.get(k)
        self._undo.append(lambda: os.environ.pop(k, None) if old is None else os.environ.__setitem__(k, old))
        os.environ[k] = str(v)
    def delenv(self, k, raising=True):
        old = os.environ.get(k)
        if old is not None:
            self._undo.append(lambda: os.environ.__setitem__(k, old)); del os.environ[k]
    def setitem(self, d, k, v):
        had, old = k in d, d.get(k)
        self._undo.append(lambda: d.__setitem__(k, old) if had else d.pop(k, None)); d[k] = v
    def undo(self):
        for f in reversed(self._undo): f()
class _Capsys:
    def __init__(self, buf): self.buf, self.pos = buf, 0
    def readouterr(self):
        v = self.buf.getvalue()[self.pos:]; self.pos = len(self.buf.getvalue())
        return types.SimpleNamespace(out=v, err='')

def _cp_fixture_table(mod, path):
    table = {}
    d = os.path.dirname(os.path.join(ROOT, path))
    chain = []
    while d.startswith(ROOT):
        if os.path.exists(os.path.join(d, 'conftest.py')): chain.append(os.path.join(d, 'conftest.py'))
        if d == ROOT: break
        d = os.path.dirname(d)
    for conf in reversed(chain):
        spec = importlib.util.spec_from_file_location('conftest_' + str(abs(hash(conf))), conf)
        cm = importlib.util.module_from_spec(spec); spec.loader.exec_module(cm)
        for k, v in vars(cm).items():
            if callable(v) and hasattr(v, '_cp_fixture'): table[k] = v
    for k, v in vars(mod).items():
        if callable(v) and hasattr(v, '_cp_fixture'): table[k] = v
    return table

class _NeedsFixture(Exception): pass

def _cp_call_with_fixtures(fn, table, extra, finalizers, capbuf, params=None):
    kwargs = {}
    sig = inspect.signature(fn)
    for name, p in sig.parameters.items():
        if name in ('self', 'cls'): continue
        if params and name in params: kwargs[name] = params[name]; continue
        if p.default is not inspect.Parameter.empty: continue
        if name in extra: kwargs[name] = extra[name]; continue
        if name == 'tmp_path': kwargs[name] = pathlib.Path(tempfile.mkdtemp()); continue
        if name == 'tmpdir': kwargs[name] = tempfile.mkdtemp(); continue
        if name == 'monkeypatch':
            mp = _MonkeyPatch(); finalizers.append(mp.undo); kwargs[name] = mp; continue
        if name == 'capsys': kwargs[name] = _Capsys(capbuf); continue
        if name in ('request', 'caplog', 'capfd', 'recwarn', 'pytestconfig', 'mocker', 'event_loop'): raise _NeedsFixture(name)
        if name not in table: raise _NeedsFixture(name)
        fx = table[name]
        value = _cp_call_with_fixtures(fx, table, extra, finalizers, capbuf)
        if inspect.isgenerator(value):
            gen = value; value = next(gen)
            finalizers.append(lambda gen=gen: next(gen, None))
        extra[name] = value
        kwargs[name] = value
    return fn(**kwargs)

def _cp_expand(fn):
    marks = getattr(fn, '_cp_marks', [])
    cases = [({}, '')]
    for name, args, kwargs in marks:
        if name != 'parametrize': continue
        names = args[0] if not isinstance(args[0], str) else [n.strip() for n in args[0].split(',')]
        values = args[1] if len(args) > 1 else kwargs.get('argvalues', [])
        new = []
        for base, label in cases:
            for i, v in enumerate(values):
                marks_v = ()
                if isinstance(v, _Param): marks_v, v = v.marks, v.values if len(names) > 1 else v.values[0]
                vals = v if len(names) > 1 else (v,)
                new.append((dict(base, **dict(zip(names, vals))), (label + '-' if label else '') + str(i)))
        cases = new
    return cases

def cp_tests(job_json):
    job = json.loads(job_json)
    _cp_install_pytest()
    results = []
    capbuf = io.StringIO()
    try:
        with contextlib.redirect_stdout(capbuf):
            mod = _cp_import(job.get('module'), job['path'])
        table = _cp_fixture_table(mod, job['path'])
    except BaseException as e:
        return json.dumps({'registrationError': _cp_err(e), 'tests': []})
    def run(name, fn, line, params=None, instance=None):
        marks = getattr(fn, '_cp_marks', [])
        for m, a, k in marks:
            if m == 'skip' or (m == 'skipif' and a and a[0]):
                results.append({'name': name, 'status': 'skipped', 'durationMs': 0, 'line': line}); return
        xfail = any(m == 'xfail' for m, a, k in marks)
        finalizers = []
        import time as _t
        started = _t.time()
        status, error = 'passed', None
        try:
            with contextlib.redirect_stdout(capbuf):
                target = getattr(instance, fn.__name__) if instance is not None else fn
                if instance is not None and hasattr(instance, 'setup_method'): instance.setup_method(target)
                out = _cp_call_with_fixtures(target, table, {}, finalizers, capbuf, params)
                if inspect.iscoroutine(out):
                    import asyncio
                    asyncio.get_event_loop().run_until_complete(out)
                if instance is not None and hasattr(instance, 'teardown_method'): instance.teardown_method(target)
        except _Skip as e: status = 'skipped'
        except _NeedsFixture as e:
            status, error = 'blocked', {'name': 'CodeProofBlocked', 'message': 'Requires the pytest fixture "%s", which the minimal collector does not provide.' % e.args[0], 'explicit': False}
        except BaseException as e:
            if isinstance(e, KeyboardInterrupt): raise
            status, error = ('xfailed', None) if xfail else ('failed', _cp_err(e))
        finally:
            for f in reversed(finalizers):
                try: f()
                except Exception: pass
        rec = {'name': name, 'status': 'passed' if (xfail and status == 'passed') else status, 'durationMs': int((_t.time() - started) * 1000), 'line': line}
        if error: rec['error'] = error
        results.append(rec)
    for attr, obj in list(vars(mod).items()):
        if getattr(obj, '__module__', None) != mod.__name__: continue
        if inspect.isclass(obj) and issubclass(obj, unittest.TestCase):
            for test in unittest.defaultTestLoader.loadTestsFromTestCase(obj):
                res = unittest.TestResult()
                with contextlib.redirect_stdout(capbuf): test.run(res)
                name = '%s > %s' % (obj.__name__, test._testMethodName)
                line = getattr(getattr(obj, test._testMethodName, None), '__code__', None)
                rec = {'name': name, 'status': 'passed', 'durationMs': 0, 'line': line.co_firstlineno if line else None}
                if res.skipped: rec['status'] = 'skipped'
                problems = res.failures + res.errors
                if problems:
                    rec['status'] = 'failed'
                    text = problems[0][1]
                    rec['error'] = {'name': text.strip().splitlines()[-1].split(':')[0][:80], 'message': text.strip().splitlines()[-1][:1000], 'stack': text[-1500:], 'explicit': False}
                results.append(rec)
        elif inspect.isclass(obj) and attr.startswith('Test') and not hasattr(obj, '__init__') or (inspect.isclass(obj) and attr.startswith('Test') and obj.__init__ is object.__init__):
            for mname, meth in vars(obj).items():
                if mname.startswith('test') and callable(meth):
                    for params, label in _cp_expand(meth):
                        run('%s > %s%s' % (attr, mname, '[' + label + ']' if label else ''), meth, meth.__code__.co_firstlineno, params, obj())
        elif inspect.isfunction(obj) and attr.startswith('test'):
            for params, label in _cp_expand(obj):
                run(attr + ('[' + label + ']' if label else ''), obj, obj.__code__.co_firstlineno, params)
    return json.dumps({'tests': results})
`;

export function codeproofPyWorker() {
  'use strict';
  const scope = typeof self !== 'undefined' ? self : globalThis;
  const postToHost = scope.postMessage.bind(scope);
  let emit = msg => postToHost(msg);
  const clock = () => (scope.performance && scope.performance.now ? scope.performance.now() : Date.now());
  const originalImportScripts = typeof scope.importScripts === 'function' ? scope.importScripts.bind(scope) : null;
  const FAKE_BASE = 'https://codeproof.invalid/pyodide/';
  let py = null;
  let runnerSource = '';

  // Serves Pyodide's own asset requests from verified bytes; everything else fails closed.
  function installAssetShims(assets) {
    const types = { 'pyodide.asm.wasm': 'application/wasm', 'pyodide-lock.json': 'application/json', 'python_stdlib.zip': 'application/zip' };
    const blobUrls = {};
    const nameOf = input => String(input && input.url ? input.url : input).split('?')[0].split('/').pop();
    scope.fetch = async input => {
      const name = nameOf(input);
      if (!assets[name]) return Promise.reject(new Error('Network access is disabled in the CodeProof sandbox'));
      return new Response(assets[name], { status: 200, headers: { 'Content-Type': types[name] || 'text/javascript' } });
    };
    scope.importScripts = (...urls) => {
      for (const url of urls) {
        const name = nameOf(url);
        if (!assets[name]) throw new Error('Script loading is disabled in the CodeProof sandbox');
        blobUrls[name] = blobUrls[name] || URL.createObjectURL(new Blob([assets[name]], { type: 'text/javascript' }));
        originalImportScripts(blobUrls[name]);
      }
    };
    return blobUrls;
  }

  async function init(data) {
    const assets = data.assets || null;
    if (assets && assets['pyodide.js']) { installAssetShims(assets); scope.importScripts(FAKE_BASE + 'pyodide.js'); }
    // pyodide.js declares loadPyodide as a global of the worker (or a test stub provides it).
    const load = globalThis.loadPyodide || scope.loadPyodide;
    if (typeof load !== 'function') throw new Error('Pyodide runtime assets were not provided to the sandbox.');
    py = await load({ indexURL: FAKE_BASE, stdout: () => {}, stderr: () => {}, checkAPIVersion: true });
    // After start-up nothing in the sandbox may load more code or reach the network.
    scope.importScripts = () => { throw new Error('Additional script imports are disabled'); };
    scope.fetch = () => Promise.reject(new Error('Network access is disabled in the CodeProof sandbox'));
    try { Object.defineProperty(scope, 'XMLHttpRequest', { value: undefined }); Object.defineProperty(scope, 'WebSocket', { value: undefined }); } catch (_) { /* ignore */ }
    if (data.runner) { runnerSource = data.runner; py.runPython(runnerSource); }
  }

  function callRunner(fn, ...args) {
    const call = `${fn}(${args.map(a => JSON.stringify(JSON.stringify(a))).join(', ')})`;
    return JSON.parse(py.runPython(call));
  }

  async function handleJob(job) {
    const started = clock();
    try {
      let result;
      if (job.type === 'mount') result = callRunner('cp_mount', job.files, job.roots || ['']);
      else if (job.type === 'compile') result = { files: callRunner('cp_compile', job.paths) };
      else if (job.type === 'load') result = callRunner('cp_load', { modules: job.modules });
      else if (job.type === 'call') result = callRunner('cp_call', { entry: job.entry, module: job.module, functionName: job.functionName, cases: job.cases });
      else if (job.type === 'tests') result = callRunner('cp_tests', { path: job.path, module: job.module });
      else throw new Error('Unknown job type');
      emit({ type: 'job-done', jobId: job.id, result, durationMs: Math.round(clock() - started) });
    } catch (e) { emit({ type: 'job-error', jobId: job.id, error: { name: (e && e.name) || 'Error', message: String((e && e.message) || e).slice(0, 2000) } }); }
  }

  // Protocol v1 (single function run and single-file grammar check) kept for the Execution Lab.
  async function legacy(data) {
    const { id, source, test } = data;
    const start = clock();
    if (data.type === 'syntax') {
      try {
        if (source.length > 250000) throw new Error('Python source exceeds syntax validation limit.');
        py.runPython('import ast\nast.parse(' + JSON.stringify(source) + ')\n"syntax valid"');
        emit({ type: 'result', id, output: { ok: true, value: 'Python grammar valid', logs: [] }, ms: Math.round(clock() - start) });
      } catch (error) { emit({ type: 'result', id, output: { ok: false, error: String((error && error.message) || error), logs: [] }, ms: Math.round(clock() - start) }); }
      return;
    }
    try {
      if (source.length > 250000) throw new Error('Python source exceeds execution limit');
      if (!/^[a-zA-Z_]\w*$/.test(test.functionName)) throw new Error('Invalid function identifier');
      const script = [
        'import json, io, contextlib',
        '__cp_logs = io.StringIO()',
        '__cp_ns = {}',
        'try:',
        '  with contextlib.redirect_stdout(__cp_logs):',
        '    exec(' + JSON.stringify(source) + ', __cp_ns)',
        '    __cp_fn = __cp_ns[' + JSON.stringify(test.functionName) + ']',
        '    __cp_args = json.loads(' + JSON.stringify(JSON.stringify(test.args)) + ')',
        '    __cp_out = __cp_fn(*__cp_args)',
        '    __cp_same = True',
        '    if ' + JSON.stringify(test.kind) + ' == "determinism":',
        '      __cp_same = __cp_out == __cp_fn(*__cp_args)',
        '    if ' + JSON.stringify(test.kind) + ' == "idempotent":',
        '      __cp_same = len(__cp_args) == 1 and __cp_out == __cp_fn(__cp_out)',
        '  try:',
        '    __cp_val = json.loads(json.dumps(__cp_out,allow_nan=False))',
        '  except (ValueError, TypeError, OverflowError):',
        '    __cp_val = repr(__cp_out)',
        '  __cp_outcome = {"ok":True,"value":__cp_val,"same":bool(__cp_same)}',
        'except BaseException as exc:',
        '  __cp_outcome = {"ok":False,"error":type(exc).__name__+": "+str(exc)}',
        '__cp_outcome["logs"] = __cp_logs.getvalue().splitlines()[:20]',
        'json.dumps(__cp_outcome)',
      ].join('\n');
      const output = JSON.parse(py.runPython(script));
      emit({ type: 'result', id, output, ms: Math.round(clock() - start) });
    } catch (e) { emit({ type: 'result', id, output: { ok: false, error: String((e && e.message) || e), logs: [] }, ms: Math.round(clock() - start) }); }
  }

  const dispatch = async data => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'init') {
      try { await init(data); emit({ type: 'ready' }); }
      catch (e) { emit({ type: 'init-error', message: String((e && e.message) || e) }); }
      return;
    }
    if (!py) return;
    if (data.type === 'job') return handleJob(data.job);
    if (data.type === 'run' || data.type === 'syntax') return legacy(data);
  };
  let connected = false;
  scope.onmessage = async ({ data, ports }) => {
    if (!connected && data && data.type === 'connect' && ports && ports[0]) {
      connected = true;
      const port = ports[0];
      emit = msg => port.postMessage(msg);
      port.onmessage = ev => dispatch(ev.data);
      scope.onmessage = null;
      emit({ type: 'connected' });
      return;
    }
    if (!connected) return dispatch(data);
  };
}

export const pyWorkerSource = `(${codeproofPyWorker.toString()})();\n//# sourceURL=codeproof-python-harness.js`;
export const pythonRunnerSource = RUNNER;
