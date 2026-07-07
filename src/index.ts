#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { chromium, Browser, BrowserContext } from "playwright";
import { z } from "zod";
import { extractAnswerFromContent, formatSearchResults } from "./answer-extraction.js";
import { validatePublicHttpUrl } from "./ssrf.js";
import { TransformersEmbeddingProvider } from "./cache/embedding.js";
import { SQLiteVectorStore } from "./cache/sqlite-store.js";
import { SemanticCache } from "./cache/semantic-cache.js";
import { CrossLingualEngine } from "./cache/crosslingual.js";
import type { SearchResultItem } from "./cache/types.js";
import { createSearchRateLimiter, createFetchRateLimiter, TokenBucket } from "./rate-limiter.js";
import type { SearchProvider } from "./providers/base.js";
import { ProviderHealthTracker } from "./providers/health.js";
import { buildProviders } from "./providers/registry.js";
import {
  filterSearchResultsByDomain,
  normalizeDomainFilter,
  resolveSearchLocale,
  type SearchLocale,
} from "./search-utils.js";
import { ContentFetcher } from "./fetch-module.js";

// --- Types & Schemas ---

export const SearchSchema = z.object({
  query: z.string().min(1).describe("The search query to perform"),
  deep: z.boolean().optional().describe("If true, fetch the top result pages and extract a direct answer. If false (default), return a ranked list of results quickly without page fetching."),
  max_results: z.number().int().min(1).max(10).optional().describe("Maximum number of results to return (1-10, default 5)."),
  domain: z.string().min(1).optional().describe("Optional domain filter, for example react.dev or github.com."),
});

const FetchSchema = z.object({
  url: z.string().url().describe("The URL of the webpage to fetch and convert to markdown"),
  force_refresh: z.boolean().optional().describe("If true, bypass cache and fetch fresh content from the web"),
});

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
  private cache: SemanticCache;
  private crossLingual: CrossLingualEngine | null = null;
  private searchLimiter: TokenBucket;
  private fetchLimiter: TokenBucket;
  private providers: SearchProvider[] = [];
  private healthTracker = new ProviderHealthTracker();
  private enableCrosslingual: boolean;
  private contentFetcher: ContentFetcher;
  private readonly startedAt = Date.now();

  constructor() {
    this.server = new Server(
      {
        name: "local-websearch-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.enableCrosslingual = getEnvBool("ENABLE_CROSSLINGUAL", false);
    const fetchWaitUntil = getEnv("FETCH_WAIT_UNTIL", "networkidle") === "domcontentloaded" ? "domcontentloaded" : "networkidle";

    // Initialize Semantic Cache with SQLite for persistence
    const embeddingProvider = new TransformersEmbeddingProvider();
    const vectorStore = new SQLiteVectorStore(getEnv("CACHE_DB_PATH", "websearch_cache.db"));
    this.cache = new SemanticCache(embeddingProvider, vectorStore);
    const cleanupIntervalHours = parseInt(getEnv("CACHE_CLEANUP_INTERVAL_HOURS", "24"), 10);
    const cleanupIntervalMs = (isNaN(cleanupIntervalHours) || cleanupIntervalHours <= 0 ? 24 : cleanupIntervalHours) * 60 * 60 * 1000;
    setInterval(() => {
      const deleted = this.cache.deleteExpiredContent();
      if (deleted > 0) console.error(`Cache cleanup: removed ${deleted} expired content entries`);
    }, cleanupIntervalMs).unref();

    if (this.enableCrosslingual) {
      this.crossLingual = new CrossLingualEngine();
    }

    this.searchLimiter = createSearchRateLimiter();
    this.fetchLimiter = createFetchRateLimiter();
    this.contentFetcher = new ContentFetcher({
      cache: this.cache,
      getBrowserContext: () => this.getBrowserContext(),
      fetchWaitUntil,
      detectIntent: this.enableCrosslingual
        ? (text) => this.cache.detectIntent(text)
        : null,
    });

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
      this.contentFetcher.close();
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
          description: "Search the web and return results. Use domain to restrict results to a site. Use deep=true to fetch pages and extract a direct answer (slower). Use deep=false (default) for a quick ranked list of URLs and snippets.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "The search query" },
              deep: { type: "boolean", description: "Fetch pages and extract answer (default: false)" },
              max_results: { type: "number", description: "Number of results to return, 1-10 (default: 5)" },
              domain: { type: "string", description: "Optional domain filter, for example react.dev or github.com" },
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

    const { query, deep = false, max_results = 5, domain } = SearchSchema.parse(args);
    const normalizedDomain = normalizeDomainFilter(domain);
    const providerQuery = normalizedDomain ? `${query} site:${normalizedDomain}` : query;
    const cacheKey = normalizedDomain ? `${query} domain:${normalizedDomain}` : query;
    const queryLocale = resolveSearchLocale(query, this.crossLingual
      ? await this.crossLingual.detectLanguage(query).catch(() => "eng_Latn")
      : "eng_Latn");
    const cached = await this.cache.get(cacheKey);

    if (cached !== null && cached.length > 0) {
      console.error(`Semantic cache hit for query: ${query}`);
      if (deep) {
        return this.buildSearchResponse(query, cached.slice(0, max_results));
      }
      const reranked = await this.cache.reRankResults(query, cached, max_results);
      return {
        content: [{ type: "text", text: formatSearchResults(query, reranked.slice(0, max_results)) }],
      };
    }

    // Search across configured providers
    const rawResults = await this.executeProviderSearch(providerQuery, queryLocale);
    const results = filterSearchResultsByDomain(rawResults, normalizedDomain);

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: normalizedDomain
          ? `No results matched the domain filter "${normalizedDomain}". Try a broader search or fetch_content with a direct URL.`
          : "Web search is currently unavailable (all providers returned no results). Try using fetch_content with a direct URL instead, or retry the search later." }],
        isError: true,
      };
    }

    await this.cache.set(cacheKey, results);
    if (!deep) {
      const reranked = await this.cache.reRankResults(query, results, max_results);
      return {
        content: [{ type: "text", text: formatSearchResults(query, reranked.slice(0, max_results)) }],
      };
    }

    return this.buildSearchResponse(query, results.slice(0, max_results));
  }

  private async buildSearchResponse(query: string, results: SearchResultItem[]) {
    const urls = results.slice(0, 2).map((result) => result.url).filter(Boolean);
    const pages = await Promise.all(urls.map((url) => this.contentFetcher.fetchPage(url)));
    const validPages = pages.filter((page) => page !== null);

    if (validPages.length > 0) {
      const combinedContent = validPages.map((page) => `# ${page.title}\n${page.content}`).join("\n\n---\n\n");
      const sourceUrls = validPages.map((page) => page.url);
      const answer = extractAnswerFromContent(query, combinedContent, sourceUrls);
      return {
        content: [{ type: "text", text: answer }],
      };
    }

    const rankedResults = await this.cache.reRankResults(query, results, results.length);
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
          const seen = new Set<string>();
          const deduped = results.filter((result) => {
            if (!result.url || seen.has(result.url)) return false;
            seen.add(result.url);
            return true;
          });
          if (deduped.length < results.length) {
            console.error(`Deduplicated ${results.length - deduped.length} duplicate URLs from ${provider.name}`);
          }
          if (deduped.length === 0) {
            this.healthTracker.record(provider.name, false);
            console.error(`Provider ${provider.name} returned 0 parsed results after deduplication`);
            continue;
          }
          this.healthTracker.record(provider.name, true);
          console.error(`Provider ${provider.name} returned ${deduped.length} results`);
          return deduped;
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
    const validation = await validatePublicHttpUrl(url);

    if (!validation.ok) {
      return {
        content: [{ type: "text", text: `Access to unsupported or local/private resource is blocked for security reasons: ${validation.hostname ?? url}` }],
        isError: true,
      };
    }

    const result = await this.contentFetcher.fetchContent(url, force_refresh ?? false);
    if (result.kind === "error") {
      return {
        content: [{
          type: "text",
          text: result.reason === "parse_failed"
            ? "Could not parse article content from the page."
            : result.reason === "blocked_url"
              ? "Access to unsupported or local/private resource is blocked for security reasons."
              : "Could not fetch page content.",
        }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: result.text }],
    };
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
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Web Search MCP Server running on stdio");
  }
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = new WebSearchServer();
  server.run().catch(console.error);
}
