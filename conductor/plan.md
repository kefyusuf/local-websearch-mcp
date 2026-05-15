# MCP Web Search Server Plan

## Objective
Create a standalone MCP (Model Context Protocol) server that performs web searches and fetches webpage content in Markdown format, without relying on external search APIs like Google Custom Search or Bing. It will operate locally using headless browser automation and HTML parsing.

## Architecture & Tech Stack
- **Runtime**: Node.js
- **Language**: TypeScript
- **MCP Framework**: `@modelcontextprotocol/sdk` (using `stdio` transport for local integration).
- **Scraping Engine**: Playwright (`playwright` / `playwright-core`) to handle JS-heavy sites and bypass simple bot protections.
- **Content Cleaning**: `@mozilla/readability` (via `jsdom`) to extract the main article content and strip out boilerplate (navbars, footers, ads).
- **Markdown Conversion**: `turndown` to convert the cleaned HTML into token-efficient Markdown.
- **Character Encoding**: `iconv-lite` to correctly parse character sets (e.g., ISO-8859-9 for Turkish sites) and prevent mangled characters.

## Tool Definitions

### 1. `web_search`
- **Description**: Performs a web search for a given query and returns a list of results.
- **Input Schema**:
  - `query` (string): The search term.
- **Process**: Uses Playwright to navigate to a privacy-friendly search engine (like DuckDuckGo HTML version: `https://html.duckduckgo.com/html/` or Google with `&udm=14`). Extracts the title, URL, and snippet for the top results.
- **Output**: A structured JSON array containing objects with `title`, `url`, and `snippet`.

### 2. `fetch_content`
- **Description**: Fetches the content of a specific URL, cleans it, and converts it to Markdown.
- **Input Schema**:
  - `url` (string): The exact URL to fetch (typically obtained from `web_search`).
- **Process**: 
  1. Playwright navigates to the URL and extracts the raw HTML.
  2. The HTML is passed to JSDOM and `@mozilla/readability` to extract the main article.
  3. `turndown` converts the Readability output into Markdown.
- **Output**: The clean Markdown text of the webpage.

## Phase 2: Advanced Features (Current)

### 2.1 Content Persistence (Full Content Caching)
- **Goal**: Cache the Markdown content of fetched URLs in SQLite to avoid redundant scraping.
- **Task**: Modify `fetch_content` to check the database before launching Playwright.

### 2.2 Semantic Re-ranking
- **Goal**: Use local embedding models to re-sort search results based on semantic relevance to the query.
- **Task**: Implement a re-ranking function using `Transformers.js` to compare query vectors with search result snippet vectors.

### 2.3 Search Engine Fallback
- **Goal**: Ensure reliability by supporting multiple search providers.
- **Task**: Add support for Google Web (`udm=14`) and DuckDuckGo Lite as fallback options if the primary provider (Brave) fails.

## Phase 3: Validation & Refinement
- **Testing**: End-to-end testing of the cache hit/miss scenarios.
- **Performance**: Optimize browser launch times and database query efficiency.

## Phase 4: Production Readiness & Advanced AI (Next)

### 4.1 Performance: Browser Context Pooling
- **Goal**: Eliminate browser startup latency on every search.
- **Task**: Implement a singleton Playwright browser instance that stays alive. Incoming requests will use `browser.newContext()` and close only the context, keeping the main process warm.

### 4.2 Scalability: `sqlite-vec` Integration
- **Goal**: Move from JS-based brute-force vector search to native C-level vector indexing for scalability (>10k records).
- **Task**: Integrate `sqlite-vec` to create virtual tables for semantic cache. Implement a fallback to JSON-based brute-force if native compilation fails on the host system.

### 4.3 Intelligence: Search Intent Classification
- **Goal**: Understand what the user is looking for before executing the search.
- **Task**: Use `Transformers.js` (Zero-shot classification) to categorize the query (e.g., News, Technical, General) to dynamically adjust Cache TTL and processing strategy.

### 4.4 Intelligence: Local Cross-lingual Support
- **Goal**: Improve results for technical queries that might lack local language resources.
- **Task**: Implement local language detection. If a technical query is detected in a non-English language, perform an auxiliary background search using English terms and merge the results via Semantic Re-ranking.
