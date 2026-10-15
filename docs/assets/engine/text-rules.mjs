// Language-independent text checks: credentials and unfinished-work markers. Secret values are never
// copied into findings; only a masked prefix and the location are reported.
import { findSecrets, maskSecret } from './util.mjs';

const FIXTURE_PATH = /(?:^|\/)(?:tests?|__tests__|spec|fixtures?|examples?|samples?|mocks?)\//i;

export function secretFindings(file, lines) {
  const out = [];
  const fixture = FIXTURE_PATH.test(file.path) || file.kind === 'test';
  for (const hit of findSecrets(file.content)) {
    const { line, column } = lines.position(hit.index);
    const strong = hit.confidence === 'high';
    out.push({
      rule: 'SECRET_LITERAL',
      title: strong ? `Hardcoded credential (${hit.kind})` : `Possible hardcoded credential${hit.name ? ` in "${hit.name}"` : ''}`,
      category: 'security',
      severity: strong ? (fixture ? 'high' : 'critical') : (fixture ? 'low' : 'high'),
      verification: strong ? 'high-confidence' : 'potential',
      confidence: strong ? 'high' : 'medium',
      file: file.path, line, column,
      excerpt: lines.lineText(line).trim(),
      rootCause: `A value matching ${strong ? `the ${hit.kind} format` : 'a credential assignment'} is embedded in source (${maskSecret(hit.value)}). Anyone with read access to the code or its history can use it.${fixture ? ' The file looks like a test or fixture, which lowers but does not remove the risk.' : ''}`,
      suggestion: 'Move the value to protected configuration or a secret manager, rotate it if it was ever real, and purge it from version history.',
      analyzer: 'secret-scanner',
    });
  }
  return out;
}

export function todoFindings(file, lines) {
  const out = [];
  for (const m of file.content.matchAll(/\b(TODO|FIXME|HACK|XXX)\b[:\s]/g)) {
    const { line, column } = lines.position(m.index);
    out.push({ rule: 'TODO', title: `${m[1]} marker`, category: 'quality', severity: 'info', verification: 'quality', file: file.path, line, column, excerpt: lines.lineText(line).trim(), rootCause: 'Source includes an unfinished-work annotation.', suggestion: 'Review whether the annotation indicates missing behavior.', analyzer: 'text-rules' });
  }
  return out;
}
