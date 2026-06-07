# My Web Search MCP Server

A high-performance, AI-powered MCP (Model Context Protocol) server for web search and content fetching — no external API keys required. Runs entirely offline using local models.

## Features

- **Browser Context Pooling:** Persistent browser instance — no cold start on every search.
- **Vector Indexing (sqlite-vec):** Semantic search across thousands of records with C-level performance.
- **Search Intent Classification:** Classifies queries as Technical, News, or General to optimize cache TTL and search strategy.
- **Cross-lingual Search:** Detects non-English technical queries, translates them, and performs parallel search in both languages. Results are merged and re-ranked.
- **Search Engine Fallback:** Brave Search → Google → DuckDuckGo Lite with automatic failover.
- **SSRF Protection:** Blocks access to local/private network resources for security.
- **Rate Limiting:** Token bucket rate limiter (configurable via environment variables).
- **Encoding Detection:** Automatic charset detection from meta tags (ISO-8859-9, Windows-1254, etc.).
- **Semantic Caching:** Content fetched from URLs is cached with smart TTL based on content category.
- **Responsible Scraping:** Rate-limited, polite user-agent, single persistent browser context.

## Installation

Requires Node.js >= 18

```bash
npm install
npx playwright install chromium
npm run build
```

> On first run, Transformers.js models are downloaded automatically (~500 MB, one-time). The server will not respond during download. Subsequent starts are instant.

## MCP Client Configuration

Add to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "websearch": {
      "command": "node",
      "args": ["path/to/my-websearch-mcp/build/index.js"],
      "env": {
        "RATE_LIMIT_SEARCH_PER_MIN": "10",
        "RATE_LIMIT_FETCH_PER_MIN": "20"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `web_search` | Searches the web with intent classification, cross-lingual support, semantic re-ranking, and multi-engine fallback. |
| `fetch_content` | Fetches a URL and returns clean Markdown with smart TTL caching and charset detection. |

## Docker

```bash
npm run docker:build  # Build Docker image
npm run docker:up     # Start with docker compose
```

Docker Compose mounts persistent volumes for the SQLite cache database and HuggingFace model cache.

## Testing

```bash
npm test              # Single run (vitest)
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Embedding | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-dim, 50+ languages) |
| Intent Classification | `Xenova/nli-deberta-v3-xsmall` (zero-shot) |
| Language Detection | `onnx-community/language_detection-ONNX` (200 languages, FLORES-200) |
| Translation | `Xenova/opus-mt-tr-en` (on-demand, expandable registry) |
| Vector Search | SQLite + `sqlite-vec` extension (C-level native, JS fallback) |
| Browser Automation | Playwright (persistent instance, context pooling) |
| Content Cleaning | `@mozilla/readability` + JSDOM + Turndown |
| Encoding | `iconv-lite` (meta charset-based detection) |
| Test Runner | vitest |

## Rate Limiting

| Tool | Default | Environment Variable |
|------|---------|---------------------|
| `web_search` | 10/min | `RATE_LIMIT_SEARCH_PER_MIN` |
| `fetch_content` | 20/min | `RATE_LIMIT_FETCH_PER_MIN` |

Rate limiter uses a token bucket algorithm. Burst capacity is 5 tokens. When exceeded, the client receives an error with a retry-after hint.

## License

ISC
