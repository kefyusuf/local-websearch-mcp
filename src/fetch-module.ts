import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { LRUCache } from "lru-cache";
import type { BrowserContext } from "playwright";
import TurndownService from "turndown";
import iconv from "iconv-lite";
import type { SearchIntent } from "./cache/intent.js";
import type { SemanticCache } from "./cache/semantic-cache.js";
import { validatePublicHttpUrl } from "./ssrf.js";

type WaitUntilMode = "domcontentloaded" | "networkidle";

export type FetchArticle = {
  url: string;
  title: string;
  content: string;
  fullText: string;
};

type FetchFailure = {
  kind: "error";
  reason: "fetch_failed" | "parse_failed" | "blocked_url";
};

type FetchArticleResult = {
  kind: "article";
  article: FetchArticle;
  source: "http" | "playwright" | "page-cache";
};

type HttpFetchResult =
  | { kind: "html"; html: string; buffer: Buffer }
  | { kind: "blocked" }
  | null;

export type FetchContentResult =
  | {
      kind: "content";
      text: string;
      source: "content-cache" | "http" | "playwright";
    }
  | FetchFailure;

type ContentFetcherOptions = {
  cache: SemanticCache;
  getBrowserContext: () => Promise<BrowserContext>;
  fetchWaitUntil: WaitUntilMode;
  detectIntent?: ((text: string) => Promise<SearchIntent>) | null;
  maxContentChars?: number;
  forcePlaywright?: () => boolean;
};

export class ContentFetcher {
  private static readonly MAX_HTTP_REDIRECTS = 5;

  private readonly cache: SemanticCache;
  private readonly getBrowserContext: () => Promise<BrowserContext>;
  private readonly fetchWaitUntil: WaitUntilMode;
  private readonly detectIntent: ((text: string) => Promise<SearchIntent>) | null;
  private readonly maxContentChars: number;
  private readonly forcePlaywright: () => boolean;
  private readonly turndown: TurndownService;
  private readonly pageCache: LRUCache<string, FetchArticle>;

  constructor(options: ContentFetcherOptions) {
    this.cache = options.cache;
    this.getBrowserContext = options.getBrowserContext;
    this.fetchWaitUntil = options.fetchWaitUntil;
    this.detectIntent = options.detectIntent ?? null;
    this.maxContentChars = options.maxContentChars ?? 50_000;
    this.forcePlaywright = options.forcePlaywright ?? (() => isEnabledEnvFlag(process.env.FORCE_PLAYWRIGHT));
    this.turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      emDelimiter: "_",
    });
    this.pageCache = new LRUCache({
      max: 100,
      ttl: 10 * 60 * 1000,
    });
  }

  close(): void {
    this.pageCache.clear();
  }

  async fetchContent(url: string, forceRefresh: boolean = false): Promise<FetchContentResult> {
    if (!forceRefresh) {
      const cachedContent = await this.cache.getCachedContent(url);
      if (cachedContent) {
        return {
          kind: "content",
          text: cachedContent,
          source: "content-cache",
        };
      }
    }

    const result = await this.acquireArticle(url, {
      allowPageCache: false,
      persistContentCache: true,
      useConfiguredWaitUntil: true,
    });

    if (result.kind === "error") {
      return result;
    }

    return {
      kind: "content",
      text: result.article.fullText,
      source: result.source === "page-cache" ? "http" : result.source,
    };
  }

  async fetchPage(url: string): Promise<FetchArticle | null> {
    const result = await this.acquireArticle(url, {
      allowPageCache: true,
      persistContentCache: false,
      useConfiguredWaitUntil: false,
    });
    return result.kind === "article" ? result.article : null;
  }

  private async acquireArticle(
    url: string,
    options: {
      allowPageCache: boolean;
      persistContentCache: boolean;
      useConfiguredWaitUntil: boolean;
    }
  ): Promise<FetchArticleResult | FetchFailure> {
    if (!(await this.isFetchUrlAllowed(url))) {
      return { kind: "error", reason: "blocked_url" };
    }

    if (options.allowPageCache) {
      const cachedPage = this.pageCache.get(url);
      if (cachedPage) {
        console.error(`Page cache hit: ${url}`);
        return {
          kind: "article",
          article: cachedPage,
          source: "page-cache",
        };
      }
    }

    if (!this.forcePlaywright()) {
      const httpResult = await this.fetchViaHttp(url);
      if (httpResult?.kind === "blocked") {
        return { kind: "error", reason: "blocked_url" };
      }

      if (httpResult) {
        const parsedArticle = this.parseHtmlToArticle(httpResult.html, url);
        if (parsedArticle) {
          await this.persistArticle(parsedArticle, options);
          return {
            kind: "article",
            article: parsedArticle,
            source: "http",
          };
        }
      }
    }

    return this.fetchViaPlaywright(url, options);
  }

  private async fetchViaPlaywright(
    url: string,
    options: {
      allowPageCache: boolean;
      persistContentCache: boolean;
      useConfiguredWaitUntil: boolean;
    }
  ): Promise<FetchArticleResult | FetchFailure> {
    const context = await this.getBrowserContext();
    const page = await context.newPage();

    try {
      let response;
      const waitUntil = options.useConfiguredWaitUntil ? this.fetchWaitUntil : "domcontentloaded";

      await page.route("**/*", async (route) => {
        const requestUrl = route.request().url();
        if (await this.isFetchUrlAllowed(requestUrl)) {
          await route.continue();
          return;
        }

        console.error(`Blocked private or unsupported Playwright request: ${requestUrl}`);
        await route.abort("blockedbyclient");
      });

      try {
        response = await page.goto(url, { waitUntil, timeout: 30000 });
      } catch (error) {
        const shouldRetry =
          options.useConfiguredWaitUntil &&
          this.fetchWaitUntil === "networkidle" &&
          error instanceof Error &&
          error.name === "TimeoutError";

        if (!shouldRetry) throw error;

        console.error(`Fetch navigation timed out with networkidle for ${url}, retrying with domcontentloaded`);
        response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      }

      const buffer = await response?.body();
      if (!buffer) {
        return { kind: "error", reason: "fetch_failed" };
      }

      const article = this.parseHtmlToArticle(this.decodeHtmlBuffer(buffer), url);
      if (!article) {
        return { kind: "error", reason: "parse_failed" };
      }

      await this.persistArticle(article, options);
      return {
        kind: "article",
        article,
        source: "playwright",
      };
    } catch {
      return { kind: "error", reason: "fetch_failed" };
    } finally {
      try {
        await page.close();
      } catch (error) {
        console.error("Error closing page:", error);
      }
    }
  }

  private async persistArticle(
    article: FetchArticle,
    options: {
      allowPageCache: boolean;
      persistContentCache: boolean;
    }
  ): Promise<void> {
    if (options.allowPageCache) {
      this.pageCache.set(article.url, article);
    }

    if (!options.persistContentCache) {
      return;
    }

    const intent = await this.detectArticleIntent(article);
    await this.cache.setCachedContent(article.url, article.fullText, article.title, intent);
  }

  private async detectArticleIntent(article: FetchArticle): Promise<SearchIntent | undefined> {
    if (!this.detectIntent) {
      return undefined;
    }

    return this.detectIntent(`${article.title} ${article.content.slice(0, 200)}`);
  }

  private truncateContent(markdown: string): string {
    return markdown.length > this.maxContentChars
      ? `${markdown.slice(0, this.maxContentChars)}\n\n_[Content truncated at 50,000 characters]_`
      : markdown;
  }

  private parseHtmlToArticle(html: string, url: string): FetchArticle | null {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article?.content || article.content.length <= 200) {
      return null;
    }

    const content = this.truncateContent(this.turndown.turndown(article.content));
    const title = article.title || "Untitled Page";

    return {
      url,
      title,
      content,
      fullText: `# ${title}\n\n${content}`,
    };
  }

  private async fetchViaHttp(url: string): Promise<HttpFetchResult> {
    let currentUrl = url;

    try {
      for (let redirectCount = 0; redirectCount <= ContentFetcher.MAX_HTTP_REDIRECTS; redirectCount += 1) {
        if (!(await this.isFetchUrlAllowed(currentUrl))) {
          return { kind: "blocked" };
        }

        const response = await fetch(currentUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
        });

        if (isRedirectStatus(response.status)) {
          const location = response.headers.get("location");
          if (!location) return null;

          const nextUrl = new URL(location, currentUrl).toString();
          if (!(await this.isFetchUrlAllowed(nextUrl))) {
            console.error(`Blocked private or unsupported HTTP redirect: ${nextUrl}`);
            return { kind: "blocked" };
          }

          currentUrl = nextUrl;
          continue;
        }

        if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
          return null;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length < 500) {
          return null;
        }

        return {
          kind: "html",
          html: this.decodeHtmlBuffer(buffer),
          buffer,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  private async isFetchUrlAllowed(url: string): Promise<boolean> {
    return (await validatePublicHttpUrl(url)).ok;
  }

  private decodeHtmlBuffer(buffer: Buffer): string {
    let html = buffer.toString("utf-8");
    const head = buffer.subarray(0, 2048).toString("ascii");
    const charsetMatch = head.match(/<meta[^>]+charset=["']?\s*([a-zA-Z0-9-]+)/i);
    if (charsetMatch) {
      const detectedCharset = charsetMatch[1].toLowerCase();
      if (detectedCharset !== "utf-8" && !detectedCharset.includes("utf")) {
        html = iconv.decode(buffer, detectedCharset);
      }
    }
    return html;
  }
}

function isEnabledEnvFlag(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}
