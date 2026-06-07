# Production Readiness Plan — my-websearch-mcp

## Overview

Feature-complete but production-zero. 4 phase plan to take it live.

---

## Phase 1: Code Quality Refactors

| # | Task | Files | Why |
|---|------|-------|-----|
| 1.1 | Extract `cosineSimilarity` to `src/cache/utils.ts` | `sqlite-store.ts`, `semantic-cache.ts`, `vector-store.ts` | 3x code duplication |
| 1.2 | Move `InMemoryVectorStore` to test utils | `vector-store.ts` → `src/__tests__/helpers.ts` | Dead code in production |
| 1.3 | Add `maxLength` param to embedding (512 chars) | `embedding.ts`, `types.ts` | BERT models cap at 512 tokens silently |
| 1.4 | Normalize cache key (trim + lowercase) | `semantic-cache.ts` | Same query, different casing → double cache miss |
| 1.5 | Expand translation registry (FR, DE, ES, PT) | `crosslingual.ts` | Cross-lingual triggers but no-op for non-TR |
| 1.6 | Fix SSRF tests to import actual implementation | `__tests__/ssrf.test.ts` | Tests regex, not DNS-based impl |

## Phase 2: Production Infrastructure

| # | Task | Files | Why |
|---|------|-------|-----|
| 2.1 | Dockerfile (multi-stage, slim) | `Dockerfile` | Reproducible builds |
| 2.2 | docker-compose.yml | `docker-compose.yml` | One-command start |
| 2.3 | GitHub Actions CI | `.github/workflows/ci.yml` | Auto-test on push/PR |
| 2.4 | .env.example | `.env.example` | Document env vars |
| 2.5 | Update .gitignore for DB + env | `.gitignore` | Don't commit secrets/cache |

## Phase 3: UAT Execution

| # | Task | Verification |
|---|------|-------------|
| 3.1 | Cold Start Smoke Test | `npm run build` + `node build/index.js` starts |
| 3.2 | SSRF Protection | fetch_content blocks 127.0.0.1 |
| 3.3 | Rate Limiter Edge Cases | `RATE_LIMIT_SEARCH_PER_MIN=0` handled gracefully |
| 3.4 | Graceful Shutdown | SIGTERM → clean close, no process.exit |
| 3.5 | Fix any UAT failures | Per failure |

## Phase 4: Final Verification

| # | Task |
|---|------|
| 4.1 | `npm run build` passes |
| 4.2 | `npm test` passes |
| 4.3 | TypeScript strict no errors |
| 4.4 | Update 00-UAT.md with results |

---

## Execution Order

```
Phase 1 —> Phase 2 —> Phase 3 —> Phase 4
```
