// Defensive ZIP reader. The central directory is parsed and validated before any entry is inflated;
// inflation is streamed through DecompressionStream with a hard byte cap, and CRC-32 is verified.
// Nothing is ever written to the user's filesystem.
import { crc32 } from './util.mjs';

export const ZIP_DEFAULTS = Object.freeze({
  maxArchiveBytes: 50_000_000,
  maxEntries: 20_000,
  maxTotalUncompressed: 64_000_000,
  maxRatio: 200,
  ratioFloorBytes: 1_000_000,
});

export class ZipError extends Error {
  constructor(message, code) { super(message); this.name = 'ZipError'; this.code = code; }
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return Array.from(bytes, c => String.fromCharCode(c)).join(''); } // CP437 approximated by Latin-1
}

export function readZipDirectory(input, limits = {}) {
  const L = { ...ZIP_DEFAULTS, ...limits };
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length > L.maxArchiveBytes) throw new ZipError(`Archive is ${b.length} bytes; the limit is ${L.maxArchiveBytes}.`, 'archive-too-large');
  if (b.length < 22) throw new ZipError('File is too small to be a ZIP archive.', 'malformed');
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('End of central directory not found: the archive is truncated or not a ZIP file.', 'malformed');
  if (u16(b, eocd + 4) !== 0 || u16(b, eocd + 6) !== 0) throw new ZipError('Multi-volume (spanned) archives are not supported.', 'unsupported');
  let total = u16(b, eocd + 10), cdSize = u32(b, eocd + 12), cdOffset = u32(b, eocd + 16);
  let zip64 = false;
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || u32(b, locator) !== 0x07064b50) throw new ZipError('ZIP64 locator missing or corrupt.', 'malformed');
    const rec = u64(b, locator + 8);
    if (rec + 56 > b.length || u32(b, rec) !== 0x06064b50) throw new ZipError('ZIP64 end record corrupt.', 'malformed');
    total = u64(b, rec + 32); cdSize = u64(b, rec + 40); cdOffset = u64(b, rec + 48); zip64 = true;
  }
  if (total > L.maxEntries) throw new ZipError(`Archive declares ${total} entries; the limit is ${L.maxEntries}.`, 'too-many-entries');
  if (cdOffset + cdSize > b.length) throw new ZipError('Central directory extends past the end of the file.', 'malformed');
  const entries = [], issues = [];
  let p = cdOffset, declaredTotal = 0;
  for (let i = 0; i < total; i++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new ZipError(`Central directory entry ${i + 1} is corrupt.`, 'malformed');
    const madeBy = u16(b, p + 4), flags = u16(b, p + 8), method = u16(b, p + 10), crc = u32(b, p + 16);
    let compressedSize = u32(b, p + 20), uncompressedSize = u32(b, p + 24);
    const nameLen = u16(b, p + 28), extraLen = u16(b, p + 30), commentLen = u16(b, p + 32), external = u32(b, p + 38);
    let localOffset = u32(b, p + 42);
    const rawName = decodeName(b.subarray(p + 46, p + 46 + nameLen), flags & 0x800);
    let x = p + 46 + nameLen;
    const extraEnd = x + extraLen;
    while (x + 4 <= extraEnd) {
      const id = u16(b, x), size = u16(b, x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (uncompressedSize === 0xffffffff) { uncompressedSize = u64(b, q); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(b, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(b, q); }
        zip64 = true;
      }
      x += 4 + size;
    }
    const hostOS = madeBy >> 8, mode = external >>> 16;
    const isSymlink = hostOS === 3 && (mode & 0o170000) === 0o120000;
    const isDirectory = rawName.endsWith('/') || (hostOS === 3 && (mode & 0o170000) === 0o040000) || (external & 0x10) === 0x10;
    entries.push({ index: i, rawName, method, flags, crc32: crc, compressedSize, uncompressedSize, localOffset, isDirectory, isSymlink, encrypted: Boolean(flags & 1), dataOffset: null });
    declaredTotal += uncompressedSize;
    p += 46 + nameLen + extraLen + commentLen;
  }
  // Resolve data offsets and reject overlapping entries (a known zip-bomb construction).
  const ranges = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (e.localOffset + 30 > b.length || u32(b, e.localOffset) !== 0x04034b50) { e.corrupt = 'Local file header missing or corrupt.'; continue; }
    e.dataOffset = e.localOffset + 30 + u16(b, e.localOffset + 26) + u16(b, e.localOffset + 28);
    if (e.dataOffset + e.compressedSize > b.length) { e.corrupt = 'Entry data extends past the end of the archive.'; continue; }
    ranges.push([e.dataOffset, e.dataOffset + e.compressedSize, e]);
  }
  ranges.sort((a, c) => a[0] - c[0]);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i][0] < ranges[i - 1][1] && ranges[i][1] > ranges[i][0]) {
      throw new ZipError(`Entries "${ranges[i - 1][2].rawName}" and "${ranges[i][2].rawName}" overlap; overlapping data is a zip-bomb technique and the archive is rejected.`, 'overlapping-entries');
    }
  }
  if (declaredTotal > L.maxTotalUncompressed * 50) issues.push(`Archive declares ${declaredTotal} uncompressed bytes in total; only entries that pass per-file limits are inflated.`);
  return { entries, zip64, declaredTotal, issues };
}

export function entryRisk(entry, limits = {}) {
  const L = { ...ZIP_DEFAULTS, ...limits };
  if (entry.corrupt) return entry.corrupt;
  if (entry.isSymlink) return 'Symbolic-link entry is not extracted.';
  if (entry.encrypted) return 'Encrypted entry cannot be read without a password.';
  if (![0, 8].includes(entry.method)) return `Unsupported compression method ${entry.method}.`;
  const ratio = entry.compressedSize ? entry.uncompressedSize / entry.compressedSize : (entry.uncompressedSize ? Infinity : 0);
  if (entry.uncompressedSize > L.ratioFloorBytes && ratio > L.maxRatio) return `Compression ratio ${Math.round(ratio)}:1 exceeds the ${L.maxRatio}:1 safety limit (possible zip bomb).`;
  return null;
}

export function inflateSupported() {
  try { new DecompressionStream('deflate-raw'); return true; } catch { return false; }
}

// Inflates a single entry with a hard cap. Throws ZipError on size or CRC mismatch.
export async function extractEntry(input, entry, { maxBytes = Infinity } = {}) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const risk = entryRisk(entry, { maxRatio: Infinity });
  if (risk) throw new ZipError(risk, 'entry-rejected');
  const cap = Math.min(entry.uncompressedSize, maxBytes);
  if (entry.uncompressedSize > maxBytes) throw new ZipError(`Entry declares ${entry.uncompressedSize} bytes; the per-file limit is ${maxBytes}.`, 'entry-too-large');
  const raw = b.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let out;
  if (entry.method === 0) {
    if (raw.length !== entry.uncompressedSize) throw new ZipError('Stored entry size does not match its header.', 'size-mismatch');
    out = raw.slice();
  } else {
    if (!inflateSupported()) throw new ZipError('This browser lacks DecompressionStream("deflate-raw"); ZIP inflation is unavailable.', 'missing-api');
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > cap) {
          await reader.cancel().catch(() => {});
          throw new ZipError(`Entry inflated beyond its declared size of ${entry.uncompressedSize} bytes (possible zip bomb); extraction stopped.`, 'size-exceeded');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof ZipError) throw error;
      throw new ZipError(`Entry data is corrupt: ${error?.message || error}`, 'corrupt-data');
    }
    out = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.byteLength; }
    if (size !== entry.uncompressedSize) throw new ZipError(`Inflated size ${size} differs from the declared ${entry.uncompressedSize} bytes.`, 'size-mismatch');
  }
  if (crc32(out) !== entry.crc32) throw new ZipError('CRC-32 checksum mismatch; the entry is corrupt or was tampered with.', 'crc-mismatch');
  return out;
}
