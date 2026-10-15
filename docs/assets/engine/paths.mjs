// Path normalization and validation for uploaded files, folders and archive entries.
// Paths are always relative, '/'-separated, NFC-normalized and free of traversal segments.

export const MAX_PATH_LENGTH = 1024;
export const MAX_SEGMENT_LENGTH = 255;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

export function normalizePath(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'Path is not a string.' };
  let path = raw.normalize('NFC');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return { ok: false, reason: 'Path contains control characters.' };
  path = path.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(path)) return { ok: false, reason: 'Absolute Windows drive path rejected.' };
  if (path.startsWith('//')) return { ok: false, reason: 'UNC/network path rejected.' };
  if (path.startsWith('/')) return { ok: false, reason: 'Absolute path rejected.' };
  const isDirectory = path.endsWith('/');
  const segments = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return { ok: false, reason: 'Path traversal segment (..) rejected.' };
    if (segment.length > MAX_SEGMENT_LENGTH) return { ok: false, reason: 'Path segment exceeds 255 characters.' };
    segments.push(segment);
  }
  if (!segments.length) return { ok: false, reason: 'Empty path.' };
  const normalized = segments.join('/');
  if (normalized.length > MAX_PATH_LENGTH) return { ok: false, reason: `Path exceeds ${MAX_PATH_LENGTH} characters.` };
  const warnings = [];
  if (normalized !== raw.replace(/\\/g, '/').replace(/^\.\//, '')) warnings.push('Path was normalized (separators, Unicode NFC or redundant segments).');
  if (segments.some(s => WINDOWS_RESERVED.test(s))) warnings.push('Contains a name reserved on Windows (for example CON or NUL).');
  if (segments.some(s => /[ .]$/.test(s))) warnings.push('A path segment ends with a space or dot, which Windows cannot represent.');
  return { ok: true, path: normalized, isDirectory, warnings };
}

export const dirname = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const basename = path => path.slice(path.lastIndexOf('/') + 1);
export const extname = path => {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

// Joins a base directory with a relative specifier ('./x', '../y'); returns null when it escapes the root.
export function joinRelative(baseDir, specifier) {
  const parts = baseDir ? baseDir.split('/') : [];
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

export function isIgnoredByPolicy(path, ignorePaths = []) {
  const segments = path.split('/');
  for (const rule of ignorePaths) {
    if (!rule) continue;
    if (path === rule || path.startsWith(rule + '/') || segments.includes(rule)) return rule;
  }
  return null;
}

// The top-level ignored directory for a path (used to aggregate skipped entries such as node_modules/).
export function ignoredRoot(path, rule) {
  const segments = path.split('/');
  const index = segments.indexOf(rule);
  if (index >= 0) return segments.slice(0, index + 1).join('/') + '/';
  return rule.endsWith('/') ? rule : rule + '/';
}
