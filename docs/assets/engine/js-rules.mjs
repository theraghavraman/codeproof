// Per-file JavaScript/TypeScript analysis: parsing, AST rules, and extraction of the facts that the
// project-level analyzers need (imports, exports, functions, environment-variable reads).
import { parseJavaScript, parseWithTypeScript, walk, looksLikeJsx } from './estree.mjs';
import { LineIndex } from './util.mjs';
import { secretFindings, todoFindings } from './text-rules.mjs';

export const JS_RULES = {
  JS_PARSE: { title: 'JavaScript parse error', category: 'syntax', severity: 'high', verification: 'confirmed-static', suggestion: 'Repair the syntax error; no code in this file can run until it parses.' },
  TS_PARSE: { title: 'TypeScript parse error', category: 'syntax', severity: 'high', verification: 'confirmed-static', suggestion: 'Repair the syntax error reported by the TypeScript parser.' },
  JS_DYNAMIC_EXEC: { title: 'Dynamic code execution', category: 'security', severity: 'critical', verification: 'security-observation', suggestion: 'Avoid eval/Function/string timers; dispatch through an explicit allowlist instead of evaluating text.' },
  JS_INNERHTML: { title: 'HTML injection sink', category: 'security', severity: 'high', verification: 'security-observation', suggestion: 'Use textContent or DOM construction; if HTML is required, sanitize it with a vetted sanitizer first.' },
  JS_CHILD_PROCESS: { title: 'Process execution capability', category: 'security', severity: 'medium', verification: 'security-observation', suggestion: 'Confirm every command and argument passed to child_process is fixed or validated.' },
  JS_COMMAND_INJECTION: { title: 'Shell command built from dynamic input', category: 'security', severity: 'high', verification: 'security-observation', suggestion: 'Use execFile/spawn with a fixed executable and an argument array; never interpolate input into a shell string.' },
  JS_SHELL_TRUE: { title: 'Process spawned through a shell', category: 'security', severity: 'medium', verification: 'security-observation', suggestion: 'Remove shell: true and pass arguments as an array.' },
  JS_SQL_INJECTION: { title: 'SQL built by string interpolation', category: 'security', severity: 'high', verification: 'security-observation', suggestion: 'Use parameterized queries or the driver\'s placeholder syntax.' },
  JS_PATH_TRAVERSAL: { title: 'File path derived from request input', category: 'security', severity: 'high', verification: 'security-observation', suggestion: 'Resolve against a fixed base directory and reject paths that escape it (after normalization).' },
  JS_REFLECTED_XSS: { title: 'Request input written into a response body', category: 'security', severity: 'medium', verification: 'security-observation', suggestion: 'Encode output for its context or use a templating engine with auto-escaping.' },
  JS_OPEN_REDIRECT: { title: 'Redirect target taken from request input', category: 'security', severity: 'medium', verification: 'security-observation', suggestion: 'Redirect only to allowlisted paths or hosts.' },
  JS_TLS_DISABLED: { title: 'TLS certificate verification disabled', category: 'security', severity: 'high', verification: 'security-observation', suggestion: 'Keep certificate verification enabled; trust a specific CA instead of disabling checks.' },
  JS_WEAK_HASH: { title: 'Weak hash algorithm', category: 'security', severity: 'medium', verification: 'security-observation', suggestion: 'Use SHA-256 or stronger for integrity, and a password KDF (scrypt, argon2, bcrypt) for passwords.' },
  JS_WEAK_CRYPTO: { title: 'Deprecated or weak cipher construction', category: 'security', severity: 'high', verification: 'security-observation', suggestion: 'Use createCipheriv with an authenticated mode such as AES-GCM and a random IV.' },
  JS_INSECURE_RANDOM: { title: 'Math.random used for a security-sensitive value', category: 'security', severity: 'medium', verification: 'security-observation', suggestion: 'Use crypto.getRandomValues or crypto.randomUUID/randomBytes for tokens, salts and identifiers.' },
  JS_DYNAMIC_REQUIRE: { title: 'Module loaded from a computed path', category: 'security', severity: 'low', verification: 'security-observation', suggestion: 'Load modules from fixed specifiers or an explicit allowlist.' },
  JS_POSTMESSAGE_STAR: { title: 'postMessage with wildcard target origin', category: 'security', severity: 'low', verification: 'security-observation', suggestion: 'Pass the exact expected target origin instead of "*".' },
  JS_DUPLICATE_KEY: { title: 'Duplicate object key', category: 'logic', severity: 'medium', verification: 'high-confidence', suggestion: 'Remove or rename one entry; the later value silently overwrites the earlier one.' },
  JS_DUPLICATE_CASE: { title: 'Duplicate switch case', category: 'logic', severity: 'medium', verification: 'high-confidence', suggestion: 'The second matching case can never run; merge or correct the case labels.' },
  JS_DUPLICATE_CONDITION: { title: 'Repeated condition in if/else-if chain', category: 'logic', severity: 'medium', verification: 'high-confidence', suggestion: 'The later branch can never run because an earlier identical condition already matched.' },
  JS_NAN_COMPARE: { title: 'Comparison with NaN', category: 'logic', severity: 'medium', verification: 'high-confidence', suggestion: 'NaN never equals anything, including itself; use Number.isNaN(value).' },
  JS_INVALID_TYPEOF: { title: 'Invalid typeof comparison', category: 'logic', severity: 'medium', verification: 'high-confidence', suggestion: 'typeof only returns undefined, object, boolean, number, bigint, string, symbol or function.' },
  JS_SELF_COMPARE: { title: 'Expression compared with itself', category: 'logic', severity: 'low', verification: 'potential', suggestion: 'Check whether a different operand was intended (use Number.isNaN for NaN checks).' },
  JS_ASSIGN_IN_CONDITION: { title: 'Assignment used as a condition', category: 'logic', severity: 'medium', verification: 'potential', suggestion: 'Use === for comparison, or wrap an intentional assignment in extra parentheses.' },
  JS_CONSTANT_CONDITION: { title: 'Constant condition', category: 'logic', severity: 'low', verification: 'potential', suggestion: 'One branch can never execute; remove it or restore the intended condition.' },
  JS_UNREACHABLE: { title: 'Unreachable code', category: 'logic', severity: 'low', verification: 'high-confidence', suggestion: 'Statements after return, throw, break or continue never run; remove them or fix the control flow.' },
  JS_EMPTY_CATCH: { title: 'Error silently swallowed', category: 'logic', severity: 'low', verification: 'potential', suggestion: 'Handle, log or rethrow the error, or document why ignoring it is safe.' },
  JS_OFF_BY_ONE: { title: 'Loop reads one element past the end', category: 'logic', severity: 'medium', verification: 'high-confidence', suggestion: 'Use i < array.length (or start reverse loops at length - 1).' },
  JS_ARRAY_CALLBACK_RETURN: { title: 'Array callback never returns a value', category: 'logic', severity: 'medium', verification: 'high-confidence', suggestion: 'Return a value from the callback (a block body needs an explicit return).' },
  JS_ASYNC_FOREACH: { title: 'Async callback passed to forEach', category: 'logic', severity: 'medium', verification: 'potential', suggestion: 'forEach does not await promises; use for...of with await or Promise.all(array.map(...)).' },
  JS_ASYNC_PROMISE_EXECUTOR: { title: 'Async Promise executor', category: 'logic', severity: 'low', verification: 'potential', suggestion: 'Errors thrown inside an async executor are lost; make the executor synchronous.' },
  JS_UNUSED_EXPRESSION: { title: 'Expression result is discarded', category: 'logic', severity: 'medium', verification: 'high-confidence', suggestion: 'The statement has no effect; an assignment or a return was probably intended.' },
  JS_IDENTICAL_BRANCHES: { title: 'Both branches are identical', category: 'quality', severity: 'low', verification: 'quality', suggestion: 'The condition has no effect; simplify or correct one branch.' },
  JS_COMPLEXITY: { title: 'High cyclomatic complexity', category: 'quality', severity: 'info', verification: 'quality', suggestion: 'Split the function into smaller units that can be tested independently.' },
  JS_DEBUGGER: { title: 'Debugger statement', category: 'quality', severity: 'low', verification: 'quality', suggestion: 'Remove the standalone debugger statement.' },
  JS_CONSOLE: { title: 'Debug console output', category: 'quality', severity: 'low', verification: 'quality', suggestion: 'Remove debug logging or use controlled diagnostics.' },
  JS_VAR: { title: 'Legacy var declaration', category: 'quality', severity: 'low', verification: 'quality', suggestion: 'Prefer let or const after confirming scoping behavior.' },
  JS_LOOSE_EQ: { title: 'Loose equality', category: 'quality', severity: 'low', verification: 'quality', suggestion: 'Use === / !== unless coercion is intended (x == null is a common, deliberate exception).' },
  TS_ANY: { title: 'Explicit any type', category: 'quality', severity: 'low', verification: 'quality', suggestion: 'Use unknown or a specific validated type.' },
};

const VALID_TYPEOF = new Set(['undefined', 'object', 'boolean', 'number', 'string', 'function', 'symbol', 'bigint']);
const COMPARE_OPS = new Set(['==', '===', '!=', '!==', '<', '>', '<=', '>=']);
const ARRAY_CALLBACK_METHODS = new Set(['map', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'reduce', 'reduceRight', 'flatMap', 'sort', 'toSorted']);
const SQL_START = /^\s*(?:select|insert|update|delete|with|replace|merge|create|drop|alter|truncate)\b/i;
const SQL_METHODS = new Set(['query', 'execute', 'raw', 'prepare', 'queryRaw', '$queryRawUnsafe', '$executeRawUnsafe', 'unsafe', 'sql']);
const REQUEST_INPUT = /^(?:req|request|ctx|context)\.(?:params|query|body|headers|cookies|request\.(?:body|query))\b/;
const FS_METHODS = new Set(['readFile', 'readFileSync', 'createReadStream', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'readdir', 'readdirSync', 'open', 'openSync', 'stat', 'statSync', 'createWriteStream', 'sendFile', 'download']);
const SENSITIVE_NAME = /token|secret|passw|salt|nonce|otp|session|api_?key|apikey|csrf|auth|credential/i;
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const TOP_LEVEL_WRAPPERS = new Set(['Program', 'ExportNamedDeclaration', 'ExportDefaultDeclaration', 'VariableDeclaration', 'VariableDeclarator', 'ExpressionStatement', 'AssignmentExpression']);

const memberPath = node => {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MetaProperty') return `${node.meta.name}.${node.property.name}`;
  if (node.type === 'MemberExpression') {
    const obj = memberPath(node.object);
    if (!obj) return null;
    if (!node.computed && node.property.type === 'Identifier') return `${obj}.${node.property.name}`;
    if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') return `${obj}.${node.property.value}`;
  }
  if (node.type === 'ChainExpression') return memberPath(node.expression);
  return null;
};
const calleeName = node => {
  if (!node) return null;
  if (node.type === 'ChainExpression') return calleeName(node.expression);
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') {
    if (!node.computed && (node.property.type === 'Identifier' || node.property.type === 'PrivateIdentifier')) return node.property.name;
    if (node.property.type === 'Literal') return String(node.property.value);
  }
  return null;
};
const isStaticString = node => (node?.type === 'Literal' && typeof node.value === 'string') || (node?.type === 'TemplateLiteral' && node.expressions.length === 0);
const staticString = node => (node?.type === 'Literal' ? String(node.value) : node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0]?.value?.cooked ?? '' : null);
const isFunctionNode = node => node && FUNCTION_TYPES.has(node.type);
const leadingString = node => {
  if (!node) return '';
  if (isStaticString(node)) return staticString(node);
  if (node.type === 'TemplateLiteral') return node.quasis[0]?.value?.cooked || '';
  if (node.type === 'BinaryExpression' && node.operator === '+') return leadingString(node.left);
  return '';
};
const isDynamicString = node => node && !isStaticString(node) && (node.type === 'TemplateLiteral' || (node.type === 'BinaryExpression' && node.operator === '+') || node.type === 'Identifier' || node.type === 'MemberExpression' || node.type === 'CallExpression');

function collectPatternNames(pattern, out = []) {
  if (!pattern) return out;
  if (pattern.type === 'Identifier') out.push(pattern.name);
  else if (pattern.type === 'AssignmentPattern') collectPatternNames(pattern.left, out);
  else if (pattern.type === 'RestElement') collectPatternNames(pattern.argument, out);
  else if (pattern.type === 'ArrayPattern') for (const el of pattern.elements) collectPatternNames(el, out);
  else if (pattern.type === 'ObjectPattern') for (const p of pattern.properties) collectPatternNames(p.type === 'RestElement' ? p.argument : p.value, out);
  return out;
}

function paramInfo(param, text) {
  const info = { name: '', optional: Boolean(param.optional), rest: false, hasDefault: false, destructured: false, type: param.typeText || null };
  let p = param;
  if (p.type === 'RestElement') { info.rest = true; p = p.argument; }
  if (p.type === 'AssignmentPattern') { info.hasDefault = true; info.defaultText = text(p.right).slice(0, 60); p = p.left; }
  if (p.type === 'Identifier') info.name = p.name;
  else { info.destructured = true; info.name = p.type === 'ObjectPattern' ? '{…}' : '[…]'; }
  if (p.typeText && !info.type) info.type = p.typeText;
  return info;
}

function containsOwnReturn(fnNode) {
  let found = false;
  walk(fnNode.body, (node) => {
    if (found) return false;
    if (node !== fnNode.body && FUNCTION_TYPES.has(node.type)) return false;
    if (node.type === 'ReturnStatement' && node.argument) found = true;
    if (node.type === 'ThrowStatement') found = true;
    return undefined;
  });
  return found;
}

export function analyzeJsFile(file, { ts } = {}) {
  const code = file.content;
  const lines = new LineIndex(code);
  const findings = [], functions = [], imports = [], envKeys = [];
  const exportsInfo = { named: new Set(), typeNamed: new Set(), default: false, star: [], cjs: false, esm: false, cjsNames: new Set(), cjsWhole: false };
  const parse = { parser: null, ok: false, notes: [] };
  const isTs = file.language === 'typescript';
  const isJsx = /\.[jt]sx$/i.test(file.path);
  const emit = (rule, at, extra = {}) => {
    const def = JS_RULES[rule] || {};
    const line = at?.line ?? at?.loc?.start?.line ?? 1;
    const column = at?.column ?? ((at?.loc?.start?.column ?? 0) + 1);
    findings.push({ rule, ...def, ...extra, title: extra.title || def.title, file: file.path, line, column, excerpt: lines.lineText(line).trim(), analyzer: extra.analyzer || (parse.parser === 'acorn' ? 'acorn-rules' : 'typescript-ast-rules') });
  };

  let ast = null, comments = [], anyKeywords = [];
  if (!isTs) {
    const r = parseJavaScript(code);
    if (r.ast) { ast = r.ast; comments = r.comments; parse.parser = 'acorn'; parse.ok = true; parse.sourceType = r.sourceType; }
    else if (ts && (isJsx || looksLikeJsx(code))) {
      const t = parseWithTypeScript(ts, file.path, code, { js: true, jsx: true });
      parse.parser = 'typescript-jsx';
      if (!t.diagnostics.length) { ast = t.ast; parse.ok = true; parse.notes.push('Contains JSX; validated with the TypeScript JSX parser (Acorn covers standard ECMAScript only).'); }
      else for (const d of t.diagnostics.slice(0, 8)) emit('JS_PARSE', d, { rootCause: d.message, analyzer: 'typescript-parser', dedupeKey: 'syntax' });
      anyKeywords = [];
    } else if (isJsx) {
      parse.parser = 'none'; parse.notes.push('JSX syntax requires the TypeScript parser, which was not available for this run.');
    } else {
      parse.parser = 'acorn';
      emit('JS_PARSE', r.error, { rootCause: r.error.message, analyzer: 'acorn', dedupeKey: 'syntax' });
    }
  } else if (ts) {
    const t = parseWithTypeScript(ts, file.path, code);
    parse.parser = 'typescript'; ast = t.ast; anyKeywords = t.anyKeywords;
    parse.ok = !t.diagnostics.length;
    if (t.diagnostics.length) parse.notes.push('Parsed with error recovery; rule results after the first syntax error may be incomplete.');
    for (const d of t.diagnostics.slice(0, 8)) emit('TS_PARSE', d, { rootCause: `TS${d.code}: ${d.message}`, analyzer: 'typescript-parser', dedupeKey: 'syntax' });
  } else {
    parse.parser = 'none';
    parse.notes.push('TypeScript compiler not loaded; only text-level checks ran.');
  }

  if (ast) runAstRules({ ast, code, emit, comments, file, functions, imports, exportsInfo, envKeys });
  else {
    for (const m of code.matchAll(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
      functions.push({ name: m[1], params: m[2].split(',').filter(s => s.trim()).length, paramInfo: [], file: file.path, line: lines.position(m.index).line, topLevel: true, exported: /^export/.test(m[0]), approximate: true });
    }
  }
  for (const a of anyKeywords) emit('TS_ANY', a);
  findings.push(...secretFindings(file, lines), ...todoFindings(file, lines));
  return {
    findings, functions, imports, envKeys, parse,
    exports: { named: [...exportsInfo.named], typeNamed: [...exportsInfo.typeNamed], default: exportsInfo.default, star: exportsInfo.star, cjs: exportsInfo.cjs, esm: exportsInfo.esm, cjsNames: [...exportsInfo.cjsNames], cjsWhole: exportsInfo.cjsWhole },
  };
}

function runAstRules({ ast, code, emit, comments, file, functions, imports, exportsInfo, envKeys }) {
  const text = node => code.slice(node.start, node.end);
  const norm = node => text(node).replace(/\s+/g, '');
  const usesChildProcess = /\bchild_process\b/.test(code);
  const fnStack = [];
  const exportedLocals = new Set();
  const hasCommentInside = node => comments.some(cm => cm.start >= node.start && cm.end <= node.end) || /\/\/|\/\*/.test(text(node));
  const paramNamesInScope = () => new Set(fnStack.flatMap(f => f.paramNames));
  const refsExternalInput = node => {
    const params = paramNamesInScope();
    let hit = false;
    walk(node, n => {
      if (hit) return false;
      if (n.type === 'Identifier' && params.has(n.name)) hit = true;
      const path = n.type === 'MemberExpression' ? memberPath(n) : null;
      if (path && (REQUEST_INPUT.test(path) || /^(?:location|document\.(?:URL|cookie|referrer|location)|window\.(?:location|name)|event\.data|e\.data|process\.argv)/.test(path))) hit = true;
      return undefined;
    });
    return hit;
  };
  const contextName = ancestors => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i];
      if (a.type === 'VariableDeclarator' && a.id?.type === 'Identifier') return a.id.name;
      if (a.type === 'Property' && a.key) return a.key.name || a.key.value;
      if (a.type === 'AssignmentExpression') return memberPath(a.left) || '';
      if (FUNCTION_TYPES.has(a.type)) return a.id?.name || '';
    }
    return '';
  };
  const addImport = (record) => imports.push({ names: [], ...record });
  const jsdocParams = (node, ancestors) => {
    const types = new Map();
    let anchor = node.start;
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i];
      if (['ExportNamedDeclaration', 'ExportDefaultDeclaration', 'VariableDeclaration', 'VariableDeclarator'].includes(a.type)) anchor = Math.min(anchor, a.start); else break;
    }
    const doc = comments.filter(cm => cm.type === 'Block' && cm.value.startsWith('*') && cm.end <= anchor && !code.slice(cm.end, anchor).trim()).pop();
    if (doc) for (const m of doc.value.matchAll(/@param\s+\{([^}]+)\}\s+\[?([A-Za-z_$][\w$]*)/g)) types.set(m[2], m[1].trim());
    return types;
  };

  walk(ast, (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1];
    switch (node.type) {
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
        let name = node.id?.name || null;
        let exportName = null;
        if (!name && parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') name = parent.id.name;
        if (!name && parent?.type === 'AssignmentExpression') {
          const target = memberPath(parent.left);
          const m = target && target.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/);
          if (m) { name = m[1]; exportName = m[1]; }
        }
        if (!name && parent?.type === 'ExportDefaultDeclaration') { name = 'default'; exportName = 'default'; }
        const topLevel = ancestors.every(a => TOP_LEVEL_WRAPPERS.has(a.type));
        const exported = Boolean(exportName) || node.exported || ancestors.some(a => a.type === 'ExportNamedDeclaration' || a.type === 'ExportDefaultDeclaration') || (ancestors.find(a => a.type === 'VariableDeclaration')?.exported ?? false);
        const info = node.params.map(p => paramInfo(p, text));
        const jsdoc = jsdocParams(node, ancestors);
        for (const p of info) if (!p.type && jsdoc.has(p.name)) { p.type = jsdoc.get(p.name); p.typeSource = 'jsdoc'; }
        const record = { name, params: node.params.length, paramInfo: info, file: file.path, line: node.loc.start.line, endLine: node.loc.end.line, topLevel, exported, exportName: exportName || (exported ? (node.isDefault || parent?.type === 'ExportDefaultDeclaration' ? 'default' : name) : null), async: Boolean(node.async), generator: Boolean(node.generator), returnType: node.returnType || null, complexity: 1, node };
        if (name) functions.push(record);
        fnStack.push({ node, paramNames: node.params.flatMap(p => collectPatternNames(p)) });
        break;
      }
      default: break;
    }

    switch (node.type) {
      case 'ImportDeclaration': {
        exportsInfo.esm = true;
        const spec = staticString(node.source);
        const names = [], record = { specifier: spec, kind: node.importKind === 'type' ? 'type' : 'static', line: node.loc.start.line, column: node.loc.start.column + 1, names, default: null, namespace: null };
        for (const s of node.specifiers || []) {
          if (s.type === 'ImportDefaultSpecifier') record.default = s.local.name;
          else if (s.type === 'ImportNamespaceSpecifier') record.namespace = s.local.name;
          else names.push({ imported: s.imported?.name ?? s.imported?.value, local: s.local.name, typeOnly: s.importKind === 'type' || node.importKind === 'type' });
        }
        if (!node.specifiers?.length) record.kind = 'side-effect';
        addImport(record);
        if (/^(?:node:)?child_process$/.test(spec || '')) emit('JS_CHILD_PROCESS', node);
        break;
      }
      case 'ExportNamedDeclaration': {
        exportsInfo.esm = true;
        const typeOnly = node.exportKind === 'type';
        if (node.source) addImport({ specifier: staticString(node.source), kind: 'reexport', line: node.loc.start.line, column: node.loc.start.column + 1, names: (node.specifiers || []).map(s => ({ imported: s.local?.name ?? s.local?.value, local: s.exported?.name ?? s.exported?.value, typeOnly })) });
        for (const s of node.specifiers || []) {
          const exported = s.exported?.name ?? s.exported?.value;
          (typeOnly || s.exportKind === 'type' ? exportsInfo.typeNamed : exportsInfo.named).add(exported);
          if (exported === 'default') exportsInfo.default = true;
          if (!node.source) exportedLocals.add(s.local?.name);
        }
        const d = node.declaration;
        if (d?.id?.name) (d.type === 'TSTypeDeclaration' ? exportsInfo.typeNamed : exportsInfo.named).add(d.id.name);
        if (d?.type === 'VariableDeclaration') for (const decl of d.declarations) for (const n of collectPatternNames(decl.id)) exportsInfo.named.add(n);
        break;
      }
      case 'ExportDefaultDeclaration': exportsInfo.esm = true; exportsInfo.default = true; break;
      case 'ExportAllDeclaration':
        exportsInfo.esm = true;
        if (node.exported) exportsInfo.named.add(node.exported.name ?? node.exported.value); else exportsInfo.star.push(staticString(node.source));
        addImport({ specifier: staticString(node.source), kind: 'reexport', star: !node.exported, line: node.loc.start.line, column: node.loc.start.column + 1 });
        break;
      case 'FunctionDeclaration': case 'ClassDeclaration': case 'TSEnumDeclaration': case 'TSTypeDeclaration':
        if (node.exported && node.id?.name) {
          exportsInfo.esm = true;
          if (node.isDefault) exportsInfo.default = true; else (node.type === 'TSTypeDeclaration' ? exportsInfo.typeNamed : exportsInfo.named).add(node.id.name);
        }
        break;
      case 'VariableDeclaration':
        if (node.exported) { exportsInfo.esm = true; for (const decl of node.declarations) for (const n of collectPatternNames(decl.id)) exportsInfo.named.add(n); }
        if (node.kind === 'var') emit('JS_VAR', node);
        break;
      case 'ImportExpression':
        addImport({ specifier: staticString(node.source), kind: 'dynamic', computed: !isStaticString(node.source), line: node.loc.start.line, column: node.loc.start.column + 1 });
        break;
      case 'NewExpression': {
        const name = calleeName(node.callee);
        if (name === 'Function') emit('JS_DYNAMIC_EXEC', node, { severity: node.arguments.some(a => !isStaticString(a)) ? 'critical' : 'medium', rootCause: 'new Function compiles a string into executable code.' });
        if (name === 'Promise' && node.arguments[0]?.async && isFunctionNode(node.arguments[0])) emit('JS_ASYNC_PROMISE_EXECUTOR', node);
        if (name === 'Script' && memberPath(node.callee)?.startsWith('vm.')) emit('JS_DYNAMIC_EXEC', node, { severity: 'high', rootCause: 'Node\'s vm module is not a security boundary for untrusted code.' });
        if (name === 'URL' && isStaticString(node.arguments[0]) && memberPath(node.arguments[1]) === 'import.meta.url') {
          const spec = staticString(node.arguments[0]);
          if (/^\.\.?\//.test(spec)) addImport({ specifier: spec, kind: 'url-asset', line: node.loc.start.line, column: node.loc.start.column + 1 });
        }
        break;
      }
      case 'CallExpression': {
        const name = calleeName(node.callee);
        const path = memberPath(node.callee);
        const args = node.arguments;
        if (node.callee.type === 'Identifier' && name === 'require') {
          const spec = staticString(args[0]);
          if (spec !== null) {
            const declarator = parent?.type === 'VariableDeclarator' ? parent : null;
            const names = declarator?.id?.type === 'ObjectPattern' ? declarator.id.properties.filter(p => p.type === 'Property').map(p => ({ imported: p.key?.name ?? p.key?.value, local: collectPatternNames(p.value)[0] })) : [];
            addImport({ specifier: spec, kind: 'require', line: node.loc.start.line, column: node.loc.start.column + 1, names, whole: declarator?.id?.type === 'Identifier' ? declarator.id.name : null });
            if (/^(?:node:)?child_process$/.test(spec)) emit('JS_CHILD_PROCESS', node);
          } else if (args[0]) emit('JS_DYNAMIC_REQUIRE', node);
        }
        if (name === 'eval' && (node.callee.type === 'Identifier' || /^(?:window|globalThis|self|global)\.eval$/.test(path || ''))) {
          const external = args[0] && !isStaticString(args[0]) && refsExternalInput(args[0]);
          emit('JS_DYNAMIC_EXEC', node, { severity: !args[0] || isStaticString(args[0]) ? 'medium' : external ? 'critical' : 'high', confidence: external ? 'medium' : 'low', rootCause: external ? 'eval receives a value derived from a function parameter or request input; if that value is attacker-controlled it executes as code.' : 'eval compiles text into executable code.' });
        }
        if (name === 'Function' && node.callee.type === 'Identifier') emit('JS_DYNAMIC_EXEC', node, { severity: args.some(a => !isStaticString(a)) ? 'critical' : 'medium', rootCause: 'Function() compiles a string into executable code.' });
        if ((name === 'setTimeout' || name === 'setInterval') && args[0] && (isStaticString(args[0]) || (args[0].type === 'BinaryExpression' && args[0].operator === '+') || args[0].type === 'TemplateLiteral')) emit('JS_DYNAMIC_EXEC', node, { severity: 'medium', rootCause: `${name} with a string argument evaluates that string as code.` });
        if (/^vm\.(?:runInNewContext|runInThisContext|runInContext|compileFunction)$/.test(path || '')) emit('JS_DYNAMIC_EXEC', node, { severity: 'high', rootCause: 'Node\'s vm module is not a security boundary for untrusted code.' });
        if (name === 'insertAdjacentHTML' && args[1] && !isStaticString(args[1])) emit('JS_INNERHTML', node, { rootCause: 'insertAdjacentHTML parses its argument as HTML.' });
        if (/^document\.writeln?$/.test(path || '') && args[0] && !isStaticString(args[0])) emit('JS_INNERHTML', node, { rootCause: 'document.write parses its argument as HTML.' });
        if (name === 'html' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'CallExpression' && ['$', 'jQuery'].includes(calleeName(node.callee.object.callee)) && args[0] && !isStaticString(args[0])) emit('JS_INNERHTML', node, { severity: 'medium', rootCause: 'jQuery .html() parses its argument as HTML.' });
        if ((name === 'exec' || name === 'execSync') && usesChildProcess && args[0] && isDynamicString(args[0])) emit('JS_COMMAND_INJECTION', node, { rootCause: `${name} runs its argument through a shell, and the command string is assembled dynamically.` });
        if (['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(name) && usesChildProcess && args.some(a => a.type === 'ObjectExpression' && a.properties.some(p => (p.key?.name ?? p.key?.value) === 'shell' && p.value?.type === 'Literal' && p.value.value === true))) emit('JS_SHELL_TRUE', node);
        if (SQL_METHODS.has(name) && args[0] && !isStaticString(args[0]) && SQL_START.test(leadingString(args[0])) && (args[0].type === 'TemplateLiteral' || args[0].type === 'BinaryExpression')) emit('JS_SQL_INJECTION', node, { rootCause: 'The SQL text is assembled from interpolated values instead of bound parameters.' });
        if (FS_METHODS.has(name) && args.some(a => refsRequest(a))) emit('JS_PATH_TRAVERSAL', node, { rootCause: `${name} receives a path built from request input.` });
        if (['send', 'write', 'end'].includes(name) && /^(?:res|response|reply)\./.test(path || '') && args[0] && (args[0].type === 'TemplateLiteral' || args[0].type === 'BinaryExpression') && refsRequest(args[0])) emit('JS_REFLECTED_XSS', node);
        if (name === 'redirect' && /^(?:res|response|reply|ctx)\./.test(path || '') && args.some(a => refsRequest(a))) emit('JS_OPEN_REDIRECT', node);
        if (name === 'createHash' && /^(?:md5|sha1|md4)$/i.test(staticString(args[0]) || '')) emit('JS_WEAK_HASH', node, { rootCause: `${staticString(args[0])} is broken for collision resistance; acceptable only for non-security checksums.` });
        if (name === 'createCipher' || (name === 'createCipheriv' && /-ecb$/i.test(staticString(args[0]) || ''))) emit('JS_WEAK_CRYPTO', node);
        if (path === 'Math.random' && SENSITIVE_NAME.test(contextName(ancestors))) emit('JS_INSECURE_RANDOM', node, { rootCause: `Math.random is not cryptographically secure but feeds "${contextName(ancestors)}".` });
        if (name === 'postMessage' && args.length >= 2 && staticString(args[1]) === '*' && node.callee.type === 'MemberExpression') emit('JS_POSTMESSAGE_STAR', node);
        if (name === 'forEach' && node.callee.type === 'MemberExpression' && isFunctionNode(args[0]) && args[0].async) emit('JS_ASYNC_FOREACH', node);
        if (ARRAY_CALLBACK_METHODS.has(name) && node.callee.type === 'MemberExpression' && isFunctionNode(args[0]) && args[0].body?.type === 'BlockStatement' && !args[0].generator && !containsOwnReturn(args[0])) emit('JS_ARRAY_CALLBACK_RETURN', args[0], { rootCause: `The callback passed to .${name}() has a block body without a return statement, so it always yields undefined.` });
        if ((path === 'console.log' || path === 'console.debug') && parent?.type === 'ExpressionStatement') emit('JS_CONSOLE', node, { autofix: 'remove-console' });
        else if (path === 'console.log' || path === 'console.debug') emit('JS_CONSOLE', node);
        break;
      }
      case 'AssignmentExpression': {
        const target = memberPath(node.left);
        if (node.left.type === 'MemberExpression' && ['innerHTML', 'outerHTML'].includes(calleeName(node.left)) && !isStaticString(node.right)) emit('JS_INNERHTML', node, { rootCause: `Assigning a non-constant value to ${calleeName(node.left)} parses it as HTML.` });
        if (target === 'module.exports') { exportsInfo.cjs = true; exportsInfo.cjsWhole = true; if (node.right.type === 'ObjectExpression') for (const p of node.right.properties) if (p.type === 'Property') exportsInfo.cjsNames.add(p.key?.name ?? p.key?.value); }
        const m = target && target.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/);
        if (m) { exportsInfo.cjs = true; exportsInfo.cjsNames.add(m[1]); }
        if (target === 'process.env.NODE_TLS_REJECT_UNAUTHORIZED' && staticString(node.right) === '0') emit('JS_TLS_DISABLED', node);
        break;
      }
      case 'MemberExpression': {
        const path = memberPath(node);
        const m = path && path.match(/^(?:process\.env|import\.meta\.env)\.([A-Za-z_][\w]*)$/);
        if (m && !(parent?.type === 'MemberExpression' && parent.object === node)) envKeys.push({ key: m[1], line: node.loc.start.line, column: node.loc.start.column + 1 });
        break;
      }
      case 'Property':
        if ((node.key?.name ?? node.key?.value) === 'rejectUnauthorized' && node.value?.type === 'Literal' && node.value.value === false) emit('JS_TLS_DISABLED', node);
        break;
      case 'JSXAttribute':
        if (node.name?.name === 'dangerouslySetInnerHTML') emit('JS_INNERHTML', node, { rootCause: 'dangerouslySetInnerHTML injects raw HTML into the DOM.' });
        break;
      case 'ObjectExpression': {
        const seen = new Map();
        for (const p of node.properties) {
          if (p.type !== 'Property' || p.computed || p.kind !== 'init') continue;
          const key = p.key?.type === 'Identifier' ? p.key.name : p.key?.type === 'Literal' ? String(p.key.value) : null;
          if (key === null || key === '__proto__') continue;
          if (seen.has(key)) emit('JS_DUPLICATE_KEY', p, { title: `Duplicate object key "${key}"`, rootCause: `Key "${key}" is defined on line ${seen.get(key)} and again here; the later value wins.` });
          else seen.set(key, p.loc.start.line);
        }
        break;
      }
      case 'SwitchStatement': {
        const seen = new Map();
        for (const c of node.cases) {
          if (!c.test) continue;
          const key = norm(c.test);
          if (seen.has(key)) emit('JS_DUPLICATE_CASE', c, { rootCause: `case ${text(c.test)} already appears on line ${seen.get(key)}.` });
          else seen.set(key, c.loc.start.line);
        }
        break;
      }
      case 'IfStatement': {
        if (!(parent?.type === 'IfStatement' && parent.alternate === node)) {
          const seen = new Map();
          for (let cur = node; cur?.type === 'IfStatement'; cur = cur.alternate) {
            const key = norm(cur.test);
            if (seen.has(key)) emit('JS_DUPLICATE_CONDITION', cur.test, { rootCause: `The condition ${text(cur.test).slice(0, 80)} already appears on line ${seen.get(key)} in the same chain.` });
            else seen.set(key, cur.loc.start.line);
          }
        }
        if (node.alternate && node.consequent && node.alternate.type !== 'IfStatement' && norm(node.consequent) === norm(node.alternate) && norm(node.consequent).length > 2) emit('JS_IDENTICAL_BRANCHES', node);
        checkCondition(node.test);
        break;
      }
      case 'WhileStatement': case 'DoWhileStatement': checkCondition(node.test, true); break;
      case 'ForStatement': if (node.test) checkCondition(node.test, true); checkOffByOne(node); break;
      case 'ConditionalExpression': checkCondition(node.test); break;
      case 'BinaryExpression': {
        const { operator: op, left, right } = node;
        if (COMPARE_OPS.has(op)) {
          const isNaNNode = n => (n.type === 'Identifier' && n.name === 'NaN') || memberPath(n) === 'Number.NaN';
          if (isNaNNode(left) || isNaNNode(right)) emit('JS_NAN_COMPARE', node);
          if (op !== '!==' && op !== '!=' && left.type !== 'Literal' && norm(left) === norm(right) && !/\(/.test(text(left))) emit('JS_SELF_COMPARE', node);
          const typeofSide = left.type === 'UnaryExpression' && left.operator === 'typeof' ? right : right.type === 'UnaryExpression' && right.operator === 'typeof' ? left : null;
          if (typeofSide && isStaticString(typeofSide) && !VALID_TYPEOF.has(staticString(typeofSide))) emit('JS_INVALID_TYPEOF', node, { title: `Invalid typeof comparison with "${staticString(typeofSide)}"`, rootCause: `typeof never returns "${staticString(typeofSide)}", so this comparison is constant.` });
        }
        if ((op === '==' || op === '!=') && !(left.type === 'Literal' && left.value === null) && !(right.type === 'Literal' && right.value === null)) emit('JS_LOOSE_EQ', node);
        break;
      }
      case 'ExpressionStatement': {
        const e = node.expression;
        if (node.directive || (e.type === 'Literal' && typeof e.value === 'string' && /^use /.test(e.value))) break;
        if (e.type === 'BinaryExpression' && COMPARE_OPS.has(e.operator)) emit('JS_UNUSED_EXPRESSION', node, { rootCause: `The comparison ${text(e).slice(0, 80)} is evaluated and discarded; an assignment, return or condition was probably intended.` });
        else if (e.type === 'BinaryExpression' || (e.type === 'Literal' && !e.regex)) emit('JS_UNUSED_EXPRESSION', node, { verification: 'potential', severity: 'low', rootCause: 'The expression is evaluated and its result is discarded.' });
        break;
      }
      case 'CatchClause':
        if (node.body?.body?.length === 0 && !hasCommentInside(node.body)) emit('JS_EMPTY_CATCH', node);
        break;
      case 'DebuggerStatement': emit('JS_DEBUGGER', node, { autofix: 'remove-debugger' }); break;
      case 'BlockStatement': case 'Program': case 'SwitchCase': checkUnreachable(node.type === 'SwitchCase' ? node.consequent : node.body); break;
      default: break;
    }
    return undefined;
  }, node => { if (fnStack.length && fnStack[fnStack.length - 1].node === node) fnStack.pop(); });

  for (const fn of functions) {
    if (!fn.exported && (exportedLocals.has(fn.name) || exportsInfo.cjsNames.has(fn.name))) { fn.exported = true; fn.exportName = fn.name; }
    fn.complexity = computeComplexity(fn.node);
    if (fn.complexity > 15) emit('JS_COMPLEXITY', { line: fn.line, column: 1 }, { title: `High cyclomatic complexity (${fn.complexity}) in ${fn.name}`, severity: fn.complexity > 30 ? 'low' : 'info', rootCause: `${fn.name} has ${fn.complexity} independent paths, which makes exhaustive testing impractical.` });
    delete fn.node;
  }

  function refsRequest(node) {
    let hit = false;
    walk(node, n => { if (hit) return false; const p = n.type === 'MemberExpression' ? memberPath(n) : null; if (p && REQUEST_INPUT.test(p)) hit = true; return undefined; });
    return hit;
  }
  function checkCondition(test, loop = false) {
    if (!test) return;
    if (test.type === 'AssignmentExpression' && test.operator === '=' && !test.parenthesized) emit('JS_ASSIGN_IN_CONDITION', test, { rootCause: `${text(test).slice(0, 80)} assigns instead of comparing, so the condition depends on the assigned value.` });
    if (!loop && test.type === 'Literal' && test.value !== null && !test.regex) emit('JS_CONSTANT_CONDITION', test, { rootCause: `The condition is always ${test.value ? 'true' : 'false'}.` });
  }
  function checkUnreachable(statements) {
    if (!Array.isArray(statements)) return;
    let terminated = null;
    for (const s of statements) {
      if (terminated) {
        if (s.type === 'FunctionDeclaration' || s.type === 'EmptyStatement' || s.type === 'TSTypeDeclaration' || (s.type === 'VariableDeclaration' && s.kind === 'var' && s.declarations.every(d => !d.init))) continue;
        emit('JS_UNREACHABLE', s, { rootCause: `This statement follows a ${terminated} statement in the same block and can never execute.` });
        return;
      }
      if (['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'].includes(s.type)) terminated = s.type.replace('Statement', '').toLowerCase();
    }
  }
  function checkOffByOne(node) {
    const t = node.test;
    if (!t || t.type !== 'BinaryExpression') return;
    let index = null, arrayText = null, reverse = false;
    if (t.operator === '<=' && t.left.type === 'Identifier' && t.right.type === 'MemberExpression' && calleeName(t.right) === 'length') { index = t.left.name; arrayText = norm(t.right.object); }
    if (t.operator === '>=' && t.left.type === 'Identifier' && t.right.type === 'Literal' && t.right.value === 0) {
      const init = node.init?.type === 'VariableDeclaration' ? node.init.declarations[0]?.init : node.init?.type === 'AssignmentExpression' ? node.init.right : null;
      if (init?.type === 'MemberExpression' && calleeName(init) === 'length') { index = t.left.name; arrayText = norm(init.object); reverse = true; }
    }
    if (!index) return;
    let accessed = false;
    walk(node.body, n => { if (accessed) return false; if (n.type === 'MemberExpression' && n.computed && n.property.type === 'Identifier' && n.property.name === index && norm(n.object) === arrayText) accessed = true; return undefined; });
    if (accessed) emit('JS_OFF_BY_ONE', t, { rootCause: reverse ? `The loop starts at ${arrayText}.length, so the first iteration reads ${arrayText}[${arrayText}.length], which is undefined.` : `The loop runs while ${index} <= ${arrayText}.length, so the last iteration reads ${arrayText}[${arrayText}.length], which is undefined.`, trigger: `Any non-empty ${arrayText}.` });
  }
}

function computeComplexity(fnNode) {
  if (!fnNode?.body) return 1;
  let n = 1;
  walk(fnNode.body, node => {
    if (node !== fnNode.body && FUNCTION_TYPES.has(node.type)) return false;
    if (['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'CatchClause', 'ConditionalExpression'].includes(node.type)) n++;
    else if (node.type === 'SwitchCase' && node.test) n++;
    else if (node.type === 'LogicalExpression') n++;
    return undefined;
  });
  return n;
}
