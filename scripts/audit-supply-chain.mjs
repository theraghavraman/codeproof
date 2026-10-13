import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (p) => readFile(resolve(root, p), 'utf8');
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const manifest = JSON.parse(await read('licenses-resolved.json'));
const bom = JSON.parse(await read('sbom.cdx.json'));
const spdxIds = new Set(['MIT', 'Apache-2.0', 'MPL-2.0']);
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
const app = await read('docs/assets/sandbox.mjs');
check(/pyodide\/v0\.28\.3\/full\//.test(app), 'Pyodide is not pinned to the version reviewed in the licence manifest.');
console.log(`Supply-chain audit passed: ${manifest.components.length} direct runtime components, SPDX metadata resolved, pinned Pyodide CDN dependency verified.`);
