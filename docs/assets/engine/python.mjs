// Python analysis without a CPython runtime: a real tokenizer (strings, f-strings, comments, continuation
// lines, bracket depth, INDENT/DEDENT) drives structural syntax checks, an outline of definitions/imports
// for integration analysis, and token-based rules. Full grammar validation is delegated to CPython's own
// compile() when the optional in-browser Pyodide runtime runs; these checks are labeled accordingly.
import { LineIndex } from './util.mjs';
import { secretFindings, todoFindings } from './text-rules.mjs';

const STRING_PREFIX = /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])?$/;
const COMPOUND = new Set(['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'async']);
const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };

export function tokenizePython(src) {
  const tokens = [], errors = [];
  const lines = new LineIndex(src);
  const at = i => lines.position(i);
  const indents = [0];
  const brackets = [];
  let i = 0, atLineStart = true, indentStyle = null;
  const push = (type, value, start, end) => { const p = at(start); tokens.push({ type, value, start, end, line: p.line, column: p.column, depth: brackets.length }); };
  while (i < src.length) {
    if (atLineStart && !brackets.length) {
      let j = i, width = 0, sawTab = false, sawSpace = false;
      while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\f')) {
        if (src[j] === '\t') { sawTab = true; width = (Math.floor(width / 8) + 1) * 8; } else if (src[j] === ' ') { sawSpace = true; width++; }
        j++;
      }
      const ch = src[j];
      if (ch === '\n' || ch === '\r' || ch === '#' || j >= src.length) { i = j; atLineStart = false; continue; }
      if (sawTab && sawSpace) errors.push({ kind: 'TabError', message: 'Indentation mixes tabs and spaces.', ...at(i), potential: true });
      const style = sawTab ? 'tab' : sawSpace ? 'space' : null;
      if (style && indentStyle && style !== indentStyle) errors.push({ kind: 'TabError', message: `Indentation uses ${style}s here but ${indentStyle}s elsewhere in the file.`, ...at(i), potential: true });
      if (style && !indentStyle) indentStyle = style;
      const top = indents[indents.length - 1];
      if (width > top) { indents.push(width); push('INDENT', '', i, j); }
      else if (width < top) {
        while (indents.length && width < indents[indents.length - 1]) { indents.pop(); push('DEDENT', '', j, j); }
        if (width !== indents[indents.length - 1]) { errors.push({ kind: 'IndentationError', message: 'unindent does not match any outer indentation level', ...at(j) }); indents.push(width); }
      }
      i = j; atLineStart = false; continue;
    }
    const c = src[i];
    if (c === '\n' || c === '\r') {
      const end = c === '\r' && src[i + 1] === '\n' ? i + 2 : i + 1;
      if (!brackets.length) { if (tokens.length && tokens[tokens.length - 1].type !== 'NEWLINE' && tokens[tokens.length - 1].type !== 'INDENT' && tokens[tokens.length - 1].type !== 'DEDENT') push('NEWLINE', '', i, end); atLineStart = true; }
      i = end; continue;
    }
    if (c === ' ' || c === '\t' || c === '\f') { i++; continue; }
    if (c === '#') { const end = src.indexOf('\n', i); push('COMMENT', src.slice(i, end < 0 ? src.length : end), i, end < 0 ? src.length : end); i = end < 0 ? src.length : end; continue; }
    if (c === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) { i += src[i + 1] === '\r' ? 3 : 2; continue; }
    // Identifiers, keywords and string prefixes.
    const idMatch = /^[A-Za-z_À-￿][\wÀ-￿]*/.exec(src.slice(i, i + 200));
    if (idMatch) {
      const word = idMatch[0];
      const next = src[i + word.length];
      if ((next === '"' || next === "'") && STRING_PREFIX.test(word)) { i = readString(i + word.length, word); continue; }
      push(KEYWORDS.has(word) ? 'KEYWORD' : 'NAME', word, i, i + word.length);
      i += word.length; continue;
    }
    if (c === '"' || c === "'") { i = readString(i, ''); continue; }
    const num = /^(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?)/.exec(src.slice(i, i + 100));
    if (num && num[0] !== '.') { push('NUMBER', num[0], i, i + num[0].length); i += num[0].length; continue; }
    if (OPEN[c]) { push('OP', c, i, i + 1); brackets.push({ ch: c, ...at(i) }); i++; continue; }
    if (CLOSE[c]) {
      const top = brackets[brackets.length - 1];
      if (!top) errors.push({ kind: 'SyntaxError', message: `unmatched '${c}'`, ...at(i) });
      else if (top.ch !== CLOSE[c]) { errors.push({ kind: 'SyntaxError', message: `closing parenthesis '${c}' does not match opening parenthesis '${top.ch}' on line ${top.line}`, ...at(i) }); brackets.pop(); }
      else brackets.pop();
      push('OP', c, i, i + 1); i++; continue;
    }
    const op = /^(?:\*\*=|\/\/=|>>=|<<=|:=|->|\*\*|\/\/|<<|>>|<=|>=|==|!=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|@=|\.\.\.|[-+*/%@&|^~<>=.,:;!])/.exec(src.slice(i, i + 4));
    if (op) { push('OP', op[0], i, i + op[0].length); i += op[0].length; continue; }
    errors.push({ kind: 'SyntaxError', message: `invalid character '${c}' (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`, ...at(i) });
    i++;
  }
  for (const b of brackets) errors.push({ kind: 'SyntaxError', message: `'${b.ch}' was never closed`, line: b.line, column: b.column });
  if (tokens.length && tokens[tokens.length - 1].type !== 'NEWLINE') push('NEWLINE', '', src.length, src.length);
  while (indents.length > 1) { indents.pop(); push('DEDENT', '', src.length, src.length); }
  push('ENDMARKER', '', src.length, src.length);
  return { tokens, errors, lines };

  function readString(start, prefix) {
    const q = src[start];
    const triple = src.slice(start, start + 3) === q.repeat(3);
    const raw = /r/i.test(prefix);
    let j = start + (triple ? 3 : 1);
    for (;;) {
      if (j >= src.length) { errors.push({ kind: 'SyntaxError', message: triple ? 'unterminated triple-quoted string literal' : 'unterminated string literal', ...at(start - prefix.length) }); break; }
      const ch = src[j];
      if (ch === '\\' && (!raw || src[j + 1] === q || src[j + 1] === '\\')) { j += 2; continue; }
      if (ch === '\\' && raw) { j++; continue; }
      if (!triple && (ch === '\n' || ch === '\r')) { errors.push({ kind: 'SyntaxError', message: 'unterminated string literal', ...at(start - prefix.length) }); break; }
      if (triple ? src.slice(j, j + 3) === q.repeat(3) : ch === q) { j += triple ? 3 : 1; break; }
      j++;
    }
    push('STRING', src.slice(start - prefix.length, j), start - prefix.length, j);
    tokens[tokens.length - 1].prefix = prefix.toLowerCase();
    return j;
  }
}

// Splits tokens into logical lines (statements) with their indentation depth.
function logicalLines(tokens) {
  const out = [];
  let cur = [], level = 0;
  for (const t of tokens) {
    if (t.type === 'INDENT') { level++; continue; }
    if (t.type === 'DEDENT') { level--; continue; }
    if (t.type === 'COMMENT') continue;
    if (t.type === 'NEWLINE' || t.type === 'ENDMARKER') { if (cur.length) out.push({ tokens: cur, level }); cur = []; continue; }
    cur.push(t);
  }
  return out;
}

const literalText = t => t.type === 'STRING' ? t.value.replace(/^[a-zA-Z]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '') : t.value;

function parseParams(toks) {
  // toks: tokens between the def's parentheses (exclusive).
  const params = [];
  let depth = 0, cur = [], kwOnly = false;
  const flush = () => {
    if (!cur.length) return;
    const first = cur[0];
    if (first.value === '/' && cur.length === 1) { cur = []; return; } // positional-only marker
    if (first.value === '*' && cur.length === 1) { kwOnly = true; cur = []; return; }
    const star = first.value === '*' ? 'vararg' : first.value === '**' ? 'kwarg' : null;
    const nameTok = cur.find(t => t.type === 'NAME' || (t.type === 'KEYWORD' && t.value === 'self'));
    const colon = cur.findIndex(t => t.value === ':' && t.depth === cur[0].depth);
    const eq = cur.findIndex(t => t.value === '=' && t.depth === cur[0].depth);
    const annotation = colon >= 0 ? cur.slice(colon + 1, eq >= 0 ? eq : undefined).map(t => t.value).join('') : null;
    const defaultTokens = eq >= 0 ? cur.slice(eq + 1) : [];
    params.push({ name: nameTok?.value || '?', kind: star || (kwOnly ? 'kwonly' : 'positional'), hasDefault: eq >= 0, defaultText: defaultTokens.map(t => t.value).join('').slice(0, 60), defaultTokens, annotation, line: first.line, column: first.column });
    if (star === 'vararg') kwOnly = true;
    cur = [];
  };
  for (const t of toks) {
    if (t.type === 'OP' && OPEN[t.value]) depth++;
    if (t.type === 'OP' && CLOSE[t.value]) depth--;
    if (depth === 0 && t.value === ',') { flush(); continue; }
    cur.push(t);
  }
  flush();
  return params;
}

function matchingClose(tokens, openIndex) {
  let depth = 0;
  for (let k = openIndex; k < tokens.length; k++) {
    if (tokens[k].type === 'OP' && OPEN[tokens[k].value]) depth++;
    else if (tokens[k].type === 'OP' && CLOSE[tokens[k].value]) { depth--; if (!depth) return k; }
  }
  return -1;
}

export function outlinePython(file, tokenized) {
  const { tokens } = tokenized;
  const statements = logicalLines(tokens);
  const outline = { functions: [], classes: [], assignments: new Set(), imports: [], all: null, hasGetattr: false, starImports: [], calls: [], envKeys: [], decorated: new Set(), mainGuard: false };
  const scope = []; // stack of {kind, name, level}
  let pendingDecorators = [];
  for (const st of statements) {
    const t = st.tokens;
    while (scope.length && scope[scope.length - 1].level >= st.level) scope.pop();
    const first = t[0];
    if (first.value === '@') { pendingDecorators.push(t.slice(1).map(x => x.value).join('')); continue; }
    const isAsync = first.value === 'async';
    const head = isAsync ? t[1] : first;
    if (head?.value === 'def' && t[isAsync ? 2 : 1]?.type === 'NAME') {
      const nameTok = t[isAsync ? 2 : 1];
      const open = t.findIndex(x => x.value === '(');
      const close = open >= 0 ? matchingClose(t, open) : -1;
      const params = open >= 0 && close > open ? parseParams(t.slice(open + 1, close)) : [];
      const arrow = t.findIndex((x, k) => k > close && x.value === '->');
      const returns = arrow >= 0 ? t.slice(arrow + 1, t.length - 1).map(x => x.value).join('') : null;
      const owner = scope[scope.length - 1];
      const fn = { name: nameTok.value, line: nameTok.line, column: nameTok.column, params, returns, async: isAsync, decorators: pendingDecorators, topLevel: !scope.length, className: owner?.kind === 'class' ? owner.name : null, level: st.level };
      outline.functions.push(fn);
      if (!scope.length) outline.assignments.add(fn.name);
      if (pendingDecorators.length && !scope.length) outline.decorated.add(fn.name);
      if (fn.name === '__getattr__' && !scope.length) outline.hasGetattr = true;
      scope.push({ kind: 'def', name: fn.name, level: st.level, fn });
      pendingDecorators = [];
      continue;
    }
    if (head?.value === 'class' && t[1]?.type === 'NAME') {
      outline.classes.push({ name: t[1].value, line: t[1].line, topLevel: !scope.length, bases: t.slice(2, t.findIndex(x => x.value === ':')).map(x => x.value).join('') });
      if (!scope.length) outline.assignments.add(t[1].value);
      scope.push({ kind: 'class', name: t[1].value, level: st.level });
      pendingDecorators = [];
      continue;
    }
    pendingDecorators = [];
    if (first.value === 'import') {
      let cur = [];
      const flush = () => {
        if (!cur.length) return;
        const asIdx = cur.findIndex(x => x.value === 'as');
        const mod = (asIdx >= 0 ? cur.slice(0, asIdx) : cur).map(x => x.value).join('');
        const alias = asIdx >= 0 ? cur[asIdx + 1]?.value : null;
        outline.imports.push({ kind: 'import', module: mod, level: 0, alias, line: first.line, column: first.column, topLevel: !scope.length, names: [] });
        if (!scope.length) outline.assignments.add(alias || mod.split('.')[0]);
        cur = [];
      };
      for (const x of t.slice(1)) { if (x.value === ',' && x.depth === first.depth) flush(); else cur.push(x); }
      flush();
      continue;
    }
    if (first.value === 'from') {
      let k = 1, level = 0;
      while (t[k] && (t[k].value === '.' || t[k].value === '...')) { level += t[k].value.length; k++; }
      const modToks = [];
      while (t[k] && t[k].value !== 'import') { modToks.push(t[k]); k++; }
      const names = [];
      const rest = t.slice(k + 1).filter(x => x.value !== '(' && x.value !== ')');
      let cur = [];
      const flush = () => {
        if (!cur.length) return;
        const asIdx = cur.findIndex(x => x.value === 'as');
        names.push({ name: cur[0].value, alias: asIdx >= 0 ? cur[asIdx + 1]?.value : null, line: cur[0].line, column: cur[0].column });
        cur = [];
      };
      for (const x of rest) { if (x.value === ',') flush(); else cur.push(x); }
      flush();
      const rec = { kind: 'from', module: modToks.map(x => x.value).join(''), level, names, line: first.line, column: first.column, topLevel: !scope.length };
      outline.imports.push(rec);
      if (names.some(n => n.name === '*')) outline.starImports.push(rec);
      if (!scope.length) for (const n of names) if (n.name !== '*') outline.assignments.add(n.alias || n.name);
      continue;
    }
    if (!scope.length) {
      // Module-level assignment targets: NAME (, NAME)* = ... / NAME: T = ...
      const eq = t.findIndex(x => x.type === 'OP' && (x.value === '=' || x.value === ':') && x.depth === 0);
      if (eq > 0 && t.slice(0, eq).every(x => x.type === 'NAME' || x.value === ',' || x.value === '(' || x.value === ')')) for (const x of t.slice(0, eq)) if (x.type === 'NAME') outline.assignments.add(x.value);
      if (first.value === '__all__') {
        const strs = t.filter(x => x.type === 'STRING').map(literalText);
        outline.all = strs;
      }
      if (first.value === 'if' && t.some(x => x.value === '__name__') && t.some(x => x.type === 'STRING' && literalText(x) === '__main__')) outline.mainGuard = true;
      if (['for', 'with'].includes(first.value)) {
        const asIdx = t.findIndex(x => x.value === 'as' || x.value === 'in');
        for (const x of t.slice(1, asIdx > 0 ? asIdx : 1)) if (x.type === 'NAME') outline.assignments.add(x.value);
      }
      if (['try', 'if', 'else', 'elif', 'except', 'finally', 'while', 'for', 'with'].includes(first.value)) scope.length = 0;
    }
    // Call sites (for cross-module arity checks) and environment reads.
    for (let k = 0; k < t.length; k++) {
      const x = t[k];
      if (x.type === 'NAME' && t[k + 1]?.value === '(' && t[k - 1]?.value !== 'def' && t[k - 1]?.value !== 'class') {
        const qualifier = t[k - 1]?.value === '.' && t[k - 2]?.type === 'NAME' && t[k - 3]?.value !== '.' ? t[k - 2].value : null;
        if (t[k - 1]?.value === '.' && !qualifier) continue;
        const close = matchingClose(t, k + 1);
        if (close < 0) continue;
        outline.calls.push({ name: x.value, qualifier, line: x.line, column: qualifier ? t[k - 2].column : x.column, args: splitArgs(t.slice(k + 2, close)), inScope: scope.map(s => s.name) });
      }
      if (x.value === 'environ' && t[k - 1]?.value === '.' && t[k - 2]?.value === 'os') {
        const key = t[k + 1]?.value === '[' && t[k + 2]?.type === 'STRING' ? literalText(t[k + 2]) : t[k + 1]?.value === '.' && t[k + 2]?.value === 'get' && t[k + 4]?.type === 'STRING' ? literalText(t[k + 4]) : null;
        if (key) outline.envKeys.push({ key, line: x.line, column: x.column });
      }
      if (x.value === 'getenv' && t[k - 1]?.value === '.' && t[k - 2]?.value === 'os' && t[k + 2]?.type === 'STRING') outline.envKeys.push({ key: literalText(t[k + 2]), line: x.line, column: x.column });
    }
  }
  outline.assignments = [...outline.assignments];
  outline.decorated = [...outline.decorated];
  return outline;
}

function splitArgs(toks) {
  const args = [];
  let depth = 0, cur = [];
  const flush = () => {
    if (!cur.length) return;
    if (cur[0].value === '*' || cur[0].value === '**') args.push({ kind: cur[0].value === '*' ? 'star' : 'starstar' });
    else if (cur[0].type === 'NAME' && cur[1]?.value === '=' && cur[1].depth === cur[0].depth) args.push({ kind: 'keyword', name: cur[0].value });
    else if (cur.some(t => t.value === 'for' && t.depth === cur[0].depth)) args.push({ kind: 'generator' });
    else args.push({ kind: 'positional' });
    cur = [];
  };
  for (const t of toks) {
    if (t.type === 'OP' && OPEN[t.value]) depth++;
    if (t.type === 'OP' && CLOSE[t.value]) depth--;
    if (depth === 0 && t.value === ',') { flush(); continue; }
    cur.push(t);
  }
  flush();
  return args;
}

const PY_RULES = {
  PY_SYNTAX: { title: 'Python syntax error', category: 'syntax', severity: 'high', verification: 'high-confidence', suggestion: 'Fix the reported construct; CPython will refuse to import this module.' },
  PY_INDENTATION: { title: 'Python indentation error', category: 'syntax', severity: 'high', verification: 'high-confidence', suggestion: 'Align the block with an enclosing indentation level.' },
  PY_TABS: { title: 'Inconsistent tabs and spaces', category: 'syntax', severity: 'medium', verification: 'potential', suggestion: 'Indent with spaces only (PEP 8); mixed indentation raises TabError in ambiguous cases.' },
  PY_MISSING_COLON: { title: 'Missing colon after block header', category: 'syntax', severity: 'high', verification: 'high-confidence', suggestion: 'Add a colon at the end of the statement header.' },
  PY2_SYNTAX: { title: 'Python 2-only syntax', category: 'syntax', severity: 'high', verification: 'high-confidence', suggestion: 'Port the statement to Python 3 syntax.' },
  PY_DYNAMIC_EXEC: { title: 'Dynamic Python execution', category: 'security', severity: 'critical', verification: 'security-observation', suggestion: 'Remove eval/exec on non-constant input or implement explicit dispatch.' },
  PY_PICKLE: { title: 'Unsafe deserialization', category: 'security', severity: 'high', verification: 'security-observation', suggestion: 'Untrusted pickle/marshal/shelve data can execute code; use JSON or another data-only format.' },
  PY_YAML_LOAD: { title: 'yaml.load without a safe loader', category: 'security', severity: 'high', verification: 'security-observation', suggestion: 'Use yaml.safe_load or Loader=yaml.SafeLoader.' },
  PY_SHELL: { title: 'Shell command execution', category: 'security', severity: 'high', verification: 'security-observation', suggestion: 'Use subprocess.run with an argument list and shell=False; validate every argument.' },
  PY_SQL_INJECTION: { title: 'SQL built by string formatting', category: 'security', severity: 'high', verification: 'security-observation', suggestion: 'Pass parameters separately: cursor.execute(sql, params).' },
  PY_TLS_DISABLED: { title: 'TLS verification disabled', category: 'security', severity: 'high', verification: 'security-observation', suggestion: 'Remove verify=False; trust a specific CA bundle instead.' },
  PY_WEAK_HASH: { title: 'Weak hash algorithm', category: 'security', severity: 'medium', verification: 'security-observation', suggestion: 'Use hashlib.sha256 or stronger; use a KDF for passwords.' },
  PY_INSECURE_RANDOM: { title: 'random module used for a security-sensitive value', category: 'security', severity: 'medium', verification: 'security-observation', suggestion: 'Use the secrets module for tokens, passwords and salts.' },
  PY_BARE_EXCEPT: { title: 'Bare exception handler', category: 'logic', severity: 'medium', verification: 'potential', suggestion: 'Catch specific exception types; a bare except also traps KeyboardInterrupt and SystemExit.' },
  PY_MUTABLE_DEFAULT: { title: 'Mutable default argument', category: 'logic', severity: 'medium', verification: 'high-confidence', suggestion: 'Default to None and create the list/dict inside the function.' },
  PY_IS_LITERAL: { title: 'Identity comparison with a literal', category: 'logic', severity: 'medium', verification: 'high-confidence', suggestion: 'Use == for value comparison; "is" compares object identity.' },
  PY_ASSERT_TUPLE: { title: 'Assert on a tuple is always true', category: 'logic', severity: 'medium', verification: 'high-confidence', suggestion: 'Write assert condition, "message" without parentheses around both.' },
  PY_RETURN_IN_INIT: { title: '__init__ returns a value', category: 'logic', severity: 'high', verification: 'high-confidence', suggestion: '__init__ must return None; constructing the object raises TypeError.' },
  PY_DUPLICATE_DEF: { title: 'Function or method redefined', category: 'logic', severity: 'medium', verification: 'high-confidence', suggestion: 'The earlier definition is silently replaced; rename or remove one.' },
  PY_UNREACHABLE: { title: 'Unreachable code', category: 'logic', severity: 'low', verification: 'high-confidence', suggestion: 'Statements after return/raise/break/continue in the same block never run.' },
  PY_EQ_NONE: { title: 'Equality comparison with None', category: 'quality', severity: 'low', verification: 'quality', suggestion: 'Use "is None" / "is not None".' },
  PY_PRINT: { title: 'Print statement', category: 'quality', severity: 'low', verification: 'quality', suggestion: 'Use configurable structured logging for diagnostics.' },
};

export function analyzePythonFile(file) {
  const tokenized = tokenizePython(file.content);
  const { tokens, errors, lines } = tokenized;
  const findings = [];
  const emit = (rule, at, extra = {}) => {
    const def = PY_RULES[rule];
    findings.push({ rule, ...def, ...extra, title: extra.title || def.title, file: file.path, line: at.line, column: at.column, excerpt: lines.lineText(at.line).trim(), analyzer: extra.analyzer || 'python-tokenizer' });
  };
  for (const e of errors) {
    if (e.kind === 'TabError') emit('PY_TABS', e, { rootCause: e.message });
    else emit(e.kind === 'IndentationError' ? 'PY_INDENTATION' : 'PY_SYNTAX', e, { rootCause: `${e.kind}: ${e.message} (detected by CodeProof's Python tokenizer; confirm with CPython compile()).`, dedupeKey: 'syntax' });
  }
  const statements = logicalLines(tokens);
  const blocking = errors.some(e => e.kind !== 'TabError');
  // Structural checks on logical lines.
  for (let s = 0; s < statements.length; s++) {
    const { tokens: t, level } = statements[s];
    const first = t[0];
    const kw = first.value === 'async' ? t[1]?.value : first.value;
    const isHeader = first.type === 'KEYWORD' && COMPOUND.has(first.value) && (first.value !== 'async' || ['def', 'for', 'with'].includes(t[1]?.value));
    if (isHeader) {
      const colonAt = t.findIndex(x => x.value === ':' && x.depth === 0 && !isLambdaColon(t, x));
      if (colonAt < 0) emit('PY_MISSING_COLON', t[t.length - 1], { rootCause: `The "${kw}" statement header has no terminating colon.` });
      else if (colonAt === t.length - 1) {
        const next = statements[s + 1];
        if (!next || next.level <= level) emit('PY_INDENTATION', t[t.length - 1], { title: 'Expected an indented block', rootCause: `The "${kw}" block on line ${first.line} has no indented body.` });
      }
    }
    if (first.value === 'print' && t[1] && (t[1].type === 'STRING' || t[1].type === 'NAME' || t[1].type === 'NUMBER')) emit('PY2_SYNTAX', first, { rootCause: 'print used as a statement is Python 2 syntax; Python 3 requires print(...).' });
    if (first.value === 'except' && t.some((x, k) => k > 1 && x.value === ',' && x.depth === 0) && !t.some(x => x.value === '(' && x.depth === 0)) emit('PY2_SYNTAX', first, { rootCause: '"except X, e" is Python 2 syntax; use "except X as e".' });
    if (first.value === 'except' && (t.length === 1 || t[1].value === ':')) emit('PY_BARE_EXCEPT', first);
    if (first.value === 'assert' && t[1]?.value === '(') {
      const close = matchingClose(t, 1);
      if (close === t.length - 1 && t.slice(2, close).some(x => x.value === ',' && x.depth === t[1].depth + 1)) emit('PY_ASSERT_TUPLE', first, { rootCause: 'assert (condition, "message") asserts a non-empty tuple, which is always truthy.' });
    }
    // Unreachable statements after return/raise/break/continue at the same level.
    if (['return', 'raise', 'break', 'continue'].includes(first.value)) {
      const next = statements[s + 1];
      if (next && next.level === level && !['def', 'class', 'elif', 'else', 'except', 'finally', 'case', '@', 'async'].includes(next.tokens[0].value)) emit('PY_UNREACHABLE', next.tokens[0], { rootCause: `This statement follows "${first.value}" in the same block and can never execute.` });
    }
  }
  // Token-level rules.
  const securityContext = k => { for (let j = k; j >= Math.max(0, k - 12); j--) if (tokens[j].type === 'NAME' && /token|secret|passw|salt|nonce|otp|session|api_?key|csrf/i.test(tokens[j].value)) return tokens[j].value; return null; };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k], n1 = tokens[k + 1], prev = tokens[k - 1];
    if (t.type !== 'NAME' && t.type !== 'KEYWORD') continue;
    const dotted = prev?.value === '.' ? `${tokens[k - 2]?.value}.${t.value}` : t.value;
    if ((t.value === 'eval' || t.value === 'exec') && n1?.value === '(' && prev?.value !== '.' && prev?.value !== 'def') {
      const arg = tokens[k + 2];
      const literal = arg?.type === 'STRING' && tokens[k + 3]?.value === ')';
      emit('PY_DYNAMIC_EXEC', t, { severity: literal ? 'medium' : 'critical', rootCause: `${t.value}() executes ${literal ? 'a constant string' : 'a runtime value'} as Python code.` });
    }
    if (/^(?:pickle|cPickle|dill|marshal|shelve|jsonpickle)\.(?:loads?|Unpickler|open|decode)$/.test(dotted) && n1?.value === '(') emit('PY_PICKLE', tokens[k - 2], { rootCause: `${dotted}() can execute code embedded in the data it reads.` });
    if (dotted === 'yaml.load' && n1?.value === '(') {
      const close = matchingClose(tokens, k + 1);
      const inner = tokens.slice(k + 2, close).map(x => x.value).join('');
      if (!/Loader=(?:yaml\.)?(?:Safe|CSafe|Base)Loader/.test(inner)) emit('PY_YAML_LOAD', tokens[k - 2]);
    }
    if (/^(?:os\.system|os\.popen|subprocess\.(?:getoutput|getstatusoutput))$/.test(dotted) && n1?.value === '(') emit('PY_SHELL', tokens[k - 2], { rootCause: `${dotted}() runs its argument through a shell.` });
    if (t.value === 'shell' && n1?.value === '=' && tokens[k + 2]?.value === 'True') emit('PY_SHELL', t, { title: 'subprocess call with shell=True', rootCause: 'shell=True passes the command through /bin/sh, so interpolated input can inject commands.' });
    if (t.value === 'verify' && n1?.value === '=' && tokens[k + 2]?.value === 'False' && t.depth > 0) emit('PY_TLS_DISABLED', t);
    if (/^hashlib\.(?:md5|sha1|md4)$/.test(dotted) && n1?.value === '(') emit('PY_WEAK_HASH', tokens[k - 2], { rootCause: `${dotted} is unsuitable for security purposes (fine for non-security checksums).` });
    if (/^random\.(?:random|randint|choice|choices|randrange|getrandbits|sample)$/.test(dotted) && n1?.value === '(') { const ctx = securityContext(k); if (ctx) emit('PY_INSECURE_RANDOM', tokens[k - 2], { rootCause: `random is predictable but feeds "${ctx}".` }); }
    if ((t.value === 'execute' || t.value === 'executemany' || t.value === 'executescript') && prev?.value === '.' && n1?.value === '(') {
      const arg = tokens[k + 2];
      const close = matchingClose(tokens, k + 1);
      const argToks = tokens.slice(k + 2, close);
      const firstArgEnd = argToks.findIndex(x => x.value === ',' && x.depth === arg?.depth);
      const firstArg = firstArgEnd >= 0 ? argToks.slice(0, firstArgEnd) : argToks;
      const sqlText = arg?.type === 'STRING' ? literalText(arg) : '';
      const formatted = (arg?.type === 'STRING' && arg.prefix?.includes('f') && /\{/.test(arg.value)) || firstArg.some(x => x.value === '%' || x.value === '+' || x.value === 'format');
      if (/^\s*(?:select|insert|update|delete|with|replace|create|drop|alter)\b/i.test(sqlText) && formatted) emit('PY_SQL_INJECTION', t, { rootCause: 'The SQL text is assembled with an f-string, % formatting, + or .format() instead of bound parameters.' });
    }
    if (t.value === 'is' && t.type === 'KEYWORD') {
      const rhs = n1?.value === 'not' ? tokens[k + 2] : n1;
      if (rhs && (rhs.type === 'NUMBER' || (rhs.type === 'STRING' && !rhs.prefix?.includes('f'))) || (prev && (prev.type === 'NUMBER' || prev.type === 'STRING') && tokens[k - 2]?.value !== 'is')) emit('PY_IS_LITERAL', t, { rootCause: '"is" with a str/bytes/int literal compares identity and CPython emits SyntaxWarning; results depend on interning.' });
    }
    if (t.value === 'None' && (prev?.value === '==' || prev?.value === '!=')) emit('PY_EQ_NONE', prev);
    if (t.value === 'print' && n1?.value === '(' && prev?.value !== '.' && prev?.value !== 'def') emit('PY_PRINT', t);
  }
  const outline = outlinePython(file, tokenized);
  for (const fn of outline.functions) {
    for (const p of fn.params) {
      const d = p.defaultTokens;
      if (!p.hasDefault || !d.length) continue;
      const mutable = (d[0].value === '[' || d[0].value === '{') || (d.length >= 3 && ['list', 'dict', 'set', 'defaultdict', 'OrderedDict', 'deque'].includes(d[0].value) && d[1].value === '(');
      if (mutable) emit('PY_MUTABLE_DEFAULT', p, { title: `Mutable default argument "${p.name}=${p.defaultText}"`, rootCause: `The default ${p.defaultText} is created once when "def ${fn.name}" runs and shared by every call, so mutations leak between calls.`, trigger: `Call ${fn.name}() twice without passing ${p.name} and mutate it in between.` });
    }
  }
  // Duplicate definitions in the same scope, and __init__ returning values.
  const scopes = new Map();
  for (const fn of outline.functions) {
    const key = `${fn.className || ''}|${fn.level}|${fn.topLevel}`;
    const names = scopes.get(key) || new Map();
    const overload = fn.decorators.some(d => /overload|setter|getter|deleter|register|property|\.(?:setter|deleter)/.test(d));
    if (names.has(fn.name) && !overload && !names.get(fn.name).overload) emit('PY_DUPLICATE_DEF', fn, { title: `"${fn.name}" is defined more than once`, rootCause: `"${fn.name}" was already defined on line ${names.get(fn.name).line}; the later definition replaces it.` });
    names.set(fn.name, { line: fn.line, overload });
    scopes.set(key, names);
  }
  for (const st of statements) {
    if (st.tokens[0].value !== 'return' || st.tokens.length < 2) continue;
    const owner = [...outline.functions].reverse().find(f => f.line < st.tokens[0].line && f.level < st.level);
    if (owner?.name === '__init__' && owner.className && !(st.tokens.length === 2 && st.tokens[1].value === 'None')) emit('PY_RETURN_IN_INIT', st.tokens[0], { rootCause: `__init__ of class ${owner.className} returns a value; instantiating ${owner.className} raises TypeError.`, trigger: `${owner.className}(...)` });
  }
  findings.push(...secretFindings(file, lines), ...todoFindings(file, lines));
  return {
    findings, outline,
    functions: outline.functions.filter(f => !f.className).map(f => ({ name: f.name, params: f.params.filter(p => p.kind === 'positional' && !['self', 'cls'].includes(p.name)).length, paramInfo: f.params, file: file.path, line: f.line, topLevel: f.topLevel, exported: f.topLevel && !f.name.startsWith('_'), decorators: f.decorators, async: f.async, returns: f.returns })),
    parse: { parser: 'python-tokenizer', ok: !blocking, notes: ['Structural tokenizer checks only; full grammar validation needs CPython (Pyodide runtime).'] },
  };
}

function isLambdaColon(tokens, colon) {
  const idx = tokens.indexOf(colon);
  for (let k = idx - 1; k >= 0; k--) { if (tokens[k].value === 'lambda' && tokens[k].depth === colon.depth) return true; }
  return false;
}
