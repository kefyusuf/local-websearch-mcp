# Verified Security Findings

## 1. Server-Side Request Forgery (SSRF) in `fetch_content`
- **Severity:** High
- **Location:** `src/index.ts` (L233)
- **Description:** The `fetch_content` tool takes a URL as input and navigates to it using Playwright without any validation. This allows an attacker (or a malicious prompt) to make the MCP server request internal resources (e.g., `http://localhost`, `http://192.168.1.1`).
- **Confidence:** High
- **CWE:** CWE-918

## 2. Critical Dependency Vulnerabilities
- **Severity:** Critical
- **Location:** `package.json`
- **Findings:**
    - `protobufjs < 7.5.5`: Arbitrary code execution (RCE).
    - `@mozilla/readability < 0.6.0`: Denial of Service (DoS).
- **Confidence:** High
- **CWE:** CWE-94, CWE-400

## 3. Lack of Rate Limiting
- **Severity:** Low
- **Description:** There is no rate limiting on arama or fetch operations. While primarily a local tool, automation could lead to unintended resource consumption or IP bans from search engines.
- **Confidence:** High
- **CWE:** CWE-770
