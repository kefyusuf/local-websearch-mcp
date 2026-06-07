---
phase: 00
fixed_at: 2026-06-05T12:00:00Z
review_path: E:\projects\my-websearch-mcp\REVIEW.md
iteration: 1
findings_in_scope: 8
fixed: 8
skipped: 0
status: all_fixed
---

# Phase 00: Code Review Fix Report

**Fixed at:** 2026-06-05T12:00:00Z
**Source review:** E:\projects\my-websearch-mcp\REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 8
- Fixed: 8
- Skipped: 0

## Fixed Issues

### CR-01: SSRF Protection Regex Is Trivially Bypassable

**Files modified:** `src/index.ts`
**Commit:** 53f4f32
**Applied fix:** Replaced the single-regex SSRF check with a proper DNS resolution approach. Added `isPrivateHost()` method that resolves hostnames via `dns.promises.resolve4`/`resolve6` and checks each resolved IP against full RFC 1918 private ranges, IPv6 loopback/link-local/ULA (RFC 4193), CGNAT (100.64.0.0/10), link-local (169.254.0.0/16), and the full 127.0.0.0/8 loopback range. Also handles IPv4-mapped IPv6 (`::ffff:x.x.x.x`), decimal/hex/octal IP obfuscation via DNS resolution. Added imports `import { promises as dns } from "dns"` and `import { isIP } from "net"`.

### WR-01: SQLite Database Connection Never Closed

**Files modified:** `src/index.ts`, `src/cache/types.ts`, `src/cache/vector-store.ts`, `src/cache/semantic-cache.ts`
**Commit:** 977f273
**Applied fix:** Added `close()` method to `IVectorStore` interface in `types.ts`. Added `close()` to `InMemoryVectorStore` in `vector-store.ts` (no-op). Added `close()` method to `SemanticCache` that delegates to `vectorStore.close()`. Wired `this.cache.close()` into the shutdown handler in `index.ts`.

### WR-02: No Error Recovery for Transformer.js Model Download Failures

**Files modified:** `src/cache/crosslingual.ts`, `src/cache/embedding.ts`, `src/cache/intent.ts`
**Commit:** 95b7d84
**Applied fix:** Added circuit-breaker pattern to all model-loading code paths. Each loader now has a `*Failed` boolean flag. On first failure, the flag is set to `true` and subsequent calls fail fast (return fallback values) instead of retrying the download. Applied to translation model and language detector in `crosslingual.ts`, embedding extractor in `embedding.ts`, and intent classifier in `intent.ts`.

### WR-03: Env Var Misconfiguration Causes Infinite DoS in Rate Limiter

**Files modified:** `src/rate-limiter.ts`
**Commit:** b2e6c8f
**Applied fix:** Extracted shared `parseRateLimit()` helper that validates the env var. If the value is `NaN` or `<= 0`, creates a token bucket with `Number.MAX_SAFE_INTEGER` for both `maxTokens` and `refillRatePerSecond` (effectively unlimited). Prevents the infinite-DoS scenario where `maxTokens=0` causes `tryConsume()` to always return `{ allowed: false, retryAfterMs: Infinity }`.

### WR-04: process.exit(0) in Shutdown Handlers Skips Cleanup

**Files modified:** `src/index.ts` (included in WR-01 commit)
**Commit:** 977f273
**Applied fix:** Removed `process.exit(0)` from the shutdown handler — the process now exits naturally when the event loop drains. Added `process.on("SIGHUP", shutdown)` for daemon reload signals. This fix was applied together with WR-01 since both target the same shutdown handler function.

### WR-05: Browser Instance Lifetime Not Managed on Launch Failure

**Files modified:** `src/index.ts`
**Commit:** d9d423e
**Applied fix:** Wrapped both `context.close()` calls (in `performSearch` and `handleFetchContent` finally blocks) with secondary try/catch. If `context.close()` itself throws, the error is logged but does not propagate, preventing resource leaks from partial closures.

### WR-06: Promiscuous `any` Types Mask Type Errors

**Files modified:** `src/cache/types.ts`, `src/cache/sqlite-store.ts`, `src/cache/vector-store.ts`, `src/cache/crosslingual.ts`, `src/cache/intent.ts`, `src/cache/semantic-cache.ts`, `src/index.ts`
**Commit:** cf5147a
**Applied fix:** Added `TranslationResult`, `ClassificationResult`, `SearchResultItem`, and `CacheMetadata` interfaces to `types.ts`. Updated `VectorMatch.metadata` type from `any` to `CacheMetadata`. Updated `IVectorStore.add()` metadata parameter type. Added type assertions for pipeline results (`TranslationResult[]`, `ClassificationResult[]`). Changed `catch (error: any)` to `catch (error: unknown)` with proper `instanceof Error` check. Updated `SemanticCache.get()` return type to `SearchResultItem[] | null`, `set()` parameter to `SearchResultItem[]`, and `reRankResults()` signature.

### WR-07: Google Search Selector `div.g` Is Known to Be Fragile

**Files modified:** `src/index.ts`
**Commit:** 86e9b66
**Applied fix:** Added page title check after Google navigation to detect captcha/rate-limit pages (`/captcha|unusual traffic/i`). Added warning log when Google returns zero results (indicates likely DOM structure change). Improved error messages with `instanceof Error` formatting for all fallback catch blocks. Added HTTP response status logging for DuckDuckGo fallback.

---

_Fixed: 2026-06-05T12:00:00Z_
_Fixer: gsd-code-fixer_
_Iteration: 1_
