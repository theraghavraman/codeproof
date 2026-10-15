// Coverage and transparency metrics. Every ratio carries its own definition and denominator, and the
// verdict distinguishes "no findings in the checks that ran" from "verification incomplete".
import { SOURCE_LANGUAGES } from './detect.mjs';
import { summarizeFindings } from './findings.mjs';

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

export function computeCoverage({ manifest, fileStatus, analyzerRuns, integrationChecks = [], runtime = null, limits = [], cancelled = false, findings = [], typecheck = null, pythonCompile = null }) {
  const sourceEntries = manifest.filter(m => SOURCE_LANGUAGES.has(m.language) || ['javascript', 'typescript', 'python'].includes(m.language));
  const statuses = [...fileStatus.values()];
  const sourceStatuses = statuses.filter(s => s.source);
  const count = st => sourceStatuses.filter(s => s.status === st).length;
  const skippedReasons = {};
  for (const m of manifest) if (m.status !== 'ingested') {
    const key = m.reason.replace(/\d[\d,]*/g, 'N').replace(/"[^"]*"/g, '"…"').slice(0, 90) || m.status;
    skippedReasons[key] = (skippedReasons[key] || 0) + (m.count || 1);
  }
  const languages = {};
  for (const s of sourceStatuses) {
    const l = languages[s.language] || (languages[s.language] = { language: s.language, files: 0, analyzed: 0, partial: 0, parseFailed: 0, failed: 0, realParser: 0, heuristicOnly: 0 });
    l.files++;
    if (s.status === 'analyzed') l.analyzed++;
    if (s.status === 'partial') l.partial++;
    if (s.status === 'parse-failed') l.parseFailed++;
    if (s.status === 'failed') l.failed++;
    if (s.depth === 'parser' || s.depth === 'compiler') l.realParser++;
    if (s.depth === 'heuristic') l.heuristicOnly++;
  }
  for (const m of sourceEntries) if (m.status !== 'ingested') { const l = languages[m.language] || (languages[m.language] = { language: m.language, files: 0, analyzed: 0, partial: 0, parseFailed: 0, failed: 0, realParser: 0, heuristicOnly: 0, skipped: 0 }); l.skipped = (l.skipped || 0) + 1; }

  const recognized = sourceStatuses.length + sourceEntries.filter(m => m.status !== 'ingested').length;
  const perFileDone = count('analyzed') + count('partial') + count('parse-failed');
  const realParsed = sourceStatuses.filter(s => (s.depth === 'parser' || s.depth === 'compiler') && s.parseOk).length;
  const files = {
    discovered: manifest.reduce((n, m) => n + (m.count || 1), 0),
    ingested: manifest.filter(m => m.status === 'ingested').length,
    recognizedSource: recognized,
    parsedByRealParser: realParsed,
    parseFailures: count('parse-failed'),
    analyzed: count('analyzed'),
    partial: count('partial'),
    failed: count('failed'),
    skipped: manifest.filter(m => m.status === 'skipped').reduce((n, m) => n + (m.count || 1), 0),
    failedIngestion: manifest.filter(m => m.status === 'failed').length,
    heuristicOnly: sourceStatuses.filter(s => s.depth === 'heuristic').length,
    skippedReasons,
  };
  const applicable = integrationChecks.filter(c => c.status !== 'not-applicable');
  const integration = { completed: applicable.filter(c => c.status === 'completed').length, applicable: applicable.length, checks: integrationChecks };
  const rt = runtime || { enabled: false };
  const blocked = [];
  for (const s of sourceStatuses) for (const b of s.blocked || []) {
    const entry = blocked.find(x => x.capability === b);
    if (entry) entry.files++; else blocked.push({ capability: b, files: 1 });
  }
  for (const c of integrationChecks.filter(c => c.status === 'unsupported' || c.status === 'skipped')) blocked.push({ capability: c.label, files: 0, reason: c.detail });
  for (const b of rt.blocked || []) blocked.push(b);
  const ratios = [
    { id: 'file-analysis', label: 'Per-file analysis', numerator: perFileDone, denominator: recognized, percent: pct(perFileDone, recognized), definition: 'Recognized source files on which every applicable per-file analyzer completed (including files whose result is a parse failure) ÷ all recognized source files discovered, including skipped ones.' },
    { id: 'real-parser', label: 'Validated by a real parser or compiler', numerator: realParsed, denominator: recognized, percent: pct(realParsed, recognized), definition: 'Files accepted by Acorn, the TypeScript compiler, the strict JSON validator or CPython compile() ÷ recognized source files. Heuristic scanners do not count.' },
  ];
  if (typecheck) ratios.push({ id: 'typecheck', label: 'Type-checked by the TypeScript compiler', numerator: typecheck.filesChecked, denominator: typecheck.files, percent: pct(typecheck.filesChecked, typecheck.files), definition: 'JavaScript/TypeScript files whose syntactic and semantic diagnostics were computed ÷ JavaScript/TypeScript files submitted to the program.' });
  if (pythonCompile) ratios.push({ id: 'python-compile', label: 'Compiled by CPython', numerator: pythonCompile.compiled, denominator: pythonCompile.total, percent: pct(pythonCompile.compiled, pythonCompile.total), definition: 'Python files passed through CPython compile() in Pyodide ÷ ingested Python files.' });
  ratios.push({ id: 'integration', label: 'Project integration checks', numerator: integration.completed, denominator: integration.applicable, percent: pct(integration.completed, integration.applicable), definition: 'Applicable project-level checks (resolution, contracts, manifests, references, cycles) that completed ÷ applicable checks.' });
  if (rt.enabled) {
    ratios.push({ id: 'tests', label: 'Discovered tests executed', numerator: rt.testsExecuted || 0, denominator: rt.testsDiscovered || 0, percent: pct(rt.testsExecuted || 0, rt.testsDiscovered || 0), definition: 'Project test cases that actually ran to a pass/fail result ÷ test cases discovered in supported test files. Blocked and timed-out tests are not executed.' });
    ratios.push({ id: 'probes', label: 'Functions exercised with generated inputs', numerator: rt.functionsProbed || 0, denominator: rt.functionsEligible || 0, percent: pct(rt.functionsProbed || 0, rt.functionsEligible || 0), definition: 'Top-level functions invoked with at least one generated input ÷ top-level functions eligible for probing (runtime-capable languages, non-test files).' });
    ratios.push({ id: 'modules', label: 'Modules loaded in the sandbox', numerator: rt.modulesLoaded || 0, denominator: rt.modulesEligible || 0, percent: pct(rt.modulesLoaded || 0, rt.modulesEligible || 0), definition: 'Modules whose top-level code finished evaluating ÷ modules submitted for load checks.' });
  }
  const failedEngines = analyzerRuns.filter(r => r.status === 'failed' || r.status === 'timeout');
  const reasons = [];
  if (cancelled) reasons.push('The scan was cancelled before all phases finished.');
  if (failedEngines.length) reasons.push(`${failedEngines.length} analyzer run(s) failed or timed out: ${[...new Set(failedEngines.map(r => r.label))].join(', ')}.`);
  if (files.skipped || files.failedIngestion) reasons.push(`${files.skipped + files.failedIngestion} discovered file(s) were skipped or could not be read.`);
  if (files.partial) reasons.push(`${files.partial} source file(s) received only partial or heuristic analysis.`);
  if (files.failed) reasons.push(`${files.failed} source file(s) could not be analyzed.`);
  if (!rt.enabled) reasons.push('Runtime checks did not run, so no behavior was executed.');
  else {
    if (rt.testsBlocked) reasons.push(`${rt.testsBlocked} test file(s) or case(s) could not run (missing dependencies or unsupported frameworks).`);
    if (rt.timeouts) reasons.push(`${rt.timeouts} runtime job(s) hit a time limit.`);
  }
  if (limits.length) reasons.push(...limits.map(l => l.detail));
  if (blocked.length) reasons.push(`${blocked.length} capability gap(s) prevented some checks (see "Checks blocked").`);
  const summary = summarizeFindings(findings);
  const incomplete = reasons.length > 0;
  const state = summary.defects > 0 ? (incomplete ? 'defects-found-incomplete' : 'defects-found') : incomplete ? 'incomplete' : 'no-findings';
  const message = {
    'defects-found': `${summary.defects} defect finding(s) were established by the checks that ran.`,
    'defects-found-incomplete': `${summary.defects} defect finding(s) were established, and verification is incomplete; more defects may exist in what was not checked.`,
    incomplete: 'Verification incomplete. No defects were established by the checks that ran, but parts of the project were not verified. This is not a clean bill of health.',
    'no-findings': 'No defects were detected by the checks that ran. This does not prove the absence of defects; it only reflects the analyzers and tests listed below.',
  }[state];
  return { files, languages: Object.values(languages).sort((a, b) => b.files - a.files), engines: analyzerRuns, integration, runtime: rt, blocked, limits, ratios, verdict: { state, incomplete, message, reasons }, findings: summary };
}
