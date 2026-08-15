# Security policy

## Supported versions

Security fixes are provided for the latest published `1.0.x` release. Update to the newest release before reporting an issue that may already be resolved.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting form](https://github.com/CedricS789/notability-live-region/security/advisories/new). Include:

- the affected plugin and Obsidian versions;
- the operating system;
- a minimal reproduction;
- the security impact;
- any suggested mitigation.

Do not include private Notability URLs, credentials, note contents, or cache images unless they are necessary and safe to disclose privately. Do not open a public issue for an unpatched exploitable vulnerability.

You should receive an initial acknowledgement within seven days. Confirmed reports will be coordinated privately until a fixed release is available.

## Scope

The plugin embeds Notability's web application and stores preview images locally. Reports involving unsafe URL handling, cross-note data exposure, unintended vault writes, cache path escape, or insertion into the wrong Markdown target are in scope. Issues entirely within Notability's hosted service should be reported to Notability.
