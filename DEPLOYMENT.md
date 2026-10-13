# Deploy CodeProof on GitHub Pages

The published site is the `docs/` folder. The workflow reconstructs the exact vendored TypeScript compiler from tracked, checksummed chunks before testing or publishing.

1. Push the repository to the `main` branch.
2. In **Settings → Pages**, set **Source → GitHub Actions**.
3. In **Actions**, watch "Deploy CodeProof to GitHub Pages". The workflow runs unit tests and supply-chain checks before publishing.
4. Open the deployment URL reported by the workflow.

Typical URL: `https://YOUR-USERNAME.github.io/YOUR-REPO/`

No npm, frontend framework build, database or server environment variables are required. Locally, use Node.js 22+:

```bash
node scripts/restore-vendor.mjs
node --test tests/*.test.mjs
node docs/integrations/cli.mjs
node scripts/generate-sbom.mjs --check
node scripts/audit-supply-chain.mjs
python3 -m http.server 8000 --directory docs
```

The browser environment is local-first. Initial Python syntax checking or Python execution downloads Pyodide over HTTPS from a pinned CDN release; JS/TS inspection and JS execution use local assets. For genuinely hostile code, do **not** rely on browser iframe isolation as a hardened OS sandbox. For team integration, use Team & CI to download a portable workflow kit.

AI authorship intentionally returns inconclusive, not a fabricated probabilistic attribution.

## Supply-chain checks

Before a tagged release, run the commands above. The `v*` release workflow creates a source archive, licence/SBOM attachments, SHA-256 checksums, and a GitHub build-provenance attestation. A DOI is available only after a release is actually archived by Zenodo.
