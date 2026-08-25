# Local Web Search MCP Server

Offline-first MCP server for web search and content fetching. It requires no external API keys and uses local models for intent classification, optional cross-lingual search, semantic re-ranking, and extractive deep-search answers.

## Features

- Browser context pooling with a persistent Playwright browser instance.
- Web search through configurable providers with health tracking and ordered fallback.
- Optional federated search across all configured providers with URL normalization, cross-provider deduplication, and Reciprocal Rank Fusion (RRF).
- Opt-in intent-aware search routing with conservative heuristics, local classifier fallback, and versioned provider profiles.
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

The `postinstall` script downloads Playwright Chromium. On first use of model-backed features, Transformers.js downloads the required model files to the local Hugging Face cache. The first request that loads a model can be slow; later requests reuse the local cache. Keep `ENABLE_CROSSLINGUAL=false` for the lightest first run. Obvious `strategy=auto` intents are resolved by heuristics without loading the intent classifier; ambiguous auto queries may trigger a first-run classifier download.

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
| `web_search` | Searches the web and returns ranked results. Use `strategy=auto` for intent-aware provider planning, `strategy=aggregate` for all-provider federated search, `domain` to restrict results to a site, or `deep=true` to fetch top result pages and extract a source-backed text answer. |
| `fetch_content` | Fetches a URL and returns clean Markdown with content caching, charset handling, GitHub Raw fast paths, RSS feed extraction, and Playwright fallback. |
| `server_status` | Returns provider availability, cache stats, browser state, routing profile metadata, feature flags, and uptime. |

### Search strategies

| Strategy | Behavior | Semantic query cache |
| --- | --- | --- |
| `fallback` **(default)** | Tries configured providers in order and stops at the first usable result set. | Enabled |
| `aggregate` | Queries all currently available configured providers in parallel, deduplicates URLs, and fuses rankings with RRF. | Bypassed |
| `auto` | Detects intent, builds a routing plan from profile `v1`, then delegates to the existing fallback/aggregate executor. | Bypassed |

`auto` is deliberately opt-in; omitting `strategy` still uses `fallback` for backward compatibility. The semantic query cache is bypassed for `aggregate` and `auto` because query-cache keys are not yet namespaced by execution strategy/provider plan. Deep-search page content continues to use the normal content cache.

`SEARCH_PROVIDERS` is an **allowlist** as well as the configured provider set. Auto routing never activates a provider omitted from `SEARCH_PROVIDERS`; the routing profile only changes ordering and how many configured providers are selected as primary candidates.

For aggregate auto profiles, secondary configured providers are contacted only if **all** selected primary providers return no usable result. A partial primary success is accepted instead of widening the request just to increase result count. This limits scraping load and reduces unnecessary blocking/CAPTCHA exposure.

Current routing profile: `v1`.

| Intent | Execution | Preferred order | Primary target |
| --- | --- | --- | ---: |
| `technical` | aggregate | brave, google, bing, duckduckgo | 2 |
| `research` | aggregate | brave, google, bing, duckduckgo | 3 |
| `news` | aggregate | google, bing, brave, duckduckgo | 3 |
| `commercial` | aggregate | brave, google, bing, duckduckgo | 3 |
| `shopping` | aggregate | google, bing, duckduckgo, brave | 2 |
| `local` | aggregate | google, bing, duckduckgo, brave | 2 |
| `navigational` | fallback | google, bing, duckduckgo, brave | all configured |
| `general` | fallback | existing configured order | all configured |

These provider preferences are initial hypotheses, not permanent quality claims. They are versioned so later releases can tune them from deterministic and live evaluation evidence without scattering routing conditionals through the server.

Example intent-aware search arguments:

```json
{
  "query": "PostgreSQL connection pooling best practices",
  "strategy": "auto",
  "max_results": 5
}
```

Use `domain` for targeted searches such as `react.dev` or `github.com`. Intent detection always receives the original query; `site:<domain>` is appended only afterward for provider execution.

```json
{
  "query": "server components reference",
  "domain": "react.dev",
  "strategy": "auto",
  "max_results": 5
}
```

Use `deep=true` only when the client needs the server to fetch top pages and extract a likely answer from page text. The MCP client LLM remains responsible for final reasoning and summarization.

Search snippets with old detected dates include a short freshness warning so clients can treat stale sources carefully.

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
| `SEARCH_PROVIDERS` | `duckduckgo,bing` | Comma-separated provider allowlist/order. Supported values: `duckduckgo`, `bing`, `brave`, `google`. `fallback` preserves this order; `aggregate` uses all configured providers; `auto` intersects profile preferences with this set. |
| `ENABLE_CROSSLINGUAL` | `false` | Enables language detection and cross-lingual search support. This can trigger first-run local model downloads. When disabled, query heuristics still infer supported locales such as Turkish. |
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

`npm run smoke:mcp` starts the compiled server over stdio, verifies the three `web_search` strategy values (`fallback`, `aggregate`, `auto`), checks routing diagnostics from `server_status`, and confirms that `fetch_content` blocks localhost. It does not perform a live provider search, keeping CI independent of search-engine HTML/network availability.

Deterministic TR/EN routing fixtures live in `evals/search-routing/queries.jsonl` and are exercised by the normal Vitest suite. They validate intent coverage, conservative heuristic behavior, ambiguity defer cases, and provider-allowlist enforcement without loading the real classifier or contacting providers.

## Troubleshooting

- If startup fails after install, run `npx playwright install chromium`.
- If the first model-backed request is slow, allow the Transformers.js model download to complete and retry.
- If search returns no results, change `SEARCH_PROVIDERS` order/set or try a direct `fetch_content` URL.
- If aggregate mode is too slow or triggers provider blocking, use the default `fallback` strategy.
- If `auto` chooses too broad a search plan for your use case, use explicit `fallback` or `aggregate`; explicit strategies bypass the auto planner.
- If Docker cannot find Chromium, rebuild the image with `npm run docker:build`.
- If cache files appear in the project root, set `CACHE_DB_PATH` to a dedicated data directory.

## npm Packaging

The npm package includes only `build/`, `README.md`, `LICENSE`, and `SECURITY.md`. `npm pack` runs `npm run build` through `prepack` so the package contains compiled JavaScript instead of local planning files, tests, caches, or source-only artifacts.

## Security

See `SECURITY.md` for reporting instructions and current dependency audit notes.

## License

ISC
