import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium, Browser, BrowserContext } from "playwright";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { z } from "zod";
import iconv from "iconv-lite";
import { isPrivateHost } from "./ssrf.js";
import { TransformersEmbeddingProvider } from "./cache/embedding.js";
import { SQLiteVectorStore } from "./cache/sqlite-store.js";
import { SemanticCache } from "./cache/semantic-cache.js";
import { CrossLingualEngine } from "./cache/crosslingual.js";
import { createSearchRateLimiter, createFetchRateLimiter, TokenBucket } from "./rate-limiter.js";
import { SearchIntent } from "./cache/intent.js";

// --- Types & Schemas ---

const SearchSchema = z.object({
  query: z.string().min(1).describe("The search query to perform"),
});

const FetchSchema = z.object({
  url: z.string().url().describe("The URL of the webpage to fetch and convert to markdown"),
  force_refresh: z.boolean().optional().describe("If true, bypass cache and fetch fresh content from the web"),
});

// --- Search Provider Types ---

type SearchProvider = {
  priority: number;
  execute: (query: string) => Promise<any[]>;
};

type ProviderResult = {
  results: any[];
  provider: string;
};

// --- Env Configuration ---

function getEnvArray(key: string, defaultVal: string): string[] {
  const raw = process.env[key] || defaultVal;
  return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function getEnv(key: string, defaultVal: string): string {
  return process.env[key] || defaultVal;
}

function getEnvBool(key: string, defaultVal: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return defaultVal;
  return raw === "true" || raw === "1";
}

// --- Server Implementation ---

class WebSearchServer {
  private server: Server;
  private browser: Browser | null = null;
  private browserContext: BrowserContext | null = null;
  private turndown: TurndownService;
  private cache: SemanticCache;
  private crossLingual: CrossLingualEngine | null = null;
  private searchLimiter: TokenBucket;
  private fetchLimiter: TokenBucket;
  private providers: SearchProvider[] = [];
  private enableCrosslingual: boolean;
  private fetchWaitUntil: "domcontentloaded" | "networkidle";

  constructor() {
    this.server = new Server(
      {
        name: "my-websearch-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      emDelimiter: "_",
    });

    this.enableCrosslingual = getEnvBool("ENABLE_CROSSLINGUAL", false);
    this.fetchWaitUntil = getEnv("FETCH_WAIT_UNTIL", "networkidle") === "domcontentloaded" ? "domcontentloaded" : "networkidle";

    // Initialize Semantic Cache with SQLite for persistence
    const embeddingProvider = new TransformersEmbeddingProvider();
    const vectorStore = new SQLiteVectorStore("websearch_cache.db");
    this.cache = new SemanticCache(embeddingProvider, vectorStore);

    if (this.enableCrosslingual) {
      this.crossLingual = new CrossLingualEngine();
    }

    this.searchLimiter = createSearchRateLimiter();
    this.fetchLimiter = createFetchRateLimiter();

    this.setupProviders();
    this.setupTools();
    this.setupShutdownHandlers();
  }

  private setupProviders() {
    const order = getEnvArray("SEARCH_PROVIDERS", "duckduckgo,bing,brave,google");

    const registry: Record<string, (query: string) => Promise<any[]>> = {
      duckduckgo: (q) => this.searchDDG(q),
      bing: (q) => this.searchBing(q),
      brave: (q) => this.searchBrave(q),
      google: (q) => this.searchGoogle(q),
    };

    this.providers = [];
    for (const name of order) {
      if (registry[name]) {
        this.providers.push({ priority: this.providers.length, execute: registry[name] });
        console.error(`Search provider registered: ${name}`);
      } else {
        console.error(`Unknown search provider in SEARCH_PROVIDERS: ${name}`);
      }
    }

    if (this.providers.length === 0) {
      console.error("No valid search providers configured. Defaulting to duckduckgo.");
      this.providers.push({ priority: 0, execute: (q) => this.searchDDG(q) });
    }
  }

  // --- DuckDuckGo Lite Search ---

  private async searchDDG(query: string): Promise<any[]> {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return [];

    const html = await response.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const results: any[] = [];
    const rows = doc.querySelectorAll("table.result tr");

    // DDG Lite returns results in <table class="result"> with alternating rows
    let currentTitle = "";
    let currentUrl = "";
    let currentSnippet = "";

    rows.forEach((row) => {
      const links = row.querySelectorAll("a");
      const tds = row.querySelectorAll("td");

      // Title + URL row
      if (links.length > 0) {
        links.forEach((link) => {
          const href = link.getAttribute("href") || "";
          if (href.startsWith("http")) {
            currentUrl = href;
          }
        });
        const snippetTd = row.querySelector("td.snippet, td.result-snippet");
        if (snippetTd) {
          currentSnippet = snippetTd.textContent?.trim() || "";
        }
        const titleEl = row.querySelector(".result-link a, a.result-link");
        if (titleEl) {
          currentTitle = titleEl.textContent?.trim() || "";
          if (currentTitle && currentUrl) {
            results.push({ title: currentTitle, url: currentUrl, snippet: currentSnippet, source: "duckduckgo" });
            currentTitle = "";
            currentUrl = "";
            currentSnippet = "";
          }
        }
      }

      // Snippet-only row (alternate row in DDG Lite table)
      if (tds.length === 1 && !currentUrl) {
        const text = tds[0].textContent?.trim();
        if (text && results.length > 0) {
          results[results.length - 1].snippet = text;
        }
      }
    });

    return results.slice(0, 10).filter((r: any) => r.title && r.url);
  }

  // --- Bing Search (Fallback) ---

  private async searchBing(query: string): Promise<any[]> {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=en-US`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return [];

    const html = await response.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    return Array.from(doc.querySelectorAll(".b_algo")).slice(0, 10).map((el) => {
      const h2 = el.querySelector("h2");
      const link = h2?.querySelector("a");
      const desc = el.querySelector(".b_caption p");
      const cite = el.querySelector("cite");
      const rawUrl = link?.getAttribute("href") || "";
      const cleanUrl = citeToUrl(cite?.textContent?.trim() || "") || rawUrl;
      return {
        title: h2?.textContent?.trim() || "",
        url: cleanUrl,
        snippet: desc?.textContent?.trim() || "",
        source: "bing",
      };
    }).filter((r: any) => r.title && r.url);
  }

  // --- Brave Search (Fallback) ---

  private async searchBrave(query: string): Promise<any[]> {
    const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return [];

    const html = await response.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    return Array.from(doc.querySelectorAll("div.snippet")).slice(0, 10).map((el) => {
      const link = el.querySelector("a.l1");
      const desc = el.querySelector(".generic-snippet .content, .inline-qa-answer");
      return {
        title: link?.textContent?.replace(link.querySelector(".site-name-wrapper")?.textContent || "", "").trim() || "",
        url: (link as HTMLAnchorElement)?.href || "",
        snippet: desc?.textContent?.trim() || "",
        source: "brave",
      };
    }).filter((r: any) => r.title && r.url);
  }

  // --- Google Search (Fallback) ---

  private async searchGoogle(query: string): Promise<any[]> {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=14`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return [];

    const html = await response.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    return Array.from(doc.querySelectorAll("div.g")).slice(0, 7).map((el) => {
      const titleEl = el.querySelector("h3");
      const linkEl = el.querySelector("a") as HTMLAnchorElement;
      const snippetEl = el.querySelector("div[style*='-webkit-line-clamp'], span.aCOpRe");
      return {
        title: titleEl?.textContent?.trim() || "",
        url: linkEl?.href || "",
        snippet: snippetEl?.textContent?.trim() || "",
        source: "google",
      };
    }).filter((r: any) => r.title && r.url);
  }

  private async getBrowser() {
    if (!this.browser) {
      console.error("Launching persistent browser instance...");
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  private async getBrowserContext(): Promise<BrowserContext> {
    if (!this.browserContext) {
      const browser = await this.getBrowser();
      this.browserContext = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      });
      console.error("Persistent browser context created.");
    }
    return this.browserContext;
  }

  private setupShutdownHandlers() {
    const shutdown = async () => {
      console.error("Shutting down Web Search MCP Server...");
      if (this.browserContext) {
        try { await this.browserContext.close(); } catch {}
        this.browserContext = null;
      }
      if (this.browser) {
        try { await this.browser.close(); } catch {}
        this.browser = null;
      }
      this.cache.close();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGHUP", shutdown);
  }

  private setupTools() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "web_search",
          description: "Search the web and return top results re-ranked by relevance. Supports multiple search engines with automatic fallback.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
        {
          name: "fetch_content",
          description: "Fetch a webpage and return its content as clean Markdown. Uses smart caching based on content type.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              force_refresh: { type: "boolean" },
            },
            required: ["url"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        if (name === "web_search") {
          return await this.handleSearch(args);
        } else if (name === "fetch_content") {
          return await this.handleFetch(args);
        } else {
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
        }
      } catch (error: unknown) {
        return {
          content: [{ type: "text", text: `Internal error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    });
  }

  private async handleSearch(args: unknown) {
    const { allowed, retryAfterMs } = this.searchLimiter.tryConsume();
    if (!allowed) {
      const seconds = Math.ceil(retryAfterMs / 1000);
      return {
        content: [{ type: "text", text: `Rate limit exceeded: web_search allows ${process.env.RATE_LIMIT_SEARCH_PER_MIN || "10"} requests per minute. Retry in ${seconds} seconds.` }],
        isError: true,
      };
    }

    const { query } = SearchSchema.parse(args);

    // 1. Check Semantic Search Cache
    const cachedResults = await this.cache.get(query);
    if (cachedResults) {
      return {
        content: [{ type: "text", text: JSON.stringify(cachedResults, null, 2) }],
      };
    }

    // 2. Optional Cross-lingual search
    if (this.enableCrosslingual && this.crossLingual) {
      const intent = await this.cache.detectIntent(query);
      console.error(`Detected Intent: ${intent}`);

      const lang = await this.crossLingual.detectLanguage(query);
      console.error(`Detected Language: ${lang}`);

      if (this.crossLingual.shouldCrossSearch(intent, lang)) {
        const enQuery = await this.crossLingual.translateToEnglish(query, lang);
        console.error(`Cross-lingual: "${query}" → "${enQuery}"`);

        const [mainResults, auxResults] = await Promise.all([
          this.executeProviderSearch(query),
          this.executeProviderSearch(enQuery),
        ]);

        const seen = new Set<string>();
        const merged = [...mainResults, ...auxResults].filter(r => {
          const key = r.url.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const rankedResults = await this.cache.reRankResults(query, merged);
        await this.cache.set(query, rankedResults);
        return {
          content: [{ type: "text", text: JSON.stringify(rankedResults, null, 2) }],
        };
      }
    }

    // 3. Standard Search with fallback across configured providers
    const results = await this.executeProviderSearch(query);

    if (results.length === 0) {
      const configured = getEnvArray("SEARCH_PROVIDERS", "duckduckgo,bing,brave,google");
      return {
        content: [{ type: "text", text: `Search failed: all configured providers returned no results. Tried: ${configured.join(", ")}. Check network connectivity or SEARCH_PROVIDERS env.` }],
        isError: true,
      };
    }

    // 4. Semantic Re-ranking
    const rankedResults = await this.cache.reRankResults(query, results);
    await this.cache.set(query, rankedResults);

    return {
      content: [{ type: "text", text: JSON.stringify(rankedResults, null, 2) }],
    };
  }

  private async executeProviderSearch(query: string): Promise<any[]> {
    for (const provider of this.providers) {
      try {
        const results = await provider.execute(query);
        if (results.length > 0) {
          console.error(`Provider returned ${results.length} results`);
          return results;
        }
      } catch (e) {
        console.error(`Provider error:`, e instanceof Error ? e.message : String(e));
      }
    }
    return [];
  }

  private async handleFetch(args: unknown) {
    const { allowed, retryAfterMs } = this.fetchLimiter.tryConsume();
    if (!allowed) {
      const seconds = Math.ceil(retryAfterMs / 1000);
      return {
        content: [{ type: "text", text: `Rate limit exceeded: fetch_content allows ${process.env.RATE_LIMIT_FETCH_PER_MIN || "20"} requests per minute. Retry in ${seconds} seconds.` }],
        isError: true,
      };
    }

    const { url, force_refresh } = FetchSchema.parse(args);

    // SSRF Protection: Block local/private resources via DNS resolution
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;

    if (await isPrivateHost(hostname)) {
      return {
        content: [{ type: "text", text: `Access to local/private resource is blocked for security reasons: ${hostname}` }],
        isError: true,
      };
    }

    // 1. Check Content Cache
    if (!force_refresh) {
      const cachedContent = await this.cache.getCachedContent(url);
      if (cachedContent) {
        return {
          content: [{ type: "text", text: cachedContent }],
        };
      }
    }

    // 2. Fetch Fresh Content
    const context = await this.getBrowserContext();
    const page = await context.newPage();

    try {
      const response = await page.goto(url, { waitUntil: this.fetchWaitUntil, timeout: 30000 });
      const buffer = await response?.body();
      
      if (!buffer) {
        return {
          content: [{ type: "text", text: "Could not fetch page content." }],
          isError: true,
        };
      }

      let html = buffer.toString("utf-8");
      // Detect charset from meta tag for proper encoding
      const head = buffer.subarray(0, 2048).toString("ascii");
      const charsetMatch = head.match(/<meta[^>]+charset=["']?\s*([a-zA-Z0-9-]+)/i);
      if (charsetMatch) {
        const detectedCharset = charsetMatch[1].toLowerCase();
        if (detectedCharset !== "utf-8" && !detectedCharset.includes("utf")) {
          html = iconv.decode(buffer, detectedCharset);
        }
      }

      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (!article || !article.content) {
        return {
          content: [{ type: "text", text: "Could not parse article content from the page." }],
          isError: true,
        };
      }

      const markdown = this.turndown.turndown(article.content);
      const title = article.title || "Untitled Page";
      const fullText = `# ${title}\n\n${markdown}`;

      // Detect intent for TTL-based caching
      let intent: SearchIntent | undefined;
      if (this.enableCrosslingual) {
        intent = await this.cache.detectIntent(title + " " + markdown.slice(0, 200));
      }

      // Save to Content Cache with intent-based TTL
      await this.cache.setCachedContent(url, fullText, title, intent);

      return {
        content: [{ type: "text", text: fullText }],
      };
    } finally {
      try {
        await page.close();
      } catch (e) {
        console.error("Error closing page:", e);
      }
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Web Search MCP Server running on stdio");
  }
}

function citeToUrl(text: string): string {
  if (!text) return "";
  try {
    const url = text.replace(/\s*›\s*/g, "/").replace(/\s+/g, "");
    new URL(url);
    return url;
  } catch {
    return "";
  }
}

const server = new WebSearchServer();
server.run().catch(console.error);
