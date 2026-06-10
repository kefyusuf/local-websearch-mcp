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
import {
  parseBingResults,
  parseBraveResults,
  parseDuckDuckGoResults,
  parseGoogleResults,
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

const AnswerSchema = z.object({
  question: z.string().min(1).describe("The question to answer (e.g. 'what is the latest Laravel version?')"),
});

// --- Search Provider Types ---

type SearchProvider = {
  name: string;
  priority: number;
  execute: (query: string, locale: SearchLocale) => Promise<any[]>;
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
  private pageCache = new Map<string, { url: string; title: string; content: string; timestamp: number }>();
  private readonly PAGE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

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

    // Clear any stale cached results from previous runs
    this.cache.clearSearchCache().catch(() => {});

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

    const registry: Record<string, (query: string, locale: SearchLocale) => Promise<any[]>> = {
      duckduckgo: (q, locale) => this.searchDDG(q, locale),
      bing: (q, locale) => this.searchBing(q, locale),
      brave: (q, locale) => this.searchBrave(q, locale),
      google: (q, locale) => this.searchGoogle(q, locale),
    };

    this.providers = [];
    for (const name of order) {
      if (registry[name]) {
        this.providers.push({ name, priority: this.providers.length, execute: registry[name] });
        console.error(`Search provider registered: ${name}`);
      } else {
        console.error(`Unknown search provider in SEARCH_PROVIDERS: ${name}`);
      }
    }

    if (this.providers.length === 0) {
      console.error("No valid search providers configured. Defaulting to duckduckgo.");
      this.providers.push({ name: "duckduckgo", priority: 0, execute: (q, locale) => this.searchDDG(q, locale) });
    }
  }

  // --- DuckDuckGo Lite Search ---

  private async searchDDG(query: string, locale: SearchLocale): Promise<any[]> {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html",
        "Accept-Language": locale.acceptLanguage,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return [];

    const html = await response.text();
    return parseDuckDuckGoResults(html);
  }

  // --- Bing Search (Fallback) ---

  private async searchBing(query: string, locale: SearchLocale): Promise<any[]> {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=${encodeURIComponent(locale.market)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": locale.acceptLanguage,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return [];

    const html = await response.text();
    return parseBingResults(html);
  }

  // --- Brave Search (Fallback) ---

  private async searchBrave(query: string, locale: SearchLocale): Promise<any[]> {
    const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": locale.acceptLanguage,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return [];

    const html = await response.text();
    return parseBraveResults(html);
  }

  // --- Google Search (Fallback) ---

  private async searchGoogle(query: string, locale: SearchLocale): Promise<any[]> {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=14`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": locale.acceptLanguage,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return [];

    const html = await response.text();
    return parseGoogleResults(html);
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
        {
          name: "get_answer",
          description: "Answer a factual question by searching the web and extracting the answer from live content. Use this for questions about versions, prices, dates, or any current information.",
          inputSchema: {
            type: "object",
            properties: {
              question: { type: "string" },
            },
            required: ["question"],
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
        } else if (name === "get_answer") {
          return await this.handleAnswer(args);
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

    // Search across configured providers
    const results = await this.executeProviderSearch(query, queryLocale);

    if (results.length === 0) {
      const configured = getEnvArray("SEARCH_PROVIDERS", "duckduckgo,bing,brave,google");
      return {
        content: [{ type: "text", text: `Search failed: all configured providers returned no results. Tried: ${configured.join(", ")}. Check network connectivity or SEARCH_PROVIDERS env.` }],
        isError: true,
      };
    }

    // Fetch top 2 results and extract answer
    const urls = results.slice(0, 2).map(r => r.url).filter(Boolean);
    const pages = await Promise.all(urls.map(url => this.fetchPageContent(url)));
    const validPages = pages.filter(p => p !== null) as { url: string; title: string; content: string }[];

    if (validPages.length > 0) {
      const combinedContent = validPages.map(p => `# ${p.title}\n${p.content}`).join("\n\n---\n\n");
      const answer = extractAnswerFromContent(query, combinedContent, validPages.map(p => p.url));
      return {
        content: [{ type: "text", text: answer }],
      };
    }

    // Fallback: return ranked results
    const rankedResults = await this.cache.reRankResults(query, results);
    return {
      content: [{ type: "text", text: formatSearchResults(query, rankedResults) }],
    };
  }

  private async executeProviderSearch(query: string, locale: SearchLocale): Promise<any[]> {
    for (const provider of this.providers) {
      try {
        const results = await provider.execute(query, locale);
        if (results.length > 0) {
          console.error(`Provider ${provider.name} returned ${results.length} results`);
          return results;
        }
        console.error(`Provider ${provider.name} returned 0 parsed results`);
      } catch (e) {
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

  private async handleAnswer(args: unknown) {
    const { question } = AnswerSchema.parse(args);
    return this.handleSearch({ query: question });
  }

  private async fetchPageContent(url: string): Promise<{ url: string; title: string; content: string } | null> {
    // Check in-memory cache first
    const cached = this.pageCache.get(url);
    if (cached && Date.now() - cached.timestamp < this.PAGE_CACHE_TTL) {
      console.error(`Page cache hit: ${url}`);
      return { url: cached.url, title: cached.title, content: cached.content };
    }

    try {
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
        const result = { url, title: article.title || "Untitled", content: markdown };
        this.pageCache.set(url, { ...result, timestamp: Date.now() });
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

function formatSearchResults(query: string, results: any[]): string {
  // Extract version info from results (e.g. "Laravel 13", "v3.2.1")
  const versionPattern = /(\d+\.\d+(?:\.\d+)?)/g;
  const labeledPatterns = [
    { label: null, re: /(?:^|\s)(\d+)\.(\d+)(?:\.(\d+))?/g },
  ];

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

const server = new WebSearchServer();
server.run().catch(console.error);
