// Static-only checks for languages without an in-browser compiler (Go, Rust, Java, Kotlin, Swift, C/C++,
// C#, PHP, Ruby, Shell, SQL). A comment/string-aware scanner checks delimiter balance; imports and risky
// calls are extracted from code tokens only. None of this is a parser, and results are labeled as such.
import { LineIndex } from './util.mjs';
import { secretFindings, todoFindings } from './text-rules.mjs';

const SYNTAX = {
  go: { line: ['//'], block: [['/*', '*/']], strings: ['"', "'", '`'] },
  rust: { line: ['//'], block: [['/*', '*/']], strings: ['"'], nestedBlock: true, rustChars: true },
  java: { line: ['//'], block: [['/*', '*/']], strings: ['"', "'"], triple: '"""' },
  kotlin: { line: ['//'], block: [['/*', '*/']], strings: ['"', "'"], triple: '"""', nestedBlock: true },
  swift: { line: ['//'], block: [['/*', '*/']], strings: ['"'], triple: '"""', nestedBlock: true },
  c: { line: ['//'], block: [['/*', '*/']], strings: ['"', "'"], preprocessor: true },
  cpp: { line: ['//'], block: [['/*', '*/']], strings: ['"', "'"], preprocessor: true, cppRaw: true },
  csharp: { line: ['//'], block: [['/*', '*/']], strings: ['"', "'"], verbatim: true, preprocessor: true },
  php: { line: ['//', '#'], block: [['/*', '*/']], strings: ['"', "'"] },
  sql: { line: ['--'], block: [['/*', '*/']], strings: ["'", '"'] },
};
const PAIRS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

// Returns code-only text (comments and string contents blanked) plus delimiter errors.
export function scanDelimiters(code, language) {
  const S = SYNTAX[language];
  if (!S) return { masked: code, errors: [], supported: false };
  const out = code.split('');
  const stack = [], errors = [];
  let i = 0;
  const blank = (a, b) => { for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < code.length) {
    const rest2 = code.slice(i, i + 3);
    if (S.preprocessor && code[i] === '#' && /(?:^|\n)[ \t]*$/.test(code.slice(Math.max(0, i - 80), i))) {
      let j = i;
      while (j < code.length && !(code[j] === '\n' && code[j - 1] !== '\\')) j++;
      blank(i, j); i = j; continue;
    }
    const lc = S.line.find(p => code.startsWith(p, i));
    if (lc) { const j = code.indexOf('\n', i); blank(i, j < 0 ? code.length : j); i = j < 0 ? code.length : j; continue; }
    const bc = S.block.find(([o]) => code.startsWith(o, i));
    if (bc) {
      let depth = 1, j = i + bc[0].length;
      while (j < code.length && depth) {
        if (S.nestedBlock && code.startsWith(bc[0], j)) { depth++; j += bc[0].length; continue; }
        if (code.startsWith(bc[1], j)) { depth--; j += bc[1].length; continue; }
        j++;
      }
      if (depth) errors.push({ message: 'Unterminated block comment', index: i });
      blank(i, j); i = j; continue;
    }
    if (S.triple && rest2 === S.triple) {
      const j = code.indexOf(S.triple, i + 3);
      if (j < 0) { errors.push({ message: 'Unterminated multi-line string', index: i }); blank(i, code.length); break; }
      blank(i, j + 3); i = j + 3; continue;
    }
    if (S.cppRaw && /^(?:u8|[uUL])?R"/.test(code.slice(i, i + 4)) && /[\w]/.test(code[i - 1] || '') === false) {
      const start = code.indexOf('R"', i) + 2;
      const paren = code.indexOf('(', start);
      const delim = code.slice(start, paren);
      const end = code.indexOf(`)${delim}"`, paren);
      if (paren > 0 && end > 0 && delim.length <= 16) { blank(i, end + delim.length + 2); i = end + delim.length + 2; continue; }
    }
    if (S.verbatim && code[i] === '@' && code[i + 1] === '"') {
      let j = i + 2;
      while (j < code.length) { if (code[j] === '"' && code[j + 1] === '"') { j += 2; continue; } if (code[j] === '"') break; j++; }
      blank(i, j + 1); i = j + 1; continue;
    }
    if (S.rustChars && code[i] === "'") {
      const m = /^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/.exec(code.slice(i, i + 14));
      if (m) { blank(i, i + m[0].length); i += m[0].length; continue; }
      i++; continue; // lifetime such as 'a
    }
    if (language === 'rust' && code[i] === 'r' && /^r#*"/.test(code.slice(i, i + 10)) && !/\w/.test(code[i - 1] || '')) {
      const hashes = /^r(#*)"/.exec(code.slice(i, i + 10))[1];
      const end = code.indexOf('"' + hashes, i + 2 + hashes.length);
      if (end > 0) { blank(i, end + 1 + hashes.length); i = end + 1 + hashes.length; continue; }
    }
    if (S.strings.includes(code[i])) {
      const q = code[i];
      let j = i + 1;
      const multiline = q === '`';
      while (j < code.length) {
        if (code[j] === '\\' && q !== '`') { j += 2; continue; }
        if (code[j] === q) break;
        if (code[j] === '\n' && !multiline && language !== 'php' && language !== 'sql') { errors.push({ message: 'Unterminated string or character literal', index: i }); break; }
        j++;
      }
      if (j >= code.length) errors.push({ message: 'Unterminated string literal', index: i });
      blank(i + 1, j); i = j + 1; continue;
    }
    const ch = code[i];
    if (PAIRS[ch]) stack.push({ ch, index: i });
    else if (CLOSERS[ch]) {
      const top = stack[stack.length - 1];
      if (!top) errors.push({ message: `Unmatched closing '${ch}'`, index: i });
      else if (top.ch !== CLOSERS[ch]) { errors.push({ message: `'${ch}' closes '${top.ch}' opened earlier`, index: i }); stack.pop(); }
      else stack.pop();
    }
    i++;
  }
  for (const s of stack.slice(-3)) errors.push({ message: `'${s.ch}' is never closed`, index: s.index });
  return { masked: out.join(''), errors, supported: true };
}

const IMPORTS = {
  go: [/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm],
  rust: [/^\s*(?:pub\s+)?(?:use|extern\s+crate)\s+([\w:]+)/gm, /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm],
  java: [/^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/gm],
  kotlin: [/^\s*import\s+([\w.*]+)/gm],
  swift: [/^\s*import\s+(\w+)/gm],
  c: [/^\s*#\s*include\s*([<"][^>"]+[>"])/gm],
  cpp: [/^\s*#\s*include\s*([<"][^>"]+[>"])/gm],
  csharp: [/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm],
  php: [/\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g, /^\s*use\s+([\w\\]+)/gm],
  ruby: [/^\s*require(?:_relative)?\s*\(?\s*['"]([^'"]+)['"]/gm],
  shell: [/^\s*(?:source|\.)\s+([^\s;]+)/gm],
};
const RISKY = {
  c: [[/\bgets\s*\(/g, 'gets() cannot bound input length and always permits buffer overflow.', 'high', 'high-confidence'], [/\b(?:strcpy|strcat|sprintf|vsprintf)\s*\(/g, 'Unbounded string copy/format can overflow the destination buffer.', 'medium', 'security-observation'], [/\bsystem\s*\(/g, 'system() runs a shell command.', 'medium', 'security-observation']],
  java: [[/\bRuntime\.getRuntime\(\)\.exec\s*\(/g, 'Runtime.exec runs an external process.', 'medium', 'security-observation'], [/\.readObject\s*\(/g, 'Java deserialization of untrusted data can execute code (gadget chains).', 'high', 'security-observation'], [/\.(?:executeQuery|executeUpdate|execute)\s*\(\s*"[^"]*"\s*\+/g, 'SQL statement is built by string concatenation.', 'high', 'security-observation']],
  go: [[/\bexec\.Command\s*\(\s*"(?:sh|bash|cmd)"/g, 'exec.Command invokes a shell interpreter.', 'medium', 'security-observation'], [/\.(?:Query|Exec|QueryRow)\s*\(\s*fmt\.Sprintf\s*\(/g, 'SQL statement is built with fmt.Sprintf.', 'high', 'security-observation'], [/InsecureSkipVerify\s*:\s*true/g, 'TLS certificate verification is disabled.', 'high', 'security-observation']],
  rust: [[/\bunsafe\s*\{/g, 'unsafe block bypasses Rust\'s memory-safety guarantees.', 'low', 'security-observation'], [/\bCommand::new\s*\(\s*"(?:sh|bash|cmd)"/g, 'Command::new invokes a shell interpreter.', 'medium', 'security-observation']],
  csharp: [[/\bBinaryFormatter\b/g, 'BinaryFormatter deserialization is unsafe for untrusted data.', 'high', 'security-observation'], [/\bProcess\.Start\s*\(/g, 'Process.Start runs an external process.', 'medium', 'security-observation']],
  php: [[/\b(?:eval|assert)\s*\(\s*\$/g, 'Dynamic code evaluation of a variable.', 'critical', 'security-observation'], [/\b(?:system|exec|shell_exec|passthru|popen|proc_open)\s*\(/g, 'Shell/process execution.', 'medium', 'security-observation'], [/\bunserialize\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)/g, 'unserialize() on request data enables object injection.', 'critical', 'security-observation'], [/\$_(?:GET|POST|REQUEST)\[[^\]]+\][^;]*\b(?:mysqli?_query|->query)\b|\b(?:mysqli?_query|->query)\s*\([^;]*\$_(?:GET|POST|REQUEST)/g, 'Request data flows into an SQL query string.', 'high', 'security-observation']],
  ruby: [[/\beval\s*\(/g, 'Dynamic code evaluation.', 'high', 'security-observation'], [/\b(?:YAML|Psych)\.load\s*\(/g, 'YAML.load can instantiate arbitrary objects on older Psych versions.', 'medium', 'security-observation'], [/\bMarshal\.load\s*\(/g, 'Marshal.load on untrusted data can execute code.', 'high', 'security-observation']],
  shell: [[/\beval\s+["$]/g, 'eval re-parses data as shell code.', 'high', 'security-observation'], [/\bcurl\b[^|\n]*\|\s*(?:ba|z)?sh\b/g, 'Piping a download straight into a shell executes unverified remote code.', 'high', 'security-observation']],
};
RISKY.cpp = RISKY.c; RISKY.kotlin = RISKY.java;

export function analyzeGenericFile(file) {
  const code = file.content;
  const lines = new LineIndex(code);
  const findings = [], imports = [];
  const scan = scanDelimiters(code, file.language);
  const masked = scan.masked;
  for (const e of scan.errors.slice(0, 5)) {
    const p = lines.position(e.index);
    findings.push({ rule: 'DELIMITER_BALANCE', title: 'Unbalanced delimiter (heuristic)', category: 'syntax', severity: 'medium', verification: 'potential', confidence: 'medium', file: file.path, line: p.line, column: p.column, excerpt: lines.lineText(p.line).trim(), rootCause: `${e.message}. Detected by CodeProof's comment/string-aware scanner, not a ${file.language} compiler; preprocessor branches or macros can cause false positives.`, suggestion: 'Confirm with the language\'s compiler; balance the delimiter if the report is accurate.', analyzer: 'delimiter-scanner', dedupeKey: 'syntax' });
  }
  const inCode = index => !scan.supported || ['c', 'cpp'].includes(file.language) || masked.slice(index, index + 40).trim() !== '';
  for (const re of IMPORTS[file.language] || []) {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) {
      // Only accept imports whose keyword sits in code (not in a comment or string).
      const keyword = m.index + m[0].search(/\S/);
      if (!inCode(keyword)) continue;
      const p = lines.position(keyword);
      imports.push({ specifier: m[1], line: p.line, column: p.column, kind: /require_relative/.test(m[0]) ? 'relative' : 'static' });
    }
  }
  if (file.language === 'go') {
    for (const m of masked.matchAll(/\bimport\s*\(/g)) {
      const end = masked.indexOf(')', m.index);
      const block = code.slice(m.index, end < 0 ? code.length : end);
      for (const s of block.matchAll(/"([^"\n]+)"/g)) {
        const p = lines.position(m.index + s.index);
        imports.push({ specifier: s[1], line: p.line, column: p.column, kind: 'static' });
      }
    }
  }
  for (const [re, message, severity, verification] of RISKY[file.language] || []) {
    re.lastIndex = 0;
    for (const m of masked.matchAll(re)) {
      const p = lines.position(m.index);
      findings.push({ rule: 'NATIVE_RISKY_CALL', title: 'Potentially risky system operation', category: 'security', severity, verification, file: file.path, line: p.line, column: p.column, excerpt: lines.lineText(p.line).trim(), rootCause: message, suggestion: 'Validate inputs and prefer safer APIs; confirm with a language-specific analyzer.', analyzer: 'native-pattern-rules' });
    }
  }
  findings.push(...secretFindings(file, lines), ...todoFindings(file, lines));
  return { findings, imports, parse: { parser: scan.supported ? 'delimiter-scanner' : 'none', ok: !scan.errors.length, heuristic: true, notes: [scan.supported ? 'Delimiter balance and token-level patterns only; no compiler or type checker for this language runs in the browser.' : 'Inventory, secret and pattern checks only.'] } };
}
