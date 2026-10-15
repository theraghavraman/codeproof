// Manifest and configuration analysis: strict JSON validation with exact positions, package.json and
// requirements models, semver range checks for lockfile consistency, and environment templates.
import { LineIndex } from './util.mjs';
import { basename, dirname } from './paths.mjs';
import { secretFindings, todoFindings } from './text-rules.mjs';

// Strict JSON validator that reports the exact failing offset (browser-independent messages).
export function jsonError(text) {
  let i = 0;
  const fail = message => { throw { message, index: Math.min(i, text.length) }; };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail(text[i] === '}' ? 'Trailing comma is not allowed in JSON' : 'Expected a double-quoted property name');
        string(); ws();
        if (text[i] !== ':') fail("Expected ':' after property name");
        i++; value(); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return; }
        fail("Expected ',' or '}' after property value");
      }
    }
    if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (;;) {
        value(); ws();
        if (text[i] === ',') { i++; ws(); if (text[i] === ']') fail('Trailing comma is not allowed in JSON'); continue; }
        if (text[i] === ']') { i++; return; }
        fail("Expected ',' or ']' after array element");
      }
    }
    if (c === '"') return string();
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
      if (!m) fail('Invalid number');
      i += m[0].length; return;
    }
    for (const lit of ['true', 'false', 'null']) if (text.startsWith(lit, i)) { i += lit.length; return; }
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) fail('Comments are not allowed in JSON');
    if (c === "'") fail('Strings must use double quotes in JSON');
    fail(i >= text.length ? 'Unexpected end of JSON input' : `Unexpected character '${c}'`);
  };
  const string = () => {
    i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') { i++; return; }
      if (ch === '\\') { if (!/["\\/bfnrtu]/.test(text[i + 1] || '')) fail('Invalid escape sequence'); i += text[i + 1] === 'u' ? 6 : 2; continue; }
      if (ch < ' ') fail('Unescaped control character in string');
      i++;
    }
    fail('Unterminated string');
  };
  try {
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    value(); ws();
    if (i < text.length) fail('Unexpected content after the JSON value');
    return null;
  } catch (error) {
    if (error && typeof error.index === 'number') return error;
    throw error;
  }
}

const JSONC_NAME = /^(?:tsconfig.*|jsconfig.*|devcontainer|\.eslintrc|\.babelrc|\.swcrc|turbo|deno|settings|extensions|launch|tasks|.*\.jsonc?)$/i;
export const allowsComments = path => /\.jsonc$/i.test(path) || /(?:^|\/)\.vscode\//.test(path) || JSONC_NAME.test(basename(path).replace(/\.jsonc?$/i, '')) && !/^package(?:-lock)?$/i.test(basename(path).replace(/\.json$/i, ''));

export function stripJsonComments(text) {
  let out = '', i = 0, inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) { out += c; if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; } if (c === '"') inString = false; i++; continue; }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && text[i + 1] === '*') { while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, ' $1');
}

export function parseJsonFile(file) {
  const tolerant = allowsComments(file.path);
  const text = tolerant ? stripJsonComments(file.content) : file.content;
  const error = jsonError(text);
  if (error) return { ok: false, error, tolerant };
  try { return { ok: true, value: JSON.parse(text.replace(/^﻿/, '')), tolerant }; } catch (e) { return { ok: false, error: { message: e.message, index: 0 }, tolerant }; }
}

export function analyzeConfigFile(file) {
  const lines = new LineIndex(file.content);
  const findings = [];
  const facts = {};
  const parse = { parser: 'none', ok: true, notes: [] };
  const base = basename(file.path).toLowerCase();
  if (file.language === 'json') {
    parse.parser = 'json-validator';
    const r = parseJsonFile(file);
    if (!r.ok) {
      parse.ok = false;
      const p = lines.position(r.error.index);
      findings.push({ rule: 'JSON_PARSE', title: `Invalid JSON in ${base}`, category: base === 'package.json' || base.startsWith('tsconfig') ? 'config' : 'syntax', severity: base === 'package.json' ? 'critical' : 'high', verification: 'confirmed-static', file: file.path, line: p.line, column: p.column, excerpt: lines.lineText(p.line).trim(), rootCause: `${r.error.message}.${base === 'package.json' ? ' npm, bundlers and Node cannot read this manifest, so installs, scripts and module resolution fail.' : ''}`, suggestion: r.tolerant ? 'Fix the structural error (comments and trailing commas are tolerated for this file type).' : 'Fix the JSON syntax; JSON does not allow comments, single quotes or trailing commas.', analyzer: 'json-validator', dedupeKey: 'syntax' });
    } else {
      facts.json = r.value;
      if (r.tolerant) parse.notes.push('Parsed as JSON with comments (JSONC).');
      if (base === 'package.json') findings.push(...checkPackageShape(file, r.value, lines));
    }
  } else if (base.startsWith('requirements') && base.endsWith('.txt')) {
    parse.parser = 'requirements-parser';
    facts.requirements = parseRequirements(file.content);
    const seen = new Map();
    for (const req of facts.requirements) {
      const prev = seen.get(req.name);
      if (prev && prev.spec !== req.spec) findings.push({ rule: 'DEP_CONFLICT', title: `Conflicting requirement for ${req.name}`, category: 'dependency', severity: 'medium', verification: 'high-confidence', file: file.path, line: req.line, column: 1, excerpt: lines.lineText(req.line).trim(), rootCause: `${req.name} is pinned as "${prev.spec || 'any'}" on line ${prev.line} and "${req.spec || 'any'}" here; pip resolves one of them or fails.`, suggestion: 'Keep a single requirement line per package.', analyzer: 'requirements-parser' });
      seen.set(req.name, req);
    }
  } else if (base === 'pyproject.toml') {
    parse.parser = 'toml-subset';
    facts.requirements = parsePyprojectDependencies(file.content);
    parse.notes.push('Only dependency arrays are read; TOML is not fully validated.');
  } else if (file.language === 'env') {
    const template = /\.(?:example|sample|template|dist|defaults?)$/i.test(base);
    facts.envKeys = [...file.content.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(m => ({ key: m[1], line: lines.position(m.index).line }));
    facts.envTemplate = template;
    if (!template && facts.envKeys.some(k => /=\s*\S/.test(lines.lineText(k.line)))) findings.push({ rule: 'ENV_FILE_INCLUDED', title: 'Environment file with values is part of the project', category: 'security', severity: 'medium', verification: 'security-observation', file: file.path, line: 1, column: 1, rootCause: `${base} contains concrete values. Environment files usually hold credentials and should not be committed or shared.`, suggestion: 'Commit a .env.example with placeholder values and keep the real file out of version control.', analyzer: 'config-rules' });
  } else {
    parse.notes.push(`${file.language || 'This file type'} is inventoried; no structural parser runs for it in the browser.`);
  }
  findings.push(...secretFindings(file, lines), ...todoFindings(file, lines));
  return { findings, facts, parse };
}

function checkPackageShape(file, pkg, lines) {
  const out = [];
  const lineOf = key => { const idx = file.content.indexOf(`"${key}"`); return idx >= 0 ? lines.position(idx).line : 1; };
  const add = (rule, key, title, rootCause, extra = {}) => out.push({ rule, title, category: 'config', severity: 'medium', verification: 'confirmed-static', file: file.path, line: lineOf(key), column: 1, excerpt: lines.lineText(lineOf(key)).trim(), rootCause, suggestion: 'Correct the manifest field so npm and Node can interpret it.', analyzer: 'package-json-rules', ...extra });
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) { add('PKG_SHAPE', 'name', 'package.json is not an object', 'The manifest must be a JSON object.'); return out; }
  if (pkg.type !== undefined && !['module', 'commonjs'].includes(pkg.type)) add('PKG_SHAPE', 'type', 'Invalid "type" field', `"type" must be "module" or "commonjs", not ${JSON.stringify(pkg.type)}.`);
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (deps === undefined) continue;
    if (typeof deps !== 'object' || Array.isArray(deps) || deps === null) { add('PKG_SHAPE', field, `"${field}" is not an object`, `${field} must map package names to version ranges.`); continue; }
    for (const [name, range] of Object.entries(deps)) if (typeof range !== 'string') add('PKG_SHAPE', name, `Invalid version for ${name}`, `The version of ${name} in ${field} must be a string.`);
  }
  for (const [name, range] of Object.entries(pkg.dependencies || {})) {
    const dev = pkg.devDependencies?.[name];
    if (typeof dev === 'string' && dev !== range) add('DEP_CONFLICT', name, `${name} declared twice with different ranges`, `${name} is "${range}" in dependencies and "${dev}" in devDependencies; installs use one of them.`, { category: 'dependency', verification: 'high-confidence' });
  }
  if (pkg.scripts !== undefined && (typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts))) add('PKG_SHAPE', 'scripts', '"scripts" is not an object', 'scripts must map script names to command strings.');
  return out;
}

export function parseRequirements(text) {
  const out = [];
  text.split('\n').forEach((raw, idx) => {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('-') || /^(?:git\+|https?:|file:)/.test(line)) return;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([<>=!~^][^;]*)?/.exec(line);
    if (m) out.push({ name: m[1].toLowerCase().replace(/_/g, '-'), spec: (m[3] || '').trim(), line: idx + 1 });
  });
  return out;
}

export function parsePyprojectDependencies(text) {
  const out = [];
  const lines = text.split('\n');
  let section = '', inArray = false;
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    const sec = /^\[([^\]]+)\]/.exec(line);
    if (sec) { section = sec[1]; inArray = false; return; }
    if (/^(?:dependencies|requires|dev-dependencies)\s*=\s*\[/.test(line) || (section.startsWith('project.optional-dependencies') && /=\s*\[/.test(line)) || (section === 'dependency-groups' && /=\s*\[/.test(line))) inArray = true;
    if (inArray) {
      for (const m of line.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)) out.push({ name: m[1].toLowerCase().replace(/_/g, '-'), spec: '', line: idx + 1 });
      if (line.includes(']')) inArray = false;
      return;
    }
    if (/^tool\.poetry\.(?:dev-)?dependencies$|^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section)) {
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
      if (m && m[1].toLowerCase() !== 'python') out.push({ name: m[1].toLowerCase().replace(/_/g, '-'), spec: '', line: idx + 1 });
    }
  });
  return out;
}

// ---- Semver range evaluation (npm subset: exact, x-ranges, ^, ~, comparators, hyphen ranges, ||) ----
function parseVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim());
  if (!m) return null;
  const n = x => (x === undefined || x === 'x' || x === '*' ? null : Number(x));
  return { major: Number(m[1]), minor: n(m[2]), patch: n(m[3]), pre: m[4] || null };
}
const cmp = (a, b) => (a.major - b.major) || ((a.minor ?? 0) - (b.minor ?? 0)) || ((a.patch ?? 0) - (b.patch ?? 0)) || (a.pre && !b.pre ? -1 : !a.pre && b.pre ? 1 : a.pre && b.pre ? (a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0) : 0);
function comparatorSet(range) {
  const set = [];
  const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(range);
  if (hyphen) return [['>=', parseVersion(hyphen[1])], ['<=', parseVersion(hyphen[2])]];
  for (const token of range.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(\^|~>?|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
    const op = m[1] || '', v = m[2] === '*' || m[2] === 'x' || m[2] === 'latest' ? { major: null } : parseVersion(m[2]);
    if (!v) return null;
    if (v.major === null) continue;
    const lo = { major: v.major, minor: v.minor ?? 0, patch: v.patch ?? 0, pre: v.pre };
    if (op === '^') {
      const hi = v.major > 0 || v.minor === null ? { major: v.major + 1, minor: 0, patch: 0 } : v.minor > 0 || v.patch === null ? { major: 0, minor: v.minor + 1, patch: 0 } : { major: 0, minor: 0, patch: (v.patch ?? 0) + 1 };
      set.push(['>=', lo], ['<', hi]);
    } else if (op.startsWith('~')) {
      set.push(['>=', lo], ['<', v.minor === null ? { major: v.major + 1, minor: 0, patch: 0 } : { major: v.major, minor: v.minor + 1, patch: 0 }]);
    } else if (!op || op === '=') {
      if (v.minor === null) set.push(['>=', lo], ['<', { major: v.major + 1, minor: 0, patch: 0 }]);
      else if (v.patch === null) set.push(['>=', lo], ['<', { major: v.major, minor: v.minor + 1, patch: 0 }]);
      else set.push(['=', lo]);
    } else set.push([op, lo]);
  }
  return set;
}
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v || v.minor === null || v.patch === null) return null;
  const r = String(range).trim();
  if (!r || r === '*' || r === 'latest' || r === 'x') return true;
  if (/^(?:file:|link:|workspace:|git|https?:|npm:|github:|[\w-]+\/[\w-]+)/.test(r)) return null; // not a semver range
  let anyEvaluated = false;
  for (const part of r.split('||')) {
    const set = comparatorSet(part);
    if (!set) continue;
    anyEvaluated = true;
    const ok = set.every(([op, target]) => { const c = cmp(v, target); return op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0; });
    if (ok && (!v.pre || set.some(([, t]) => t.pre && t.major === v.major && t.minor === v.minor && t.patch === v.patch))) return true;
  }
  return anyEvaluated ? false : null;
}

export function packageModel(file, json) {
  const deps = new Map();
  for (const [field, kind] of [['dependencies', 'prod'], ['devDependencies', 'dev'], ['peerDependencies', 'peer'], ['optionalDependencies', 'optional']]) {
    for (const [name, range] of Object.entries(json?.[field] || {})) if (!deps.has(name) || kind === 'prod') deps.set(name, { name, range: String(range), kind });
  }
  return { path: file.path, dir: dirname(file.path), name: typeof json?.name === 'string' ? json.name : null, type: json?.type === 'module' ? 'module' : 'commonjs', json, deps, scripts: json?.scripts && typeof json.scripts === 'object' ? json.scripts : {}, workspaces: Array.isArray(json?.workspaces) ? json.workspaces : Array.isArray(json?.workspaces?.packages) ? json.workspaces.packages : [] };
}
