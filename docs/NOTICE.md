# Third-party notices

CodeProof includes the following runtime components. Their source and versions are pinned; bundled copies are checked by the supply-chain audit.

## TypeScript compiler 5.8.3
- Source: https://github.com/microsoft/TypeScript
- Licence: Apache-2.0
- Runtime assets: `docs/vendor/typescript.js`, `docs/integrations/typescript.cjs`
- The reconstructed copy is checked against a SHA-256 digest in `scripts/restore-vendor.mjs`.
- Licence: [docs/vendor/LICENSE.typescript.txt](vendor/LICENSE.typescript.txt)

## Acorn 8.15.0
- Source: https://github.com/acornjs/acorn
- Licence: MIT
- Runtime asset: `docs/assets/acorn.mjs`, also vendored for the portable CI kit.
- Licence: [docs/vendor/LICENSE.acorn.txt](vendor/LICENSE.acorn.txt)

## JSZip 3.10.1
- Source: https://github.com/Stuk/jszip
- Licence: MIT
- Runtime asset: `docs/vendor/jszip.min.js`
- Licence: [docs/vendor/LICENSE.jszip.txt](vendor/LICENSE.jszip.txt)

## Pyodide 0.28.3 (loaded on demand)
- Source: https://github.com/pyodide/pyodide
- Loaded from: https://cdn.jsdelivr.net/pyodide/v0.28.3/full/
- Licence and component notices are provided by the upstream distribution. The full remote runtime is not embedded in this source SBOM.

Project code is MIT-licensed; see [LICENSE](../LICENSE).
