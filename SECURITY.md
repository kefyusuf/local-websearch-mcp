# Security Policy

## Supported Versions

Security fixes are handled on the default branch until the project publishes versioned release branches.

## Reporting a Vulnerability

Please report vulnerabilities through GitHub Issues if the report does not contain sensitive exploit details. If the report includes sensitive details, contact the maintainer privately before publishing a proof of concept.

Do not include secrets, private tokens, or credentials in reports.

## Current Security Notes

The server includes SSRF protection for `fetch_content`, rate limiting for public MCP tools, and no requirement for external API keys.

Dependency security is enforced in CI with `npm audit --audit-level=moderate`; moderate-or-higher findings fail the CI job.

The project uses the maintained `@huggingface/transformers` package for local model pipelines. Two temporary npm overrides keep transitive native/archive dependencies on patched releases:

- `sharp` is pinned to `0.35.3` because the current Transformers.js dependency range still resolves a vulnerable `<0.35.0` release.
- `adm-zip` is pinned to `0.6.0` because current `onnxruntime-node` releases still request the vulnerable `^0.5.x` line.

Remove these overrides when the corresponding upstream dependency ranges include patched versions and the blocking audit remains clean without local intervention.
