import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const bom = await readJson('sbom.cdx.json');
const manifest = await readJson('licenses-resolved.json');
const check = process.argv.includes('--check');
if (bom.bomFormat !== 'CycloneDX' || bom.specVersion !== '1.6') throw Error('Expected CycloneDX 1.6.');
if (!Array.isArray(manifest.components) || manifest.components.length !== 4 || !Array.isArray(bom.components) || bom.components.length !== 4) throw Error('Expected exactly four reviewed direct runtime components.');
const mismatches = [];
for (const component of manifest.components) {
  if (!['MIT','Apache-2.0','MPL-2.0','PSF-2.0'].includes(component.spdxLicenseId)) mismatches.push(`Unapproved SPDX license for ${component.name}`);
  for (const evidence of component.evidence ?? []) {
    try { await readFile(evidence); } catch { mismatches.push(`Missing evidence: ${evidence}`); }
  }
  for (const path of component.files ?? []) {
    const stat = await readFile(path).catch(() => null);
    if (!stat) { mismatches.push(`Missing runtime file: ${path}`); continue; }
    const actual = await sha256(path);
    if (component.sha256 && component.sha256 !== actual && check) mismatches.push(`Manifest SHA-256 mismatch: ${path}`);
    component.sha256 = actual;
    const entry = bom.components.find(item => item.name === component.name);
    if (!entry) { mismatches.push(`SBOM component missing: ${component.name}`); continue; }
    if (entry.version !== component.version || entry.purl !== `pkg:npm/${component.name}@${component.version}`) mismatches.push(`Version or PURL mismatch: ${component.name}`);
    if (check && entry.hashes?.[0]?.content !== actual) mismatches.push(`SBOM SHA-256 mismatch: ${path}`);
    entry.hashes = [{alg:'SHA-256',content:actual}];
  }
  const entry = bom.components.find(item => item.name === component.name);
  if (!entry || entry.licenses?.[0]?.license?.id !== component.spdxLicenseId) mismatches.push(`SBOM/license mismatch: ${component.name}`);
}
const pinned = await readJson('scripts/pinned-assets.json');
const browserPins = await readFile('docs/assets/runtime/pinned-pyodide.mjs','utf8');
for (const [name, pkg] of Object.entries(pinned.packages)) {
  const component = manifest.components.find(c => c.name === name);
  if (!component || component.version !== pkg.version) mismatches.push(`Pinned ${name}@${pkg.version} is not the reviewed licence-manifest version.`);
}
const pyIntegrity = Buffer.from(pinned.packages.pyodide.integrity.split('-')[1], 'base64').toString('hex');
if (bom.components.find(c => c.name === 'pyodide')?.hashes?.[0]?.content !== pyIntegrity) mismatches.push('SBOM Pyodide SHA-512 differs from the pinned tarball integrity.');
for (const digest of Object.values(pinned.packages.pyodide.extract.files)) if (!browserPins.includes(digest)) mismatches.push(`Browser-side Pyodide digest list is missing ${digest}.`);
if (mismatches.length) throw Error('Supply-chain check failed:\n- '+mismatches.join('\n- '));
if (check) {
  console.log('Supply-chain inventory is current: direct asset hashes, four component versions, SPDX IDs, evidence and pinned runtime digests are verified.');
} else {
  bom.serialNumber = `urn:uuid:${randomUUID()}`;
  bom.metadata.timestamp = new Date().toISOString();
  manifest.reviewedOn = new Date().toISOString().slice(0,10);
  await writeFile('sbom.cdx.json',JSON.stringify(bom,null,2)+'\n');
  await writeFile('licenses-resolved.json',JSON.stringify(manifest,null,2)+'\n');
  console.log('Updated sbom.cdx.json and licenses-resolved.json.');
}
