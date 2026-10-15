// Findings registry: one normalized shape for every analyzer, with deduplication that keeps provenance.
import { fnv1a, redact, clampText } from './util.mjs';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
export const SEVERITY_LABELS = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Informational' };
export const VERIFICATION = Object.freeze({
  'confirmed-runtime': 'Confirmed defect reproduced during execution',
  'confirmed-static': 'Confirmed syntax, compilation or configuration failure',
  'high-confidence': 'High-confidence static finding',
  potential: 'Potential defect needing further investigation',
  quality: 'Code-quality recommendation',
  'security-observation': 'Security observation (exploitability not established)',
});
export const VERIFICATION_ORDER = ['confirmed-runtime', 'confirmed-static', 'high-confidence', 'potential', 'security-observation', 'quality'];
export const CATEGORIES = Object.freeze({
  syntax: 'Syntax and parsing', compile: 'Compilation', type: 'Types', runtime: 'Runtime', logic: 'Logic',
  security: 'Security', integration: 'Project integration', dependency: 'Dependencies', config: 'Configuration',
  test: 'Tests', quality: 'Quality and maintainability', performance: 'Performance',
});
export const CONFIDENCE = ['high', 'medium', 'low'];

const rank = (list, value) => { const i = list.indexOf(value); return i < 0 ? list.length : i; };

// Style-only and quality recommendations never outrank behavior-affecting defects.
export function calibrateSeverity(finding) {
  let severity = SEVERITIES.includes(finding.severity) ? finding.severity : 'medium';
  if (finding.verification === 'quality' && rank(SEVERITIES, severity) < rank(SEVERITIES, 'low')) severity = 'low';
  if (finding.verification === 'potential' && severity === 'critical') severity = 'high';
  return severity;
}

export function makeFinding(input) {
  const verification = VERIFICATION[input.verification] ? input.verification : 'potential';
  const f = {
    id: '',
    rule: input.rule || 'UNSPECIFIED',
    title: clampText(redact(input.title || input.rule), 200),
    category: CATEGORIES[input.category] ? input.category : 'quality',
    severity: 'medium',
    confidence: CONFIDENCE.includes(input.confidence) ? input.confidence : (verification.startsWith('confirmed') ? 'high' : 'medium'),
    verification,
    verificationLabel: VERIFICATION[verification],
    scope: input.scope || (input.file ? 'file' : 'project'),
    file: input.file || null,
    line: input.line ? Math.max(1, input.line | 0) : null,
    column: input.column ? Math.max(1, input.column | 0) : null,
    endLine: input.endLine || null,
    endColumn: input.endColumn || null,
    excerpt: input.excerpt ? clampText(redact(input.excerpt), 300) : '',
    rootCause: clampText(redact(input.rootCause || input.message || ''), 1500),
    trigger: clampText(redact(input.trigger || ''), 600),
    reproduction: (input.reproduction || []).map(s => clampText(redact(s), 400)).slice(0, 8),
    actual: input.actual !== undefined ? clampText(redact(typeof input.actual === 'string' ? input.actual : JSON.stringify(input.actual)), 600) : '',
    expected: input.expected !== undefined ? clampText(redact(typeof input.expected === 'string' ? input.expected : JSON.stringify(input.expected)), 600) : '',
    affected: [...new Set(input.affected || [])].slice(0, 20),
    suggestion: clampText(redact(input.suggestion || input.remediation || ''), 800),
    related: [],
    relatedKeys: input.relatedKeys || [],
    analyzers: [...new Set([].concat(input.analyzer || input.analyzers || 'unknown'))],
    evidence: (input.evidence || []).map(e => clampText(redact(e), 400)).slice(0, 10),
    autofix: input.autofix || '',
    dedupeKey: input.dedupeKey || null,
    priority: input.priority || 0,
    tags: input.tags || [],
  };
  f.severity = calibrateSeverity({ ...f, severity: input.severity });
  // Legacy aliases kept for the existing inspector, receipts and CI annotations.
  f.message = f.rootCause;
  f.remediation = f.suggestion;
  f.id = 'CP-' + fnv1a(`${f.rule}|${f.file}|${f.line}|${f.column}|${f.title}`).slice(0, 10).toUpperCase();
  return f;
}

export class FindingRegistry {
  constructor() { this.byKey = new Map(); }
  key(f) { return `${f.file || '<project>'}|${f.line || 0}|${f.dedupeKey || f.rule}`; }
  add(input) {
    const f = input.verificationLabel ? input : makeFinding(input);
    const key = this.key(f);
    const existing = this.byKey.get(key);
    if (!existing) { this.byKey.set(key, f); return f; }
    // Merge: keep the strongest evidence class, union provenance and evidence.
    const vf = rank(VERIFICATION_ORDER, f.verification), ve = rank(VERIFICATION_ORDER, existing.verification);
    const stronger = vf < ve || (vf === ve && (f.priority || 0) > (existing.priority || 0));
    const base = stronger ? { ...f } : existing;
    const other = stronger ? existing : f;
    base.analyzers = [...new Set([...base.analyzers, ...other.analyzers])];
    base.evidence = [...new Set([...base.evidence, ...other.evidence, other.title !== base.title ? `${other.analyzers.join(', ')}: ${other.title}` : null].filter(Boolean))].slice(0, 10);
    base.affected = [...new Set([...base.affected, ...other.affected])];
    base.relatedKeys = [...new Set([...(base.relatedKeys || []), ...(other.relatedKeys || [])])];
    base.reproduction = base.reproduction.length ? base.reproduction : other.reproduction;
    if (rank(SEVERITIES, other.severity) < rank(SEVERITIES, base.severity) && base.verification !== 'quality') base.severity = other.severity;
    if (!base.column && other.column) base.column = other.column;
    this.byKey.set(key, base);
    return base;
  }
  addAll(list) { for (const f of list || []) this.add(f); }
  finalize() {
    const list = [...this.byKey.values()];
    const byRelKey = new Map();
    for (const f of list) for (const k of f.tags.filter(t => t.startsWith('key:'))) byRelKey.set(k.slice(4), f.id);
    for (const f of list) {
      const related = new Set();
      for (const k of f.relatedKeys || []) if (byRelKey.has(k) && byRelKey.get(k) !== f.id) related.add(byRelKey.get(k));
      for (const g of list) if (g !== f && g.file && g.file === f.file && g.line && g.line === f.line) related.add(g.id);
      for (const id of f.related || []) related.add(id);
      f.related = [...related].filter(id => id !== f.id).slice(0, 12);
      delete f.relatedKeys;
    }
    return sortFindings(list);
  }
}

export function sortFindings(list) {
  return list.sort((a, b) =>
    rank(VERIFICATION_ORDER, a.verification) - rank(VERIFICATION_ORDER, b.verification) ||
    rank(SEVERITIES, a.severity) - rank(SEVERITIES, b.severity) ||
    String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0) || a.rule.localeCompare(b.rule));
}

export function summarizeFindings(findings) {
  const by = (field, values) => Object.fromEntries(values.map(v => [v, findings.filter(f => f[field] === v).length]));
  return {
    total: findings.length,
    bySeverity: by('severity', SEVERITIES),
    byVerification: by('verification', Object.keys(VERIFICATION)),
    byCategory: by('category', Object.keys(CATEGORIES)),
    defects: findings.filter(f => ['confirmed-runtime', 'confirmed-static', 'high-confidence'].includes(f.verification)).length,
  };
}

export function filterFindings(findings, { severity, category, file, verification, analyzer, search } = {}) {
  const q = (search || '').trim().toLowerCase();
  return findings.filter(f =>
    (!severity || severity === 'all' || f.severity === severity) &&
    (!category || category === 'all' || f.category === category) &&
    (!verification || verification === 'all' || f.verification === verification) &&
    (!file || file === 'all' || f.file === file || (f.affected || []).includes(file)) &&
    (!analyzer || analyzer === 'all' || f.analyzers.includes(analyzer)) &&
    (!q || `${f.title} ${f.rule} ${f.rootCause} ${f.file} ${f.id}`.toLowerCase().includes(q)));
}
