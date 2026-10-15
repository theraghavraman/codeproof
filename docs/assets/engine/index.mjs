// Public engine API. Every module here is environment-neutral (browser main thread, workers, Node 22+).
export { scanProject, finalizeWithRuntime, clearAnalysisCache, FILE_ANALYZERS, SCAN_SCHEMA, ENGINE_VERSION } from './scan.mjs';
export { ingestEntries, ingestZip, ingestTextFiles, projectNameFrom, INGEST_DEFAULTS } from './ingest.mjs';
export { readZipDirectory, extractEntry, ZipError, inflateSupported } from './zip.mjs';
export { normalizePath } from './paths.mjs';
export { detectLanguage, classifyKind, languageLabel, SOURCE_LANGUAGES } from './detect.mjs';
export { makeFinding, FindingRegistry, filterFindings, summarizeFindings, VERIFICATION, SEVERITIES, SEVERITY_LABELS, CATEGORIES } from './findings.mjs';
export { analyzeJsFile, JS_RULES } from './js-rules.mjs';
export { analyzePythonFile, tokenizePython } from './python.mjs';
export { analyzeGenericFile } from './generic.mjs';
export { analyzeConfigFile, jsonError, satisfies } from './config.mjs';
export { runTypeScriptProgram, loadLibClosure, DEFAULT_LIBS } from './ts-program.mjs';
export { analyzeIntegration, checkPythonCall } from './graph.mjs';
export { computeCoverage } from './coverage.mjs';
export { capabilityMatrix, LANGUAGE_CAPABILITIES, CAPABILITY_LABELS } from './capabilities.mjs';
export { estimateProjectAuthorship, estimateFileAuthorship, AUTHORSHIP_CATEGORIES } from './authorship.mjs';
export { generateCases, inferType } from './testgen.mjs';
export { planRuntime, interpretRuntime, RUNTIME_LIMITS } from './runtime-plan.mjs';
export { buildReport, reportMarkdown, reportSarif } from './report.mjs';
