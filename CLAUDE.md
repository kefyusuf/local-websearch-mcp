# my-websearch-mcp

Offline-first MCP server for web search and content fetching — no API keys.

## Commands

```bash
npm run build        # Compile TypeScript
npm run typecheck    # Type-check without emitting
npm start            # Run compiled server
npm run dev          # Run with ts-node
npm test             # Run all tests (vitest)
npm run docker:build # Build Docker image
npm run docker:up    # Start with docker compose
```

## Architecture

```
index.ts (WebSearchServer)
├── ssrf.ts           — Private IP detection (DNS resolution)
├── rate-limiter.ts   — TokenBucket rate limiter
└── cache/
    ├── semantic-cache.ts — Cache with TTL, intent, re-ranking
    ├── sqlite-store.ts   — SQLite + sqlite-vec vector store
    ├── embedding.ts      — Transformers.js embedding (384-dim)
    ├── intent.ts         — Zero-shot intent classification
    ├── crosslingual.ts   — Language detection + translation
    ├── utils.ts          — Shared cosineSimilarity
    └── types.ts          — Shared interfaces
```

## Conventions

- **ESM** modules (`import`/`export`, `"type": "module"`)
- **Strict TypeScript**, no `any` in production code
- Tests: vitest, co-located in `src/__tests__/*.test.ts`
- All errors: `console.error` (MCP server logs to stderr)
- No external API keys — everything runs locally
