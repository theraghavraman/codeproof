// Writes docs/sandbox/run.html with the SHA-256 of its static bootstrap pinned in the page CSP.
// Usage: node scripts/build-sandbox-page.mjs [--check]
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { BOOTSTRAP_SOURCE, makeSandboxHtml } from '../docs/assets/sandbox.mjs';

const hash = createHash('sha256').update(BOOTSTRAP_SOURCE, 'utf8').digest('base64');
const html = makeSandboxHtml('javascript', '', hash);
const target = 'docs/sandbox/run.html';
if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8').catch(() => '');
  if (current !== html) { console.error(`${target} is out of date; run node scripts/build-sandbox-page.mjs`); process.exit(1); }
  console.log(`${target} is current (bootstrap sha256-${hash}).`);
} else {
  await mkdir('docs/sandbox', { recursive: true });
  await writeFile(target, html);
  console.log(`Wrote ${target} (bootstrap sha256-${hash}).`);
}
