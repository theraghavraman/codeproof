// Per-language capability matrix. Levels describe what actually runs in the browser build:
// 'compiler' (real compiler/interpreter), 'parser' (real grammar parser), 'heuristic' (scanner or pattern
// rules), 'conditional' (needs an optional runtime the user enables) and 'unavailable'.
export const CAPABILITY_KINDS = ['syntax', 'lint', 'types', 'dependencies', 'tests', 'runtime'];
export const CAPABILITY_LABELS = { syntax: 'Syntax parsing', lint: 'Static rules', types: 'Type checking', dependencies: 'Dependency analysis', tests: 'Test execution', runtime: 'Runtime execution' };

const NATIVE = note => ({
  syntax: { level: 'heuristic', detail: 'Comment/string-aware delimiter scanner; not a compiler.' },
  lint: { level: 'heuristic', detail: 'Token-pattern security and quality rules.' },
  types: { level: 'unavailable', detail: 'No compiler for this language runs in the browser.' },
  dependencies: { level: 'heuristic', detail: 'Import/include extraction; local headers and packages are not built.' },
  tests: { level: 'unavailable', detail: `Tests cannot run without a native toolchain${note ? ` (${note})` : ''}.` },
  runtime: { level: 'unavailable', detail: 'No in-browser runtime is bundled.' },
});

export const LANGUAGE_CAPABILITIES = {
  javascript: {
    syntax: { level: 'parser', detail: 'Acorn 8.15 (ECMAScript latest, module and script goals); JSX via the TypeScript parser.' },
    lint: { level: 'parser', detail: 'AST rules for logic, security and quality.' },
    types: { level: 'compiler', detail: 'TypeScript 5.8 checkJs over the whole project; only high-signal diagnostics are reported for JavaScript.' },
    dependencies: { level: 'parser', detail: 'Module resolution, export contracts, manifests, lockfile and cycle checks.' },
    tests: { level: 'compiler', detail: 'Jest/Vitest/Mocha-style and node:test suites in the CodeProof sandbox harness; local modules only.' },
    runtime: { level: 'compiler', detail: 'Sandboxed worker in an opaque-origin iframe; no Node.js APIs, DOM or network.' },
  },
  typescript: {
    syntax: { level: 'compiler', detail: 'TypeScript 5.8 parser.' },
    lint: { level: 'parser', detail: 'AST rules (shared with JavaScript).' },
    types: { level: 'compiler', detail: 'TypeScript 5.8 type checker with the project tsconfig.json when present.' },
    dependencies: { level: 'compiler', detail: 'Compiler module resolution plus CodeProof graph checks.' },
    tests: { level: 'compiler', detail: 'Transpiled by TypeScript, then run in the sandbox harness; local modules only.' },
    runtime: { level: 'compiler', detail: 'Transpiled to JavaScript and executed in the sandbox.' },
  },
  python: {
    syntax: { level: 'conditional', detail: 'Tokenizer checks always; CPython 3.13 compile() for every file when the Pyodide runtime is enabled.' },
    lint: { level: 'heuristic', detail: 'Token-based logic and security rules.' },
    types: { level: 'unavailable', detail: 'No type checker (mypy/pyright) is bundled.' },
    dependencies: { level: 'heuristic', detail: 'Import resolution, cross-module name and call-signature checks, requirements/pyproject comparison.' },
    tests: { level: 'conditional', detail: 'unittest and a minimal pytest-compatible collector in Pyodide; standard library only, no plugins.' },
    runtime: { level: 'conditional', detail: 'Pyodide 0.28.3 (CPython 3.13) in the sandbox; third-party packages and native extensions unavailable.' },
  },
  json: {
    syntax: { level: 'parser', detail: 'Strict JSON validator (JSONC tolerated for tsconfig and editor files).' },
    lint: { level: 'parser', detail: 'package.json shape and dependency rules.' },
    types: { level: 'unavailable', detail: 'No JSON Schema validation.' },
    dependencies: { level: 'parser', detail: 'package.json and package-lock.json consistency.' },
    tests: { level: 'unavailable', detail: 'Not applicable.' },
    runtime: { level: 'unavailable', detail: 'Not applicable.' },
  },
  html: { syntax: { level: 'unavailable', detail: 'No HTML validator.' }, lint: { level: 'heuristic', detail: 'Local script, stylesheet and asset reference checks.' }, types: { level: 'unavailable', detail: '' }, dependencies: { level: 'heuristic', detail: 'Script tags become dependency-graph edges.' }, tests: { level: 'unavailable', detail: '' }, runtime: { level: 'unavailable', detail: 'Pages are not rendered.' } },
  css: { syntax: { level: 'unavailable', detail: 'No CSS parser.' }, lint: { level: 'heuristic', detail: 'url() and @import reference checks.' }, types: { level: 'unavailable', detail: '' }, dependencies: { level: 'heuristic', detail: 'Asset references.' }, tests: { level: 'unavailable', detail: '' }, runtime: { level: 'unavailable', detail: '' } },
  go: NATIVE('go test'), rust: NATIVE('cargo test'), java: NATIVE('JUnit'), kotlin: NATIVE(), swift: NATIVE(), c: NATIVE(), cpp: NATIVE(), csharp: NATIVE('dotnet test'), php: NATIVE('PHPUnit'), ruby: NATIVE('RSpec/minitest'), shell: NATIVE(), sql: { ...NATIVE(), lint: { level: 'heuristic', detail: 'CREATE TABLE statements feed query/schema consistency checks.' } },
};

export function capabilityFor(language) {
  return LANGUAGE_CAPABILITIES[language] || null;
}

export function capabilityMatrix(languages) {
  return languages.map(language => ({ language, capabilities: capabilityFor(language) || Object.fromEntries(CAPABILITY_KINDS.map(k => [k, { level: 'unavailable', detail: 'Inventory only.' }])) }));
}
