// Project Scan workspace: upload, progress, and the results views (summary, findings, integration, runtime,
// security, dependency graph, coverage and inventory, report) plus the secondary authorship view.
// All dynamic text is escaped with h(); nothing here executes project code.
import { icon, h, fmt, badge, btn } from './kit.mjs';
import { VERIFICATION, SEVERITY_LABELS, CATEGORIES, filterFindings } from '../engine/findings.mjs';
import { CAPABILITY_LABELS, CAPABILITY_KINDS } from '../engine/capabilities.mjs';
import { languageLabel } from '../engine/detect.mjs';

export const SCAN_TABS = [['summary', 'Summary'], ['findings', 'Findings'], ['integration', 'Integration'], ['runtime', 'Runtime & tests'], ['security', 'Security'], ['graph', 'Dependency graph'], ['coverage', 'Coverage & inventory'], ['report', 'Report']];
export const PHASES = [['ingest', 'Ingest files'], ['files', 'Per-file analysis'], ['typecheck', 'Type check'], ['integration', 'Integration'], ['runtime', 'Runtime & tests'], ['finalize', 'Coverage & report']];
const VERIFICATION_SHORT = { 'confirmed-runtime': 'Reproduced', 'confirmed-static': 'Confirmed', 'high-confidence': 'High confidence', potential: 'Potential', quality: 'Quality', 'security-observation': 'Security observation' };
const LEVEL_BADGE = { compiler: 'passed', parser: 'passed', heuristic: 'warning', conditional: 'info', unavailable: 'off' };
const STATUS_BADGE = { analyzed: 'passed', partial: 'warning', 'parse-failed': 'failed', failed: 'failed', skipped: 'off', ingested: 'passed', completed: 'passed', 'not-applicable': 'off', blocked: 'warning', timeout: 'failed', unsupported: 'off' };
const pct = r => (r.percent === null || r.percent === undefined ? '—' : `${r.percent}%`);

export const verificationBadge = v => `<span class="vbadge ${h(v)}" title="${h(VERIFICATION[v] || v)}">${h(VERIFICATION_SHORT[v] || v)}</span>`;
export const severityBadge = s => badge(SEVERITY_LABELS[s] || s, s);

function uploadPanel(S) {
  const p = S.project;
  const counts = p ? { ingested: p.manifest.filter(m => m.status === 'ingested').length, skipped: p.manifest.filter(m => m.status === 'skipped').reduce((n, m) => n + (m.count || 1), 0), failed: p.manifest.filter(m => m.status === 'failed').length } : null;
  const langs = p ? Object.entries(p.files.reduce((acc, f) => { if (f.language) acc[f.language] = (acc[f.language] || 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8) : [];
  const running = S.scan.status === 'running';
  return `<section class="panel mb" aria-labelledby="upload-title"><div class="panel-head"><h3 id="upload-title">${icon('upload', 16)} Project input</h3>${badge('Processed in this browser', 'passed')}</div><div class="panel-body">
  <div class="upload-box" id="drop-zone" tabindex="0" role="button" aria-label="Drop files, a folder or a ZIP archive here, or press Enter to choose files" data-action="open-files">${icon('upload', 30)}<strong>Drop source files, a folder or a ZIP archive</strong><span class="small">Single files, many files, nested folders and ZIP projects. Nothing is uploaded; files are read into this tab's memory.</span>
  <div class="row wrap">${btn(icon('file', 14) + ' Files', 'open-files', 'ghost sm')}${btn(icon('folder', 14) + ' Folder', 'open-folder', 'ghost sm')}${btn(icon('layers', 14) + ' ZIP archive', 'open-zip', 'ghost sm')}${btn(icon('code', 14) + ' Use editor workspace', 'scan-workspace', 'ghost sm')}</div></div>
  <input id="zip-picker" class="hidden" type="file" accept=".zip,application/zip"><input id="folder-picker" class="hidden" type="file" webkitdirectory directory multiple><input id="files-picker" class="hidden" type="file" multiple>
  ${S.ingestError ? `<div class="warning-callout mt" role="alert"><b>${h(S.ingestError.title)}</b><br>${h(S.ingestError.message)}</div>` : ''}
  ${p ? `<div class="project-meta mt"><div><span class="muted small">Project</span><strong>${h(p.name)}</strong></div><div><span class="muted small">Source</span><strong>${h(p.source || 'upload')}</strong></div><div><span class="muted small">Loaded</span><strong>${fmt(counts.ingested)}</strong></div><div><span class="muted small">Skipped / failed</span><strong>${fmt(counts.skipped)} / ${fmt(counts.failed)}</strong></div></div>
  <div class="row wrap mt" aria-label="Languages">${langs.map(([l, n]) => `<span class="chip">${h(languageLabel(l))} · ${n}</span>`).join('')}</div>${(p.limits || []).length ? `<div class="notice mt"><b>Input limits applied.</b> ${p.limits.map(l => h(l.detail)).join(' ')}</div>` : ''}` : '<p class="hint mt">No project loaded yet. The demo workspace in the editor can be scanned too.</p>'}
  </div></section>
  <section class="panel mb" aria-labelledby="options-title"><div class="panel-head"><h3 id="options-title">${icon('settings', 16)} Scan options</h3></div><div class="panel-body">
  <label class="check"><input type="checkbox" checked disabled> Static analysis: parsers, AST rules, TypeScript type checking, dependency graph and integration checks (always on)</label>
  <label class="check"><input type="checkbox" id="opt-js" ${S.scanOptions.js ? 'checked' : ''}> Execute JavaScript/TypeScript tests, module loads and generated inputs in the sandbox</label>
  <label class="check"><input type="checkbox" id="opt-python" ${S.scanOptions.python ? 'checked' : ''}> Run Python compile, tests and generated inputs in Pyodide (about 12 MB, integrity-checked, loaded from this site)</label>
  <p class="form-help">Execution happens in an opaque-origin iframe worker with network access blocked by Content-Security-Policy. Each job has a time limit; the whole runtime phase is limited to ${Math.round(S.scanOptions.budgetMs / 1000)} s.</p>
  <div class="row wrap mt">${running ? btn(icon('stop') + ' Cancel scan', 'cancel-scan', 'danger') : btn(icon('scan') + (S.scan.result ? ' Rerun scan' : ' Start scan'), 'start-scan', 'primary')}${S.scan.result && !running ? btn(icon('download') + ' Export report', 'scan-tab-report', 'ghost') : ''}</div></div></section>`;
}

function progressPanel(S) {
  const sc = S.scan;
  if (sc.status === 'idle') return '';
  const total = sc.total || 0, done = sc.done || 0;
  const width = sc.status === 'complete' ? 100 : total ? Math.min(100, Math.round((done / total) * 100)) : 15;
  return `<section class="panel mb" aria-labelledby="progress-title"><div class="panel-head"><h3 id="progress-title">${icon('clock', 16)} Scan progress</h3>${badge(sc.status === 'running' ? 'Running' : sc.status === 'complete' ? 'Complete' : sc.status === 'cancelled' ? 'Cancelled' : 'Failed', sc.status === 'complete' ? 'passed' : sc.status === 'running' ? 'info' : 'failed')}</div><div class="panel-body">
  <ol class="phases">${PHASES.map(([id, label]) => `<li class="phase ${h(sc.phases?.[id] || 'pending')}"><span class="phase-dot" aria-hidden="true"></span><span>${h(label)}</span><small>${h(sc.phases?.[id] || 'pending')}</small></li>`).join('')}</ol>
  <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width}" aria-label="Scan progress"><div style="width:${width}%"></div></div>
  <p class="small muted" id="scan-progress-label" aria-live="polite">${h(sc.label || '')}${sc.startedAt ? ` · started ${h(new Date(sc.startedAt).toLocaleTimeString())}` : ''}${sc.finishedAt ? ` · ${Math.round((sc.finishedAt - sc.startedAt) / 100) / 10} s` : ''}</p>
  ${sc.error ? `<div class="warning-callout" role="alert"><b>${h(sc.error.stage || 'Scan')} failed.</b> ${h(sc.error.message)}<br><span class="small">${h(sc.error.action || 'Partial results, if any, are shown below and marked incomplete.')}</span></div>` : ''}</div></section>`;
}

function verdictBanner(result) {
  const v = result.coverage.verdict;
  const cls = v.state === 'no-findings' ? 'insight' : v.state === 'incomplete' ? 'warning-callout' : 'danger-callout';
  const title = { 'no-findings': 'No findings in the checks that ran', incomplete: 'Verification incomplete', 'defects-found': 'Defects found', 'defects-found-incomplete': 'Defects found · verification incomplete' }[v.state];
  return `<div class="${cls} verdict mb" role="status"><div class="row between wrap"><b class="verdict-title">${h(title)}</b><span class="small">${h(result.project.name)} · ${h(new Date(result.generatedAt).toLocaleString())}</span></div><p>${h(v.message)}</p>${v.reasons.length ? `<details><summary>Why verification is ${v.incomplete ? 'incomplete' : 'scoped'} (${v.reasons.length})</summary><ul>${v.reasons.map(r => `<li>${h(r)}</li>`).join('')}</ul></details>` : ''}</div>`;
}

function kpis(result) {
  const f = result.coverage.findings;
  const rt = result.runtime;
  const tile = (n, label, cls = '') => `<div class="kpi ${cls}"><strong>${n}</strong><small>${h(label)}</small></div>`;
  return `<div class="kpi-row wide mb">${tile(fmt(f.byVerification['confirmed-runtime'] || 0), 'Reproduced at runtime', 'alert')}${tile(fmt(f.byVerification['confirmed-static'] || 0), 'Confirmed static failures', 'alert')}${tile(fmt(f.byVerification['high-confidence'] || 0), 'High-confidence findings')}${tile(fmt(f.byVerification.potential || 0), 'Potential defects')}${tile(fmt(f.byVerification['security-observation'] || 0), 'Security observations')}${tile(rt?.enabled ? `${rt.testsPassed}/${rt.testsExecuted}` : '—', 'Tests passed / executed')}</div>`;
}

function ratiosTable(result) {
  return `<div class="table-wrap"><table class="data"><caption class="sr-only">Coverage measures with numerators and denominators</caption><thead><tr><th scope="col">Measure</th><th scope="col">Covered</th><th scope="col">%</th><th scope="col">Definition</th></tr></thead><tbody>${result.coverage.ratios.map(r => `<tr><th scope="row">${h(r.label)}</th><td>${fmt(r.numerator)} / ${fmt(r.denominator)}</td><td>${pct(r)}</td><td class="small muted">${h(r.definition)}</td></tr>`).join('')}</tbody></table></div>`;
}

export function findingRow(f, selected) {
  return `<li><button type="button" class="finding-row ${selected ? 'active' : ''}" data-action="select-finding" data-id="${h(f.id)}" aria-pressed="${selected ? 'true' : 'false'}"><span class="finding-badges">${severityBadge(f.severity)}${verificationBadge(f.verification)}</span><span class="finding-title">${h(f.title)}</span><span class="code-ref">${h(f.file || 'project')}${f.line ? ':' + f.line : ''} · ${h(CATEGORIES[f.category] || f.category)}</span></button></li>`;
}

export function codeContext(content, line, radius = 4) {
  if (typeof content !== 'string' || !line) return '';
  const rows = content.split('\n');
  const start = Math.max(1, line - radius), end = Math.min(rows.length, line + radius);
  let out = '';
  for (let n = start; n <= end; n++) out += `<div class="code-line${n === line ? ' hit' : ''}"><span class="ln">${n}</span><span class="src">${h(rows[n - 1].slice(0, 300)) || ' '}</span></div>`;
  return `<div class="code-context" role="region" aria-label="Source around line ${line}">${out}</div>`;
}

export function findingDetail(f, S) {
  if (!f) return `<div class="blank">${icon('search', 28)}<strong>Select a finding</strong>Details, source context and reproduction steps appear here.</div>`;
  const file = S.files.find(x => x.path === f.file);
  const field = (label, value) => (value ? `<dt>${h(label)}</dt><dd>${value}</dd>` : '');
  const list = items => (items?.length ? `<ul>${items.map(i => `<li>${h(i)}</li>`).join('')}</ul>` : '');
  const all = S.scan.result?.findings || [];
  return `<article class="finding-detail" aria-labelledby="fd-title"><div class="row wrap mb-sm">${severityBadge(f.severity)}${verificationBadge(f.verification)}${badge(CATEGORIES[f.category] || f.category, 'info')}${badge('confidence: ' + f.confidence, 'low')}</div>
  <h3 id="fd-title">${h(f.title)}</h3><p class="code-ref">${h(f.id)} · ${h(f.rule)} · ${h(f.file || 'project-level')}${f.line ? `:${f.line}${f.column ? ':' + f.column : ''}` : ''}</p>
  ${file && f.line ? codeContext(file.content, f.line) + (S.dirtyAfterScan?.has(f.file) ? '<p class="form-help">This file was edited after the scan; the context may have moved.</p>' : '') : f.excerpt ? `<pre class="test-detail">${h(f.excerpt)}</pre>` : ''}
  <dl class="detail-list">${field('Verification', h(f.verificationLabel))}${field('Root cause', h(f.rootCause))}${field('Trigger', h(f.trigger))}${f.reproduction?.length ? field('Reproduction', `<ol>${f.reproduction.map(r => `<li>${h(r)}</li>`).join('')}</ol>`) : ''}${field('Actual', f.actual ? `<code>${h(f.actual)}</code>` : '')}${field('Expected', f.expected ? `<code>${h(f.expected)}</code>` : '')}${field('Affected', f.affected?.length ? list(f.affected) : '')}${field('Suggested correction', h(f.suggestion))}${field('Evidence', list(f.evidence))}${field('Analyzer provenance', h(f.analyzers.join(', ')))}${f.related?.length ? field('Related findings', f.related.map(id => { const r = all.find(x => x.id === id); return `<button type="button" class="linklike" data-action="select-finding" data-id="${h(id)}">${h(id)}${r ? ' · ' + h(r.title.slice(0, 60)) : ''}</button>`; }).join('<br>')) : ''}</dl>
  <div class="row wrap mt">${file ? btn(icon('code', 14) + ' Open in editor', 'open-in-editor', 'ghost sm', `data-path="${h(f.file)}" data-line="${f.line || 1}"`) : ''}${btn(icon('copy', 14) + ' Copy reproduction', 'copy-finding', 'ghost sm', `data-id="${h(f.id)}"`)}</div></article>`;
}

function findingsExplorer(S, findings, { title = 'Findings', idPrefix = 'f' } = {}) {
  const ff = S.findingFilters;
  const filtered = filterFindings(findings, ff);
  const shown = filtered.slice(0, S.findingPage * 100);
  const selected = findings.find(f => f.id === S.selectedFindingId) || null;
  const files = [...new Set(findings.map(f => f.file).filter(Boolean))].sort();
  const analyzers = [...new Set(findings.flatMap(f => f.analyzers))].sort();
  const select = (id, label, value, options) => `<label class="sr-only" for="${idPrefix}-${id}">${h(label)}</label><select class="form-control" id="${idPrefix}-${id}" data-filter="${id}">${options.map(([v, l]) => `<option value="${h(v)}" ${v === value ? 'selected' : ''}>${h(l)}</option>`).join('')}</select>`;
  return `<div class="filters row wrap mb-sm" role="group" aria-label="Filter ${h(title)}">${select('severity', 'Severity', ff.severity, [['all', 'All severities'], ...Object.entries(SEVERITY_LABELS)])}${select('verification', 'Verification', ff.verification, [['all', 'All verification classes'], ...Object.entries(VERIFICATION)])}${select('category', 'Category', ff.category, [['all', 'All categories'], ...Object.entries(CATEGORIES)])}${select('file', 'File', ff.file, [['all', 'All files'], ...files.map(f => [f, f])])}${select('analyzer', 'Analyzer', ff.analyzer, [['all', 'All analyzers'], ...analyzers.map(a => [a, a])])}<div class="finder"><label class="sr-only" for="${idPrefix}-search">Search findings</label><input id="${idPrefix}-search" data-filter="search" value="${h(ff.search)}" placeholder="Search title, rule, file or ID"></div></div>
  <div class="split"><div><p class="small muted" aria-live="polite">${fmt(filtered.length)} of ${fmt(findings.length)} ${h(title.toLowerCase())}</p><ul class="finding-list" aria-label="${h(title)}">${shown.map(f => findingRow(f, f.id === S.selectedFindingId)).join('') || `<li class="blank">${icon('check', 24)}<strong>No findings match</strong>${findings.length ? 'Adjust the filters.' : 'None of the checks that ran produced a finding of this kind. Check coverage before concluding anything.'}</li>`}</ul>${filtered.length > shown.length ? btn(`Show more (${fmt(filtered.length - shown.length)} remaining)`, 'findings-more', 'ghost sm') : ''}</div><div class="detail-pane" id="finding-detail">${findingDetail(selected, S)}</div></div>`;
}

function summaryTab(S, r) {
  const top = r.findings.filter(f => ['confirmed-runtime', 'confirmed-static', 'high-confidence'].includes(f.verification)).slice(0, 6);
  const failedRuns = r.analyzerRuns.filter(a => ['failed', 'timeout', 'partial', 'blocked'].includes(a.status));
  return `${kpis(r)}<div class="grid-two mb"><section class="panel"><div class="panel-head"><h3>Coverage</h3><span class="meta">Each measure states its denominator</span></div><div class="panel-body">${ratiosTable(r)}</div></section>
  <section class="panel"><div class="panel-head"><h3>Highest-evidence findings</h3>${btn('All findings ' + icon('arrow', 14), 'scan-tab', 'ghost sm', 'data-tab="findings"')}</div><div class="panel-body compact"><ul class="finding-list">${top.map(f => findingRow(f, false)).join('') || '<li class="blank"><strong>No confirmed or high-confidence findings</strong>This reflects only the checks that ran.</li>'}</ul></div></section></div>
  <div class="grid-two mb"><section class="panel"><div class="panel-head"><h3>Project</h3></div><div class="panel-body"><dl class="detail-list compact"><dt>Languages</dt><dd>${r.project.languages.map(l => `${h(l.label)} (${l.files} files, ${fmt(l.lines)} lines)`).join(', ') || '—'}</dd><dt>Frameworks detected</dt><dd>${h(r.project.frameworks.join(', ') || 'None detected')}</dd><dt>Entry points</dt><dd>${r.project.entryPoints.slice(0, 8).map(e => `<code>${h(e.path)}</code> <span class="muted small">(${h(e.reason)})</span>`).join('<br>') || 'None identified'}</dd><dt>Manifests</dt><dd>${r.project.packages.map(p => `<code>${h(p.path)}</code>`).join(', ') || 'No package.json'}</dd></dl></div></section>
  <section class="panel"><div class="panel-head"><h3>Analysis engines executed</h3></div><div class="panel-body compact">${engineTable(r.analyzerRuns)}${failedRuns.length || r.diagnostics.length ? `<div class="warning-callout mt"><b>Failures and gaps</b><ul>${r.diagnostics.slice(0, 8).map(d => `<li><b>${h(d.stage)}</b>${d.file ? ` (${h(d.file)})` : ''}: ${h(d.message)} <span class="small">Scope: ${h(d.scope)} · origin: ${h(d.origin)} · still completed: ${h(d.alternatives)} · next: ${h(d.action)}</span></li>`).join('')}</ul></div>` : ''}</div></section></div>`;
}

function engineTable(runs) {
  return `<div class="table-wrap"><table class="data"><thead><tr><th scope="col">Engine</th><th scope="col">Status</th><th scope="col">Files</th><th scope="col">Time</th></tr></thead><tbody>${runs.map(a => `<tr><th scope="row">${h(a.label)}${a.detail ? `<div class="small muted">${h(a.detail)}</div>` : ''}${a.failures?.length ? `<div class="small">${a.failures.slice(0, 3).map(x => h(`${x.file || 'project'}: ${x.error}`)).join('<br>')}</div>` : ''}</th><td>${badge(a.status, STATUS_BADGE[a.status] || 'info')}</td><td>${fmt(a.files)}</td><td>${Math.round(a.durationMs || 0)} ms</td></tr>`).join('')}</tbody></table></div>`;
}

function integrationTab(S, r) {
  const findings = r.findings.filter(f => ['integration', 'dependency', 'config'].includes(f.category) || f.scope === 'project');
  return `<section class="panel mb"><div class="panel-head"><h3>Integration checks</h3><span class="meta">${r.coverage.integration.completed} of ${r.coverage.integration.applicable} applicable checks completed</span></div><div class="panel-body compact"><div class="table-wrap"><table class="data"><thead><tr><th scope="col">Check</th><th scope="col">Status</th><th scope="col">Detail</th></tr></thead><tbody>${r.integrationChecks.map(c => `<tr><th scope="row">${h(c.label)}</th><td>${badge(c.status, STATUS_BADGE[c.status] || 'info')}</td><td class="small">${h(c.detail)}</td></tr>`).join('')}</tbody></table></div></div></section>
  <section class="panel"><div class="panel-head"><h3>Cross-file, dependency and configuration findings</h3></div><div class="panel-body">${findingsExplorer(S, findings, { title: 'Integration findings', idPrefix: 'if' })}</div></section>`;
}

function runtimeTab(S, r) {
  const rt = r.runtime;
  if (!rt?.enabled) return `<div class="notice">${icon('info', 14)} Runtime checks were not run for this scan, so no project code was executed. Enable them in Scan options and rerun.</div>${rt?.blocked?.length ? blockedList(rt.blocked.map(b => ({ capability: `${b.engine} ${b.type}${b.path ? ' · ' + b.path : ''}`, reason: b.reason }))) : ''}`;
  const res = rt.results || {};
  const statusBadge = s => badge(s, s === 'passed' ? 'passed' : s === 'failed' ? 'failed' : s === 'blocked' ? 'warning' : 'off');
  const show = v => { try { return JSON.stringify(v, (k, x) => (x && x.__cp ? (x.__cp === 'undefined' ? 'undefined' : x.__cp === 'NaN' ? 'NaN' : x.value ?? `[${x.__cp}]`) : x)); } catch { return String(v); } };
  return `<div class="kpi-row wide mb"><div class="kpi"><strong>${rt.testsDiscovered}</strong><small>Tests discovered</small></div><div class="kpi"><strong>${rt.testsExecuted}</strong><small>Tests executed</small></div><div class="kpi"><strong>${rt.testsPassed}</strong><small>Passed</small></div><div class="kpi alert"><strong>${rt.testsFailed}</strong><small>Failed</small></div><div class="kpi"><strong>${rt.testsGenerated}</strong><small>Generated cases (${rt.generatedExecuted} executed)</small></div><div class="kpi"><strong>${rt.modulesLoaded}/${rt.modulesEligible}</strong><small>Modules loaded</small></div></div>
  ${rt.cancelled ? '<div class="warning-callout mb">The runtime phase was cancelled; only completed jobs are listed.</div>' : ''}
  <section class="panel mb"><div class="panel-head"><h3>Test results</h3><span class="meta">Executed by CodeProof's sandbox harnesses (Jest/Vitest/node:test-compatible API; minimal pytest-compatible collector) — not by the projects' own runners</span></div><div class="panel-body compact"><div class="table-wrap"><table class="data"><thead><tr><th scope="col">Test</th><th scope="col">Status</th><th scope="col">Detail</th></tr></thead><tbody>${(res.tests || []).slice(0, 400).map(t => `<tr><th scope="row"><span class="code-ref">${h(t.path)}</span><br>${h(t.name)}</th><td>${statusBadge(t.status)}</td><td class="small">${h(t.error || t.blockedReason || '')}${t.durationMs ? ` · ${t.durationMs} ms` : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No tests were discovered in supported test files.</td></tr>'}</tbody></table></div></div></section>
  <div class="grid-two mb"><section class="panel"><div class="panel-head"><h3>Generated-input probes</h3><span class="meta">Seeded and reproducible; no expected outputs are invented</span></div><div class="panel-body compact"><div class="table-wrap"><table class="data"><thead><tr><th scope="col">Call</th><th scope="col">Outcome</th></tr></thead><tbody>${(res.probes || []).slice(0, 200).map(p => `<tr><th scope="row"><code>${h(p.name)}(${h(p.args.map(show).join(', ').slice(0, 120))})</code><div class="small muted">${h(p.path)} · ${h(p.rationale || '')}</div></th><td class="small">${p.status === 'timeout' ? badge('timeout', 'failed') : p.ok ? `returned <code>${h(show(p.value).slice(0, 80))}</code>` : `<b>${h(p.error?.name || 'Error')}</b>: ${h((p.error?.message || '').slice(0, 140))}${p.error?.explicit ? ' <span class="muted">(deliberate rejection)</span>' : ''}`}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No functions were probed.</td></tr>'}</tbody></table></div>${(res.observations || []).length ? `<details class="mt"><summary>${res.observations.length} crash(es) on inputs outside any declared contract (not reported as findings)</summary><ul class="small">${res.observations.slice(0, 60).map(o => `<li><code>${h(o.name)}(${h(o.args.map(show).join(', ').slice(0, 80))})</code> — ${h(o.error)}</li>`).join('')}</ul></details>` : ''}</div></section>
  <section class="panel"><div class="panel-head"><h3>Module load checks</h3></div><div class="panel-body compact"><div class="table-wrap"><table class="data"><thead><tr><th scope="col">Module</th><th scope="col">Result</th></tr></thead><tbody>${(res.loads || []).map(l => `<tr><th scope="row"><code>${h(l.path)}</code></th><td class="small">${l.ok ? badge('loaded', 'passed') : l.blockedReason ? badge('blocked', 'warning') + ' ' + h(l.blockedReason) : badge('threw', 'failed') + ' ' + h(l.error || '')}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No modules were load-tested.</td></tr>'}${res.compile ? `<tr><th scope="row">CPython compile()</th><td>${res.compile.compiled}/${res.compile.total} files compiled</td></tr>` : ''}</tbody></table></div></div></section></div>
  ${blockedList(rt.blocked || [])}`;
}

function blockedList(blocked) {
  if (!blocked.length) return '';
  return `<section class="panel mb"><div class="panel-head"><h3>Checks blocked by missing capabilities</h3><span class="meta">${blocked.length}</span></div><div class="panel-body compact"><ul class="blocked-list">${blocked.slice(0, 150).map(b => `<li><b>${h(b.capability)}</b>${b.files ? ` <span class="muted">(${b.files} file${b.files === 1 ? '' : 's'})</span>` : ''}${b.reason ? ` — ${h(b.reason)}` : ''}</li>`).join('')}</ul></div></section>`;
}

function securityTab(S, r) {
  const sec = r.findings.filter(f => f.category === 'security');
  const strong = sec.filter(f => f.verification !== 'security-observation');
  const obs = sec.filter(f => f.verification === 'security-observation');
  return `<div class="notice mb">${icon('shield', 14)} Security results are split by evidence. <b>Higher-evidence findings</b> (for example credentials in recognized formats) are listed first. <b>Observations</b> mark risky sinks and patterns whose exploitability CodeProof did not establish; review the data flow before treating them as vulnerabilities. Secret values are masked in every view and export.</div>
  <section class="panel mb"><div class="panel-head"><h3>Higher-evidence security findings</h3><span class="meta">${strong.length}</span></div><div class="panel-body compact"><ul class="finding-list">${strong.map(f => findingRow(f, f.id === S.selectedFindingId)).join('') || '<li class="blank"><strong>None</strong>No credential or security defect was established by the checks that ran.</li>'}</ul></div></section>
  <section class="panel"><div class="panel-head"><h3>Security observations (exploitability not established)</h3><span class="meta">${obs.length}</span></div><div class="panel-body compact"><ul class="finding-list">${obs.map(f => findingRow(f, f.id === S.selectedFindingId)).join('') || '<li class="blank"><strong>None</strong></li>'}</ul></div></section>${S.selectedFindingId && sec.some(f => f.id === S.selectedFindingId) ? `<section class="panel mt"><div class="panel-body">${findingDetail(sec.find(f => f.id === S.selectedFindingId), S)}</div></section>` : ''}`;
}

export function graphSvg(graph) {
  const internal = graph.edges.filter(e => e.to && e.status !== 'external' && e.status !== 'builtin');
  const degree = new Map();
  for (const e of internal) { degree.set(e.from, (degree.get(e.from) || 0) + 1); degree.set(e.to, (degree.get(e.to) || 0) + 1); }
  const nodes = [...degree.keys()].sort((a, b) => degree.get(b) - degree.get(a)).slice(0, 60);
  if (!nodes.length) return '<p class="muted">No internal module relationships were found.</p>';
  const set = new Set(nodes);
  const edges = internal.filter(e => set.has(e.from) && set.has(e.to));
  const depth = new Map();
  const roots = nodes.filter(n => !edges.some(e => e.to === n));
  const queue = (roots.length ? roots : [nodes[0]]).map(n => [n, 0]);
  while (queue.length) { const [n, d] = queue.shift(); if (depth.has(n) && depth.get(n) >= d) continue; if (d > 12) continue; depth.set(n, d); for (const e of edges.filter(x => x.from === n)) queue.push([e.to, d + 1]); }
  for (const n of nodes) if (!depth.has(n)) depth.set(n, 0);
  const columns = new Map();
  for (const n of nodes) { const d = depth.get(n); columns.set(d, [...(columns.get(d) || []), n]); }
  const colW = 200, rowH = 34, pos = new Map();
  for (const [d, list] of columns) list.forEach((n, i) => pos.set(n, { x: 16 + d * colW, y: 24 + i * rowH }));
  const width = 32 + (Math.max(...columns.keys()) + 1) * colW, height = 40 + Math.max(...[...columns.values()].map(l => l.length)) * rowH;
  const cyc = new Set((graph.cycles || []).flat());
  const lines = edges.map(e => { const a = pos.get(e.from), b = pos.get(e.to); return `<line x1="${a.x + 150}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="g-edge${cyc.has(e.from) && cyc.has(e.to) ? ' cycle' : ''}" marker-end="url(#arrow)"/>`; }).join('');
  const labels = nodes.map(n => { const p = pos.get(n); const name = n.split('/').pop(); return `<g class="g-node${cyc.has(n) ? ' cycle' : ''}"><rect x="${p.x}" y="${p.y - 12}" width="150" height="24" rx="6"/><text x="${p.x + 8}" y="${p.y + 4}">${h(name.length > 22 ? name.slice(0, 21) + '…' : name)}</text><title>${h(n)}</title></g>`; }).join('');
  return `<div class="graph-scroll"><svg role="img" aria-label="Dependency graph of ${nodes.length} modules" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="g-arrow"/></marker></defs>${lines}${labels}</svg></div>`;
}

function graphTab(S, r) {
  const g = r.graph;
  const unresolved = g.edges.filter(e => ['missing', 'case-mismatch', 'escapes-root', 'directory-without-index'].includes(e.status));
  return `<div class="grid-two mb"><section class="panel"><div class="panel-head"><h3>Module graph</h3><span class="meta">Local edges; cycles highlighted</span></div><div class="panel-body">${graphSvg(g)}</div></section>
  <section class="panel"><div class="panel-head"><h3>Cycles and unresolved edges</h3></div><div class="panel-body compact">${(g.cycles || []).length ? `<ul>${g.cycles.map(c => `<li><code>${h([...c, c[0]].join(' → '))}</code></li>`).join('')}</ul>` : '<p class="muted">No circular imports among static value imports.</p>'}${unresolved.length ? `<ul>${unresolved.slice(0, 50).map(e => `<li><code>${h(e.from)}:${e.line || ''}</code> → <code>${h(e.specifier)}</code> ${badge(e.status, 'failed')}</li>`).join('')}</ul>` : '<p class="muted">Every static local import resolved.</p>'}</div></section></div>
  <section class="panel mb"><div class="panel-head"><h3>External packages</h3><span class="meta">Never downloaded; declarations are checked against manifests</span></div><div class="panel-body compact"><div class="table-wrap"><table class="data"><thead><tr><th scope="col">Package</th><th scope="col">Imports</th><th scope="col">Declared</th></tr></thead><tbody>${(g.externalPackages || []).slice(0, 200).map(p => `<tr><th scope="row"><code>${h(p.name)}</code></th><td>${p.uses}</td><td>${p.declared ? badge('declared', 'passed') : badge('undeclared', 'failed')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No third-party JavaScript imports.</td></tr>'}${(g.pythonExternal || []).map(m => `<tr><th scope="row"><code>${h(m)}</code> <span class="muted small">(Python)</span></th><td>—</td><td>see dependency findings</td></tr>`).join('')}</tbody></table></div></div></section>
  <section class="panel"><div class="panel-head"><h3>All edges</h3><span class="meta">${fmt(g.edges.length)}</span></div><div class="panel-body compact"><div class="table-wrap"><table class="data"><thead><tr><th scope="col">From</th><th scope="col">Specifier</th><th scope="col">Resolved</th><th scope="col">Kind</th></tr></thead><tbody>${g.edges.slice(0, 300).map(e => `<tr><td><code>${h(e.from)}${e.line ? ':' + e.line : ''}</code></td><td><code>${h(e.specifier || '(computed)')}</code></td><td>${e.to ? `<code>${h(e.to)}</code>` : badge(e.status, STATUS_BADGE[e.status] || (e.status === 'external' ? 'info' : 'failed'))}</td><td class="small">${h(e.kind)}</td></tr>`).join('')}</tbody></table></div>${g.edges.length > 300 ? `<p class="form-help">Showing 300 of ${fmt(g.edges.length)} edges; the JSON report contains all of them.</p>` : ''}</div></section>`;
}

export function buildTree(entries) {
  const root = { name: '', dirs: new Map(), files: [] };
  for (const e of entries) {
    const parts = e.path.replace(/\/$/, '').split('/');
    let node = root;
    const isDir = e.kind === 'excluded-directory';
    for (const part of (isDir ? parts : parts.slice(0, -1))) { if (!node.dirs.has(part)) node.dirs.set(part, { name: part, dirs: new Map(), files: [] }); node = node.dirs.get(part); }
    if (isDir) node.excluded = e; else node.files.push({ ...e, name: parts[parts.length - 1] });
  }
  return root;
}

export function treeHtml(node, statusOf, counts, depth = 0) {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = node.files.sort((a, b) => a.name.localeCompare(b.name));
  return `<ul class="tree" role="${depth ? 'group' : 'tree'}">${dirs.map(d => `<li role="treeitem" aria-expanded="${depth < 2 ? 'true' : 'false'}"><details ${depth < 2 ? 'open' : ''}><summary>${icon('folder', 13)} ${h(d.name)}/${d.excluded ? ` ${badge(`excluded · ${d.excluded.count} files`, 'off')}` : ''}</summary>${d.excluded ? '' : treeHtml(d, statusOf, counts, depth + 1)}</details></li>`).join('')}${files.map(f => { const st = statusOf(f); const n = counts.get(f.path) || 0; return `<li role="treeitem"><button type="button" class="tree-file" data-action="tree-file" data-path="${h(f.path)}" title="${h(f.reason || st)}">${icon('file', 12)}<span class="file-name">${h(f.name)}</span>${badge(st, STATUS_BADGE[st] || 'info')}${n ? `<span class="count" aria-label="${n} findings">${n}</span>` : ''}</button></li>`; }).join('')}</ul>`;
}

function coverageTab(S, r) {
  const c = r.coverage;
  const fileStatus = new Map(r.files.map(f => [f.path, f.status]));
  const counts = new Map();
  for (const f of r.findings) if (f.file) counts.set(f.file, (counts.get(f.file) || 0) + 1);
  const statusOf = m => (m.status === 'ingested' ? fileStatus.get(m.path) || 'ingested' : m.status);
  const tree = buildTree(r.manifest);
  const inv = S.inventoryFilter;
  const rows = r.manifest.filter(m => inv === 'all' || statusOf(m) === inv || (inv === 'not-analyzed' && ['skipped', 'failed', 'partial', 'parse-failed'].includes(statusOf(m))));
  const shown = rows.slice(0, S.inventoryPage * 200);
  const byPath = new Map(r.files.map(f => [f.path, f]));
  return `<section class="panel mb"><div class="panel-head"><h3>Coverage measures</h3></div><div class="panel-body">${ratiosTable(r)}<div class="kpi-row wide mt"><div class="kpi"><strong>${fmt(c.files.discovered)}</strong><small>Files discovered</small></div><div class="kpi"><strong>${fmt(c.files.recognizedSource)}</strong><small>Recognized source files</small></div><div class="kpi"><strong>${fmt(c.files.parsedByRealParser)}</strong><small>Parsed by a real parser</small></div><div class="kpi alert"><strong>${fmt(c.files.parseFailures)}</strong><small>Parse failures</small></div><div class="kpi"><strong>${fmt(c.files.partial)}</strong><small>Partial / heuristic only</small></div><div class="kpi"><strong>${fmt(c.files.skipped + c.files.failedIngestion)}</strong><small>Skipped or unreadable</small></div></div>${Object.keys(c.files.skippedReasons).length ? `<details class="mt"><summary>Skipped and limited files by reason</summary><ul>${Object.entries(c.files.skippedReasons).map(([k, v]) => `<li>${fmt(v)} × ${h(k)}</li>`).join('')}</ul></details>` : ''}${c.limits.length ? `<div class="notice mt"><b>Limits encountered:</b> ${c.limits.map(l => h(l.detail)).join(' ')}</div>` : ''}</div></section>
  <section class="panel mb"><div class="panel-head"><h3>Capabilities by language</h3><span class="meta">What actually runs in this browser build</span></div><div class="panel-body compact"><div class="table-wrap"><table class="data cap"><thead><tr><th scope="col">Language</th>${CAPABILITY_KINDS.map(k => `<th scope="col">${h(CAPABILITY_LABELS[k])}</th>`).join('')}</tr></thead><tbody>${r.capabilities.map(row => `<tr><th scope="row">${h(languageLabel(row.language))}</th>${CAPABILITY_KINDS.map(k => { const cap = row.capabilities[k] || { level: 'unavailable', detail: '' }; return `<td title="${h(cap.detail)}">${badge(cap.level, LEVEL_BADGE[cap.level] || 'info')}<div class="small muted">${h(cap.detail)}</div></td>`; }).join('')}</tr>`).join('')}</tbody></table></div></div></section>
  <div class="grid-two mb"><section class="panel"><div class="panel-head"><h3>Directory tree</h3><span class="meta">Status per file</span></div><div class="panel-body tree-wrap">${treeHtml(tree, statusOf, counts)}</div></section>
  <section class="panel"><div class="panel-head"><h3>File inventory</h3><label class="sr-only" for="inventory-filter">Filter inventory</label><select class="form-control" id="inventory-filter">${[['all', 'All files'], ['not-analyzed', 'Not fully analyzed'], ['analyzed', 'Analyzed'], ['partial', 'Partial'], ['parse-failed', 'Parse failed'], ['skipped', 'Skipped'], ['failed', 'Failed']].map(([v, l]) => `<option value="${v}" ${inv === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div class="panel-body compact"><div class="table-wrap"><table class="data"><thead><tr><th scope="col">Path</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Reason / parser</th></tr></thead><tbody>${shown.map(m => { const f = byPath.get(m.path); const st = statusOf(m); return `<tr><th scope="row"><code>${h(m.path)}</code>${m.count ? ` <span class="muted small">(${fmt(m.count)} entries)</span>` : ''}</th><td class="small">${h(m.language ? languageLabel(m.language) : m.kind || '—')}${m.kind && m.language ? ` · ${h(m.kind)}` : ''}</td><td>${badge(st, STATUS_BADGE[st] || 'info')}</td><td class="small">${h(m.reason || (f ? `${f.parser || ''}${f.notes?.length ? ' · ' + f.notes.join(' ') : ''}${f.blocked?.length ? ' · blocked: ' + f.blocked.join('; ') : ''}` : ''))}${m.warnings?.length ? `<div class="muted">${h(m.warnings.join(' '))}</div>` : ''}</td></tr>`; }).join('')}</tbody></table></div>${rows.length > shown.length ? btn(`Show more (${fmt(rows.length - shown.length)} remaining)`, 'inventory-more', 'ghost sm') : ''}</div></section></div>
  ${blockedList(c.blocked)}
  <section class="panel"><div class="panel-head"><h3>Analysis engines</h3></div><div class="panel-body compact">${engineTable(r.analyzerRuns)}</div></section>`;
}

function reportTab(S, r) {
  return `<section class="panel mb"><div class="panel-head"><h3>Export scan report</h3>${badge('Local until you export', 'passed')}</div><div class="panel-body"><p class="hint">Reports are generated in this tab. They contain findings, coverage, the file manifest, analyzer provenance and limitations, but never file contents; detected secrets are masked.</p><div class="row wrap">${btn(icon('download') + ' JSON report', 'export-scan-json', 'primary')}${btn(icon('file') + ' Markdown report', 'export-scan-md')}${btn(icon('code') + ' SARIF 2.1.0', 'export-scan-sarif')}${btn(icon('copy') + ' Copy summary', 'copy-scan-summary', 'ghost')}</div><p class="form-help mt">Reproducibility: generated inputs use deterministic seeds recorded in each finding, and every file's SHA-256 fingerprint is in the JSON report.</p></div></section>
  <section class="panel"><div class="panel-head"><h3>Limitations of this scan</h3></div><div class="panel-body"><ul>${r.limitations.map(l => `<li>${h(l)}</li>`).join('')}</ul></div></section>`;
}

export function scanView(S, { pageHead }) {
  const r = S.scan.result;
  const tab = S.scanTab;
  let body = '';
  if (r) {
    const tabs = `<div class="tabs" role="tablist" aria-label="Scan results">${SCAN_TABS.map(([id, label]) => `<button type="button" role="tab" id="tab-${id}" aria-controls="scan-panel" aria-selected="${tab === id}" tabindex="${tab === id ? 0 : -1}" class="tab ${tab === id ? 'active' : ''}" data-action="scan-tab" data-tab="${id}">${h(label)}${id === 'findings' ? ` <span class="count">${fmt(r.findings.length)}</span>` : ''}</button>`).join('')}</div>`;
    const content = tab === 'findings' ? findingsExplorer(S, r.findings) : tab === 'integration' ? integrationTab(S, r) : tab === 'runtime' ? runtimeTab(S, r) : tab === 'security' ? securityTab(S, r) : tab === 'graph' ? graphTab(S, r) : tab === 'coverage' ? coverageTab(S, r) : tab === 'report' ? reportTab(S, r) : summaryTab(S, r);
    body = `${verdictBanner(r)}${tabs}<div id="scan-panel" role="tabpanel" aria-labelledby="tab-${h(tab)}" class="tabpanel">${content}</div>`;
  }
  return `${pageHead('Project verification', 'Project Scan', 'Analyze single files, folders and ZIP projects as a whole: parse and type-check every supported file, resolve how files depend on each other, run supported tests and generated inputs in an isolated sandbox, and see exactly what was and was not verified.')}
  <div class="scan-layout"><div class="scan-controls">${uploadPanel(S)}${progressPanel(S)}</div><div class="scan-results">${body || `<div class="blank tall">${icon('scan', 34)}<strong>No scan results yet</strong>Load a project and start a scan. Results stay in this tab until you export them.</div>`}</div></div>`;
}

export function authorshipView(S, { pageHead }) {
  const a = S.scan.result?.authorship;
  const head = pageHead('Secondary · provenance', 'Authorship estimate', 'A cautious, heuristic estimate of whether code shows evidence of AI generation. It is independent of defect analysis and never changes findings, severities or coverage.');
  if (!a) return `${head}<div class="notice">Run a project scan to produce an estimate. Until then the answer is "Indeterminate".</div>`;
  const indicator = i => `<li>${badge(i.weight, i.weight === 'strong' ? 'info' : i.weight === 'moderate' ? 'warning' : 'off')} ${h(i.label)}${i.line ? ` <span class="code-ref">line ${i.line}</span>` : ''}${i.detail ? `<div class="small muted">${h(i.detail)}</div>` : ''}</li>`;
  return `${head}<div class="notice mb">${icon('info', 14)} <b>Heuristic estimate — not a probability, not forensic proof.</b> Source code alone cannot prove who or what wrote it. Do not use this for academic, employment or legal decisions.</div>
  <div class="grid-two mb"><section class="panel secondary"><div class="panel-head"><h3>Project estimate</h3>${badge(a.label, a.category === 'indeterminate' ? 'off' : 'warning')}</div><div class="panel-body"><dl class="detail-list compact"><dt>Estimate type</dt><dd>${h(a.estimateType)} (uncalibrated)</dd><dt>Confidence</dt><dd>${h(a.confidence)}</dd><dt>Basis</dt><dd>${h(a.note || '')}</dd><dt>Evaluable files</dt><dd>${fmt(a.evaluableFiles)}</dd><dt>Distribution</dt><dd>${Object.entries(a.distribution).filter(([, n]) => n).map(([k, n]) => `${h(k)}: ${n}`).join(' · ') || '—'}</dd>${a.workflowArtifacts?.length ? `<dt>AI tooling configuration present</dt><dd>${a.workflowArtifacts.map(p => `<code>${h(p)}</code>`).join(', ')}</dd>` : ''}</dl></div></section>
  <section class="panel secondary"><div class="panel-head"><h3>Methodology and limits</h3></div><div class="panel-body"><ol class="small">${a.methodology.map(m => `<li>${h(m)}</li>`).join('')}</ol><ul class="small">${a.limitations.map(m => `<li>${h(m)}</li>`).join('')}</ul></div></section></div>
  <section class="panel secondary"><div class="panel-head"><h3>Files with indicators</h3><span class="meta">${a.files.length}</span></div><div class="panel-body compact">${a.files.map(f => `<div class="cardlink"><div><h4 class="code-ref">${h(f.path)}</h4><p>${badge(f.label || f.category, f.category === 'indeterminate' ? 'off' : 'warning')} confidence ${h(f.confidence)} — ${h(f.note || '')}</p><ul class="indicators">${f.indicators.map(indicator).join('')}</ul></div></div>`).join('') || '<p class="muted">No file carries provenance indicators. That is not evidence of human authorship.</p>'}</div></section>`;
}
