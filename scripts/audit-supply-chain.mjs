import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (p) => readFile(resolve(root, p), 'utf8');
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const manifest = JSON.parse(await read('licenses-resolved.json'));
const bom = JSON.parse(await read('sbom.cdx.json'));
const spdxIds = new Set(['MIT', 'Apache-2.0', 'MPL-2.0', 'PSF-2.0']);
check(await stat(resolve(root, 'LICENSE')).then((s) => s.isFile()), 'Project LICENSE is missing.');
check((await read('LICENSE')).includes('MIT License'), 'Project LICENSE must agree with the manifest (MIT).');
check(manifest.project?.spdxLicenseId === 'MIT', 'Project licence ID is not MIT.');
check(bom.bomFormat === 'CycloneDX' && bom.specVersion === '1.6', 'SBOM must be CycloneDX 1.6.');
check(Array.isArray(manifest.components) && manifest.components.length >= 4, 'Expected four reviewed direct runtime components.');
check(Array.isArray(bom.components) && bom.components.length === manifest.components.length, 'SBOM and licence inventory component counts differ.');
for (const component of manifest.components) {
  check(spdxIds.has(component.spdxLicenseId), `Unexpected or unresolved SPDX licence for ${component.name}: ${component.spdxLicenseId}`);
  check(component.version && component.upstream && component.evidence?.length, `Missing version/upstream/evidence for ${component.name}.`);
  for (const p of component.evidence) check(await stat(resolve(root, p)).then((s) => s.isFile()), `Missing licence/version evidence: ${p}`);
}
for (const component of bom.components) {
  check(component.purl && component.version && component.licenses?.length, `SBOM component lacks identity or licence: ${component.name}`);
  check(component.licenses.every((x) => x.license?.id && spdxIds.has(x.license.id)), `SBOM has an unapproved licence field for ${component.name}`);
}
// Pinned third-party runtime files: build manifest, browser-side digests and licence inventory must agree,
// and no application source may load code from a CDN.
const pinned = JSON.parse(await read('scripts/pinned-assets.json'));
const browserPins = await import(new URL('../docs/assets/runtime/pinned-pyodide.mjs', import.meta.url));
const py = pinned.packages.pyodide;
check(py.version === browserPins.PYODIDE_VERSION && manifest.components.find(c => c.name === 'pyodide')?.version === py.version, 'Pyodide version differs between scripts/pinned-assets.json, pinned-pyodide.mjs and the licence manifest.');
for (const [file, digest] of Object.entries(py.extract.files)) check(browserPins.PYODIDE_FILES[file]?.sha256 === digest, `Browser-side digest for ${file} differs from scripts/pinned-assets.json.`);
check(Object.keys(browserPins.PYODIDE_FILES).length === Object.keys(py.extract.files).length, 'Browser-side Pyodide file list differs from the build manifest.');
check(pinned.packages.typescript.version === manifest.components.find(c => c.name === 'typescript')?.version, 'TypeScript lib version differs from the licence manifest.');
for (const [name, pkg] of Object.entries(pinned.packages)) check(/^sha512-[A-Za-z0-9+/=]{88}$/.test(pkg.integrity) && pkg.tarball.startsWith('https://registry.npmjs.org/'), `${name}: tarball must come from the npm registry with a sha512 integrity pin.`);
const { readdir } = await import('node:fs/promises');
const sources = [];
const walkSources = async dir => { for (const e of await readdir(resolve(root, dir), { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) { if (!['vendor', 'sandbox'].includes(e.name)) await walkSources(p); } else if (/\.(?:mjs|js|html)$/.test(e.name) && e.name !== 'acorn.mjs') sources.push(p); } };
await walkSources('docs');
for (const p of sources) check(!/https?:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)/.test(await read(p)), `${p} references a CDN; runtime code must be served from this site.`);
console.log(`Supply-chain audit passed: ${manifest.components.length} direct runtime components, SPDX metadata resolved, ${Object.keys(py.extract.files).length} Pyodide files pinned consistently (build + browser), no CDN references in ${sources.length} application files.`);
