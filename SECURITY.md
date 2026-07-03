# Security Policy

## Supported Versions

Security fixes are handled on the default branch until the project publishes versioned release branches.

## Reporting a Vulnerability

Please report vulnerabilities through GitHub Issues if the report does not contain sensitive exploit details. If the report includes sensitive details, contact the maintainer privately before publishing a proof of concept.

Do not include secrets, private tokens, or credentials in reports.

## Current Security Notes

The server includes SSRF protection for `fetch_content`, rate limiting for public MCP tools, and no requirement for external API keys.

As of the latest local release-readiness pass, `npm audit --audit-level=moderate` reports 0 vulnerabilities.

The project uses an npm `overrides` entry to pin transitive `protobufjs` to `8.6.5` because `@xenova/transformers -> onnxruntime-web -> onnx-proto` otherwise resolves an older vulnerable `protobufjs` release. Keep this override until the upstream dependency chain resolves to a non-vulnerable version without local intervention.
