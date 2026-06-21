import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright";
import { ContentFetcher } from "../fetch-module.js";
import { SemanticCache } from "../cache/semantic-cache.js";
import { InMemoryVectorStore } from "./helpers.js";
import type { IEmbeddingProvider } from "../cache/types.js";

function createMockEmbedding(): IEmbeddingProvider {
  return {
    getEmbedding: vi.fn(async () => new Array(384).fill(0.01)),
    isAvailable: vi.fn(() => true),
  };
}

function createFetcher(overrides?: {
  getBrowserContext?: () => Promise<BrowserContext>;
  forcePlaywright?: () => boolean;
}) {
  const cache = new SemanticCache(createMockEmbedding(), new InMemoryVectorStore());
  const defaultContext = {
    newPage: async () => ({
      goto: async () => undefined,
      close: async () => undefined,
    }),
  } as BrowserContext;

  return {
    cache,
    fetcher: new ContentFetcher({
      cache,
      getBrowserContext: overrides?.getBrowserContext ?? (async () => defaultContext),
      fetchWaitUntil: "networkidle",
      forcePlaywright: overrides?.forcePlaywright,
    }),
  };
}

describe("ContentFetcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns fetch_failed for non-HTML responses", async () => {
    const { fetcher } = createFetcher();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ));

    await expect(fetcher.fetchPage("https://example.com/data")).resolves.toBeNull();
  });

  it("returns null for failed HTTP responses", async () => {
    const { fetcher } = createFetcher();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("<html><body>failure</body></html>", {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    ));

    await expect(fetcher.fetchPage("https://example.com/failure")).resolves.toBeNull();
  });

  it("returns null for very short html responses", async () => {
    const { fetcher } = createFetcher();
    const html = `<html><body>${"a".repeat(450)}</body></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    ));

    await expect(fetcher.fetchPage("https://example.com/short")).resolves.toBeNull();
  });

  it("returns parsed article content for valid html responses", async () => {
    const { fetcher } = createFetcher();
    const html = `<html><head><title>Test</title></head><body><article><p>${"content ".repeat(80)}</p></article></body></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    ));

    const result = await fetcher.fetchPage("https://example.com/article");

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Test");
    expect(result?.content).toContain("content");
    expect(result?.fullText).toContain("# Test");
  });

  it("prefers content cache when force_refresh is false", async () => {
    const { cache, fetcher } = createFetcher();
    await cache.setCachedContent("https://example.com/cached", "# Cached\n\nBody", "Cached");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetcher.fetchContent("https://example.com/cached", false);

    expect(result).toEqual({
      kind: "content",
      text: "# Cached\n\nBody",
      source: "content-cache",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to Playwright when HTTP fetch cannot produce an article", async () => {
    const page = {
      goto: vi.fn().mockResolvedValue({
        body: async () => Buffer.from(`<html><head><title>Rendered</title></head><body><article><p>${"rendered ".repeat(80)}</p></article></body></html>`),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browserContext = {
      newPage: vi.fn().mockResolvedValue(page),
    } as unknown as BrowserContext;
    const { fetcher } = createFetcher({
      getBrowserContext: async () => browserContext,
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("<html><body>tiny</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    ));

    const result = await fetcher.fetchContent("https://example.com/rendered");

    expect(result.kind).toBe("content");
    if (result.kind === "content") {
      expect(result.source).toBe("playwright");
      expect(result.text).toContain("# Rendered");
    }
    expect(page.goto).toHaveBeenCalled();
    expect(page.close).toHaveBeenCalled();
  });
});
