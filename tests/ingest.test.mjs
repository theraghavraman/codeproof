import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath } from '../docs/assets/engine/paths.mjs';
import { detectLanguage, classifyKind, decodeText, looksBinary, magicType } from '../docs/assets/engine/detect.mjs';
import { ingestEntries, ingestZip } from '../docs/assets/engine/ingest.mjs';
import { readZipDirectory, extractEntry, ZipError } from '../docs/assets/engine/zip.mjs';
import { buildZip } from './helpers/zip-writer.mjs';

const text = (path, content) => ({ path, size: Buffer.byteLength(content), read: async () => Buffer.from(content) });

test('paths: traversal, absolute, drive, UNC and control characters are rejected; Unicode and spaces kept', () => {
  for (const bad of ['../x.js', 'a/../../x.js', '/etc/passwd', 'C:\\Windows\\x.js', '//server/share/x', 'a/\u0000b.js', '']) assert.equal(normalizePath(bad).ok, false, bad);
  assert.equal(normalizePath('src\\win\\file.js').path, 'src/win/file.js');
  assert.equal(normalizePath('./a/./b//c.py').path, 'a/b/c.py');
  assert.equal(normalizePath('naïve dir/über file.ts').path, 'naïve dir/über file.ts');
  assert.equal(normalizePath('cafe\u0301.js').path, 'café.js', 'NFC normalization');
  assert.ok(normalizePath('src/CON.js').warnings.some(w => /reserved on Windows/.test(w)));
});

test('language detection uses extensions, shebangs and file roles; binary and encoding sniffing', () => {
  assert.equal(detectLanguage('bin/tool', '#!/usr/bin/env node\nconsole.log(1)'), 'javascript');
  assert.equal(detectLanguage('scripts/run', '#!/usr/bin/env python3\nprint(1)'), 'python');
  assert.equal(detectLanguage('types/x.d.ts'), 'typescript');
  assert.equal(classifyKind('package-lock.json', 'json'), 'lockfile');
  assert.equal(classifyKind('src/__tests__/a.test.ts', 'typescript'), 'test');
  assert.equal(classifyKind('tests/test_a.py', 'python'), 'test');
  assert.equal(classifyKind('.env.example', 'env'), 'env');
  assert.equal(magicType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2])), 'PNG image');
  assert.equal(looksBinary(Buffer.from([65, 0, 66])), true);
  const latin1 = decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  assert.equal(latin1.valid, false); assert.equal(latin1.text, 'café');
  assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x41])).encoding, 'utf-8-bom');
});

test('ingestion records every entry with an explicit status and never drops files silently', async () => {
  const r = await ingestEntries([
    text('src/a.js', 'export const a = 1;'),
    text('src/a.js', 'duplicate'),
    text('../evil.js', 'x'),
    text('empty.js', ''),
    { path: 'logo.png', size: 10, read: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { path: 'fake.js', size: 8, read: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) },
    text('big.py', 'x'.repeat(2000)),
    text('node_modules/lib/index.js', 'module.exports = 1'),
    text('node_modules/lib/other.js', 'module.exports = 2'),
    text('legacy.py', '\u00e9'),
    { path: 'link.js', isSymlink: true, size: 0 },
  ], { policy: { maxFileBytes: 1000, ignorePaths: ['node_modules'] } });
  const by = p => r.manifest.find(m => m.path === p);
  assert.equal(by('src/a.js').status, 'ingested');
  assert.match(r.manifest.find(m => m.path === 'src/a.js' && m.status === 'skipped').reason, /Duplicate path/);
  assert.match(by('../evil.js').reason, /Path traversal/);
  assert.ok(by('empty.js').warnings.includes('Empty file.'));
  assert.match(by('logo.png').reason, /Binary file inventoried/);
  assert.match(by('fake.js').reason, /Misleading extension: content is a PNG image/);
  assert.match(by('big.py').reason, /per-file limit is 1000 bytes/);
  assert.equal(by('node_modules/').count, 2);
  assert.match(by('link.js').reason, /Symbolic link/);
  assert.ok(r.limits.some(l => l.type === 'max-file-bytes'));
  assert.equal(r.files.length, 3);
});

test('ingestion file-count limit is reported per file', async () => {
  const r = await ingestEntries([text('a.js', '1'), text('b.js', '2'), text('c.js', '3')], { policy: { maxFiles: 2 } });
  assert.equal(r.files.length, 2);
  assert.match(r.manifest.find(m => m.path === 'c.js').reason, /File-count limit of 2/);
  assert.ok(r.limits.some(l => l.type === 'max-files'));
});

test('case-only path collisions are flagged', async () => {
  const r = await ingestEntries([text('src/Utils.js', '1'), text('src/utils.js', '2')]);
  assert.equal(r.caseCollisions.length, 1);
  assert.ok(r.manifest.find(m => m.path === 'src/Utils.js').warnings.some(w => /letter case/.test(w)));
});

test('ZIP: nested directories, Unicode names and deflate/store entries round-trip with CRC verification', async () => {
  const zip = buildZip([{ name: 'proj/src/deep/a b/ünï.js', data: 'export const u = 1;' }, { name: 'proj/README.md', data: '# hi', method: 0 }, { name: 'proj/src/', data: '' }]);
  const r = await ingestZip(zip);
  assert.deepEqual(r.files.map(f => f.path).sort(), ['proj/README.md', 'proj/src/deep/a b/ünï.js']);
  assert.equal(r.archive.entries, 3);
});

test('ZIP: traversal and absolute entries are skipped, symlinks not followed', async () => {
  const r = await ingestZip(buildZip([{ name: '../../etc/x.js', data: '1' }, { name: '/abs.js', data: '2' }, { name: 'ok.js', data: '3' }, { name: 'link', data: 'target', unixMode: 0o120777 }]));
  assert.deepEqual(r.files.map(f => f.path), ['ok.js']);
  assert.match(r.manifest.find(m => m.path === '../../etc/x.js').reason, /traversal/);
  assert.match(r.manifest.find(m => m.path === '/abs.js').reason, /Absolute/);
  assert.match(r.manifest.find(m => m.path === 'link').reason, /Symbolic link/);
});

test('ZIP: compression-ratio bombs and lying size headers are refused without full inflation', async () => {
  const bomb = buildZip([{ name: 'zeros.txt', data: Buffer.alloc(30_000_000) }, { name: 'a.js', data: 'export const a = 1;' }]);
  const r = await ingestZip(bomb);
  assert.match(r.manifest.find(m => m.path === 'zeros.txt').reason, /zip bomb|per-file limit/i);
  assert.deepEqual(r.files.map(f => f.path), ['a.js']);
  // Declared size says 10 bytes but the stream inflates to 2 MB: extraction stops at the declared size.
  const liar = buildZip([{ name: 'liar.js', data: Buffer.alloc(2_000_000, 97), declaredSize: 10 }]);
  const dir = readZipDirectory(liar);
  await assert.rejects(extractEntry(liar, dir.entries[0], { maxBytes: 1_000_000 }), e => e instanceof ZipError && e.code === 'size-exceeded');
});

test('ZIP: CRC mismatch, overlapping entries, entry-count limits and malformed archives fail explicitly', async () => {
  const badCrc = buildZip([{ name: 'a.js', data: 'abc', crc: 1234 }]);
  const d = readZipDirectory(badCrc);
  await assert.rejects(extractEntry(badCrc, d.entries[0]), e => e.code === 'crc-mismatch');
  const overlap = buildZip([{ name: 'a.txt', data: 'hello world', method: 0 }, { name: 'b.txt', data: 'hello world', method: 0, localOffset: 0 }]);
  assert.throws(() => readZipDirectory(overlap), e => e.code === 'overlapping-entries' || e.code === 'malformed');
  assert.throws(() => readZipDirectory(buildZip([{ name: 'a', data: '1' }, { name: 'b', data: '2' }]), { maxEntries: 1 }), e => e.code === 'too-many-entries');
  assert.throws(() => readZipDirectory(Buffer.from('PK\u0003\u0004 not really a zip file at all')), e => e.code === 'malformed');
  await assert.rejects(ingestZip(Buffer.alloc(10)), e => e.code === 'malformed');
});
