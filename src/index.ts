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
  executeProviderSearch as executeSearch,
  executeSearchPlan,
  type SearchStrategy,
} from "./search/executor.js";
import { SearchIntentDetector, type IntentDetector } from "./search/intent.js";
import { planSearch } from "./search/planner.js";
import { ROUTING_PROFILE_VERSION } from "./search/profiles.js";
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
  strategy: z.enum(["fallback", "aggregate", "auto"]).optional().describe("Search execution strategy. fallback tries providers in order and stops at the first success. aggregate queries all available providers and fuses results with Reciprocal Rank Fusion. auto detects search intent and selects a configured-provider plan before using the existing fallback or aggregate execution path."),
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
  private fetchWaitUntil: "domcontentloaded" | "networkidle";
  private cacheDbPath: string;
  private contentFetcher: ContentFetcher;
  private intentDetector: IntentDetector;
  private readonly startedAt = Date.now();

  constructor(intentDetector: IntentDetector = new SearchIntentDetector()) {
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
    this.fetchWaitUntil = getEnv("FETCH_WAIT_UNTIL", "networkidle") === "domcontentloaded" ? "domcontentloaded" : "networkidle";
    this.cacheDbPath = getEnv("CACHE_DB_PATH", "websearch_cache.db");
    this.intentDetector = intentDetector;

    // Initialize Semantic Cache with SQLite for persistence. The router and content
    // cache share one detector so ambiguous requests do not create duplicate models.
    const embeddingProvider = new TransformersEmbeddingProvider();
    const vectorStore = new SQLiteVectorStore(this.cacheDbPath);
    this.cache = new SemanticCache(embeddingProvider, vectorStore, 0.75, this.intentDetector);
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
      fetchWaitUntil: this.fetchWaitUntil,
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
          description: "Search the web and return results. Use domain to restrict results to a site. Use strategy=aggregate for all configured providers, or strategy=auto for intent-aware provider planning. Use deep=true to fetch pages and extract a direct answer (slower). Use deep=false (default) for a quick ranked list of URLs and snippets.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "The search query" },
              deep: { type: "boolean", description: "Fetch pages and extract answer (default: false)" },
              max_results: { type: "number", description: "Number of results to return, 1-10 (default: 5)" },
              domain: { type: "string", description: "Optional domain filter, for example react.dev or github.com" },
              strategy: {
                type: "string",
                enum: ["fallback", "aggregate", "auto"],
                description: "fallback tries providers in order; aggregate queries all configured providers; auto detects intent and selects a configured-provider plan (default: fallback)",
              },
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
        if (error instanceof z.ZodError) {
          return {
            content: [{ type: "text", text: `Invalid arguments: ${error.issues.map((issue) => issue.message).join("; ")}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: `Internal error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    });
  }

  overrideSearchProvidersForTesting(providers: SearchProvider[]): void {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("overrideSearchProvidersForTesting is only available during tests");
    }
    this.providers = providers;
    this.healthTracker = new ProviderHealthTracker();
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

    const { query, deep = false, max_results = 5, domain, strategy = "fallback" } = SearchSchema.parse(args);
    const normalizedDomain = normalizeDomainFilter(domain);
    const providerQuery = normalizedDomain ? `${query} site:${normalizedDomain}` : query;
    const cacheKey = normalizedDomain ? `${query} domain:${normalizedDomain}` : query;
    const queryLocale = resolveSearchLocale(query, this.crossLingual
      ? await this.crossLingual.detectLanguage(query).catch(() => "eng_Latn")
      : "eng_Latn");

    // The semantic query cache currently has no strategy/provider-plan namespace.
    // Keep it only on the legacy fallback path. Aggregate and auto both bypass it;
    // deep page-content caching remains unchanged.
    const useSemanticSearchCache = strategy === "fallback";
    const cached = useSemanticSearchCache ? await this.cache.get(cacheKey) : null;

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

    let rawResults: SearchResultItem[];
    if (strategy === "auto") {
      const detection = await this.intentDetector.detect(query);
      const searchPlan = planSearch({
        intent: detection.intent,
        configuredProviderNames: this.providers.map((provider) => provider.name),
      });
      console.error(`Auto search intent: ${detection.intent} (${detection.source})`);
      console.error(
        `Auto search plan: ${searchPlan.strategy} [${searchPlan.primaryProviderNames.join(", ")}]` +
        (searchPlan.fallbackProviderNames.length > 0
          ? `, fallback [${searchPlan.fallbackProviderNames.join(", ")}]`
          : "")
      );
      rawResults = await executeSearchPlan({
        providers: this.providers,
        query: providerQuery,
        locale: queryLocale,
        plan: searchPlan,
        healthTracker: this.healthTracker,
      });
    } else {
      rawResults = await this.executeProviderSearch(providerQuery, queryLocale, strategy);
    }

    const results = filterSearchResultsByDomain(rawResults, normalizedDomain);

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: normalizedDomain
          ? `No results matched the domain filter "${normalizedDomain}". Try a broader search or fetch_content with a direct URL.`
          : "Web search is currently unavailable (all providers returned no results). Try using fetch_content with a direct URL instead, or retry the search later." }],
        isError: true,
      };
    }

    if (useSemanticSearchCache) {
      await this.cache.set(cacheKey, results);
    }

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

  private async executeProviderSearch(
    query: string,
    locale: SearchLocale,
    strategy: SearchStrategy = "fallback"
  ): Promise<SearchResultItem[]> {
    return executeSearch({
      providers: this.providers,
      query,
      locale,
      strategy,
      healthTracker: this.healthTracker,
    });
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
        ...this.healthTracker.getSnapshot(provider.name),
      })),
      cache: cacheStats,
      browser: this.browser ? "running" : "idle",
      crosslingual: this.enableCrosslingual ? "enabled" : "disabled",
      config: {
        searchProviders: this.providers.map((provider) => provider.name),
        searchStrategyDefault: "fallback",
        autoRouting: "available",
        routingProfileVersion: ROUTING_PROFILE_VERSION,
        fetchWaitUntil: this.fetchWaitUntil,
        forcePlaywright: getEnvBool("FORCE_PLAYWRIGHT", false),
        cacheDbPath: this.cacheDbPath,
      },
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
    };
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
