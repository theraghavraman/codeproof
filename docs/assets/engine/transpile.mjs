// Prepares JavaScript/TypeScript modules for the sandbox: ES modules and TypeScript are transpiled to
// CommonJS by the real TypeScript compiler, and a line map (from the emitted source map) lets runtime
// stack traces point back at original source lines.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = Object.fromEntries([...B64].map((c, i) => [c, i]));

export function decodeLineMap(mappings) {
  const lines = mappings.split(';');
  const out = new Array(lines.length + 1).fill(0);
  let srcLine = 0;
  for (let g = 0; g < lines.length; g++) {
    let first = null;
    for (const segment of lines[g].split(',')) {
      if (!segment) continue;
      const values = [];
      let value = 0, shift = 0;
      for (const ch of segment) {
        const digit = B64_INDEX[ch];
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else { values.push(value & 1 ? -(value >> 1) : value >> 1); value = 0; shift = 0; }
      }
      if (values.length >= 4) { srcLine += values[2]; if (first === null) first = srcLine; }
    }
    out[g + 1] = first === null ? 0 : first + 1;
  }
  // Carry forward so lines without a mapping inherit the previous original line.
  for (let i = 1; i < out.length; i++) if (!out[i]) out[i] = out[i - 1];
  return out;
}

export function transpileForRuntime(ts, files, { maxBytes = 2_000_000 } = {}) {
  const modules = {}, errors = [];
  let total = 0;
  for (const f of files) {
    if (total > maxBytes) { errors.push({ path: f.path, message: 'Runtime module budget exceeded.' }); continue; }
    if (f.language === 'json' || f.path.endsWith('.json')) { modules[f.path] = { kind: 'json', code: f.content }; total += f.content.length; continue; }
    if (!(f.language === 'javascript' || f.language === 'typescript') || f.path.endsWith('.d.ts') || f.kind === 'generated') continue;
    try {
      const isPlainCjs = f.language === 'javascript' && !/^\s*(?:import|export)\b/m.test(f.content) && !/\bimport\s*\(/.test(f.content) && !/<[A-Za-z]/.test(f.content);
      if (isPlainCjs) { modules[f.path] = { kind: 'js', code: f.content, lineMap: null }; total += f.content.length; continue; }
      const out = ts.transpileModule(f.content, { fileName: f.path, reportDiagnostics: false, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, esModuleInterop: true, sourceMap: true, inlineSources: false, allowJs: true, isolatedModules: true } });
      const map = out.sourceMapText ? JSON.parse(out.sourceMapText) : null;
      modules[f.path] = { kind: 'js', code: out.outputText.replace(/\/\/# sourceMappingURL=.*$/m, ''), lineMap: map ? decodeLineMap(map.mappings) : null };
      total += out.outputText.length;
    } catch (error) { errors.push({ path: f.path, message: String(error?.message || error) }); }
  }
  return { modules, errors };
}
