// Deterministic, signature-driven input generation. Expected outputs are never invented: generated cases
// only look for crashes, NaN/Infinity results and contract violations whose meaning is unambiguous.
import { seededRandom } from './util.mjs';

const NUMBER_NAME = /^(?:n|i|j|k|x|y|z|a|b|count|num|number|index|idx|total|sum|amount|price|qty|quantity|size|len|length|age|value|val|min|max|limit|offset|rate|percent|pct|score|width|height|depth|level|step|start|end|from|to|lo|hi|base|exp|factor|ms|seconds|timeout|year|month|day|hours?|minutes?)\d*$/i;
const STRING_NAME = /^(?:s|str|text|name|title|label|msg|message|path|url|uri|email|word|query|key|id|slug|prefix|suffix|sep|separator|pattern|input|line|content|html|code|token|username|password|first_?name|last_?name|description|lang|locale)\d*$/i;
const ARRAY_NAME = /^(?:arr|array|items|list|values|nums|numbers|xs|ys|elements|entries|rows|data|scores|prices|words|names|lines|records|collection|vec|seq|sequence)\d*$/i;
const BOOL_NAME = /^(?:is[A-Z_]\w*|has[A-Z_]\w*|should[A-Z_]\w*|flag|enabled|disabled|strict|verbose|force|dry_?run|recursive|ascending|descending|reverse|inclusive)$/;
const OBJECT_NAME = /^(?:obj|object|options|opts|config|cfg|settings|params|props|user|person|item|record|payload|body|data|ctx|context|state|dict|mapping|map)$/i;

export function inferType(param, language) {
  const raw = (param.type || param.annotation || '').replace(/\s+/g, '').replace(/^\{|\}$/g, '');
  const t = raw.toLowerCase();
  if (raw) {
    const optional = /\|(?:undefined|null)|optional\[|\|none|none\|/.test(t) || param.optional;
    const base = t.replace(/\|(?:undefined|null|none)/g, '').replace(/^optional\[(.+)\]$/, '$1');
    if (/^(?:number|int|float|bigint|complex|decimal)$/.test(base)) return { type: base === 'int' ? 'int' : 'number', declared: true, optional };
    if (/^(?:string|str)$/.test(base) || /^(?:'[^']*'|"[^"]*")(?:\|(?:'[^']*'|"[^"]*"))*$/.test(raw)) return { type: 'string', declared: true, optional, literals: raw.match(/["']([^"']*)["']/g)?.map(s => s.slice(1, -1)) };
    if (/^(?:boolean|bool)$/.test(base)) return { type: 'boolean', declared: true, optional };
    if (/^(?:number\[\]|array<number>|list\[(?:int|float)\]|readonlyarray<number>|sequence\[(?:int|float)\]|iterable\[(?:int|float)\])$/.test(base)) return { type: 'number[]', declared: true, optional };
    if (/^(?:string\[\]|array<string>|list\[str\]|sequence\[str\])$/.test(base)) return { type: 'string[]', declared: true, optional };
    if (/^(?:any\[\]|unknown\[\]|array<any>|list|list\[any\]|array)$/.test(base)) return { type: 'array', declared: true, optional };
    if (/\[\]$|^array<|^list|^sequence|^tuple|^iterable/.test(base)) return { type: 'unknown', declared: true, optional, raw };
    if (/^(?:record<|dict|map|\{)/.test(base)) return { type: 'object', declared: true, optional };
    return { type: 'unknown', declared: true, optional, raw };
  }
  if (param.hasDefault && param.defaultText !== undefined) {
    const d = String(param.defaultText).trim();
    if (/^-?\d+(?:\.\d+)?$/.test(d)) return { type: d.includes('.') ? 'number' : language === 'python' ? 'int' : 'number', declared: false, optional: true };
    if (/^["'`]/.test(d)) return { type: 'string', declared: false, optional: true };
    if (/^(?:true|false|True|False)$/.test(d)) return { type: 'boolean', declared: false, optional: true };
    if (/^\[/.test(d)) return { type: 'array', declared: false, optional: true };
  }
  const name = param.name || '';
  if (BOOL_NAME.test(name)) return { type: 'boolean', declared: false };
  if (ARRAY_NAME.test(name)) return { type: /word|name|line/i.test(name) ? 'string[]' : 'number[]', declared: false };
  if (NUMBER_NAME.test(name)) return { type: 'number', declared: false };
  if (STRING_NAME.test(name)) return { type: 'string', declared: false };
  if (OBJECT_NAME.test(name)) return { type: 'object', declared: false };
  return { type: 'unknown', declared: false };
}

function valuesFor(info, rnd, language) {
  const int = () => Math.floor(rnd() * 201) - 100;
  switch (info.type) {
    case 'int': return { typical: 7, boundaries: [0, -1, 1, 1_000_000_000, int()] };
    case 'number': return { typical: 7, boundaries: [0, -1, 2.5, 1e9, int()] };
    case 'string': {
      if (info.literals?.length) return { typical: info.literals[0], boundaries: info.literals.slice(1, 4) };
      return { typical: 'example', boundaries: ['', ' padded ', 'Ünïcödé ✓', 'a'.repeat(300)] };
    }
    case 'boolean': return { typical: true, boundaries: [false] };
    case 'number[]': return { typical: [3, 1, 2], boundaries: [[], [0], [-5, 10, 10], [int(), int(), int(), int()]] };
    case 'string[]': return { typical: ['beta', 'alpha'], boundaries: [[], [''], ['same', 'same']] };
    case 'array': return { typical: [1, 2, 3], boundaries: [[], [null]] };
    case 'object': return { typical: { id: 1, name: 'example' }, boundaries: [{}] };
    default: return { typical: 1, boundaries: language === 'python' ? [None(), 0, '', []] : [null, undefined, 0, '', []] };
  }
}
const None = () => null;

export function generateCases(fn, { seed = 'codeproof', maxCases = 8, language = 'javascript' } = {}) {
  const params = (fn.paramInfo || []).filter(p => language !== 'python' || (p.kind === 'positional' && !['self', 'cls'].includes(p.name)));
  const rnd = seededRandom(`${seed}|${fn.file}|${fn.name}`);
  const infos = params.map(p => ({ param: p, ...inferType(p, language) }));
  const sets = infos.map(info => valuesFor(info, rnd, language));
  const contract = !infos.length || infos.every(i => i.declared && i.type !== 'unknown') ? 'declared' : infos.every(i => i.type !== 'unknown') ? 'inferred' : 'unknown';
  // A declared type that cannot be generated (an interface, class or domain object) would only produce
  // inputs that violate the contract, so such functions are not probed at all.
  const ungeneratable = infos.filter(i => i.declared && i.type === 'unknown').map(i => `${i.param.name}: ${i.raw || i.param.type || i.param.annotation}`);
  if (ungeneratable.length) return { contract: 'declared-unsupported', parameters: infos.map(i => ({ name: i.param.name, type: i.type, declared: i.declared })), cases: [], seed: `${seed}|${fn.file}|${fn.name}`, skipReason: `No generator for declared parameter type ${ungeneratable.join(', ')}; probing would violate the contract.` };
  const cases = [];
  const push = (args, rationale) => {
    if (cases.length >= maxCases) return;
    const key = JSON.stringify(args, (k, v) => (v === undefined ? '__undefined__' : v));
    if (cases.some(c => c.key === key)) return;
    cases.push({ id: `${fn.file}:${fn.name}:${cases.length}`, args, rationale, key, contract });
  };
  const typical = sets.map(s => s.typical);
  push(typical, 'Representative values for every parameter');
  for (let i = 0; i < sets.length; i++) for (const b of sets[i].boundaries) push(typical.map((v, j) => (j === i ? b : v)), `Boundary value for "${infos[i].param.name}" (${infos[i].type})`);
  if (sets.length > 1) push(sets.map(s => s.boundaries[0] ?? s.typical), 'All parameters at their first boundary simultaneously');
  for (const c of cases) delete c.key;
  return { contract, parameters: infos.map(i => ({ name: i.param.name, type: i.type, declared: i.declared })), cases, seed: `${seed}|${fn.file}|${fn.name}` };
}
