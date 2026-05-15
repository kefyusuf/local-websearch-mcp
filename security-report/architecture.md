# Project Architecture Map

## Overview
- **Project Name:** my-websearch-mcp
- **Type:** Model Context Protocol (MCP) Server
- **Language:** TypeScript (Node.js)

## Components

### 1. MCP Interface (`src/index.ts`)
- **Transport:** Stdio
- **Tools exposed:** `web_search`, `fetch_content`
- **Validation:** Zod schemas

### 2. Scraping Engine (Playwright)
- **Primary Search:** Brave Search (Direct scraping)
- **Fallback Search:** Google (Direct scraping)
- **Content Fetching:** Direct navigation to provided URLs.

### 3. Processing Pipeline
- **Cleaning:** `@mozilla/readability` + `JSDOM`
- **Conversion:** `Turndown` (HTML to Markdown)
- **Encoding:** `iconv-lite`

### 4. Semantic Cache & Persistence
- **Embedding:** `Transformers.js` (`all-MiniLM-L6-v2`)
- **Storage:** SQLite (`better-sqlite3`)
- **Logic:** `SemanticCache` (Similarity threshold check)

## Data Flow
1. User input -> MCP Tool Call -> Validation (Zod)
2. Semantic Cache Check (SQLite + Vectors)
3. If miss: Browser Automation (Playwright) -> External Web
4. Parsing (Readability) -> Storage (SQLite) -> Return (MCP Result)

## Security Boundaries
- **Inbound:** MCP Stdio (Local only)
- **Outbound:** HTTP/HTTPS via Playwright (Global access)
- **Local:** SQLite DB file (`websearch_cache.db`), Node.js environment.
