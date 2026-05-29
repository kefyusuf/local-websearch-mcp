import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { z } from "zod";
import iconv from "iconv-lite";
import { TransformersEmbeddingProvider } from "./cache/embedding.js";
import { SQLiteVectorStore } from "./cache/sqlite-store.js";
import { SemanticCache } from "./cache/semantic-cache.js";
import { CrossLingualEngine } from "./cache/crosslingual.js";
import { createSearchRateLimiter, createFetchRateLimiter } from "./rate-limiter.js";
// --- Types & Schemas ---
const SearchSchema = z.object({
    query: z.string().min(1).describe("The search query to perform"),
});
const FetchSchema = z.object({
    url: z.string().url().describe("The URL of the webpage to fetch and convert to markdown"),
    force_refresh: z.boolean().optional().describe("If true, bypass cache and fetch fresh content from the web"),
});
// --- Server Implementation ---
class WebSearchServer {
    server;
    browser = null;
    turndown;
    cache;
    crossLingual;
    searchLimiter;
    fetchLimiter;
    constructor() {
        this.server = new Server({
            name: "my-websearch-mcp",
            version: "1.0.0",
        }, {
            capabilities: {
                tools: {},
            },
        });
        this.turndown = new TurndownService({
            headingStyle: "atx",
            codeBlockStyle: "fenced",
            emDelimiter: "_",
        });
        // Initialize Semantic Cache with SQLite for persistence
        const embeddingProvider = new TransformersEmbeddingProvider();
        const vectorStore = new SQLiteVectorStore("websearch_cache.db");
        this.cache = new SemanticCache(embeddingProvider, vectorStore);
        this.crossLingual = new CrossLingualEngine();
        this.searchLimiter = createSearchRateLimiter();
        this.fetchLimiter = createFetchRateLimiter();
        this.setupTools();
        this.setupShutdownHandlers();
    }
    async getBrowser() {
        if (!this.browser) {
            console.error("Launching persistent browser instance...");
            this.browser = await chromium.launch({ headless: true });
        }
        return this.browser;
    }
    setupShutdownHandlers() {
        const shutdown = async () => {
            console.error("Shutting down Web Search MCP Server...");
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
            }
            process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }
    setupTools() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "web_search",
                    description: "Search the web and return top results re-ranked by relevance. Supports fallback to multiple engines.",
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
                    const { allowed, retryAfterMs } = this.searchLimiter.tryConsume();
                    if (!allowed) {
                        const seconds = Math.ceil(retryAfterMs / 1000);
                        return {
                            content: [{ type: "text", text: `Rate limit exceeded: web_search allows ${process.env.RATE_LIMIT_SEARCH_PER_MIN || "10"} requests per minute. Retry in ${seconds} seconds.` }],
                            isError: true,
                        };
                    }
                    const { query } = SearchSchema.parse(args);
                    // 1. Detect Intent (Technical, News, etc.)
                    const intent = await this.cache.detectIntent(query);
                    console.error(`Detected Intent: ${intent}`);
                    // 2. Check Semantic Search Cache
                    const cachedResults = await this.cache.get(query);
                    if (cachedResults) {
                        return {
                            content: [{ type: "text", text: JSON.stringify(cachedResults, null, 2) }],
                        };
                    }
                    // 3. Detect language for cross-lingual search
                    const lang = await this.crossLingual.detectLanguage(query);
                    console.error(`Detected Language: ${lang}`);
                    // 4. Cross-lingual search for non-English technical queries
                    if (this.crossLingual.shouldCrossSearch(intent, lang)) {
                        const enQuery = await this.crossLingual.translateToEnglish(query, lang);
                        console.error(`Cross-lingual: "${query}" → "${enQuery}"`);
                        const [mainResults, auxResults] = await Promise.all([
                            this.performSearch(query),
                            this.performSearch(enQuery),
                        ]);
                        const seen = new Set();
                        const merged = [...mainResults, ...auxResults].filter(r => {
                            const key = r.url.toLowerCase();
                            if (seen.has(key))
                                return false;
                            seen.add(key);
                            return true;
                        });
                        const rankedResults = await this.cache.reRankResults(query, merged);
                        await this.cache.set(query, rankedResults);
                        return {
                            content: [{ type: "text", text: JSON.stringify(rankedResults, null, 2) }],
                        };
                    }
                    // 5. Standard Search (with Fallback)
                    const results = await this.handleWebSearch(query);
                    // 6. Semantic Re-ranking
                    if (results.content[0].type === "text") {
                        try {
                            const parsedResults = JSON.parse(results.content[0].text);
                            const rankedResults = await this.cache.reRankResults(query, parsedResults);
                            await this.cache.set(query, rankedResults);
                            return {
                                content: [{ type: "text", text: JSON.stringify(rankedResults, null, 2) }],
                            };
                        }
                        catch (e) {
                            return results;
                        }
                    }
                    return results;
                }
                else if (name === "fetch_content") {
                    const { allowed, retryAfterMs } = this.fetchLimiter.tryConsume();
                    if (!allowed) {
                        const seconds = Math.ceil(retryAfterMs / 1000);
                        return {
                            content: [{ type: "text", text: `Rate limit exceeded: fetch_content allows ${process.env.RATE_LIMIT_FETCH_PER_MIN || "20"} requests per minute. Retry in ${seconds} seconds.` }],
                            isError: true,
                        };
                    }
                    const { url, force_refresh } = FetchSchema.parse(args);
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
                    const results = await this.handleFetchContent(url);
                    return results;
                }
                else {
                    throw new Error(`Unknown tool: ${name}`);
                }
            }
            catch (error) {
                return {
                    content: [{ type: "text", text: `Error: ${error.message}` }],
                    isError: true,
                };
            }
        });
    }
    async performSearch(query) {
        const browser = await this.getBrowser();
        const context = await browser.newContext({
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        });
        const page = await context.newPage();
        try {
            // Primary: Brave Search
            try {
                const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
                await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
                await page.waitForSelector("div.snippet", { timeout: 10000 });
                const results = await page.$$eval("div.snippet", (elements) => {
                    return elements.slice(0, 10).map((el) => {
                        const titleEl = el.querySelector(".title");
                        const linkEl = el.querySelector("a");
                        const snippetEl = el.querySelector(".snippet-description, .snippet-content");
                        return {
                            title: titleEl?.textContent?.trim() || "",
                            url: linkEl?.href || "",
                            snippet: snippetEl?.textContent?.trim() || "",
                            source: "brave"
                        };
                    }).filter((r) => r.title && r.url);
                });
                if (results.length > 0)
                    return results;
            }
            catch (e) {
                console.error("Brave Search failed, trying fallback...");
            }
            // Fallback 1: Google Web-only
            try {
                const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=14`;
                await page.goto(googleUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
                const results = await page.$$eval("div.g", (elements) => {
                    return elements.slice(0, 7).map((el) => {
                        const titleEl = el.querySelector("h3");
                        const linkEl = el.querySelector("a");
                        const snippetEl = el.querySelector("div[style*='-webkit-line-clamp']");
                        return {
                            title: titleEl?.innerText || "",
                            url: linkEl?.href || "",
                            snippet: snippetEl?.textContent?.trim() || "",
                            source: "google"
                        };
                    }).filter((r) => r.title && r.url);
                });
                if (results.length > 0)
                    return results;
            }
            catch (e) {
                console.error("Google fallback failed, trying DuckDuckGo...");
            }
            // Fallback 2: DuckDuckGo Lite
            try {
                const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
                await page.goto(ddgUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
                const results = await page.$$eval("a.result-link", (links) => {
                    return links.slice(0, 10).map((link) => {
                        const row = link.closest("tr");
                        const snippetEl = row?.querySelector("td.result-snippet");
                        return {
                            title: link.textContent?.trim() || "",
                            url: link.href || "",
                            snippet: snippetEl?.textContent?.trim() || "",
                            source: "duckduckgo"
                        };
                    }).filter((r) => r.title && r.url);
                });
                if (results.length > 0)
                    return results;
            }
            catch (e) {
                console.error("DuckDuckGo fallback failed.");
            }
            return [];
        }
        finally {
            await context.close();
        }
    }
    async handleWebSearch(query) {
        const results = await this.performSearch(query);
        if (results.length === 0)
            throw new Error("All search providers failed.");
        return { content: [{ type: "text", text: JSON.stringify(results) }] };
    }
    async handleFetchContent(url) {
        // SSRF Protection: Block local/private resources
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname.toLowerCase();
        const privateIpRegex = /^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/;
        if (privateIpRegex.test(hostname)) {
            throw new Error(`Access to local/private resource is blocked for security reasons: ${hostname}`);
        }
        const browser = await this.getBrowser();
        const context = await browser.newContext({
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        });
        const page = await context.newPage();
        try {
            const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
            const buffer = await response?.body();
            if (!buffer)
                throw new Error("Could not fetch page content.");
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
            if (!article || !article.content)
                throw new Error("Could not parse article content.");
            const markdown = this.turndown.turndown(article.content);
            const title = article.title || "Untitled Page";
            const fullText = `# ${title}\n\n${markdown}`;
            // Save to Content Cache
            await this.cache.setCachedContent(url, fullText, title);
            return {
                content: [{ type: "text", text: fullText }],
            };
        }
        finally {
            await context.close();
        }
    }
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("Web Search MCP Server running on stdio");
    }
}
const server = new WebSearchServer();
server.run().catch(console.error);
