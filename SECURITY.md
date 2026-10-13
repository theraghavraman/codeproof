# Security Policy

## Supported versions

Security fixes are targeted at the latest version on the default branch and the latest published release.

## Reporting a vulnerability

Please do not report exploitable vulnerabilities in a public issue. Use GitHub's **Report a vulnerability** flow on this repository when it is enabled. If private vulnerability reporting is unavailable, open a minimal issue asking for a private contact channel without publishing exploit details.

Include the affected version or commit, reproduction steps, impact, and any suggested mitigation. Do not include real secrets or third-party personal data.

## Safe-use boundaries

CodeProof is intended to be a browser-first static analysis and convenience testing tool, not a hardened hostile-code execution service. Browser sandboxing does not guarantee protection against browser vulnerabilities or resource-exhaustion attacks. Do not run genuinely hostile code containing secrets. For adversarial workloads, use a separately isolated microVM or container runner.
