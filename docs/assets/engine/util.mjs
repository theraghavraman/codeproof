// Shared, environment-neutral helpers (browser main thread, workers, and Node 22+).

export const textEncoder = new TextEncoder();

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? textEncoder.encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// Fast, non-cryptographic hash for stable IDs and cache keys (FNV-1a, 52-bit safe).
export function fnv1a(input) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).padStart(12, '0');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(bytes, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Deterministic PRNG (mulberry32) so generated test inputs are reproducible from a seed.
export function seededRandom(seed) {
  let a = 0x811c9dc5;
  if (typeof seed === 'number') a = seed >>> 0;
  else for (const ch of String(seed)) a = Math.imul(a ^ ch.codePointAt(0), 0x01000193) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next(); next(); // discard the first outputs, which correlate with nearby seeds
  return next;
}

// Maps character offsets to 1-based line and column numbers without repeated scans.
export class LineIndex {
  constructor(text) {
    this.text = text;
    this.starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  get lineCount() { return this.starts.length; }
  position(offset) {
    const o = Math.max(0, Math.min(offset | 0, this.text.length));
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= o) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, column: o - this.starts[lo] + 1 };
  }
  lineText(line) {
    const start = this.starts[line - 1];
    if (start === undefined) return '';
    const end = line < this.starts.length ? this.starts[line] - 1 : this.text.length;
    return this.text.slice(start, end).replace(/\r$/, '');
  }
  offsetOf(line, column = 1) {
    const start = this.starts[Math.max(0, Math.min(line - 1, this.starts.length - 1))];
    return start + Math.max(0, column - 1);
  }
}

// Secret detection patterns shared by the analyzers and the report redactor.
export const SECRET_PATTERNS = [
  { id: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, confidence: 'high' },
  { id: 'github-token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g, confidence: 'high' },
  { id: 'slack-token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, confidence: 'high' },
  { id: 'stripe-live-key', regex: /\b[rs]k_live_[A-Za-z0-9]{16,}\b/g, confidence: 'high' },
  { id: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, confidence: 'high' },
  { id: 'openai-style-key', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g, confidence: 'medium' },
  { id: 'private-key-block', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g, confidence: 'high' },
];
const ASSIGNMENT_SECRET = /\b([A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)[A-Za-z0-9_]*)["']?\s*[:=]\s*(["'`])([^"'`\n]{8,})\2/gi;
const PLACEHOLDER = /^(?:x+|\*+|\.+|changeme|change[_-]?me|password|secret|example|sample|dummy|test|testing|placeholder|your[_-].*|<.*>|\$\{.*\}|\{\{.*\}\}|%\(.*\)s|process\.env.*|null|undefined|none|todo|redacted|[a-z]+_here)$/i;

export function findSecrets(text) {
  const out = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const m of text.matchAll(pattern.regex)) out.push({ kind: pattern.id, index: m.index, length: m[0].length, value: m[0], confidence: pattern.confidence });
  }
  for (const m of text.matchAll(ASSIGNMENT_SECRET)) {
    const value = m[3];
    if (PLACEHOLDER.test(value.trim()) || /\s{2,}/.test(value) || value.length > 200) continue;
    const valueIndex = m.index + m[0].lastIndexOf(value);
    if (out.some(o => o.index <= valueIndex && valueIndex < o.index + o.length)) continue;
    out.push({ kind: 'assigned-credential', name: m[1], index: valueIndex, length: value.length, value, confidence: 'medium' });
  }
  return out;
}

export function maskSecret(value) {
  const s = String(value);
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(Math.min(12, s.length - 4))}…(${s.length} chars)`;
}

// Redacts anything that looks like a credential from free text before it leaves an analyzer.
export function redact(text) {
  let out = String(text ?? '');
  const hits = findSecrets(out).sort((a, b) => b.index - a.index);
  for (const hit of hits) out = out.slice(0, hit.index) + maskSecret(hit.value) + out.slice(hit.index + hit.length);
  return out;
}

export function clampText(text, max = 400) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export const isIdentifier = name => typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name);

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Scan cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

export const nowMs = () => (globalThis.performance?.now?.() ?? Date.now());
