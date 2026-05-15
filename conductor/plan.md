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

## Phase 2: Advanced Features ✅ COMPLETED
- 2.1 Content Persistence — Done
- 2.2 Semantic Re-ranking — Done
- 2.3 Search Engine Fallback (Brave → Google → DuckDuckGo) — Done

## Phase 3: Validation & Refinement ✅ COMPLETED
- Testing: 19 unit tests (vitest)
- Performance: Browser context pooling implemented

## Phase 4: Production Readiness & Advanced AI ✅ COMPLETED
- 4.1 Browser Context Pooling — Done
- 4.2 sqlite-vec Integration — Done (with JS fallback)
- 4.3 Search Intent Classification — Done
- 4.4 Cross-lingual Search — Done (lang detect + on-demand translation + parallel search)
- 4.5 Rate Limiting — Done (Token bucket, env-configurable)
- 4.6 Encoding Detection — Done (meta charset-based)
- 4.7 SSRF Protection — Done
