// Language, file-role and encoding detection. Extensions are a hint, not an authority:
// shebangs, magic numbers, manifests and content are consulted where they matter.
import { basename, extname } from './paths.mjs';

export const LANGUAGE_DEFS = [
  { id: 'javascript', label: 'JavaScript', ext: ['js', 'mjs', 'cjs', 'jsx'] },
  { id: 'typescript', label: 'TypeScript', ext: ['ts', 'mts', 'cts', 'tsx'] },
  { id: 'python', label: 'Python', ext: ['py', 'pyw', 'pyi'] },
  { id: 'go', label: 'Go', ext: ['go'] },
  { id: 'rust', label: 'Rust', ext: ['rs'] },
  { id: 'java', label: 'Java', ext: ['java'] },
  { id: 'kotlin', label: 'Kotlin', ext: ['kt', 'kts'] },
  { id: 'swift', label: 'Swift', ext: ['swift'] },
  { id: 'c', label: 'C', ext: ['c', 'h'] },
  { id: 'cpp', label: 'C++', ext: ['cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'ino'] },
  { id: 'csharp', label: 'C#', ext: ['cs'] },
  { id: 'php', label: 'PHP', ext: ['php'] },
  { id: 'ruby', label: 'Ruby', ext: ['rb'] },
  { id: 'shell', label: 'Shell', ext: ['sh', 'bash', 'zsh'] },
  { id: 'sql', label: 'SQL', ext: ['sql'] },
  { id: 'json', label: 'JSON', ext: ['json', 'jsonc'] },
  { id: 'html', label: 'HTML', ext: ['html', 'htm'] },
  { id: 'css', label: 'CSS', ext: ['css'] },
  { id: 'scss', label: 'Sass/Less', ext: ['scss', 'sass', 'less'] },
  { id: 'vue', label: 'Vue SFC', ext: ['vue'] },
  { id: 'svelte', label: 'Svelte', ext: ['svelte'] },
  { id: 'markdown', label: 'Markdown', ext: ['md', 'markdown', 'mdx'] },
  { id: 'yaml', label: 'YAML', ext: ['yml', 'yaml'] },
  { id: 'toml', label: 'TOML', ext: ['toml'] },
  { id: 'xml', label: 'XML', ext: ['xml', 'plist', 'csproj', 'xaml'] },
  { id: 'ini', label: 'INI/properties', ext: ['ini', 'cfg', 'conf', 'properties', 'editorconfig'] },
  { id: 'text', label: 'Plain text', ext: ['txt', 'rst', 'csv', 'tsv', 'log'] },
];
const BY_EXT = new Map(LANGUAGE_DEFS.flatMap(def => def.ext.map(e => [e, def.id])));
const BY_NAME = new Map([
  ['dockerfile', 'dockerfile'], ['containerfile', 'dockerfile'], ['makefile', 'makefile'], ['gnumakefile', 'makefile'],
  ['gemfile', 'ruby'], ['rakefile', 'ruby'], ['pipfile', 'toml'], ['procfile', 'text'], ['license', 'text'], ['licence', 'text'],
  ['.gitignore', 'text'], ['.npmignore', 'text'], ['.dockerignore', 'text'], ['.nvmrc', 'text'], ['.python-version', 'text'],
  ['.babelrc', 'json'], ['.eslintrc', 'json'], ['.prettierrc', 'json'], ['.swcrc', 'json'],
]);
export const SOURCE_LANGUAGES = new Set(['javascript', 'typescript', 'python', 'go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'php', 'ruby', 'shell', 'sql', 'vue', 'svelte']);
export const languageLabel = id => LANGUAGE_DEFS.find(d => d.id === id)?.label || (id === 'dockerfile' ? 'Dockerfile' : id === 'makefile' ? 'Makefile' : id || 'Unknown');

const BINARY_EXT = new Set('png jpg jpeg gif webp bmp ico icns tif tiff psd avif heic pdf zip gz tgz bz2 xz 7z rar jar war ear class so dylib dll exe bin o a lib obj wasm woff woff2 ttf otf eot mp3 mp4 m4a mov avi webm ogg wav flac pyc pyo pyd db sqlite sqlite3 lockb pkl pickle npy npz h5 onnx pt pth ckpt parquet feather docx xlsx pptx odt key numbers pages dmg iso apk ipa'.split(' '));
const ARCHIVE_EXT = new Set(['zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war', 'ear']);

const MANIFESTS = new Set(['package.json', 'requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'setup.cfg', 'pipfile', 'go.mod', 'cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'gemfile', 'deno.json', 'deno.jsonc', 'environment.yml']);
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'poetry.lock', 'pipfile.lock', 'uv.lock', 'cargo.lock', 'go.sum', 'composer.lock', 'gemfile.lock']);
const CONFIG_NAME = /^(?:tsconfig.*\.json|jsconfig.*\.json|\.eslintrc.*|eslint\.config\.[cm]?[jt]s|\.prettierrc.*|prettier\.config\.[cm]?js|babel\.config\.[cm]?[jt]s(?:on)?|\.babelrc.*|(?:vite|vitest|webpack|rollup|jest|playwright|cypress|next|nuxt|svelte|astro|tailwind|postcss|karma|esbuild)\.config\.[cm]?[jt]s|\.editorconfig|\.gitignore|\.npmrc|\.nvmrc|dockerfile|containerfile|docker-compose\.ya?ml|compose\.ya?ml|makefile|tox\.ini|pytest\.ini|setup\.cfg|mypy\.ini|\.flake8|ruff\.toml|\.pre-commit-config\.yaml|netlify\.toml|vercel\.json|firebase\.json|app\.json|manifest\.json|turbo\.json|nx\.json|lerna\.json|renovate\.json|\.codeproof-policy\.json)$/i;
const ENV_NAME = /^\.env(?:\..+)?$/i;
const DOC_NAME = /^(?:readme|changelog|contributing|license|licence|notice|authors|security|code_of_conduct)(?:\..*)?$/i;
const TEST_PATH = /(?:^|\/)(?:__tests__|__mocks__|tests?|specs?)\/|(?:^|\/)[^/]*[._-](?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|(?:^|\/)[^/]*_test\.(?:py|go)$|(?:^|\/)conftest\.py$/i;
const GENERATED_PATH = /(?:^|\/)(?:vendor|third_party|node_modules|bower_components|dist|build|out|\.next|\.nuxt|coverage|__pycache__|site-packages)\/|\.min\.(?:js|css)$|\.bundle\.js$|(?:^|\/)[^/]*\.(?:map|snap)$/i;

export function detectLanguage(path, text = null) {
  const base = basename(path).toLowerCase();
  const ext = extname(path);
  if (base.endsWith('.d.ts') || base.endsWith('.d.mts') || base.endsWith('.d.cts')) return 'typescript';
  if (BY_NAME.has(base)) return BY_NAME.get(base);
  if (ENV_NAME.test(base)) return 'env';
  if (ext && BY_EXT.has(ext)) return BY_EXT.get(ext);
  if (text && !ext) {
    const first = text.slice(0, 200).split('\n')[0];
    if (/^#!.*\b(?:node|deno|bun)\b/.test(first)) return 'javascript';
    if (/^#!.*\bpython[0-9.]*\b/.test(first)) return 'python';
    if (/^#!.*\b(?:ba|z|k|da)?sh\b/.test(first)) return 'shell';
    if (/^#!.*\bruby\b/.test(first)) return 'ruby';
  }
  return null;
}

export function magicType(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const b = bytes;
  const sig = (...xs) => xs.every((x, i) => b[i] === x);
  if (sig(0x89, 0x50, 0x4e, 0x47)) return 'PNG image';
  if (sig(0xff, 0xd8, 0xff)) return 'JPEG image';
  if (sig(0x47, 0x49, 0x46, 0x38)) return 'GIF image';
  if (sig(0x25, 0x50, 0x44, 0x46)) return 'PDF document';
  if (sig(0x50, 0x4b, 0x03, 0x04) || sig(0x50, 0x4b, 0x05, 0x06)) return 'ZIP archive';
  if (sig(0x1f, 0x8b)) return 'gzip archive';
  if (sig(0x00, 0x61, 0x73, 0x6d)) return 'WebAssembly module';
  if (sig(0x7f, 0x45, 0x4c, 0x46)) return 'ELF executable';
  if (sig(0xcf, 0xfa, 0xed, 0xfe) || sig(0xfe, 0xed, 0xfa, 0xcf) || sig(0xca, 0xfe, 0xba, 0xbe)) return 'Mach-O/Java class binary';
  if (sig(0x4d, 0x5a)) return 'Windows PE executable';
  if (sig(0x53, 0x51, 0x4c, 0x69)) return 'SQLite database';
  return null;
}

export function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8192);
  if (!n) return false;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return false; // UTF-16 BOM
  let control = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 0) return true;
    if (c < 7 || (c > 13 && c < 32 && c !== 27)) control++;
  }
  return control / n > 0.1;
}

// Decodes bytes to text. Invalid UTF-8 falls back to Windows-1252 and is reported, never silently replaced.
export function decodeText(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3)), encoding: 'utf-8-bom', valid: true }; } catch { /* fall through */ }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', valid: true };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', valid: true };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', valid: true }; }
  catch {
    let text;
    try { text = new TextDecoder('windows-1252').decode(bytes); } catch { text = new TextDecoder('utf-8').decode(bytes); }
    return { text, encoding: 'windows-1252 (fallback)', valid: false };
  }
}

export function classifyKind(path, language) {
  const base = basename(path).toLowerCase();
  const ext = extname(path);
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if (BINARY_EXT.has(ext)) return 'binary';
  if (ext === 'svg') return 'asset';
  if (LOCKFILES.has(base)) return 'lockfile';
  if (MANIFESTS.has(base) || /^requirements[\w.-]*\.txt$/.test(base)) return 'manifest';
  if (language === 'env') return 'env';
  if (GENERATED_PATH.test(path)) return 'generated';
  if (CONFIG_NAME.test(base) || /(?:^|\/)\.github\/workflows\//.test(path)) return 'config';
  if (TEST_PATH.test(path) && SOURCE_LANGUAGES.has(language)) return 'test';
  if (SOURCE_LANGUAGES.has(language)) return 'source';
  if (DOC_NAME.test(base) || language === 'markdown') return 'docs';
  if (['json', 'yaml', 'toml', 'xml', 'ini'].includes(language)) return 'config';
  if (['html', 'css', 'scss'].includes(language)) return 'web';
  if (language === 'dockerfile' || language === 'makefile') return 'config';
  if (language === 'text') return 'docs';
  return 'other';
}

export const isBinaryExtension = path => BINARY_EXT.has(extname(path)) && extname(path) !== 'svg';
export const isArchiveExtension = path => ARCHIVE_EXT.has(extname(path));

// Heuristic for minified or machine-generated code that should not be judged as hand-written source.
export function looksMinified(text) {
  if (text.length < 3000) return false;
  const lines = text.split('\n');
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  if (lines.length <= 3) return longest > 3000;
  return longest > 10000 && text.length / lines.length > 400;
}

export const isTestPath = path => TEST_PATH.test(path);
