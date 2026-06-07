---
phase: code-review
reviewed: 2026-06-05T12:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - src/index.ts
  - src/rate-limiter.ts
  - src/cache/semantic-cache.ts
  - src/cache/crosslingual.ts
  - src/cache/embedding.ts
  - src/cache/sqlite-store.ts
  - src/cache/intent.ts
  - src/cache/types.ts
  - src/cache/vector-store.ts
findings:
  critical: 1
  warning: 7
  info: 7
  total: 15
status: issues_found
---

# Phase: Code Review Report

**Reviewed:** 2026-06-05T12:00:00Z
**Depth:** standard
**Files Reviewed:** 9 across `src/` (index.ts, rate-limiter.ts, cache/*)
**Status:** issues_found

## Summary

Reviewed 9 TypeScript source files (940 total lines) implementing an offline-first MCP server for web search and content fetching. Architecture separates concerns reasonably (embedding, cache, rate limiter, intent classifier, vector store). Found one critical SSRF vulnerability, several resource leak patterns, duplicated logic, and pervasive use of `any` types. The error handling strategy relies on silent `console.error` swallowing throughout the cache layer.

## Critical Issues

### CR-01: SSRF Protection Regex Is Trivially Bypassable

**File:** `src/index.ts:329`

**Issue:** The SSRF guard uses a single regex to block local/private resources, but this regex covers only a subset of IPv4 private ranges and plain `localhost`. It is trivially bypassed via:

- **IPv6 loopback** — `::1`, `[::1]`, `0:0:0:0:0:0:0:1`
- **IPv4-mapped IPv6** — `[::ffff:127.0.0.1]`, `[::ffff:10.0.0.1]`
- **IPv6 link-local** — `fe80::`, `[fe80::1]`
- **Decimal IP** — `2130706433` (decodes to `127.0.0.1`)
- **Hex IP** — `0x7f000001`, `0x7f.0.0.1`
- **Octal IP** — `0177.0.0.1`
- **Shorthand IP** — `127.1`, `127.0.1` (both resolve to loopback)
- **`0.0.0.0`** — not blocked
- **DNS rebinding domains** — e.g., `1.1.1.1.nip.io` (resolves to arbitrary IP, the regex only checks the hostname string)

An attacker who controls the URL passed to `fetch_content` can use any of these forms to bypass SSRF protection and issue requests to internal infrastructure, cloud metadata endpoints (`169.254.169.254`), or other private network hosts.

**Fix:** Replace the regex with a proper IP resolution check that:
1. Resolves the hostname to IP addresses (using `dns.promises.resolve4` and `dns.promises.resolve6`).
2. Checks each resolved IP against the full set of private/loopback ranges (RFC 1918, RFC 4193, loopback, link-local, CGNAT, etc.).
3. Rejects non-IP hostnames that resolve to private IPs (DNS rebinding protection).

```typescript
import { promises as dns } from "dns";
import { isIP } from "net";

// Use a dedicated library like `ipaddr.js` or the built-in `net` module
import { isPrivate } from "ipaddr.js";  // or implement RFC 1918/4193 checks

private async isPrivateHost(hostname: string): Promise<boolean> {
  // Quick string check for obvious local addresses first
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "localhost6" || lower === "0.0.0.0") {
    return true;
  }

  // Resolve DNS to catch DNS rebinding
  const addresses = await dns.resolve4(hostname).catch(() => []);
  const addresses6 = await dns.resolve6(hostname).catch(() => []);
  const allAddresses = [...addresses, ...addresses6];

  for (const ip of allAddresses) {
    // net:isIP() + manual RFC range check or use ipaddr.js
    if (isPrivate(ip)) return true;
  }

  return false;
}
```

Alternatively, use the `private-ip` npm package for a battle-tested solution.

---

## Warnings

### WR-01: SQLite Database Connection Never Closed

**File:** `src/cache/sqlite-store.ts:156-158`

**Issue:** The `close()` method exists but is never called — not in shutdown handlers and not on process exit. While better-sqlite3 handles finalization on process exit reasonably well, WAL-mode databases may lose the last few transactions or leave the WAL/index files incompletely checkpointed. If the server is killed hard (SIGKILL), corruption risk increases.

**Fix:** Wire `close()` into the shutdown handlers in `index.ts`:

```typescript
// src/index.ts — in WebSearchServer class
private cleanupDb() {
  // Access the vectorStore's close method
  // This requires the vectorStore to expose close() via the interface
  if (this.cache && typeof (this.cache as any).close === 'function') {
    (this.cache as any).close();
  }
}
```

Also add the `close()` method to `IVectorStore` interface so it can be called polymorphically.

### WR-02: No Error Recovery for Transformer.js Model Download Failures

**Files:**
- `src/cache/crosslingual.ts:17-20` — translation model loading
- `src/cache/crosslingual.ts:37-39` — language detection model loading
- `src/cache/embedding.ts:14` — embedding model loading
- `src/cache/intent.ts:15` — classifier model loading

**Issue:** All four places download/pipeline-load HuggingFace models on first invocation. If the download fails mid-flight (network timeout, disk full, corrupted cache), the error propagates. Worse, for the translation model in `crosslingual.ts:12-24`, the `models` Map is not updated on failure, so every subsequent call retries the download — potentially saturating network and delaying every request. For the embedding provider (`embedding.ts:14`), the `extractor` field is never set, so every subsequent call also retries the download.

**Fix:** Add a circuit-breaker pattern — track failure state and fail fast instead of retrying the download on every call:

```typescript
// crosslingual.ts
private modelLoadAttempted = false;
private modelLoadFailed = false;

async translate(text: string, sourceLang: string): Promise<string> {
  const modelName = OPUS_MT_REGISTRY[sourceLang];
  if (!modelName) return text;

  if (this.modelLoadFailed) return text;  // fail fast, fall back to original

  let model = this.models.get(modelName);
  if (!model) {
    try {
      model = await pipeline("translation", modelName);
      this.models.set(modelName, model);
    } catch (e) {
      this.modelLoadFailed = true;
      console.error("Translation model permanently failed:", e);
      return text;  // fall back
    }
  }
  const [result] = await model(text);
  return result.translation_text;
}
```

Apply the same pattern to `semantic-cache.ts:get()` / `set()` / `reRankResults()` so a permanently broken embedding model doesn't block every operation.

### WR-03: Env Var Misconfiguration Causes Infinite DoS in Rate Limiter

**Files:** `src/rate-limiter.ts:43-47, 51-55`

**Issue:** If `RATE_LIMIT_SEARCH_PER_MIN` or `RATE_LIMIT_FETCH_PER_MIN` is set to `"0"` (a plausible "disable rate limiting" value), the token bucket is created with `maxTokens: 0` and `refillRatePerSecond: 0`. This means `tryConsume()` always returns `{ allowed: false, retryAfterMs: Infinity }` — the server permanently blocks itself. If set to garbage like `"abc"`, `parseInt` returns `NaN`, producing `NaN` tokens and `NaN` retry times.

**Fix:** Validate the environment variable and treat unparseable/zero values as "no limit":

```typescript
export function createSearchRateLimiter(): TokenBucket {
  const raw = process.env.RATE_LIMIT_SEARCH_PER_MIN;
  const perMinute = raw ? parseInt(raw, 10) : 10;
  if (isNaN(perMinute) || perMinute <= 0) {
    // Treat as "effectively unlimited" — extremely high cap
    return new TokenBucket({
      maxTokens: Number.MAX_SAFE_INTEGER,
      refillRatePerSecond: Number.MAX_SAFE_INTEGER,
    });
  }
  return new TokenBucket({
    maxTokens: Math.min(perMinute, 5),
    refillRatePerSecond: perMinute / 60,
  });
}
```

### WR-04: process.exit(0) in Shutdown Handlers Skips Cleanup

**File:** `src/index.ts:87`

**Issue:** Shutdown handlers call `process.exit(0)` immediately after closing the browser. This prevents async cleanup that may be in-flight (SQLite WAL checkpoint, pending cache writes, HTTP requests). Additionally, `process.exit()` does not guarantee that the event loop drains — other pending `finally` blocks may not execute.

**Fix:** Remove `process.exit(0)` and let the process exit naturally when the MCP transport disconnects:

```typescript
private setupShutdownHandlers() {
  const shutdown = async () => {
    console.error("Shutting down Web Search MCP Server...");
    await this.browser?.close();
    this.browser = null;
    // Close DB here if exposed
    // this.cleanupDb();
    // Do NOT call process.exit — let Node exit when event loop is idle
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);  // also common for daemon reload
}
```

### WR-05: Browser Instance Lifetime Not Managed on Launch Failure

**File:** `src/index.ts:72-78`

**Issue:** If `chromium.launch()` throws (e.g., Playwright not installed, no Chrome binary), the `browser` field stays `null`. The next call to `getBrowser()` retries the launch. This is acceptable. But if `getBrowser()` succeeds and later `newContext()` or `page.goto()` throws inside `performSearch()` or `handleFetchContent()`, the `context.close()` in the `finally` block runs correctly. However, if `context.close()` itself throws, the `finally` block in `CallToolRequestSchema` handler catches it and returns an error, but the context is leaked. Consider wrapping `context.close()` in a secondary try/catch.

**Fix:** Safeguard context.close() in the finally blocks:

```typescript
finally {
  try {
    await context.close();
  } catch (e) {
    console.error("Error closing browser context:", e);
  }
}
```

### WR-06: Promiscuous `any` Types Mask Type Errors

**Files:** Multiple — `crosslingual.ts:10,28`, `embedding.ts:5`, `intent.ts:6`, `types.ts:8,28,31`, `semantic-cache.ts:43,55`, `index.ts:226,235, etc.`

**Issue:** The codebase uses `any` extensively for pipeline results, stored metadata, and error handlers. This defeats TypeScript's type checking and makes refactoring hazardous. Key examples:

- `crosslingual.ts:22` — `const [result] = await model(text)` — destructures the result as an array, but the pipeline type is `any`, so this is unchecked.
- `sqlite-store.ts:94` — `json.parse(row.metadata)` — metadata stored as `JSON.stringify(any)`, no shape guarantee.
- `semantic-cache.ts:43` — returns `matches[0].metadata.results` as `any` — the cache entry shape is never validated.

**Fix:** Add proper interfaces for pipeline results and stored metadata shapes:

```typescript
// Add to types.ts or create model-types.ts
interface TranslationResult {
  translation_text: string;
}

interface ClassificationResult {
  label: string;
  score: number;
}

interface CacheMetadata {
  query: string;
  results: SearchResult[];
  timestamp: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  semanticScore?: number;
}
```

Then replace `IVectorStore` metadata type from `any` to a union/unknown with runtime validation.

### WR-07: Google Search Selector `div.g` Is Known to Be Fragile

**File:** `src/index.ts:272`

**Issue:** The fallback Google search scraper uses `div.g` as the result container selector. Google frequently changes its DOM structure (historically `div.g`, `div#search`, `div[data-hveid]`, etc.). This makes the fallback unreliable on a moving target. When Google changes its layout, the selectors silently return zero results, and the code falls through to DuckDuckGo — but the user gets no indication that Google scraping failed.

**Fix:** Add a warning log when a search provider yields zero results due to selector mismatch, and consider using the optional `results.length` check with a more resilient selector strategy:

```typescript
// src/index.ts — inside Google fallback catch block
catch (e) {
  // Distinguish between timeout/network errors and selector failures
  console.error("Google fallback failed — likely DOM structure change:", e instanceof Error ? e.message : e);
  // Still continue to DuckDuckGo
}
```

Better yet, add a page title or URL check to detect captchas or unexpected redirects:

```typescript
const pageTitle = await page.title();
if (pageTitle.includes("captcha") || pageTitle.includes("unusual traffic")) {
  console.error("Google blocked the request (captcha/rate-limit)");
}
```

---

## Info

### IN-01: Duplicate `cosineSimilarity` Implementation in Three Files

**Files:**
- `src/cache/semantic-cache.ts:122-133`
- `src/cache/sqlite-store.ts:143-154`
- `src/cache/vector-store.ts:39-49`

**Issue:** The exact same cosine similarity function is copy-pasted across three files. This violates DRY and means any bug fix or optimization (e.g., adding epsilon to prevent division by near-zero, or using `Math.hypot` for numerical stability) must be applied in three places.

**Fix:** Extract to a shared utility module:

```typescript
// src/cache/similarity.ts
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  const epsilon = 1e-8; // prevent division by zero for near-zero vectors
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB) + epsilon);
}
```

### IN-02: Error Swallowing via `console.error` in Cache Operations

**Files:**
- `src/cache/semantic-cache.ts:46,61,117` — `get()`, `set()`, `reRankResults()` all catch and silently fail
- `src/cache/crosslingual.ts:49` — language detection returns `"eng_Latn"` on error
- `src/cache/intent.ts:32` — classification returns `"general"` on error

**Issue:** While silent degradation is acceptable for a cache (cache miss is not an error), the `set()` and `reRankResults()` failure at `semantic-cache.ts:61,117` means developers have no visibility into write failures. A corrupted database or disk-full error would be silently ignored. The `crosslingual.ts` and `intent.ts` fallbacks are sensible defaults, but there is no way to distinguish "model never loaded" from "model failed permanently" from "transient network error."

**Fix:** For write operations, at minimum increment a metric or log at a higher level. Consider returning a success/failure boolean from `set()`:

```typescript
// semantic-cache.ts
async set(query: string, results: any): Promise<boolean> {
  try {
    const vector = await this.embeddingProvider.getEmbedding(query);
    const id = Buffer.from(query).toString("base64");
    await this.vectorStore.add(id, vector, { query, results, timestamp: Date.now() });
    return true;
  } catch (error) {
    console.error("Cache set error — write failed, stale data may be served:", error);
    return false;
  }
}
```

### IN-03: Unused `InMemoryVectorStore` in the Codebase

**File:** `src/cache/vector-store.ts` (entire file, 50 lines)

**Issue:** The `InMemoryVectorStore` class is never imported or used by `index.ts` or any other production file. The main server always uses `SQLiteVectorStore`. This is dead code that must be maintained alongside the SQLite implementation.

**Fix:** Either remove the file, or export it with a comment explaining when it should be used (e.g., testing, ephemeral environments):

```typescript
// vector-store.ts — Primarily for testing. Production uses SQLiteVectorStore.
```

If it's kept, add a `close()` method to match the interface used by the production store.

### IN-04: Cross-Lingual Engine Supports Only Turkish Translation

**File:** `src/cache/crosslingual.ts:3-5`

**Issue:** The `OPUS_MT_REGISTRY` only contains `"tur_Latn"`. For any other non-English language, `shouldCrossSearch()` returns `true` (if intent is technical), but `translateToEnglish()` returns the original text unchanged. This means for a non-Turkish, non-English technical query, the cross-lingual path runs two searches (original + identical original) and merges duplicates — effectively wasted work. The user has no indication that translation was not performed.

**Fix:** Either expand the registry with more language pairs, or gate `shouldCrossSearch` on translation availability:

```typescript
shouldCrossSearch(intent: string, lang: string): boolean {
  if (lang?.startsWith("eng_")) return false;
  if (intent !== "technical") return false;
  // Only cross-search if we have a translation model for this language
  return !!OPUS_MT_REGISTRY[lang];
}
```

### IN-05: No Input Length Validation for Embedding Calls

**File:** `src/cache/embedding.ts:19-22`

**Issue:** The `getEmbedding()` method accepts any string length. When `reRankResults` calls this for each search result (concatenating title + snippet), very long snippets could cause excessive memory usage in the Transformer.js pipeline. The model `paraphrase-multilingual-MiniLM-L12-v2` has a max token limit of 128 tokens; inputs longer than this are silently truncated by the pipeline, meaning longer inputs waste computation without improving re-ranking quality.

**Fix:** Truncate input to a reasonable length before embedding:

```typescript
async getEmbedding(text: string): Promise<number[]> {
  const MAX_CHARS = 512;  // ~128 tokens
  const truncated = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  const extractor = await this.getExtractor();
  const output = await extractor(truncated, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}
```

### IN-06: Base64 Query ID May Cause Unexpected Collisions

**File:** `src/cache/semantic-cache.ts:54`

**Issue:** The cache key is computed as `Buffer.from(query).toString("base64")`. Base64 encoding is not a hash — two semantically different queries that happen to have the same string will collide, and the `INSERT OR REPLACE` semantics will silently overwrite. This is fine for exact-match caches but misleading since the module is called "SemanticCache" (which implies cache hits based on semantic similarity, not exact match). The actual semantic lookup is done via embedding similarity at `get()` time, but the ID is still just a base64 encoding. If the same query string is cached under different casing or with extra whitespace, the base64 encoding differs and the cache stores a duplicate.

**Fix:** Normalize the query before computing the ID:

```typescript
const normalizedQuery = query.toLowerCase().trim().replace(/\s+/g, " ");
const id = Buffer.from(normalizedQuery).toString("base64");
```

### IN-07: DuckDuckGo Lite URL May Redirect or Change

**File:** `src/index.ts:293`

**Issue:** The DuckDuckGo fallback uses `https://lite.duckduckgo.com/lite/`. The "lite" endpoint has historically been deprecated or redirected by DuckDuckGo. If the endpoint returns a redirect or an error page, the `$$eval` selector `a.result-link` returns zero results, and the code silently falls through to returning an empty array — which causes `handleWebSearch` to throw "All search providers failed."

**Fix:** Log the response status and page URL after navigation to detect redirects:

```typescript
// Inside DuckDuckGo try block
const response = await page.goto(ddgUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
if (response && response.status() >= 400) {
  console.error(`DuckDuckGo returned status ${response.status()}`);
  // Optionally check page.url() for redirect detection
}
```

---

## Summary of Findings by Severity

| Severity | Count | Key Areas |
|----------|-------|-----------|
| CRITICAL | 1 | SSRF regex bypass via IPv6 / IP obfuscation |
| WARNING  | 7 | DB never closed, model download no recovery, rate limiter env parsing, process.exit, browser launch, any types, fragile selectors |
| INFO     | 7 | Duplicated code, error swallowing, unused class, limited translation, no input truncation, key collision risk, DDG endpoint fragility |

**Top priorities for fixing:**
1. Replace the SSRF regex with proper IP resolution + RFC 1918/4193 checks (CR-01)
2. Add circuit-breaker for model download failures (WR-02)
3. Wire SQLite close into shutdown (WR-01)
4. Extract shared `cosineSimilarity` utility (IN-01)

---

_Reviewed: 2026-06-05T12:00:00Z_
_Reviewer: gsd-code-reviewer_
_Depth: standard_
