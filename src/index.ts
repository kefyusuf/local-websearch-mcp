import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { chromium, Browser, BrowserContext } from "playwright";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { LRUCache } from "lru-cache";
import TurndownService from "turndown";
import { z } from "zod";
import iconv from "iconv-lite";
import { isPrivateHost } from "./ssrf.js";
import { TransformersEmbeddingProvider } from "./cache/embedding.js";
import { SQLiteVectorStore } from "./cache/sqlite-store.js";
import { SemanticCache } from "./cache/semantic-cache.js";
import { CrossLingualEngine } from "./cache/crosslingual.js";
import { OllamaClient } from "./llm/ollama.js";
import type { SearchResultItem } from "./cache/types.js";
import { createSearchRateLimiter, createFetchRateLimiter, TokenBucket } from "./rate-limiter.js";
import { SearchIntent } from "./cache/intent.js";
import type { SearchProvider } from "./providers/base.js";
import { ProviderHealthTracker } from "./providers/health.js";
import { buildProviders } from "./providers/registry.js";
import {
  resolveSearchLocale,
  type SearchLocale,
} from "./search-utils.js";

// --- Types & Schemas ---

const SearchSchema = z.object({
  query: z.string().min(1).describe("The search query to perform"),
});

const FetchSchema = z.object({
  url: z.string().url().describe("The URL of the webpage to fetch and convert to markdown"),
  force_refresh: z.boolean().optional().describe("If true, bypass cache and fetch fresh content from the web"),
});

type PageCacheEntry = {
  url: string;
  title: string;
  content: string;
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

export class WebSearchServer {
  private server: Server;
  private browser: Browser | null = null;
  private browserContext: BrowserContext | null = null;
  private turndown: TurndownService;
  private cache: SemanticCache;
  private crossLingual: CrossLingualEngine | null = null;
  private searchLimiter: TokenBucket;
  private fetchLimiter: TokenBucket;
  private providers: SearchProvider[] = [];
  private healthTracker = new ProviderHealthTracker();
  private enableCrosslingual: boolean;
  private fetchWaitUntil: "domcontentloaded" | "networkidle";
  private pageCache: LRUCache<string, PageCacheEntry>;
  private ollamaClient: OllamaClient | null = null;
  private readonly MAX_CONTENT_CHARS = 50_000;
  private readonly startedAt = Date.now();

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
    const vectorStore = new SQLiteVectorStore(getEnv("CACHE_DB_PATH", "websearch_cache.db"));
    this.cache = new SemanticCache(embeddingProvider, vectorStore);
    this.pageCache = new LRUCache({
      max: 100,
      ttl: 10 * 60 * 1000,
    });

    if (getEnvBool("ENABLE_OLLAMA", false)) {
      this.ollamaClient = new OllamaClient(
        getEnv("OLLAMA_URL", "http://localhost:11434"),
        getEnv("OLLAMA_MODEL", "llama3.2")
      );
      console.error(
        "Ollama integration enabled: " +
          getEnv("OLLAMA_URL", "http://localhost:11434") +
          " model=" +
          getEnv("OLLAMA_MODEL", "llama3.2")
      );
    }

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
    const order = getEnvArray("SEARCH_PROVIDERS", "duckduckgo,bing");
    this.providers = buildProviders(order);
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
      this.pageCache.clear();
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
          description: "Search the web and return top results with an extracted answer. Use for factual questions, current versions, prices, or any live information.",
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
        {
          name: "server_status",
          description: "Returns the current status of the MCP server: active search providers, cache statistics, model load state, and uptime. Use this to check if the server is healthy before issuing search requests.",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
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
        } else if (name === "server_status") {
          return await this.handleStatus();
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
    const queryLocale = resolveSearchLocale(query, this.crossLingual
      ? await this.crossLingual.detectLanguage(query).catch(() => "eng_Latn")
      : "eng_Latn");
    const cached = await this.cache.get(query);

    if (cached !== null && cached.length > 0) {
      console.error(`Semantic cache hit for query: ${query}`);
      return this.buildSearchResponse(query, cached);
    }

    // Search across configured providers
    const results = await this.executeProviderSearch(query, queryLocale);

    if (results.length === 0) {
      const configured = getEnvArray("SEARCH_PROVIDERS", "duckduckgo,bing,brave,google");
      return {
        content: [{ type: "text", text: `Search failed: all configured providers returned no results. Tried: ${configured.join(", ")}. Check network connectivity or SEARCH_PROVIDERS env.` }],
        isError: true,
      };
    }

    await this.cache.set(query, results);
    return this.buildSearchResponse(query, results);
  }

  private async buildSearchResponse(query: string, results: SearchResultItem[]) {
    const urls = results.slice(0, 2).map((result) => result.url).filter(Boolean);
    const pages = await Promise.all(urls.map((url) => this.fetchPageContent(url)));
    const validPages = pages.filter((page): page is PageCacheEntry => page !== null);

    if (validPages.length > 0) {
      const combinedContent = validPages.map((page) => `# ${page.title}\n${page.content}`).join("\n\n---\n\n");
      const sourceUrls = validPages.map((page) => page.url);
      let answer: string;
      if (this.ollamaClient) {
        const ollamaAnswer = await this.ollamaClient.summarize(combinedContent, query);
        if (ollamaAnswer) {
          const sources = sourceUrls.map((url, i) => `Source ${i + 1}: ${url}`).join("\n");
          answer = `Answer: ${ollamaAnswer}\n\n${sources}`;
        } else {
          answer = extractAnswerFromContent(query, combinedContent, sourceUrls);
        }
      } else {
        answer = extractAnswerFromContent(query, combinedContent, sourceUrls);
      }
      return {
        content: [{ type: "text", text: answer }],
      };
    }

    const rankedResults = await this.cache.reRankResults(query, results);
    return {
      content: [{ type: "text", text: formatSearchResults(query, rankedResults) }],
    };
  }

  private async executeProviderSearch(query: string, locale: SearchLocale): Promise<SearchResultItem[]> {
    for (const provider of this.providers) {
      if (!this.healthTracker.isAvailable(provider.name)) {
        console.error(`Skipping provider ${provider.name}: provider is in backoff window`);
        continue;
      }

      try {
        const results = await provider.execute(query, locale);
        if (results.length > 0) {
          this.healthTracker.record(provider.name, true);
          console.error(`Provider ${provider.name} returned ${results.length} results`);
          return results;
        }
        this.healthTracker.record(provider.name, false);
        console.error(`Provider ${provider.name} returned 0 parsed results`);
      } catch (e) {
        this.healthTracker.record(provider.name, false);
        console.error(`Provider ${provider.name} error:`, e instanceof Error ? e.message : String(e));
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

    // HTTP-first: try plain fetch before spinning up Playwright
    if (!process.env.FORCE_PLAYWRIGHT) {
      const httpResult = await this.fetchViaHttp(url);
      if (httpResult) {
        const dom = new JSDOM(httpResult.html, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();
        if (article?.content && article.content.length > 200) {
          const markdown = this.turndown.turndown(article.content);
          const truncatedMarkdown = this.truncateContent(markdown);
          const title = article.title || "Untitled Page";
          const fullText = `# ${title}\n\n${truncatedMarkdown}`;
          let intent: SearchIntent | undefined;
          if (this.enableCrosslingual) {
            intent = await this.cache.detectIntent(title + " " + truncatedMarkdown.slice(0, 200));
          }
          await this.cache.setCachedContent(url, fullText, title, intent);
          return { content: [{ type: "text", text: fullText }] };
        }
      }
    }
    // Fall through to Playwright for JS-rendered pages

    // 2. Fetch Fresh Content
    const context = await this.getBrowserContext();
    const page = await context.newPage();

    try {
      let response;
      try {
        response = await page.goto(url, { waitUntil: this.fetchWaitUntil, timeout: 30000 });
      } catch (error) {
        const shouldRetry =
          this.fetchWaitUntil === "networkidle" &&
          error instanceof Error &&
          error.name === "TimeoutError";

        if (!shouldRetry) throw error;

        console.error(`Fetch navigation timed out with networkidle for ${url}, retrying with domcontentloaded`);
        response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      }

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
      const truncatedMarkdown = this.truncateContent(markdown);
      const title = article.title || "Untitled Page";
      const fullText = `# ${title}\n\n${truncatedMarkdown}`;

      // Detect intent for TTL-based caching
      let intent: SearchIntent | undefined;
      if (this.enableCrosslingual) {
        intent = await this.cache.detectIntent(title + " " + truncatedMarkdown.slice(0, 200));
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

  private async handleStatus() {
    const cacheStats = this.cache.getCacheStats();
    const status = {
      providers: this.providers.map((provider) => ({
        name: provider.name,
        available: this.healthTracker.isAvailable(provider.name),
      })),
      cache: cacheStats,
      browser: this.browser ? "running" : "idle",
      crosslingual: this.enableCrosslingual ? "enabled" : "disabled",
      ollama: this.ollamaClient ? "enabled" : "disabled",
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
    };
  }

  private truncateContent(markdown: string): string {
    return markdown.length > this.MAX_CONTENT_CHARS
      ? `${markdown.slice(0, this.MAX_CONTENT_CHARS)}\n\n_[Content truncated at 50,000 characters]_`
      : markdown;
  }

  private async fetchViaHttp(url: string): Promise<{ html: string; buffer: Buffer } | null> {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 500) return null;

      let html = buffer.toString("utf-8");
      // charset detection (same logic as Playwright path)
      const head = buffer.subarray(0, 2048).toString("ascii");
      const charsetMatch = head.match(/<meta[^>]+charset=["']?\s*([a-zA-Z0-9-]+)/i);
      if (charsetMatch) {
        const detectedCharset = charsetMatch[1].toLowerCase();
        if (detectedCharset !== "utf-8" && !detectedCharset.includes("utf")) {
          const iconvModule = await import("iconv-lite");
          html = iconvModule.default.decode(buffer, detectedCharset);
        }
      }
      return { html, buffer };
    } catch {
      return null;
    }
  }

  private async fetchPageContent(url: string): Promise<PageCacheEntry | null> {
    // Check in-memory cache first
    const cached = this.pageCache.get(url);
    if (cached) {
      console.error(`Page cache hit: ${url}`);
      return cached;
    }

    try {
      // HTTP-first attempt
      if (!process.env.FORCE_PLAYWRIGHT) {
        const httpResult = await this.fetchViaHttp(url);
        if (httpResult) {
          const dom = new JSDOM(httpResult.html, { url });
          const reader = new Readability(dom.window.document);
          const article = reader.parse();
          if (article?.content && article.content.length > 200) {
            const markdown = this.turndown.turndown(article.content);
            const truncatedMarkdown = this.truncateContent(markdown);
            const result: PageCacheEntry = { url, title: article.title || "Untitled", content: truncatedMarkdown };
            this.pageCache.set(url, result);
            return result;
          }
        }
      }
      // Fall through to Playwright

      const context = await this.getBrowserContext();
      const page = await context.newPage();
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        const buffer = await response?.body();
        if (!buffer) return null;

        let html = buffer.toString("utf-8");
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
        if (!article || !article.content) return null;

        const markdown = this.turndown.turndown(article.content);
        const truncatedMarkdown = this.truncateContent(markdown);
        const result = { url, title: article.title || "Untitled", content: truncatedMarkdown };
        this.pageCache.set(url, result);
        return result;
      } finally {
        await page.close().catch(() => {});
      }
    } catch {
      return null;
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

function extractAnswerFromContent(question: string, combinedContent: string, sourceUrls: string[]): string {
  const lowerContent = combinedContent.toLowerCase();
  const lowerQuestion = question.toLowerCase();
  const questionWords = lowerQuestion.split(/\s+/);

  // Extract version numbers from content
  const versionRegex = /(\w+)\s+(\d+)\.(\d+)(?:\.(\d+))?/g;
  const versions: { name: string; major: number; minor: number; patch: number; context: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = versionRegex.exec(combinedContent)) !== null) {
    const name = match[1];
    const major = parseInt(match[2]);
    const minor = parseInt(match[3]);
    const patch = match[4] ? parseInt(match[4]) : 0;
    const start = Math.max(0, match.index - 60);
    const end = Math.min(combinedContent.length, match.index + match[0].length + 100);
    const context = combinedContent.slice(start, end).replace(/\n+/g, " ").trim();
    versions.push({ name, major, minor, patch, context });
  }

  // Find best answer
  let answer = "";

  // Strategy 1: Version question with labeled versions
  if (versions.length > 0) {
    // Find versions whose name appears in the question
    const relevantVersions = versions.filter(v => {
      const nameLower = v.name.toLowerCase();
      return questionWords.some(w => nameLower.includes(w) || w.includes(nameLower));
    });

    const candidates = relevantVersions.length > 0 ? relevantVersions : versions;

    const best = candidates.reduce((a, b) =>
      a.major !== b.major ? (a.major > b.major ? a : b) :
      a.minor !== b.minor ? (a.minor > b.minor ? a : b) :
      a.patch > b.patch ? a : b
    );

    answer = `The latest ${best.name} version is ${best.name} ${best.major}.${best.minor}` +
      (best.patch > 0 ? `.${best.patch}` : "") + ".\n";

    // Add context from source
    const contextClean = best.context
      .replace(best.name, `**${best.name} ${best.major}.${best.minor}**`);
    answer += `\nContext: ${contextClean}\n`;
  }

  // Strategy 2: General factual answer - find sentence with most question word matches
  if (!answer) {
    const sentences = combinedContent.split(/[.!?]+\s+/);
    let bestSentence = "";
    let bestScore = 0;

    for (const sentence of sentences) {
      const lowerSentence = sentence.toLowerCase();
      const score = questionWords.filter(w => lowerSentence.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        bestSentence = sentence.trim();
      }
    }

    if (bestSentence && bestScore > 0) {
      answer = bestSentence + ".\n";
    }
  }

  // Fallback
  if (!answer) {
    // Return first meaningful paragraph
    const paragraphs = combinedContent.split(/\n\n+/).filter(p => p.trim().length > 50);
    answer = paragraphs.length > 0 ? paragraphs[0].trim() + "\n" : "Could not extract a specific answer from the content.";
  }

  // Add sources
  const sources = sourceUrls.map((url, i) => `Source ${i + 1}: ${url}`).join("\n");
  return `Answer: ${answer}\n\n${sources}`;
}

function formatSearchResults(query: string, results: SearchResultItem[]): string {
  const foundVersions: { label: string; major: number; minor: number; patch: number }[] = [];

  for (const r of results) {
    const text = `${r.title} ${r.snippet}`;
    let m: RegExpExecArray | null;
    const re = /(?:^|\s)(\d+)\.(\d+)(?:\.(\d+))?/g;
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(Math.max(0, m.index - 20), m.index);
      const labelMatch = before.match(/(\w+)\s*$/);
      const label = labelMatch ? labelMatch[1] : "";
      foundVersions.push({
        label,
        major: parseInt(m[1]),
        minor: parseInt(m[2]),
        patch: m[3] ? parseInt(m[3]) : 0,
      });
    }
  }

  let summary = "";
  if (foundVersions.length > 0) {
    const best = foundVersions.reduce((a, b) =>
      a.major !== b.major ? (a.major > b.major ? a : b) :
      a.minor !== b.minor ? (a.minor > b.minor ? a : b) :
      a.patch > b.patch ? a : b
    );
    const labelText = best.label ? `${best.label} ${best.major}.${best.minor}` : `v${best.major}.${best.minor}`;
    summary = `Answer: The latest version found is ${labelText}.\n\n`;
  }

  const formatted = results.map((r, i) =>
    `${i + 1}. "${r.title}" - ${r.url}\n   ${r.snippet || "(no description)"}`
  ).join("\n\n");

  return summary + formatted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = new WebSearchServer();
  server.run().catch(console.error);
}
