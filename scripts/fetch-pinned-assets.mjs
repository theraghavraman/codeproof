#!/usr/bin/env node
// Restores pinned third-party runtime assets (TypeScript lib .d.ts files and the Pyodide core runtime)
// from npm tarballs. Fails closed: a tarball whose sha512 differs from the pinned integrity, or an
// extracted file whose SHA-256 differs from scripts/pinned-assets.json, is never written.
// Usage: node scripts/fetch-pinned-assets.mjs [--check] [--only typescript|pyodide] [--cache DIR]
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const cacheDir = args.includes('--cache') ? args[args.indexOf('--cache') + 1] : null;
const manifest = JSON.parse(await readFile('scripts/pinned-assets.json', 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sri512 = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');

async function existingMatches(path, expected) {
  try { return sha256(await readFile(path)) === expected; } catch { return false; }
}

// Minimal ustar/pax reader: returns Map(path -> Buffer) for regular files.
function untar(buffer) {
  const files = new Map();
  let offset = 0, paxPath = null;
  const field = (start, len) => buffer.subarray(offset + start, offset + start + len).toString('utf8').replace(/\0.*$/s, '');
  while (offset + 512 <= buffer.length) {
    if (buffer.subarray(offset, offset + 512).every(b => b === 0)) break;
    const name = field(0, 100), prefix = field(345, 155), type = field(156, 1) || '0';
    const size = parseInt(field(124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('Corrupt tar header');
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    if (type === 'x') {
      const match = body.toString('utf8').match(/\d+ path=([^\n]*)\n/);
      paxPath = match ? match[1] : null;
    } else if (type === '0' || type === '\0') {
      const path = paxPath || (prefix ? `${prefix}/${name}` : name);
      if (path.split('/').includes('..') || path.startsWith('/')) throw new Error(`Unsafe tar path: ${path}`);
      files.set(path, Buffer.from(body));
      paxPath = null;
    } else paxPath = null;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function tarball(pkg, name) {
  const cached = cacheDir ? join(cacheDir, `${name}-${pkg.version}.tgz`) : null;
  let bytes = cached ? await readFile(cached).catch(() => null) : null;
  if (!bytes) {
    const response = await fetch(pkg.tarball);
    if (!response.ok) throw new Error(`${name}: download failed with HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const actual = sri512(bytes);
  if (actual !== pkg.integrity) throw new Error(`${name}: tarball integrity mismatch (${actual})`);
  if (cached) { await mkdir(cacheDir, { recursive: true }); await writeFile(cached, bytes); }
  return untar(gunzipSync(bytes));
}

let restored = 0, verified = 0;
for (const [name, pkg] of Object.entries(manifest.packages)) {
  if (only && only !== name) continue;
  const { from, to, files } = pkg.extract;
  const missing = [];
  for (const [file, digest] of Object.entries(files)) if (!(await existingMatches(join(to, file), digest))) missing.push(file);
  if (!missing.length) { verified += Object.keys(files).length; console.log(`${name}@${pkg.version}: ${Object.keys(files).length} files already present and verified.`); continue; }
  if (checkOnly) throw new Error(`${name}: ${missing.length} pinned files missing or modified (first: ${missing[0]}). Run node scripts/fetch-pinned-assets.mjs`);
  const entries = await tarball(pkg, name);
  for (const [path, digest] of Object.entries(pkg.crossCheck || {})) {
    const actual = entries.has(path) ? sha256(entries.get(path)) : 'missing';
    if (actual !== digest) throw new Error(`${name}: provenance cross-check failed for ${path} (${actual})`);
  }
  for (const file of missing) {
    const body = entries.get(from + file);
    if (!body) throw new Error(`${name}: ${from + file} is absent from the tarball`);
    const actual = sha256(body);
    if (actual !== files[file]) throw new Error(`${name}: SHA-256 mismatch for ${file} (${actual})`);
    await mkdir(dirname(join(to, file)), { recursive: true });
    await writeFile(join(to, file), body);
    restored++;
  }
  console.log(`${name}@${pkg.version}: restored ${missing.length} files into ${to} (tarball sha512 and per-file SHA-256 verified).`);
}
// The CI-kit download lists the TypeScript lib files from this index (static hosting has no directory listing).
if (!only || only === 'typescript') {
  const libs = Object.keys(manifest.packages.typescript.extract.files).sort();
  const index = JSON.stringify(libs) + '\n';
  const path = manifest.packages.typescript.extract.to + 'files.json';
  if (checkOnly) { if ((await readFile(path, 'utf8').catch(() => '')) !== index) throw new Error(`${path} is missing or stale`); }
  else await writeFile(path, index);
}
if (checkOnly) console.log(`Pinned assets verified: ${verified} files.`);
else console.log(`Pinned asset restore complete: ${restored} written, ${verified} already verified.`);
await stat('scripts/pinned-assets.json');
