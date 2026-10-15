// Whole-program TypeScript/JavaScript checking with the real TypeScript 5.8 compiler over an in-memory
// file system. TypeScript files receive genuine compiler diagnostics; JavaScript files are checked with
// checkJs and only a curated set of high-signal diagnostics is reported (the rest are counted, not hidden).
import { dirname } from './paths.mjs';
import { LineIndex } from './util.mjs';

const ROOT = '/project/';
const LIB_ROOT = '/__lib__/';
export const DEFAULT_LIBS = ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'];

// Diagnostics that indicate missing typings for the execution environment rather than code defects.
const ENVIRONMENT_CODES = new Set([2580, 2581, 2582, 2591, 2592, 2593, 2867, 2868]);
const ENVIRONMENT_GLOBALS = new Set(['require', 'module', 'exports', 'process', 'Buffer', '__dirname', '__filename', 'global', 'describe', 'it', 'test', 'expect', 'jest', 'vi', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'suite', 'context', 'cy', 'Cypress', '$', 'jQuery', 'chrome', 'browser', 'Deno', 'Bun', 'gtag', 'dataLayer', 'google', 'React', 'JSX', 'NodeJS']);
const MODULE_NOT_FOUND = new Set([2307, 2792, 2834, 2835]);
const EXPORT_MISMATCH = new Set([2305, 2614, 2724, 2459, 2460, 1192, 2613, 1259, 2497, 2498]);
// High-signal diagnostics reported for JavaScript under checkJs.
const JS_REPORTED = new Set([2304, 2552, 2554, 2555, 2349, 2351, 2451, 2300, 2393, 2367, 2588, 2630, 2695, 7027, 7029, 2448, 2454, 2585, 2365, 2362, 2363, 2356, 2357, 2531, 2532, 2533, 18047, 18048, 2722, 2721, 1308, 1232, 2741, 2350, 18046, 2774, 2801, 2845, 2839]);
const QUALITY_CODES = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205, 7027]);

export async function loadLibClosure(names, fetchLib) {
  const loaded = new Map();
  const queue = [...names];
  while (queue.length) {
    const name = queue.shift();
    if (loaded.has(name)) continue;
    const text = await fetchLib(name);
    if (typeof text !== 'string') throw new Error(`TypeScript lib file ${name} is unavailable.`);
    loaded.set(name, text);
    for (const m of text.matchAll(/^\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/gm)) queue.push(`lib.${m[1].toLowerCase()}.d.ts`);
  }
  return loaded;
}

export function libFileNamesFor(ts, options) {
  if (options.noLib) return [];
  if (Array.isArray(options.lib) && options.lib.length) return options.lib.map(l => (l.startsWith('lib.') ? l : ts.libMap.get(String(l).toLowerCase()) || `lib.${String(l).toLowerCase()}.d.ts`));
  return DEFAULT_LIBS;
}

const sourceFileCache = new Map();

function classify(code, isJs, specifier, message) {
  if (MODULE_NOT_FOUND.has(code)) return specifier && /^\.{1,2}\//.test(specifier) ? 'unresolved-relative' : 'unresolved-external';
  if (ENVIRONMENT_CODES.has(code)) return 'environment';
  if ((code === 2304 || code === 2552 || code === 2503 || code === 2694) && ENVIRONMENT_GLOBALS.has((message.match(/name(?:space)? '([^'.]+)/) || [])[1])) return 'environment';
  if (EXPORT_MISMATCH.has(code)) return 'export-mismatch';
  if (QUALITY_CODES.has(code)) return 'quality';
  if (isJs && !JS_REPORTED.has(code)) return 'suppressed';
  return 'report';
}

function describeCode(code) {
  if (code === 2304 || code === 2552) return { category: 'runtime', title: 'Reference to an undeclared name', severity: 'high' };
  if (code === 2554 || code === 2555) return { category: 'type', title: 'Wrong number of arguments', severity: 'high' };
  if (code === 2345) return { category: 'type', title: 'Argument type mismatch', severity: 'medium' };
  if (code === 2322) return { category: 'type', title: 'Type mismatch in assignment or return', severity: 'medium' };
  if (code === 2339) return { category: 'type', title: 'Property does not exist on type', severity: 'medium' };
  if (code === 2349 || code === 2351) return { category: 'runtime', title: 'Value is not callable', severity: 'high' };
  if (code === 2531 || code === 2532 || code === 2533 || code === 18047 || code === 18048) return { category: 'runtime', title: 'Possibly null or undefined value dereferenced', severity: 'medium' };
  if (code === 2367) return { category: 'logic', title: 'Comparison that can never be true', severity: 'medium' };
  if (code === 2588 || code === 2630) return { category: 'runtime', title: 'Assignment to a constant', severity: 'high' };
  if (code === 2451 || code === 2300 || code === 2393) return { category: 'compile', title: 'Duplicate declaration', severity: 'high' };
  if (code === 2448 || code === 2454) return { category: 'runtime', title: 'Variable used before assignment', severity: 'high' };
  if (code === 7027) return { category: 'logic', title: 'Unreachable code', severity: 'low' };
  if (code === 7029) return { category: 'logic', title: 'Switch case falls through', severity: 'low' };
  if (code === 7030) return { category: 'logic', title: 'Not all code paths return a value', severity: 'medium' };
  if (code === 2741) return { category: 'type', title: 'Required property missing', severity: 'medium' };
  if (code === 2801 || code === 2774 || code === 2845 || code === 2839) return { category: 'logic', title: 'Condition is always true or false', severity: 'medium' };
  if (code >= 1000 && code < 2000) return { category: 'syntax', title: 'TypeScript syntax error', severity: 'high' };
  if (code >= 5000 && code < 7000) return { category: 'config', title: 'Compiler configuration error', severity: 'medium' };
  return { category: 'type', title: 'TypeScript compiler error', severity: 'medium' };
}

// files: ingested project files (JS/TS sources + tsconfig/package.json); libs: Map(name -> text)
// hostFiles: every loaded text file (including generated/vendored code) so imports of them resolve;
// isKnownElsewhere(from, specifier) reports specifiers that point at files which exist but were not loaded.
export function runTypeScriptProgram(ts, files, { libs, signal, deadlineMs = 60000, tsconfigPath = null, existingPaths = new Set(), maxFiles = 3000, hostFiles = files, isKnownElsewhere = (_from, _specifier) => false } = {}) {
  const started = Date.now();
  const byPath = new Map(hostFiles.map(f => [f.path, f]));
  const codeFiles = files.filter(f => (f.language === 'javascript' || f.language === 'typescript') && f.kind !== 'generated').slice(0, maxFiles);
  const findings = [];
  const stats = { files: codeFiles.length, tsFiles: 0, jsFiles: 0, reported: 0, suppressedJs: 0, environment: 0, unresolvedExternal: new Map(), configErrors: 0, timedOut: false, libsLoaded: libs?.size || 0, filesChecked: 0 };
  let options = {
    allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, strict: false, skipLibCheck: true,
    esModuleInterop: true, allowSyntheticDefaultImports: true, resolveJsonModule: true, allowImportingTsExtensions: true,
    noFallthroughCasesInSwitch: true, noImplicitReturns: true, allowUnreachableCode: false, noUnusedLocals: true,
    types: [], maxNodeModuleJsDepth: 0, isolatedModules: false, allowArbitraryExtensions: true,
  };
  // Apply the root tsconfig.json (if present) on top of the defaults.
  const tsconfig = tsconfigPath ? byPath.get(tsconfigPath) : null;
  if (tsconfig) {
    const parsedJson = ts.parseConfigFileTextToJson(ROOT + tsconfig.path, tsconfig.content);
    if (parsedJson.error) {
      stats.configErrors++;
      findings.push(diagToFinding(ts, parsedJson.error, tsconfig.path, tsconfig.content, { verification: 'confirmed-static', category: 'config', title: 'tsconfig.json cannot be parsed' }));
    } else {
      const host = {
        useCaseSensitiveFileNames: true,
        readDirectory: () => codeFiles.map(f => ROOT + f.path),
        fileExists: p => byPath.has(p.replace(ROOT, '')),
        readFile: p => byPath.get(p.replace(ROOT, ''))?.content,
      };
      const parsed = ts.parseJsonConfigFileContent(parsedJson.config, host, ROOT + dirname(tsconfig.path), undefined, ROOT + tsconfig.path);
      for (const d of parsed.errors || []) {
        if (d.code === 18003) continue; // "No inputs were found" is expected with our virtual readDirectory
        stats.configErrors++;
        const f = diagToFinding(ts, d, tsconfig.path, tsconfig.content, { verification: 'confirmed-static', category: 'config', title: 'Invalid tsconfig.json setting' });
        f.rule = 'TSCONFIG';
        findings.push(f);
      }
      const keep = { ...parsed.options };
      for (const key of ['outDir', 'outFile', 'declarationDir', 'rootDir', 'composite', 'incremental', 'tsBuildInfoFile', 'declaration', 'sourceMap', 'emitDeclarationOnly', 'plugins']) delete keep[key];
      options = { ...options, ...keep, noEmit: true, skipLibCheck: true, types: keep.types || [], allowJs: keep.allowJs ?? true, checkJs: keep.checkJs ?? true, noUnusedLocals: keep.noUnusedLocals ?? true };
    }
  }
  const libNames = libFileNamesFor(ts, options);
  const libFiles = new Map();
  for (const [name, text] of libs || []) libFiles.set(LIB_ROOT + name, text);
  const directories = new Set(['/project']);
  for (const f of files) { let d = dirname(ROOT + f.path); while (d && d !== '/' && !directories.has(d)) { directories.add(d); d = dirname(d); } }
  for (const p of existingPaths) { let d = dirname(ROOT + p); while (d && d !== '/' && !directories.has(d)) { directories.add(d); d = dirname(d); } }
  const textOf = fileName => (fileName.startsWith(LIB_ROOT) ? libFiles.get(fileName) : byPath.get(fileName.slice(ROOT.length))?.content);
  const host = {
    getSourceFile(fileName, languageVersion) {
      const text = textOf(fileName);
      if (text === undefined) return undefined;
      if (fileName.startsWith(LIB_ROOT)) {
        const key = fileName + '|' + (typeof languageVersion === 'object' ? languageVersion.languageVersion : languageVersion);
        if (!sourceFileCache.has(key)) sourceFileCache.set(key, ts.createSourceFile(fileName, text, languageVersion, false));
        return sourceFileCache.get(key);
      }
      return ts.createSourceFile(fileName, text, languageVersion, true);
    },
    getDefaultLibFileName: () => LIB_ROOT + (libNames[0] || 'lib.es5.d.ts'),
    getDefaultLibLocation: () => LIB_ROOT.slice(0, -1),
    writeFile: () => {},
    getCurrentDirectory: () => ROOT.slice(0, -1),
    getDirectories: dir => [...directories].filter(d => dirname(d) === dir.replace(/\/$/, '')).map(d => d.slice(d.lastIndexOf('/') + 1)),
    fileExists: fileName => textOf(fileName) !== undefined,
    readFile: fileName => textOf(fileName),
    directoryExists: dir => directories.has(dir.replace(/\/$/, '')) || dir.startsWith(LIB_ROOT),
    getCanonicalFileName: f => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    realpath: p => p,
  };
  const libOption = libNames.filter(n => libFiles.has(LIB_ROOT + n));
  const programOptions = { ...options, lib: libOption.length ? libOption : undefined, noLib: !libOption.length };
  if (!libOption.length) stats.libsMissing = true;
  const program = ts.createProgram({ rootNames: codeFiles.map(f => ROOT + f.path), options: programOptions, host });
  const checker = program.getTypeChecker();
  const token = { isCancellationRequested: () => Boolean(signal?.aborted) || Date.now() - started > deadlineMs, throwIfCancellationRequested() { if (this.isCancellationRequested()) throw new ts.OperationCanceledException(); } };
  for (const d of program.getOptionsDiagnostics()) {
    if (d.file || d.code === 18003) continue;
    stats.configErrors++;
    findings.push({ rule: 'TSCONFIG', title: 'Compiler option error', category: 'config', severity: 'medium', verification: 'confirmed-static', file: tsconfig?.path || null, line: 1, column: 1, rootCause: `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`, analyzer: 'typescript-compiler' });
  }
  for (const f of codeFiles) {
    if (token.isCancellationRequested()) { stats.timedOut = !signal?.aborted; break; }
    const sf = program.getSourceFile(ROOT + f.path);
    if (!sf) continue;
    const isJs = f.language === 'javascript';
    isJs ? stats.jsFiles++ : stats.tsFiles++;
    let diags;
    try { diags = [...program.getSyntacticDiagnostics(sf, token), ...program.getSemanticDiagnostics(sf, token)]; }
    catch (error) { if (error instanceof ts.OperationCanceledException) { stats.timedOut = !signal?.aborted; break; } throw error; }
    stats.filesChecked++;
    const lines = new LineIndex(f.content);
    for (const d of diags) {
      if (d.category !== ts.DiagnosticCategory.Error && !QUALITY_CODES.has(d.code)) continue;
      const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
      const specifier = (message.match(/module '([^']+)'/i) || [])[1];
      let kind = classify(d.code, isJs, specifier, message);
      if (kind === 'unresolved-relative' && isKnownElsewhere(f.path, specifier)) kind = 'environment';
      if ((d.code === 2304 || d.code === 2552) && isJs) {
        const name = (message.match(/name '([^']+)'/) || [])[1];
        // `typeof name` guards (and runtime-defined globals they protect) are not ReferenceErrors.
        if (name && new RegExp(`\\btypeof\\s+${name.replace(/[$]/g, '\\$&')}\\b`).test(f.content)) kind = 'environment';
      }
      if (kind === 'suppressed') { stats.suppressedJs++; continue; }
      if (kind === 'environment') { stats.environment++; continue; }
      if (kind === 'unresolved-external') { stats.unresolvedExternal.set(specifier, (stats.unresolvedExternal.get(specifier) || 0) + 1); continue; }
      const p = lines.position(d.start || 0);
      const base = { file: f.path, line: p.line, column: p.column, excerpt: lines.lineText(p.line).trim(), analyzer: 'typescript-compiler', rootCause: `TS${d.code}: ${message}`, confidence: isJs ? 'medium' : 'high' };
      if (kind === 'unresolved-relative') {
        findings.push({ ...base, rule: 'IMPORT_UNRESOLVED', title: `Cannot resolve module "${specifier}"`, category: 'integration', severity: 'high', verification: 'confirmed-static', dedupeKey: `import-unresolved:${specifier}`, suggestion: 'Fix the import path or add the missing file.' });
        continue;
      }
      if (kind === 'export-mismatch') {
        const name = (message.match(/(?:exported member|declares) '([^']+)'/) || [])[1];
        const noDefault = d.code === 1192 || d.code === 2613 || d.code === 1259;
        findings.push({ ...base, rule: noDefault ? 'IMPORT_NO_DEFAULT' : 'IMPORT_MISSING_EXPORT', title: noDefault ? `Default import from a module without a default export` : `Imported name "${name}" is not exported`, category: 'integration', severity: 'high', verification: isJs ? 'high-confidence' : 'confirmed-static', dedupeKey: noDefault ? 'import-no-default' : `import-missing:${name}`, suggestion: noDefault ? 'Use a named import or add a default export to the target module.' : 'Export the name from the target module or correct the import.', ...crossFileInfo(ts, program, sf, d) });
        continue;
      }
      if (kind === 'quality') {
        if (d.code === 7027) { findings.push({ ...base, rule: 'JS_UNREACHABLE', title: 'Unreachable code', category: 'logic', severity: 'low', verification: 'high-confidence', suggestion: 'Remove the dead code or fix the control flow.', dedupeKey: 'JS_UNREACHABLE' }); continue; }
        findings.push({ ...base, rule: 'TS_UNUSED', title: 'Unused declaration', category: 'quality', severity: 'info', verification: 'quality', suggestion: 'Remove the unused declaration or use it.' });
        continue;
      }
      const desc = isJs && (d.code === 2554 || d.code === 2555) ? { category: 'logic', title: 'Call passes more arguments than the function declares', severity: 'medium' } : describeCode(d.code);
      const cross = crossFileInfo(ts, program, sf, d, checker);
      findings.push({ ...base, rule: `TS${d.code}`, title: cross.crossFile ? `${desc.title} (cross-file contract)` : desc.title, category: cross.crossFile ? 'integration' : desc.category, severity: desc.severity, verification: isJs ? (d.code === 2304 || d.code === 2552 ? 'high-confidence' : 'potential') : 'confirmed-static', suggestion: 'Resolve the compiler diagnostic; it reflects a contract the code does not satisfy.', dedupeKey: d.code >= 1000 && d.code < 2000 ? 'syntax' : undefined, ...cross });
      stats.reported++;
    }
  }
  stats.unresolvedExternal = Object.fromEntries(stats.unresolvedExternal);
  stats.durationMs = Date.now() - started;
  stats.options = { strict: Boolean(programOptions.strict), checkJs: Boolean(programOptions.checkJs), libs: libOption, fromTsconfig: Boolean(tsconfig) };
  return { findings, stats };
}

// Links a diagnostic to the declaration it violates when that declaration lives in another file.
function crossFileInfo(ts, program, sf, d, checker) {
  try {
    const node = findNode(ts, sf, d.start || 0);
    let call = node;
    while (call && !ts.isCallExpression(call) && !ts.isNewExpression(call) && !ts.isImportDeclaration(call)) call = call.parent;
    if (call && ts.isImportDeclaration(call) && ts.isStringLiteral(call.moduleSpecifier)) {
      const target = program.getResolvedModule?.(sf, call.moduleSpecifier.text, undefined)?.resolvedModule?.resolvedFileName;
      if (target && target !== sf.fileName) return { crossFile: true, affected: [sf.fileName.replace(ROOT, ''), target.replace(ROOT, '')] };
    }
    if (checker && call && (ts.isCallExpression(call) || ts.isNewExpression(call))) {
      const signature = checker.getResolvedSignature(call);
      const decl = signature?.getDeclaration?.() || signature?.declaration;
      const declFile = decl?.getSourceFile?.();
      if (declFile && declFile !== sf && declFile.fileName.startsWith(ROOT)) {
        const p = declFile.getLineAndCharacterOfPosition(decl.getStart(declFile));
        return { crossFile: true, affected: [sf.fileName.replace(ROOT, ''), declFile.fileName.replace(ROOT, '')], evidence: [`Declaration: ${declFile.fileName.replace(ROOT, '')}:${p.line + 1}`] };
      }
    }
  } catch { /* best effort */ }
  return { crossFile: false };
}

function findNode(ts, sf, pos) {
  let found = sf;
  const visit = node => { if (pos >= node.getStart(sf) && pos < node.end) { found = node; ts.forEachChild(node, visit); } };
  ts.forEachChild(sf, visit);
  return found;
}

function diagToFinding(ts, d, path, content, extra) {
  const lines = new LineIndex(content);
  const p = lines.position(d.start || 0);
  return { rule: 'TSCONFIG', title: extra.title, category: extra.category, severity: 'high', verification: extra.verification, file: path, line: p.line, column: p.column, excerpt: lines.lineText(p.line).trim(), rootCause: `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`, suggestion: 'Fix the configuration so the compiler can read it.', analyzer: 'typescript-compiler' };
}
