# Security Policy

## Supported versions

Security fixes are targeted at the latest version on the default branch and the latest published release.

## Reporting a vulnerability

Please do not report exploitable vulnerabilities in a public issue. Use GitHub's **Report a vulnerability** flow on this repository when it is enabled. If private vulnerability reporting is unavailable, open a minimal issue asking for a private contact channel without publishing exploit details.

Please include the affected version/commit, reproduction steps, impact, and any suggested mitigation. Do not include real secrets or third-party personal data.

## Safe-use boundaries

CodeProof is a browser-first static analysis and convenience testing tool, **not a hardened hostile-code execution service**. JavaScript runs in a browser sandbox; Python runtime mode downloads the pinned Pyodide build from jsDelivr and is experimental. Do not submit adversarial code containing secrets, and do not treat a clean report as proof that code is secure. For hostile workloads, use a separately isolated microVM/container runner.
