// Whole-project integration analysis: module resolution, the dependency graph, cross-file contracts
// (imports/exports, Python call signatures), manifests, lockfiles, environment templates and asset links.
import { dirname, basename, joinRelative, extname } from './paths.mjs';
import { isNodeBuiltin, PYTHON_STDLIB, PYTHON_IMPORT_ALIASES, TOOLING_PACKAGES, FRAMEWORKS, PY_FRAMEWORKS } from './catalog.mjs';
import { satisfies, packageModel, parseJsonFile, stripJsonComments } from './config.mjs';
import { LineIndex, fnv1a } from './util.mjs';

const JS_EXTS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const ESM_TO_TS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const BUILD_DIR = /^(?:dist|build|out|lib|es|esm|cjs|umd|\.next|public\/build)\//;

export function buildProjectIndex(files, manifest) {
  const loaded = new Map(files.map(f => [f.path, f]));
  const known = new Map();
  for (const m of manifest) if (m.status !== 'skipped' || m.kind !== 'excluded-directory') known.set(m.path, m);
  for (const f of files) if (!known.has(f.path)) known.set(f.path, { path: f.path, status: 'ingested' });
  const lower = new Map();
  for (const p of known.keys()) lower.set(p.toLowerCase(), [...(lower.get(p.toLowerCase()) || []), p]);
  const dirs = new Set();
  for (const p of known.keys()) { let d = dirname(p); while (d && !dirs.has(d)) { dirs.add(d); d = dirname(d); } }
  return { loaded, known, lower, dirs, excluded: manifest.filter(m => m.kind === 'excluded-directory').map(m => m.path) };
}

function lookup(index, candidate) {
  const excluded = index.excluded.find(root => candidate.startsWith(root));
  if (excluded) return { status: 'resolved-unanalyzed', target: candidate, excluded: excluded };
  if (index.known.has(candidate)) return { status: index.known.get(candidate).status === 'ingested' ? 'resolved' : 'resolved-unanalyzed', target: candidate, entry: index.known.get(candidate) };
  const ci = index.lower.get(candidate.toLowerCase());
  if (ci) return { status: 'case-mismatch', target: ci[0] };
  return null;
}

export function resolveJsSpecifier(index, from, rawSpec, ctx = {}) {
  const spec = rawSpec.replace(/[?#].*$/, '');
  if (!spec) return { status: 'unknown' };
  const relative = spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
  if (!relative && !spec.startsWith('/')) {
    if (isNodeBuiltin(spec)) return { status: 'builtin', package: spec.replace(/^node:/, '') };
    for (const alias of ctx.aliases || []) {
      const m = alias.match(spec);
      if (m !== null) {
        for (const target of alias.targets) {
          const r = resolveFile(index, target.replace('*', m));
          if (r) return { ...r, via: `alias ${alias.pattern}` };
        }
        return { status: 'missing', base: alias.targets[0].replace('*', m), via: `alias ${alias.pattern}` };
      }
    }
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    const workspace = ctx.workspacePackages?.get(pkg);
    if (workspace) {
      const sub = spec.slice(pkg.length).replace(/^\//, '');
      const r = sub ? resolveFile(index, joinRelative(workspace.dir, sub)) : resolveFile(index, joinRelative(workspace.dir, workspace.json?.module || workspace.json?.main || 'index'));
      if (r) return { ...r, package: pkg, via: 'workspace package' };
      return { status: 'workspace', package: pkg, target: workspace.path };
    }
    return { status: 'external', package: pkg };
  }
  const base = spec.startsWith('/') ? spec.slice(1) : joinRelative(dirname(from), spec);
  if (base === null) return { status: 'escapes-root' };
  if (spec.endsWith('/') && (base === '' || index.dirs.has(base))) return { status: 'directory', target: base || '.' };
  const r = resolveFile(index, base);
  return r || { status: 'missing', base };
}

function resolveFile(index, base) {
  const ext = extname(base);
  const candidates = [];
  if (ext) candidates.push(base);
  if (ESM_TO_TS['.' + ext]) for (const e of ESM_TO_TS['.' + ext]) candidates.push(base.slice(0, -ext.length - 1) + e);
  for (const e of JS_EXTS) candidates.push(base + e);
  for (const e of JS_EXTS) candidates.push((base ? base + '/' : '') + 'index' + e);
  let caseHit = null;
  for (const c of candidates) {
    const r = lookup(index, c);
    if (r && r.status !== 'case-mismatch') return r;
    if (r && !caseHit) caseHit = r;
  }
  const pkgJson = index.loaded.get((base ? base + '/' : '') + 'package.json');
  if (pkgJson) {
    try {
      const json = JSON.parse(pkgJson.content);
      const main = json.module || json.main;
      if (typeof main === 'string') { const r = resolveFile(index, joinRelative(base, main)); if (r) return r; }
    } catch { /* invalid package.json reported elsewhere */ }
  }
  if (!ext && index.dirs.has(base)) return { status: 'directory-without-index', target: base };
  return caseHit;
}

// ---------------------------------------------------------------- Python module resolution
function pythonRoots(index, pyFiles) {
  const roots = new Set(['']);
  for (const f of pyFiles) {
    let d = dirname(f.path);
    while (d && index.known.has(d + '/__init__.py')) d = dirname(d);
    roots.add(d);
    roots.add(dirname(f.path));
  }
  for (const r of ['src', 'app', 'lib']) if (index.dirs.has(r)) roots.add(r);
  return [...roots];
}

function resolvePyModule(index, roots, dotted) {
  const rel = dotted.split('.').join('/');
  for (const root of roots) {
    const prefix = root ? root + '/' : '';
    for (const c of [prefix + rel + '.py', prefix + rel + '/__init__.py', prefix + rel + '.pyi']) {
      const r = lookup(index, c);
      if (r && r.status !== 'case-mismatch') return { ...r, root };
    }
    if (index.dirs.has(prefix + rel)) return { status: 'namespace-package', target: prefix + rel, root };
  }
  return null;
}

function pythonModuleName(index, path) {
  let root = dirname(path);
  while (root && index.known.has(root + '/__init__.py')) root = dirname(root);
  if (basename(path) === '__init__.py' && root === dirname(path)) root = dirname(root);
  return path.slice(root ? root.length + 1 : 0).replace(/\/__init__\.py$/, '').replace(/\.pyi?$/, '').split('/').join('.');
}

// ---------------------------------------------------------------- main entry
export function analyzeIntegration(ctx) {
  const { files, manifest, perFile } = ctx;
  const index = buildProjectIndex(files, manifest);
  const findings = [], edges = [], checks = [];
  const add = f => findings.push({ scope: 'project', analyzer: 'integration-graph', ...f });
  const excerpt = (path, line) => (line ? new LineIndex(index.loaded.get(path)?.content || '').lineText(line).trim() : '');
  const check = (id, label, status, detail = '') => checks.push({ id, label, status, detail });

  // ---- Manifests and workspace packages
  const packages = [];
  for (const f of files) if (basename(f.path) === 'package.json') { const r = parseJsonFile(f); if (r.ok && r.value && typeof r.value === 'object') packages.push(packageModel(f, r.value)); }
  const workspacePackages = new Map(packages.filter(p => p.name).map(p => [p.name, p]));
  const nearestPackage = path => packages.filter(p => !p.dir || path.startsWith(p.dir + '/')).sort((a, b) => b.dir.length - a.dir.length)[0] || null;
  const aliases = [];
  for (const f of files) {
    if (!/^(?:tsconfig|jsconfig)(?:\.[\w-]+)?\.json$/.test(basename(f.path))) continue;
    try {
      const json = JSON.parse(stripJsonComments(f.content));
      const co = json.compilerOptions || {};
      const baseDir = joinRelative(dirname(f.path), co.baseUrl || '.');
      for (const [pattern, targets] of Object.entries(co.paths || {})) {
        const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('*', '(.*)') + '$');
        aliases.push({ pattern, match: s => { const m = re.exec(s); return m ? (m[1] ?? '') : null; }, targets: (Array.isArray(targets) ? targets : []).map(t => joinRelative(baseDir, t)).filter(Boolean) });
      }
    } catch { /* reported by the config analyzer */ }
  }
  const jsCtx = { aliases, workspacePackages };

  // ---- JS/TS import resolution
  const jsFiles = files.filter(f => (f.language === 'javascript' || f.language === 'typescript') && perFile.get(f.path)?.imports);
  const externalUse = new Map();
  let resolvedCount = 0, unresolvedCount = 0;
  for (const f of jsFiles) {
    for (const imp of perFile.get(f.path).imports) {
      if (!imp.specifier) { edges.push({ from: f.path, to: null, specifier: null, kind: imp.kind, status: 'computed', line: imp.line }); continue; }
      const r = resolveJsSpecifier(index, f.path, imp.specifier, jsCtx);
      const edge = { from: f.path, to: r.target || null, specifier: imp.specifier, kind: imp.kind, status: r.status, line: imp.line, package: r.package || null, typeOnly: imp.kind === 'type' };
      edges.push(edge);
      if (r.status === 'resolved' || r.status === 'resolved-unanalyzed') resolvedCount++;
      if (r.status === 'external') {
        const list = externalUse.get(r.package) || [];
        list.push({ file: f.path, line: imp.line, kind: imp.kind, test: f.kind === 'test' });
        externalUse.set(r.package, list);
      }
      const where = { file: f.path, line: imp.line, column: imp.column, excerpt: excerpt(f.path, imp.line) };
      if (r.status === 'missing' || r.status === 'escapes-root') {
        unresolvedCount++;
        const generated = r.base && BUILD_DIR.test(r.base);
        add({ ...where, rule: 'IMPORT_UNRESOLVED', title: `Cannot resolve "${imp.specifier}"`, category: 'integration', severity: generated ? 'low' : 'high', verification: generated ? 'potential' : 'confirmed-static', dedupeKey: `import-unresolved:${imp.specifier}`, rootCause: r.status === 'escapes-root' ? `The path climbs above the project root.` : `No file matches ${r.base}${extname(r.base) ? '' : ' with any of ' + JS_EXTS.join(', ')} or an index file${r.via ? ` (via ${r.via})` : ''}.${generated ? ' The target is inside a build-output directory, which is usually generated and not committed.' : ''}`, trigger: `Load or bundle ${f.path}.`, actual: 'Module not found at build or run time.', suggestion: 'Correct the specifier or add the missing module.', affected: [f.path] });
      } else if (r.status === 'case-mismatch') {
        add({ ...where, rule: 'IMPORT_CASE_MISMATCH', title: `Import path case differs from the file on disk`, category: 'integration', severity: 'high', verification: 'confirmed-static', priority: 2, dedupeKey: `import-unresolved:${imp.specifier}`, rootCause: `"${imp.specifier}" only matches ${r.target} when letter case is ignored. Case-insensitive file systems (default macOS and Windows) hide this; Linux CI and servers fail with "module not found".`, trigger: 'Build or run on a case-sensitive file system such as Linux.', suggestion: `Change the import to match ${r.target} exactly.`, affected: [f.path, r.target] });
      } else if (r.status === 'directory-without-index') {
        add({ ...where, rule: 'IMPORT_UNRESOLVED', title: `Import points at a directory without an index file`, category: 'integration', severity: 'high', verification: 'confirmed-static', dedupeKey: `import-unresolved:${imp.specifier}`, rootCause: `${r.target}/ exists but contains no index file or package.json entry point.`, suggestion: 'Import a specific file or add an index module.', affected: [f.path] });
      }
      // Static export/import contract (TypeScript adds compiler-backed coverage of the same contract).
      if (r.status === 'resolved' && /\.(?:[mc]?[jt]sx?)$/.test(r.target)) {
        const target = perFile.get(r.target);
        const ex = target?.exports;
        if (!ex || !target.parse?.ok) continue;
        const esmOnly = ex.esm && !ex.cjs && !ex.star.length;
        if ((imp.kind === 'static' || imp.kind === 'reexport') && esmOnly) {
          for (const n of imp.names || []) {
            if (n.imported === 'default' || n.typeOnly || !n.imported) continue;
            if (!ex.named.includes(n.imported) && !ex.typeNamed.includes(n.imported)) add({ ...where, rule: 'IMPORT_MISSING_EXPORT', title: `Imported name "${n.imported}" is not exported`, category: 'integration', severity: 'high', verification: 'high-confidence', dedupeKey: `import-missing:${n.imported}`, rootCause: `${r.target} exports ${ex.named.length ? ex.named.slice(0, 12).join(', ') : 'no named bindings'}${ex.default ? ' and a default export' : ''}, but not "${n.imported}".`, trigger: `Load ${f.path}.`, actual: `SyntaxError: The requested module does not provide an export named '${n.imported}' (native ESM), or undefined after bundling.`, suggestion: 'Export the name from the target module or fix the import.', affected: [f.path, r.target], relatedKeys: [`exports:${r.target}`] });
          }
          if (imp.default && !ex.default) add({ ...where, rule: 'IMPORT_NO_DEFAULT', title: 'Default import from a module without a default export', category: 'integration', severity: 'high', verification: 'high-confidence', dedupeKey: 'import-no-default', rootCause: `${r.target} has only named exports (${ex.named.slice(0, 8).join(', ') || 'none'}).`, actual: `SyntaxError: The requested module does not provide an export named 'default'.`, suggestion: 'Use a named import or add a default export.', affected: [f.path, r.target] });
        }
        if (imp.kind === 'require' && ex.cjs && ex.cjsWhole && !ex.esm && ex.cjsNames.length) {
          for (const n of imp.names || []) if (n.imported && !ex.cjsNames.includes(n.imported)) add({ ...where, rule: 'REQUIRE_MISSING_NAME', title: `Destructured "${n.imported}" is not exported`, category: 'integration', severity: 'high', verification: 'high-confidence', rootCause: `${r.target} assigns module.exports with ${ex.cjsNames.join(', ')}; "${n.imported}" will be undefined.`, actual: `${n.local || n.imported} is undefined at runtime; calling it throws TypeError.`, suggestion: 'Export the property or fix the destructuring.', affected: [f.path, r.target] });
        }
      }
    }
  }
  check('js-resolution', 'JavaScript/TypeScript module resolution', jsFiles.length ? 'completed' : 'not-applicable', `${resolvedCount} local imports resolved, ${unresolvedCount} unresolved`);

  // ---- Python import resolution and cross-module contracts
  const pyFiles = files.filter(f => f.language === 'python' && perFile.get(f.path)?.outline);
  const roots = pythonRoots(index, pyFiles);
  const moduleNames = new Map(pyFiles.map(f => [f.path, pythonModuleName(index, f.path)]));
  const pyExternal = new Map();
  let pyResolved = 0, pyContractChecks = 0;
  for (const f of pyFiles) {
    const out = perFile.get(f.path).outline;
    const importedFns = new Map(); // local name -> {file, fn}
    const importedModules = new Map(); // alias -> file
    for (const imp of out.imports) {
      const where = { file: f.path, line: imp.line, column: imp.column, excerpt: excerpt(f.path, imp.line) };
      let target = null, dotted = imp.module;
      if (imp.level > 0) {
        let base = dirname(f.path);
        for (let k = 1; k < imp.level; k++) { if (!base) { base = null; break; } base = dirname(base); }
        if (base === null) {
          add({ ...where, rule: 'PY_IMPORT_UNRESOLVED', title: 'Relative import beyond the top-level package', category: 'integration', severity: 'high', verification: 'high-confidence', rootCause: `"${'.'.repeat(imp.level)}${imp.module}" climbs above the project root.`, actual: 'ImportError: attempted relative import beyond top-level package', suggestion: 'Use fewer leading dots or an absolute import.' });
          continue;
        }
        const rel = imp.module ? imp.module.split('.').join('/') : '';
        const candidate = rel ? (base ? base + '/' : '') + rel : base;
        target = lookupPy(index, candidate);
        if (!target && rel) {
          add({ ...where, rule: 'PY_IMPORT_UNRESOLVED', title: `Cannot resolve relative import "${'.'.repeat(imp.level)}${imp.module}"`, category: 'integration', severity: 'high', verification: 'high-confidence', rootCause: `No module ${candidate}.py or package ${candidate}/__init__.py exists.`, actual: 'ModuleNotFoundError / ImportError when the module is imported.', suggestion: 'Fix the module path or add the missing module.', affected: [f.path] });
          continue;
        }
      } else {
        const r = resolvePyModule(index, roots, dotted);
        if (r) target = r;
        else {
          const top = dotted.split('.')[0];
          const localTop = resolvePyModule(index, roots, top);
          if (localTop) {
            add({ ...where, rule: 'PY_IMPORT_UNRESOLVED', title: `Module "${dotted}" not found in local package "${top}"`, category: 'integration', severity: 'high', verification: 'high-confidence', rootCause: `"${top}" resolves to ${localTop.target}, but no submodule matches ${dotted}.`, actual: `ModuleNotFoundError: No module named '${dotted}'`, suggestion: 'Correct the module path or add the missing module.', affected: [f.path, localTop.target] });
          } else if (!PYTHON_STDLIB.has(top)) {
            const list = pyExternal.get(top) || [];
            list.push({ file: f.path, line: imp.line });
            pyExternal.set(top, list);
          }
          continue;
        }
      }
      if (!target || target.status === 'case-mismatch') continue;
      pyResolved++;
      edges.push({ from: f.path, to: target.target, specifier: `${'.'.repeat(imp.level)}${imp.module}`, kind: 'python-import', status: target.status, line: imp.line });
      const targetOutline = perFile.get(target.target)?.outline;
      if (imp.kind === 'import' && imp.alias) importedModules.set(imp.alias, target.target);
      if (imp.kind === 'import' && !imp.alias && !imp.module.includes('.')) importedModules.set(imp.module, target.target);
      if (imp.kind !== 'from') continue;
      for (const n of imp.names) {
        if (n.name === '*') continue;
        const pkgDir = target.target.endsWith('__init__.py') ? dirname(target.target) : target.status === 'namespace-package' ? target.target : null;
        const submodule = pkgDir !== null ? lookupPy(index, (pkgDir ? pkgDir + '/' : '') + n.name) : null;
        if (submodule) { edges.push({ from: f.path, to: submodule.target, specifier: `${imp.module}.${n.name}`, kind: 'python-import', status: submodule.status, line: n.line }); importedModules.set(n.alias || n.name, submodule.target); continue; }
        if (!targetOutline) continue;
        const fn = targetOutline.functions.find(x => x.topLevel && x.name === n.name);
        if (fn) importedFns.set(n.alias || n.name, { file: target.target, fn, decorated: targetOutline.decorated.includes(n.name) });
        const definesAll = targetOutline.assignments.includes(n.name);
        const opaque = targetOutline.starImports.length || targetOutline.hasGetattr || !perFile.get(target.target).parse?.ok;
        pyContractChecks++;
        if (!definesAll && !opaque) {
          add({ file: f.path, line: n.line, column: n.column, excerpt: excerpt(f.path, n.line), rule: 'PY_IMPORT_MISSING_NAME', title: `"${n.name}" is not defined in ${moduleNames.get(target.target) || target.target}`, category: 'integration', severity: 'high', verification: 'high-confidence', rootCause: `${target.target} defines ${targetOutline.assignments.slice(0, 15).join(', ') || 'no top-level names'} at module level, but not "${n.name}".`, trigger: `import ${moduleNames.get(f.path)}`, actual: `ImportError: cannot import name '${n.name}' from '${moduleNames.get(target.target)}'`, suggestion: 'Define or re-export the name in the target module, or correct the import.', affected: [f.path, target.target] });
        }
      }
    }
    // Same-file top-level functions are also checked (a defect even without integration).
    for (const fn of out.functions.filter(x => x.topLevel)) if (!importedFns.has(fn.name)) importedFns.set(fn.name, { file: f.path, fn, local: true, decorated: out.decorated.includes(fn.name) });
    const redefined = name => out.functions.filter(x => x.topLevel && x.name === name).length > 1 || (out.imports.some(i => i.names?.some(n => (n.alias || n.name) === name)) && out.functions.some(x => x.topLevel && x.name === name));
    for (const call of out.calls) {
      let target = null;
      if (call.qualifier && importedModules.has(call.qualifier)) {
        const tf = importedModules.get(call.qualifier);
        const fn = perFile.get(tf)?.outline?.functions.find(x => x.topLevel && x.name === call.name);
        if (fn) target = { file: tf, fn, decorated: perFile.get(tf).outline.decorated.includes(call.name) };
      } else if (!call.qualifier) target = importedFns.get(call.name);
      if (!target || target.decorated || redefined(call.name) || call.inScope.includes(call.name)) continue;
      pyContractChecks++;
      const problem = checkPythonCall(target.fn, call.args);
      if (!problem) continue;
      const cross = target.file !== f.path;
      add({ file: f.path, line: call.line, column: call.column, excerpt: excerpt(f.path, call.line), rule: 'PY_CALL_SIGNATURE', title: `${cross ? 'Cross-module call' : 'Call'} does not match the signature of ${target.fn.name}()`, category: cross ? 'integration' : 'logic', severity: 'high', verification: 'high-confidence', rootCause: `${problem} The definition at ${target.file}:${target.fn.line} is def ${target.fn.name}(${target.fn.params.map(p => (p.kind === 'vararg' ? '*' : p.kind === 'kwarg' ? '**' : '') + p.name + (p.hasDefault ? '=…' : '')).join(', ')}).`, trigger: `Execute line ${call.line} of ${f.path}.`, actual: `TypeError: ${target.fn.name}() ${problem.replace(/\.$/, '')}`, suggestion: 'Align the call with the function signature (or update the signature and every caller).', affected: [...new Set([f.path, target.file])], evidence: [`Definition: ${target.file}:${target.fn.line}`] });
    }
  }
  check('py-resolution', 'Python import resolution and call contracts', pyFiles.length ? 'completed' : 'not-applicable', `${pyResolved} local imports resolved, ${pyContractChecks} name/signature checks`);

  // ---- Dependency declarations and lockfiles
  const lockChecks = checkDependencies({ packages, externalUse, nearestPackage, files, add, index, check });
  checkPythonDependencies({ files, pyExternal, add, check, perFile });
  checkPackageTargets({ packages, index, add, perFile, files, check });
  checkEnvTemplates({ files, perFile, add, check });
  checkWebReferences({ files, index, add, check, edges });
  checkSqlSchema({ files, perFile, add, check });
  checkDuplicateCode({ files, perFile, add, check });

  // ---- Cycles (static value imports only)
  const internal = edges.filter(e => e.to && (e.status === 'resolved' || e.status === 'resolved-unanalyzed') && !e.typeOnly && e.kind !== 'dynamic' && e.kind !== 'url-asset');
  const cycles = findCycles(internal);
  for (const cycle of cycles.slice(0, 25)) {
    const first = internal.find(e => e.from === cycle[0] && e.to === cycle[1 % cycle.length]);
    add({ file: cycle[0], line: first?.line || 1, column: 1, rule: 'IMPORT_CYCLE', title: `Circular import across ${cycle.length} modules`, category: 'integration', severity: 'low', verification: 'potential', confidence: 'medium', rootCause: `${[...cycle, cycle[0]].join(' → ')}. Code that runs during module initialization and reads a binding from this cycle can see undefined (CommonJS), a TDZ ReferenceError (ES modules) or a partially initialized module (Python).`, suggestion: 'Move shared definitions into a module with no back-reference, or defer the access until after initialization.', affected: cycle, tags: [`key:cycle:${cycle.join('|')}`] });
  }
  check('cycles', 'Circular dependency detection', internal.length ? 'completed' : 'not-applicable', `${cycles.length} cycle(s)`);

  // ---- Entry points and frameworks
  const entryPoints = discoverEntryPoints({ packages, files, perFile, index, edges });
  const frameworks = new Set();
  for (const p of packages) for (const [dep, label] of FRAMEWORKS) if (p.deps.has(dep)) frameworks.add(label);
  for (const [mod, label] of PY_FRAMEWORKS) if (pyExternal.has(mod) || files.some(f => basename(f.path) === 'manage.py' && mod === 'django')) frameworks.add(label);
  const nodes = files.filter(f => perFile.has(f.path)).map(f => ({ path: f.path, language: f.language, kind: f.kind, out: edges.filter(e => e.from === f.path && e.to).length, in: edges.filter(e => e.to === f.path).length }));
  const externalPackages = [...externalUse.entries()].map(([name, uses]) => ({ name, uses: uses.length, declared: Boolean(nearestPackage(uses[0].file)?.deps.has(name)) })).sort((a, b) => b.uses - a.uses);
  return { findings, graph: { nodes, edges, cycles, entryPoints, frameworks: [...frameworks], packages: packages.map(p => ({ path: p.path, name: p.name, type: p.type, dependencies: p.deps.size })), externalPackages, pythonExternal: [...pyExternal.keys()], pythonRoots: roots, moduleNames: Object.fromEntries(moduleNames) }, checks, lockChecks };
}

function lookupPy(index, candidate) {
  for (const c of [candidate + '.py', candidate + '/__init__.py', candidate + '.pyi']) { const r = lookup(index, c); if (r && r.status !== 'case-mismatch') return r; }
  if (index.dirs.has(candidate)) return { status: 'namespace-package', target: candidate };
  return null;
}

export function checkPythonCall(fn, args) {
  if (args.some(a => a.kind === 'star' || a.kind === 'starstar' || a.kind === 'generator')) return null;
  const params = fn.className ? fn.params.slice(1) : fn.params.filter((p, i) => !(i === 0 && (p.name === 'self' || p.name === 'cls')));
  const positional = params.filter(p => p.kind === 'positional');
  const vararg = params.some(p => p.kind === 'vararg');
  const kwarg = params.some(p => p.kind === 'kwarg');
  const kwonly = params.filter(p => p.kind === 'kwonly');
  const pos = args.filter(a => a.kind === 'positional').length;
  const keywords = args.filter(a => a.kind === 'keyword').map(a => a.name);
  if (pos > positional.length && !vararg) return `takes ${positional.length} positional argument${positional.length === 1 ? '' : 's'} but ${pos} ${pos === 1 ? 'was' : 'were'} given.`;
  const names = new Set([...positional.map(p => p.name), ...kwonly.map(p => p.name)]);
  for (const k of keywords) {
    if (!names.has(k) && !kwarg) return `got an unexpected keyword argument '${k}'.`;
    const idx = positional.findIndex(p => p.name === k);
    if (idx >= 0 && idx < pos) return `got multiple values for argument '${k}'.`;
  }
  const missing = positional.slice(pos).filter(p => !p.hasDefault && !keywords.includes(p.name)).map(p => p.name);
  if (missing.length) return `missing ${missing.length} required positional argument${missing.length === 1 ? '' : 's'}: ${missing.map(m => `'${m}'`).join(' and ')}.`;
  const missingKw = kwonly.filter(p => !p.hasDefault && !keywords.includes(p.name)).map(p => p.name);
  if (missingKw.length) return `missing ${missingKw.length} required keyword-only argument${missingKw.length === 1 ? '' : 's'}: ${missingKw.map(m => `'${m}'`).join(' and ')}.`;
  return null;
}

function findCycles(edges) {
  const adj = new Map();
  for (const e of edges) { if (e.from === e.to) continue; adj.set(e.from, [...(adj.get(e.from) || []), e.to]); }
  let index = 0;
  const stack = [], onStack = new Set(), idx = new Map(), low = new Map(), sccs = [];
  const strong = v => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); onStack.add(v);
    for (const w of adj.get(v) || []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const scc = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); scc.push(w); } while (w !== v);
      if (scc.length > 1) sccs.push(scc.reverse());
    }
  };
  for (const v of adj.keys()) if (!idx.has(v)) strong(v);
  // Present each SCC as a concrete cycle path when possible.
  return sccs.map(scc => {
    const set = new Set(scc);
    const path = [scc[0]];
    const seen = new Set(path);
    let cur = scc[0];
    for (;;) {
      const next = (adj.get(cur) || []).find(n => set.has(n) && !seen.has(n));
      if (!next) break;
      path.push(next); seen.add(next); cur = next;
    }
    return path;
  });
}

function checkDependencies({ packages, externalUse, nearestPackage, files, add, index, check }) {
  let declaredChecks = 0, lockfileChecks = 0;
  for (const [name, uses] of externalUse) {
    const nonTypeUses = uses.filter(u => u.kind !== 'type');
    if (!nonTypeUses.length) continue;
    const pkg = nearestPackage(nonTypeUses[0].file);
    if (!pkg) continue;
    declaredChecks++;
    const dep = pkg.deps.get(name) || packages.find(p => !p.dir && p.deps.has(name))?.deps.get(name);
    const where = { file: nonTypeUses[0].file, line: nonTypeUses[0].line, column: 1 };
    if (!dep) {
      add({ ...where, rule: 'DEP_UNDECLARED', title: `"${name}" is imported but not declared in ${pkg.path}`, category: 'dependency', severity: 'high', verification: 'high-confidence', rootCause: `${nonTypeUses.length} import(s) of "${name}" (first in ${nonTypeUses[0].file}) have no matching entry in dependencies, devDependencies, peerDependencies or optionalDependencies of ${pkg.path}. It only works if another package happens to install it.`, actual: `Error: Cannot find module '${name}' after a clean install.`, suggestion: `Add "${name}" to ${pkg.path} with the version you test against.`, affected: [...new Set(nonTypeUses.map(u => u.file))].slice(0, 10) });
    } else if (dep.kind === 'dev' && nonTypeUses.some(u => !u.test && !/(?:^|\/)(?:scripts?|tools?|config|\.storybook|e2e|cypress|tests?|__tests__)\//.test(u.file) && !/\.config\.[cm]?[jt]s$|\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(u.file))) {
      const u = nonTypeUses.find(x => !x.test);
      add({ file: u.file, line: u.line, column: 1, rule: 'DEP_DEV_IN_RUNTIME', title: `Runtime code imports devDependency "${name}"`, category: 'dependency', severity: 'low', verification: 'potential', rootCause: `"${name}" is a devDependency but ${u.file} imports it. Production installs (npm install --omit=dev) will not include it unless it is bundled.`, suggestion: 'Move it to dependencies if it is needed at run time, or confirm it is bundled.' });
    }
  }
  for (const pkg of packages) {
    const used = new Set(externalUse.keys());
    const scriptsText = Object.values(pkg.scripts).join(' ') + ' ' + files.filter(f => f.kind === 'config').map(f => f.content).join(' ').slice(0, 200000);
    for (const dep of pkg.deps.values()) {
      if (dep.kind !== 'prod' || used.has(dep.name) || TOOLING_PACKAGES.test(dep.name) || scriptsText.includes(dep.name)) continue;
      if (![...externalUse.keys()].length) continue;
      add({ file: pkg.path, line: lineOfKey(index, pkg.path, dep.name), column: 1, rule: 'DEP_UNUSED', title: `Dependency "${dep.name}" is never imported`, category: 'dependency', severity: 'info', verification: 'quality', rootCause: `No analyzed source file imports "${dep.name}" and no script or config mentions it. It may be loaded dynamically or by a framework convention.`, suggestion: 'Remove it if unused to reduce install size and attack surface.' });
    }
    // npm lockfile consistency.
    const lockPath = (pkg.dir ? pkg.dir + '/' : '') + 'package-lock.json';
    const lock = index.loaded.get(lockPath);
    if (!lock) continue;
    let json;
    try { json = JSON.parse(lock.content); } catch { add({ file: lockPath, line: 1, column: 1, rule: 'LOCKFILE_INVALID', title: 'package-lock.json is not valid JSON', category: 'dependency', severity: 'high', verification: 'confirmed-static', rootCause: 'npm ci cannot read the lockfile.', suggestion: 'Regenerate it with npm install.' }); continue; }
    const lockPackages = json.packages || {};
    for (const dep of pkg.deps.values()) {
      if (dep.kind === 'peer') continue;
      lockfileChecks++;
      const entry = lockPackages[`node_modules/${dep.name}`];
      const version = entry?.version || json.dependencies?.[dep.name]?.version;
      if (!version) {
        if (dep.kind === 'optional') continue;
        add({ file: lockPath, line: 1, column: 1, rule: 'LOCKFILE_MISSING', title: `${dep.name} is missing from package-lock.json`, category: 'dependency', severity: 'medium', verification: 'high-confidence', rootCause: `${pkg.path} declares ${dep.name}@${dep.range}, but the lockfile has no entry for it.`, actual: 'npm ci fails: package.json and package-lock.json are out of sync.', suggestion: 'Run npm install and commit the updated lockfile.', affected: [pkg.path, lockPath] });
        continue;
      }
      const ok = satisfies(version, dep.range);
      if (ok === false) add({ file: lockPath, line: lineOfKey(index, lockPath, `node_modules/${dep.name}`), column: 1, rule: 'LOCKFILE_MISMATCH', title: `Locked ${dep.name}@${version} does not satisfy "${dep.range}"`, category: 'dependency', severity: 'medium', verification: 'high-confidence', rootCause: `${pkg.path} requires ${dep.name}@${dep.range}, but package-lock.json pins ${version}.`, actual: 'npm ci fails because package.json and package-lock.json are out of sync.', suggestion: 'Run npm install to refresh the lockfile, or align the declared range.', affected: [pkg.path, lockPath] });
    }
  }
  check('dependencies', 'Declared dependency verification', packages.length ? 'completed' : 'not-applicable', `${declaredChecks} external packages checked against manifests, ${lockfileChecks} lockfile entries checked`);
  if (files.some(f => ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock'].includes(basename(f.path)))) check('lockfile-other', 'yarn/pnpm/bun lockfile consistency', 'unsupported', 'Only package-lock.json is parsed.');
  return { declaredChecks, lockfileChecks };
}

function checkPythonDependencies({ files, pyExternal, add, check, perFile }) {
  const reqFiles = files.filter(f => perFile.get(f.path)?.facts?.requirements);
  if (!reqFiles.length) { check('py-dependencies', 'Python dependency declarations', pyExternal.size ? 'skipped' : 'not-applicable', pyExternal.size ? 'No requirements.txt or pyproject.toml to compare against.' : ''); return; }
  const declared = new Set(reqFiles.flatMap(f => perFile.get(f.path).facts.requirements.map(r => r.name)));
  let checked = 0;
  for (const [mod, uses] of pyExternal) {
    checked++;
    const alias = PYTHON_IMPORT_ALIASES[mod];
    const candidates = [mod.toLowerCase().replace(/_/g, '-'), alias].filter(Boolean);
    if (candidates.some(c => declared.has(c) || (c.endsWith('*') && [...declared].some(d => d.startsWith(c.slice(0, -1)))))) continue;
    add({ file: uses[0].file, line: uses[0].line, column: 1, rule: 'PY_DEP_UNDECLARED', title: `Third-party module "${mod}" is not declared`, category: 'dependency', severity: 'medium', verification: 'potential', confidence: 'medium', rootCause: `"${mod}" is neither in the Python standard library nor in ${reqFiles.map(f => f.path).join(', ')}. Distribution names can differ from import names, so confirm before acting.`, actual: `ModuleNotFoundError: No module named '${mod}' in a fresh environment.`, suggestion: `Declare the distribution that provides "${mod}".` });
  }
  check('py-dependencies', 'Python dependency declarations', 'completed', `${checked} third-party modules compared with ${declared.size} declared distributions`);
}

function lineOfKey(index, path, key) {
  const content = index.loaded.get(path)?.content || '';
  const i = content.indexOf(`"${key}"`);
  return i < 0 ? 1 : content.slice(0, i).split('\n').length;
}

function checkPackageTargets({ packages, index, add, perFile, files, check }) {
  let checked = 0;
  for (const pkg of packages) {
    const hasBuild = Object.keys(pkg.scripts).some(k => /build|compile|prepare|prepublish/.test(k));
    const targets = [];
    for (const field of ['main', 'module', 'types', 'typings', 'browser']) if (typeof pkg.json[field] === 'string') targets.push([field, pkg.json[field]]);
    if (typeof pkg.json.bin === 'string') targets.push(['bin', pkg.json.bin]);
    else if (pkg.json.bin && typeof pkg.json.bin === 'object') for (const [k, v] of Object.entries(pkg.json.bin)) if (typeof v === 'string') targets.push([`bin.${k}`, v]);
    const walkExports = (value, label) => {
      if (typeof value === 'string') { if (value.startsWith('./') && !value.includes('*')) targets.push([label, value]); }
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkExports(v, `${label}[${k}]`);
    };
    walkExports(pkg.json.exports, 'exports');
    for (const [field, target] of targets) {
      checked++;
      const path = joinRelative(pkg.dir, target);
      if (path === null) continue;
      const r = lookup(index, path) || (extname(path) ? null : resolveFile(index, path));
      if (r && r.status !== 'case-mismatch') continue;
      const generated = BUILD_DIR.test(path.slice(pkg.dir ? pkg.dir.length + 1 : 0)) && hasBuild;
      add({ file: pkg.path, line: lineOfKey(index, pkg.path, field.split(/[.[]/)[0]), column: 1, rule: 'PKG_MISSING_ENTRY', title: `package.json "${field}" points to a missing file`, category: 'config', severity: generated ? 'info' : 'high', verification: generated ? 'potential' : 'confirmed-static', rootCause: `"${field}": "${target}" resolves to ${path}, which ${r?.status === 'case-mismatch' ? `only exists with different letter case (${r.target})` : 'does not exist in the project'}.${generated ? ' It is inside a build-output directory and a build script exists, so it is probably generated.' : ''}`, actual: generated ? 'Fails only if the package is used without building.' : 'Importing or running the package fails with "Cannot find module".', suggestion: 'Point the field at an existing file or add the build step that produces it.', affected: [pkg.path] });
    }
    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (typeof command !== 'string') continue;
      for (const m of command.matchAll(/\b(?:node|nodemon|ts-node|tsx|bun|deno run|python3?|py)\s+(?:--?[\w-]+(?:[= ][^\s-][^\s]*)?\s+)*([^\s&|;'"]+\.(?:[cm]?[jt]sx?|py))/g)) {
        checked++;
        const path = joinRelative(pkg.dir, m[1]);
        if (!path || lookup(index, path)?.status?.startsWith('resolved')) continue;
        add({ file: pkg.path, line: lineOfKey(index, pkg.path, name), column: 1, rule: 'PKG_SCRIPT_MISSING_FILE', title: `Script "${name}" runs a missing file`, category: 'config', severity: 'medium', verification: 'high-confidence', rootCause: `"${name}": "${command}" references ${m[1]}, which is not in the project.`, actual: `npm run ${name} fails with "Cannot find module".`, suggestion: 'Fix the path in the script.' });
      }
    }
    // Module-format mismatch: CommonJS syntax inside an ES-module package.
    if (pkg.type === 'module') {
      for (const f of files) {
        if (f.language !== 'javascript' || !/\.js$/.test(f.path) || (pkg.dir && !f.path.startsWith(pkg.dir + '/')) || f.kind === 'generated' || f.kind === 'config') continue;
        const info = perFile.get(f.path);
        if (!info?.exports || info.exports.esm) continue;
        const usesRequire = info.imports?.some(i => i.kind === 'require');
        if (!info.exports.cjs && !usesRequire) continue;
        const line = info.imports?.find(i => i.kind === 'require')?.line || 1;
        add({ file: f.path, line, column: 1, rule: 'MODULE_FORMAT_MISMATCH', title: 'CommonJS code in an ES-module package', category: 'integration', severity: 'high', verification: 'high-confidence', rootCause: `${pkg.path} sets "type": "module", so Node treats ${f.path} as an ES module, but it uses ${usesRequire ? 'require()' : 'module.exports'}.`, actual: `ReferenceError: ${usesRequire ? 'require' : 'module'} is not defined in ES module scope`, trigger: `Run or import ${f.path} with Node.`, suggestion: 'Rename the file to .cjs or convert it to import/export.', affected: [f.path, pkg.path] });
      }
    }
  }
  check('package-targets', 'package.json entry points and scripts', packages.length ? 'completed' : 'not-applicable', `${checked} referenced paths checked`);
}

function checkEnvTemplates({ files, perFile, add, check }) {
  const used = new Map();
  for (const f of files) for (const k of perFile.get(f.path)?.envKeys || perFile.get(f.path)?.outline?.envKeys || []) if (!used.has(k.key)) used.set(k.key, { file: f.path, line: k.line });
  const templates = files.filter(f => perFile.get(f.path)?.facts?.envTemplate);
  if (!templates.length) { check('env', 'Environment variable templates', used.size ? 'skipped' : 'not-applicable', used.size ? `${used.size} environment variables read; no .env.example template to compare.` : ''); return; }
  const declared = new Map();
  for (const t of templates) for (const k of perFile.get(t.path).facts.envKeys) declared.set(k.key, { file: t.path, line: k.line });
  const builtins = /^(?:NODE_ENV|PORT|HOME|PATH|CI|PWD|USER|SHELL|TZ|LANG|DEBUG|HOSTNAME|TERM|VERCEL|NETLIFY|GITHUB_\w+|npm_\w+|VITE_\w*MODE|MODE|DEV|PROD|SSR|BASE_URL)$/;
  for (const [key, where] of used) {
    if (declared.has(key) || builtins.test(key)) continue;
    add({ file: where.file, line: where.line, column: 1, rule: 'ENV_UNDOCUMENTED', title: `Environment variable ${key} is read but not in the template`, category: 'config', severity: 'low', verification: 'potential', rootCause: `${where.file} reads ${key}, but ${templates.map(t => t.path).join(', ')} does not list it, so deployments configured from the template leave it undefined.`, suggestion: `Add ${key} to the environment template or provide a default.`, affected: [where.file, ...templates.map(t => t.path)] });
  }
  for (const [key, where] of declared) if (!used.has(key)) add({ file: where.file, line: where.line, column: 1, rule: 'ENV_UNUSED', title: `Template variable ${key} is never read`, category: 'config', severity: 'info', verification: 'quality', rootCause: `No analyzed JavaScript, TypeScript or Python file reads ${key}. It may be consumed by tooling outside the analyzed code, or be a stale/misspelled key.`, suggestion: 'Remove the stale key or fix the consumer\'s spelling.' });
  check('env', 'Environment variable templates', 'completed', `${used.size} variables read, ${declared.size} declared`);
}

function checkWebReferences({ files, index, add, check, edges }) {
  let refs = 0;
  const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{|\$|data:|mailto:)/i;
  const visit = (file, value, line, kind) => {
    const clean = value.trim().replace(/[?#].*$/, '');
    if (!clean || external.test(clean) || clean.includes('{{') || clean.includes('${') || clean.includes('<%')) return;
    refs++;
    const candidates = clean.startsWith('/') ? [clean.slice(1), joinRelative(dirname(file.path), '.' + clean)] : [joinRelative(dirname(file.path), clean)];
    for (const c of candidates) { if (c === null) continue; const r = lookup(index, c) || (index.dirs.has(c) && kind === 'link' ? { status: 'resolved' } : null); if (r && r.status !== 'case-mismatch') { if (r.target && /\.(?:[cm]?js|ts)$/.test(r.target)) edges.push({ from: file.path, to: r.target, specifier: value, kind: 'html-script', status: r.status, line }); return; } }
    const generated = BUILD_DIR.test(candidates[0] || '') || /(?:^|\/)(?:dist|build)\//.test(clean);
    add({ file: file.path, line, column: 1, excerpt: new LineIndex(file.content).lineText(line).trim(), rule: 'BROKEN_REFERENCE', title: `Referenced ${kind} "${value}" does not exist`, category: 'integration', severity: generated ? 'low' : kind === 'script' || kind === 'stylesheet' ? 'high' : 'medium', verification: generated ? 'potential' : 'high-confidence', rootCause: `${file.path} references ${clean}, which is not part of the project${clean.startsWith('/') ? ' (root-relative paths were resolved against the project root and the file\'s directory)' : ''}.`, actual: 'The browser receives HTTP 404 for this resource.', suggestion: 'Correct the path or add the missing asset.', affected: [file.path] });
  };
  for (const f of files) {
    if (f.language === 'html' || f.language === 'vue' || f.language === 'svelte') {
      const lines = new LineIndex(f.content);
      for (const m of f.content.matchAll(/<(script|link|img|source|iframe|video|audio)\b[^>]*?\s(src|href)\s*=\s*(["'])([^"']+)\3[^>]*>/gi)) {
        const tag = m[1].toLowerCase();
        const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1] || '';
        if (tag === 'link' && /preconnect|dns-prefetch|canonical|alternate/i.test(rel)) continue;
        visit(f, m[4], lines.position(m.index).line, tag === 'script' ? 'script' : tag === 'link' && /stylesheet/i.test(rel) ? 'stylesheet' : tag === 'link' ? 'link' : 'asset');
      }
    }
    if (f.language === 'css' || f.language === 'scss') {
      const lines = new LineIndex(f.content);
      for (const m of f.content.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(["'])([^"']+)\3/g)) visit(f, m[2] || m[4], lines.position(m.index).line, 'stylesheet asset');
    }
  }
  check('web-references', 'HTML/CSS asset references', refs ? 'completed' : 'not-applicable', `${refs} local references checked`);
}

function checkSqlSchema({ files, perFile, add, check }) {
  const schema = new Map();
  for (const f of files) {
    if (f.language !== 'sql') continue;
    for (const m of f.content.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?[`"[]?(\w+)[`"\]]?\s*\(([\s\S]*?)\)\s*;/gi)) {
      const cols = new Set();
      for (const line of m[2].split(/,(?![^(]*\))/)) { const c = /^\s*[`"[]?(\w+)[`"\]]?\s+\w/.exec(line); if (c && !/^(?:primary|foreign|unique|constraint|check|key|index)$/i.test(c[1])) cols.add(c[1].toLowerCase()); }
      schema.set(m[1].toLowerCase(), { cols, file: f.path });
    }
    for (const m of f.content.matchAll(/alter\s+table\s+[`"[]?(\w+)[`"\]]?\s+add\s+(?:column\s+)?[`"[]?(\w+)/gi)) schema.get(m[1].toLowerCase())?.cols.add(m[2].toLowerCase());
  }
  if (!schema.size) { check('sql-schema', 'SQL queries against schema files', 'not-applicable', 'No CREATE TABLE statements found.'); return; }
  let queries = 0;
  for (const f of files) {
    if (!['javascript', 'typescript', 'python'].includes(f.language)) continue;
    const lines = new LineIndex(f.content);
    for (const m of f.content.matchAll(/(["'`])((?:select|insert\s+into|update|delete\s+from)\s[^"'`]{5,400})\1/gi)) {
      const sql = m[2];
      queries++;
      const table = (/\bfrom\s+[`"]?(\w+)/i.exec(sql) || /\binsert\s+into\s+[`"]?(\w+)/i.exec(sql) || /^\s*update\s+[`"]?(\w+)/i.exec(sql))?.[1]?.toLowerCase();
      if (!table) continue;
      const line = lines.position(m.index).line;
      const def = schema.get(table);
      if (!def) { add({ file: f.path, line, column: 1, excerpt: lines.lineText(line).trim(), rule: 'SQL_UNKNOWN_TABLE', title: `Query references table "${table}" that no schema file defines`, category: 'integration', severity: 'medium', verification: 'potential', confidence: 'medium', rootCause: `The project's SQL files define ${[...schema.keys()].slice(0, 10).join(', ')}, but not "${table}". The table may be created by migrations or an ORM outside the analyzed files.`, suggestion: 'Confirm the table name or add its schema.' }); continue; }
      const cols = [];
      const sel = /^\s*select\s+([\s\S]+?)\s+from\s/i.exec(sql);
      if (sel && !/\*|\(/.test(sel[1])) for (const c of sel[1].split(',')) { const n = c.trim().split(/\s+/)[0].split('.').pop().replace(/[`"]/g, ''); if (/^\w+$/.test(n)) cols.push(n.toLowerCase()); }
      const ins = /insert\s+into\s+[`"]?\w+[`"]?\s*\(([^)]+)\)/i.exec(sql);
      if (ins) for (const c of ins[1].split(',')) cols.push(c.trim().replace(/[`"]/g, '').toLowerCase());
      const upd = /^\s*update\s+\S+\s+set\s+([\s\S]+?)(?:\swhere\s|$)/i.exec(sql);
      if (upd) for (const c of upd[1].split(',')) { const n = /^\s*[`"]?(\w+)/.exec(c)?.[1]; if (n) cols.push(n.toLowerCase()); }
      for (const w of sql.matchAll(/\bwhere\s+[`"]?(\w+)[`"]?\s*(?:=|<|>|like|in\b|is\b)/gi)) cols.push(w[1].toLowerCase());
      const unknown = [...new Set(cols)].filter(c => !def.cols.has(c) && !/^\d/.test(c));
      if (unknown.length) add({ file: f.path, line, column: 1, excerpt: lines.lineText(line).trim(), rule: 'SQL_UNKNOWN_COLUMN', title: `Query uses column${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} not defined on "${table}"`, category: 'integration', severity: 'high', verification: 'high-confidence', confidence: 'medium', rootCause: `${def.file} defines ${table}(${[...def.cols].join(', ')}). The query references ${unknown.join(', ')}.`, actual: 'The database rejects the statement with an unknown-column error.', suggestion: 'Fix the column name or add a migration for it.', affected: [f.path, def.file] });
    }
  }
  check('sql-schema', 'SQL queries against schema files', 'completed', `${queries} embedded queries checked against ${schema.size} tables`);
}

function checkDuplicateCode({ files, perFile, add, check }) {
  const seen = new Map();
  let compared = 0;
  for (const f of files) {
    for (const fn of perFile.get(f.path)?.functions || []) {
      if (!fn.endLine || fn.endLine - fn.line < 6) continue;
      const body = f.content.split('\n').slice(fn.line - 1, fn.endLine).join('\n').replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ').replace(new RegExp(`\\b${fn.name}\\b`, 'g'), 'F');
      if (body.length < 200) continue;
      compared++;
      const key = fnv1a(body);
      const prev = seen.get(key);
      if (prev && prev.file !== f.path) add({ file: f.path, line: fn.line, column: 1, rule: 'DUPLICATE_CODE', title: `${fn.name} duplicates ${prev.name} in ${prev.file}`, category: 'quality', severity: 'info', verification: 'quality', rootCause: `The bodies of ${f.path}:${fn.line} and ${prev.file}:${prev.line} are identical after whitespace normalization; fixes applied to one copy can miss the other.`, suggestion: 'Extract the shared logic into one module.', affected: [f.path, prev.file] });
      else if (!prev) seen.set(key, { file: f.path, line: fn.line, name: fn.name });
    }
  }
  check('duplicates', 'Duplicated function bodies across files', compared ? 'completed' : 'not-applicable', `${compared} function bodies compared`);
}

function discoverEntryPoints({ packages, files, perFile, index, edges }) {
  const out = [];
  const push = (path, reason) => { if (path && !out.some(e => e.path === path)) out.push({ path, reason }); };
  for (const p of packages) {
    for (const field of ['main', 'module', 'browser']) if (typeof p.json[field] === 'string') { const r = resolveFile(index, joinRelative(p.dir, p.json[field]) || ''); if (r?.target) push(r.target, `package.json ${field}`); }
    const bins = typeof p.json.bin === 'string' ? { [p.name]: p.json.bin } : p.json.bin || {};
    for (const v of Object.values(bins)) if (typeof v === 'string') { const r = resolveFile(index, joinRelative(p.dir, v) || ''); if (r?.target) push(r.target, 'package.json bin'); }
  }
  for (const e of edges) if (e.kind === 'html-script' && e.to) push(e.to, `script tag in ${e.from}`);
  for (const f of files) {
    if (f.language === 'python' && perFile.get(f.path)?.outline?.mainGuard) push(f.path, 'Python __main__ guard');
    if (/(?:^|\/)(?:manage|app|main|wsgi|asgi)\.py$/.test(f.path)) push(f.path, 'conventional Python entry module');
    if (/^(?:src\/)?(?:index|main|server|app|cli)\.[cm]?[jt]sx?$/.test(f.path)) push(f.path, 'conventional entry module name');
    if (f.language === 'go' && /^package main\b/m.test(f.content) && /\bfunc main\(\)/.test(f.content)) push(f.path, 'Go main package');
    if (/(?:^|\/)src\/main\.rs$/.test(f.path)) push(f.path, 'Cargo binary entry');
  }
  return out.slice(0, 50);
}
