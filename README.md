# Local Web Search MCP Server

Offline-first MCP server for web search and content fetching. It requires no external API keys and uses local models for intent classification, optional cross-lingual search, semantic re-ranking, and extractive deep-search answers.

## Features

- Browser context pooling with a persistent Playwright browser instance.
- Web search through configurable providers with health tracking and ordered fallback.
- Optional federated search across all configured providers with URL normalization, cross-provider deduplication, and Reciprocal Rank Fusion (RRF).
- Domain-filtered web search for targeted site queries.
- HTTP-first page fetching with GitHub Raw and RSS fast paths plus Playwright fallback for rendered pages.
- SSRF protection for `fetch_content` by blocking localhost and private network targets.
- Token-bucket rate limiting for search and fetch tools.
- Semantic cache backed by SQLite and `sqlite-vec`.
- Optional cross-lingual query expansion with local Transformers.js models.
- Clean Markdown extraction through Readability, JSDOM, and Turndown.

## Requirements

- Node.js 20.9.0 or newer.
- npm.
- Network access during installation for npm packages, Playwright Chromium, and first-run model downloads.

## Installation

```bash
npm install
npm run build
```

The `postinstall` script downloads Playwright Chromium. On first use of model-backed features, Transformers.js downloads the required model files to the local Hugging Face cache. The first request that loads a model can be slow; later requests reuse the local cache. Keep `ENABLE_CROSSLINGUAL=false` for the lightest first run.

## MCP Client Configuration

Add the built server to your MCP client config:

```json
{
  "mcpServers": {
    "websearch": {
      "command": "node",
      "args": ["path/to/local-websearch-mcp/build/index.js"],
      "env": {
        "RATE_LIMIT_SEARCH_PER_MIN": "10",
        "RATE_LIMIT_FETCH_PER_MIN": "20",
        "SEARCH_PROVIDERS": "duckduckgo,bing",
        "ENABLE_CROSSLINGUAL": "false",
        "CACHE_DB_PATH": "websearch_cache.db"
      }
    }
  }
}
```

If the package is installed globally or through a package runner, use the binary entrypoint:

```json
{
  "mcpServers": {
    "websearch": {
      "command": "local-websearch-mcp",
      "args": [],
      "env": {
        "SEARCH_PROVIDERS": "duckduckgo,bing",
        "ENABLE_CROSSLINGUAL": "false"
      }
    }
  }
}
```

For package-runner based clients, the command can be `npx` with `args` set to `["-y", "local-websearch-mcp"]` once the package is available from the configured npm registry.

## Tools

| Tool | Description |
| --- | --- |
| `web_search` | Searches the web and returns ranked results. Set `strategy=aggregate` for federated multi-provider search, `domain` to restrict results to a site, or `deep=true` to fetch top result pages and extract a source-backed text answer. |
| `fetch_content` | Fetches a URL and returns clean Markdown with content caching, charset handling, GitHub Raw fast paths, RSS feed extraction, and Playwright fallback. |
| `server_status` | Returns provider availability, cache stats, browser state, feature flags, and uptime. |

`web_search` supports two execution strategies:

- `fallback` (default): tries `SEARCH_PROVIDERS` in order and stops after the first provider that returns usable results. This preserves the original low-latency behavior.
- `aggregate`: queries every currently available configured provider in parallel, canonicalizes URLs, removes cross-provider duplicates, and merges provider rankings with RRF before the existing semantic re-ranking stage.

Aggregate mode intentionally bypasses the semantic **query** cache for now because the cache does not yet namespace entries by search strategy. Deep-search page content still uses the normal content cache.

Use `domain` for targeted searches such as `react.dev` or `github.com`. Use `deep=true` only when the client needs the server to fetch top pages and extract a likely answer from page text. The MCP client LLM remains responsible for final reasoning and summarization.

Search snippets with old detected dates include a short freshness warning so clients can treat stale sources carefully.

Example targeted search arguments:

```json
{
  "query": "server components reference",
  "domain": "react.dev",
  "max_results": 5
}
```

Example federated search arguments:

```json
{
  "query": "postgres connection pooling strategies",
  "strategy": "aggregate",
  "max_results": 5
}
```

`fetch_content` uses fast source-specific paths before opening a browser:

- GitHub repository, blob, tree, and raw URLs are read from `raw.githubusercontent.com` when possible.
- RSS or Atom feed URLs, plus common blog/news feed paths, are converted into a Markdown list of recent items.
- Regular HTML pages still use HTTP-first Readability parsing with Playwright fallback.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `RATE_LIMIT_SEARCH_PER_MIN` | `10` | Maximum `web_search` requests per minute. Invalid or non-positive values disable the limiter. |
| `RATE_LIMIT_FETCH_PER_MIN` | `20` | Maximum `fetch_content` requests per minute. Invalid or non-positive values disable the limiter. |
| `SEARCH_PROVIDERS` | `duckduckgo,bing` | Comma-separated provider order for `fallback` and provider set for `aggregate`. Supported values: `duckduckgo`, `bing`, `brave`, `google`. |
| `ENABLE_CROSSLINGUAL` | `false` | Enables language detection and cross-lingual search support. This can trigger first-run local model downloads. |
| `FETCH_WAIT_UNTIL` | `networkidle` | Playwright wait strategy. Use `domcontentloaded` for faster rendered-page fallback. |
| `FORCE_PLAYWRIGHT` | unset | Set to `true` to skip HTTP-first fetch and always use Playwright. |
| `CACHE_DB_PATH` | `websearch_cache.db` | SQLite cache database path. |
| `CACHE_CLEANUP_INTERVAL_HOURS` | `24` | Interval for expired content cache cleanup. |

## Docker

```bash
npm run docker:build
npm run docker:up
```

Docker Compose stores the SQLite cache in a named volume mounted at `/app/data` and stores Hugging Face models in a separate named volume. The container sets `CACHE_DB_PATH=/app/data/websearch_cache.db`.

## Development

```bash
npm run build
npm run typecheck
npm test
npm run smoke:mcp
npm audit --audit-level=moderate
npm pack --dry-run --json
```

`npm run smoke:mcp` starts the compiled server over stdio, verifies `tools/list`, calls `server_status`, and confirms that `fetch_content` blocks localhost.

## Troubleshooting

- If startup fails after install, run `npx playwright install chromium`.
- If the first model-backed request is slow, wait for the Transformers.js model download to finish and retry.
- If search returns no results, change `SEARCH_PROVIDERS` order or try a direct `fetch_content` URL.
- If aggregate mode is too slow or triggers provider blocking, use the default `fallback` strategy.
- If Docker cannot find Chromium, rebuild the image with `npm run docker:build`.
- If cache files appear in the project root, set `CACHE_DB_PATH` to a dedicated data directory.

## npm Packaging

The npm package includes only `build/`, `README.md`, `LICENSE`, and `SECURITY.md`. `npm pack` runs `npm run build` through `prepack` so the package contains compiled JavaScript instead of local planning files, tests, caches, or source-only artifacts.

## Security

See `SECURITY.md` for reporting instructions and current dependency audit notes.

## License

ISC
