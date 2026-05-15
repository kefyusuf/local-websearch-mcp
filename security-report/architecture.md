# Project Architecture Map

## Overview
- **Project Name:** my-websearch-mcp
- **Type:** Model Context Protocol (MCP) Server
- **Language:** TypeScript (Node.js, ESM)
- **Transport:** Stdio

## Components

### 1. MCP Interface (`src/index.ts`)
- **Transport:** Stdio
- **Tools exposed:** `web_search`, `fetch_content`
- **Validation:** Zod schemas
- **Rate Limiting:** TokenBucket (search: 10/min, fetch: 20/min)

### 2. Scraping Engine (Playwright)
- **Primary Search:** Brave Search (direct scraping)
- **Fallback 1:** Google Web-only (`udm=14`)
- **Fallback 2:** DuckDuckGo Lite
- **Browser:** Persistent singleton instance (context pooling)

### 3. Processing Pipeline
- **Cleaning:** `@mozilla/readability` + `JSDOM`
- **Conversion:** `Turndown` (HTML → Markdown)
- **Encoding Detection:** Meta charset-based with `iconv-lite` fallback

### 4. AI / Semantic Layer
- **Embedding:** `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-dim)
- **Intent Classification:** `Xenova/nli-deberta-v3-xsmall` (zero-shot)
- **Language Detection:** `onnx-community/language_detection-ONNX` (200 langs, FLORES-200)
- **Translation:** `Xenova/opus-mt-tr-en` (on-demand, expandable registry)
- **Re-ranking:** Cosine similarity on multilingual embeddings
- **Caching:** Semantic cache with TTL-based content persistence

### 5. Storage
- **Vector Search:** `sqlite-vec` (native C-level, with JS fallback)
- **Content Cache:** SQLite (`better-sqlite3`)
- **Persistent:** Disk-based (`websearch_cache.db`)

## Data Flow
1. MCP client → Stdio → Tool call with Zod validation
2. Rate limit check (TokenBucket)
3. Intent classification → Language detection
4. Cross-lingual: translate if non-English technical query
5. Semantic cache lookup (sqlite-vec vector search)
6. Cache miss → Browser search (Brave → Google → DDG fallback)
7. Semantic re-ranking → Cache store → Return

## Security Boundaries
- **Inbound:** MCP Stdio (local only)
- **Outbound:** HTTP/HTTPS via Playwright (SSRF-protected)
- **Rate Limited:** Token bucket prevents abuse/IP bans
- **Local:** SQLite DB file, Node.js runtime
