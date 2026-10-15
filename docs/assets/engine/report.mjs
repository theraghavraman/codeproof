// Report generation (JSON, Markdown, SARIF 2.1.0). Reports stay in memory until the user exports them;
// secrets are already redacted at finding creation, and file contents are never embedded.
import { VERIFICATION, SEVERITY_LABELS, CATEGORIES } from './findings.mjs';
import { CAPABILITY_LABELS } from './capabilities.mjs';

export function buildReport(scan) {
  return {
    schema: scan.schema,
    engineVersion: scan.engineVersion,
    generatedAt: scan.generatedAt,
    project: scan.project,
    verdict: scan.coverage.verdict,
    coverage: { files: scan.coverage.files, ratios: scan.coverage.ratios, languages: scan.coverage.languages, integration: scan.coverage.integration, runtime: scan.coverage.runtime, blocked: scan.coverage.blocked, limits: scan.coverage.limits },
    analyzers: scan.analyzerRuns.map(r => ({ id: r.id, label: r.label, status: r.status, files: r.files, durationMs: Math.round(r.durationMs || 0), failures: r.failures.slice(0, 20), detail: r.detail })),
    diagnostics: scan.diagnostics,
    capabilities: scan.capabilities,
    findings: scan.findings.map(({ dedupeKey, tags, ...f }) => f),
    graph: { entryPoints: scan.graph.entryPoints, cycles: scan.graph.cycles, edges: scan.graph.edges.slice(0, 5000), externalPackages: scan.graph.externalPackages, frameworks: scan.graph.frameworks },
    runtime: scan.runtime,
    manifest: scan.manifest,
    files: scan.files,
    authorship: scan.authorship ? { ...scan.authorship, notice: 'Secondary heuristic estimate; independent of all findings and coverage figures.' } : null,
    limitations: scan.limitations,
    privacy: 'Generated entirely in the browser. No source code, findings or report data were transmitted by CodeProof.',
  };
}

const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function reportMarkdown(scan) {
  const c = scan.coverage;
  const lines = [];
  lines.push(`# CodeProof scan report — ${scan.project.name}`, '', `Generated ${scan.generatedAt} · engine ${scan.engineVersion} · schema ${scan.schema}`, '');
  lines.push('## Verdict', '', `**${c.verdict.state === 'no-findings' ? 'No findings in the checks that ran' : c.verdict.incomplete ? 'Verification incomplete' : 'Defects found'}.** ${c.verdict.message}`, '');
  if (c.verdict.reasons.length) lines.push(...c.verdict.reasons.map(r => `- ${r}`), '');
  lines.push('## Coverage', '', '| Measure | Covered | Of | % | Definition |', '|---|---:|---:|---:|---|');
  for (const r of c.ratios) lines.push(`| ${esc(r.label)} | ${r.numerator} | ${r.denominator} | ${r.percent ?? '—'} | ${esc(r.definition)} |`);
  lines.push('', `Files discovered: ${c.files.discovered} · ingested: ${c.files.ingested} · recognized source: ${c.files.recognizedSource} · parse failures: ${c.files.parseFailures} · skipped: ${c.files.skipped} · heuristic-only: ${c.files.heuristicOnly}`, '');
  if (Object.keys(c.files.skippedReasons).length) { lines.push('### Skipped or limited', ''); for (const [k, v] of Object.entries(c.files.skippedReasons)) lines.push(`- ${v} × ${k}`); lines.push(''); }
  lines.push('## Analysis engines', '', '| Engine | Status | Files | Notes |', '|---|---|---:|---|');
  for (const r of scan.analyzerRuns) lines.push(`| ${esc(r.label)} | ${r.status} | ${r.files} | ${esc(r.detail || (r.failures.length ? `${r.failures.length} failure(s)` : ''))} |`);
  if (c.blocked.length) { lines.push('', '## Checks blocked by missing capabilities', ''); for (const b of c.blocked.slice(0, 80)) lines.push(`- ${b.capability}${b.files ? ` (${b.files} file(s))` : ''}${b.reason ? `: ${b.reason}` : ''}`); }
  if (scan.runtime?.enabled) {
    const rt = scan.runtime;
    lines.push('', '## Runtime and tests', '', `- Tests discovered: ${rt.testsDiscovered}; executed: ${rt.testsExecuted}; passed: ${rt.testsPassed}; failed: ${rt.testsFailed}; blocked: ${rt.testsBlocked}`, `- Generated cases: ${rt.testsGenerated}; executed: ${rt.generatedExecuted}; functions probed: ${rt.functionsProbed} of ${rt.functionsEligible} eligible`, `- Modules loaded: ${rt.modulesLoaded} of ${rt.modulesEligible}; time limits hit: ${rt.timeouts}`);
  } else lines.push('', '## Runtime and tests', '', 'Runtime checks were not run for this report. No code was executed.');
  lines.push('', `## Findings (${scan.findings.length})`, '');
  const groups = Object.keys(VERIFICATION);
  for (const v of groups) {
    const list = scan.findings.filter(f => f.verification === v);
    if (!list.length) continue;
    lines.push(`### ${VERIFICATION[v]} (${list.length})`, '');
    for (const f of list.slice(0, 400)) {
      lines.push(`- **${SEVERITY_LABELS[f.severity]}** · ${CATEGORIES[f.category]} · \`${f.id}\` — ${f.title}${f.file ? ` — \`${f.file}${f.line ? `:${f.line}${f.column ? `:${f.column}` : ''}` : ''}\`` : ''}`);
      if (f.rootCause) lines.push(`  - Cause: ${f.rootCause}`);
      if (f.trigger) lines.push(`  - Trigger: ${f.trigger}`);
      if (f.actual) lines.push(`  - Actual: ${f.actual}${f.expected ? ` · Expected: ${f.expected}` : ''}`);
      if (f.suggestion) lines.push(`  - Suggested correction: ${f.suggestion}`);
      lines.push(`  - Analyzer: ${f.analyzers.join(', ')} · confidence ${f.confidence}`);
    }
    if (list.length > 400) lines.push(`- … ${list.length - 400} more in the JSON report.`);
    lines.push('');
  }
  lines.push('## Capabilities by language', '', `| Language | ${Object.values(CAPABILITY_LABELS).join(' | ')} |`, `|---|${Object.keys(CAPABILITY_LABELS).map(() => '---').join('|')}|`);
  for (const row of scan.capabilities) lines.push(`| ${row.language} | ${Object.keys(CAPABILITY_LABELS).map(k => row.capabilities[k]?.level || 'unavailable').join(' | ')} |`);
  if (scan.authorship) {
    const a = scan.authorship;
    lines.push('', '## Authorship estimate (secondary, heuristic)', '', `Estimate: **${a.label}** (confidence ${a.confidence}; ${a.estimateType} estimate, not a probability). ${a.note || ''}`, '', ...a.limitations.map(l => `- ${l}`));
  }
  lines.push('', '## Limitations', '', ...scan.limitations.map(l => `- ${l}`), '', '_Generated locally in the browser; nothing was uploaded._', '');
  return lines.join('\n');
}

const SARIF_LEVEL = { critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'note' };
export function reportSarif(scan) {
  const rules = [...new Map(scan.findings.map(f => [f.rule, { id: f.rule, name: f.rule, shortDescription: { text: f.title.slice(0, 120) }, properties: { category: f.category } }])).values()];
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'CodeProof', version: scan.engineVersion, informationUri: 'https://github.com/theraghavraman/codeproof', rules } },
      results: scan.findings.map(f => ({
        ruleId: f.rule,
        level: SARIF_LEVEL[f.severity] || 'warning',
        message: { text: `${f.title}. ${f.rootCause}`.slice(0, 2000) },
        locations: f.file ? [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: f.line || 1, startColumn: f.column || 1 } } }] : [],
        partialFingerprints: { codeproofId: f.id },
        properties: { verification: f.verification, confidence: f.confidence, category: f.category, analyzers: f.analyzers },
      })),
      properties: { verdict: scan.coverage.verdict.state, coverage: scan.coverage.ratios },
    }],
  };
}
