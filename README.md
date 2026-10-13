# CodeProof — Browser-First Code Verification Lab

[![Verification and supply-chain audit](https://github.com/theraghavraman/codeproof/actions/workflows/checks.yml/badge.svg)](https://github.com/theraghavraman/codeproof/actions/workflows/checks.yml) [![Deploy to GitHub Pages](https://github.com/theraghavraman/codeproof/actions/workflows/pages.yml/badge.svg)](https://github.com/theraghavraman/codeproof/actions/workflows/pages.yml)

CodeProof is a static, local-first code inspection and verification workbench designed for GitHub Pages. It requires no npm install, backend, account system, secrets, or hosted database. JavaScript and TypeScript assets are reconstructed from the tracked, verified compiler parts during CI. Python grammar validation and experimental Python execution download the pinned Pyodide runtime on demand.

**Application entry point:** [docs/index.html](docs/index.html)  
**Deployment instructions:** [DEPLOYMENT.md](DEPLOYMENT.md)  
**Security boundaries:** [SECURITY.md](SECURITY.md)  
**Third-party notices:** [docs/NOTICE.md](docs/NOTICE.md)

## Verify locally

Use Node.js 22 or newer:

```bash
node scripts/restore-vendor.mjs
node --test tests/*.test.mjs
node docs/integrations/cli.mjs
node scripts/generate-sbom.mjs --check
node scripts/audit-supply-chain.mjs
python3 -m http.server 8000 --directory docs
```

Then visit `http://localhost:8000`. The unit/contract tests use Node's built-in test runner; no package install is required. Python's first full grammar check or execution needs a network connection to the pinned Pyodide release.

## What it does

- Parse JavaScript and TypeScript and run heuristic security/quality checks.
- Inspect Python source preliminarily and optionally run full grammar validation via a pinned Pyodide AST parser.
- Execute supported self-contained JavaScript/TypeScript functions in a sandboxed browser frame, with documented limits.
- Run user-defined expected-value and boundary checks; export evidence as JSON or Markdown.
- Generate project-level reports and map source imports; this is not a CVE or lockfile scanner.
- Download a portable Team & CI kit for repository-owned, static-only pull-request audits.
- Import bounded source ZIPs locally in the browser. Several other languages are inventory/static-only and do not have a native compiler or runner.

AI-authorship assessment intentionally reports **inconclusive** rather than inventing a percentage. Clean static checks are not proof that software is secure.

## Publish on GitHub Pages

The Pages workflow reconstructs the pinned TypeScript compiler, runs tests and supply-chain checks, and publishes `docs/`. In repository settings, choose **Settings → Pages → Build and deployment → Source → GitHub Actions**. The deployment URL appears in the workflow summary.

## Supply-chain and release records

- [LICENSE](LICENSE) provides the project's MIT licence.
- [CITATION.cff](CITATION.cff) records citation metadata for this software version.
- [licenses-resolved.json](licenses-resolved.json) records runtime licence resolutions.
- [sbom.cdx.json](sbom.cdx.json) is a CycloneDX 1.6 SBOM with pinned versions and SHA-256 hashes for bundled dependencies.
- `.github/workflows/checks.yml` tests code and checks that the SBOM/licence inventory remains consistent.
- `.github/workflows/release.yml` runs only on a `v*` tag, re-tests the tagged source, creates checksummed release assets, and attests source provenance.

A DOI is **not** asserted in this repository yet. After enabling the repository in Zenodo, publish a tagged GitHub release; Zenodo can archive that release and assign a DOI. Add a DOI to metadata only after Zenodo reports the actual identifier.

## Important limitations

- Browser sandboxing is not a hardened OS sandbox and does not impose a guaranteed memory quota.
- Python execution is experimental. It downloads Pyodide from jsDelivr and must not be treated as safe for genuinely hostile code containing secrets.
- Static rules can generate false positives and miss vulnerabilities; no full taint analysis, live CVE database, compiler-backed checks for all languages, mutation testing, or native execution service is included.
- The SBOM covers the application's direct runtime components. It does not claim a full transitive inventory of every package delivered inside the remote Pyodide distribution.

## License

Project code is licensed under the [MIT License](LICENSE). Third-party assets remain subject to their own notices; see [docs/NOTICE.md](docs/NOTICE.md) and `docs/vendor/`.
