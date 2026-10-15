import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = '.codeproof-vendor/typescript';
const expectedBytes = 9066411;
const expectedSha256 = 'dd17428736a07e1db1a138d8a14295ddb2699ba780ee15038acdd2c6da5373a0';
const names = (await readdir(directory)).filter(name => /^part-\d{3}\.txt$/.test(name)).sort();
if (names.length !== 26) throw new Error(`Expected 26 pinned TypeScript compiler parts; found ${names.length}`);
const pieces = await Promise.all(names.map(name => readFile(join(directory, name), 'utf8')));
const source = pieces.join('');
const bytes = Buffer.from(source, 'utf8');
if (bytes.length !== expectedBytes) throw new Error(`TypeScript source size mismatch: ${bytes.length}`);
const actual = createHash('sha256').update(bytes).digest('hex');
if (actual !== expectedSha256) throw new Error(`TypeScript source hash mismatch: ${actual}`);
for (const path of ['docs/vendor/typescript.js', 'docs/integrations/typescript.cjs']) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, bytes);
  console.log(`Restored ${path} (${bytes.length} bytes; SHA-256 ${actual})`);
}
// ES-module view of the same verified bytes for the analysis worker: the bundle declares `var ts`, so a
// fixed export suffix is enough and no eval/new Function is needed to load the compiler in the browser.
const esm = Buffer.concat([bytes, Buffer.from('\nexport default ts;\n', 'utf8')]);
await writeFile('docs/vendor/typescript.mjs', esm);
console.log(`Derived docs/vendor/typescript.mjs (verified source + "export default ts")`);
