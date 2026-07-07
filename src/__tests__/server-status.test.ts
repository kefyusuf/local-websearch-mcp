import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSearchServer } from "../index.js";
import type { SearchProvider } from "../providers/base.js";

describe("WebSearchServer diagnostics", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports provider health and runtime configuration in server_status", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("FETCH_WAIT_UNTIL", "domcontentloaded");
    vi.stubEnv("FORCE_PLAYWRIGHT", "true");
    vi.stubEnv("CACHE_DB_PATH", ":memory:");
    const server = new WebSearchServer();
    server.overrideSearchProvidersForTesting([
      { name: "mock", execute: vi.fn(async () => []) },
    ]);

    const result = await callPrivate<{
      content: Array<{ text: string }>;
    }>(server, "handleStatus");
    const status = JSON.parse(result.content[0].text);

    expect(status.providers[0]).toMatchObject({
      name: "mock",
      available: true,
      recentAttempts: 0,
      recentSuccesses: 0,
      recentFailures: 0,
      successRate: null,
      backoffRemainingMs: 0,
    });
    expect(status.config).toMatchObject({
      searchProviders: ["mock"],
      fetchWaitUntil: "domcontentloaded",
      forcePlaywright: true,
      cacheDbPath: ":memory:",
    });
    expect(status.cache).toHaveProperty("contentCount");
    expect(status.cache).toHaveProperty("vectorCount");
  });

  it("falls back to the next provider when the first provider returns no results", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CACHE_DB_PATH", ":memory:");
    const emptyProvider: SearchProvider = {
      name: "empty",
      execute: vi.fn(async () => []),
    };
    const successfulProvider: SearchProvider = {
      name: "successful",
      execute: vi.fn(async () => [
        {
          title: "MCP Guide",
          url: "https://example.com/mcp",
          snippet: "A guide to MCP tools.",
          source: "successful",
        },
      ]),
    };
    const server = new WebSearchServer();
    server.overrideSearchProvidersForTesting([emptyProvider, successfulProvider]);

    const results = await callPrivate(server, "executeProviderSearch", ["mcp guide", {
      acceptLanguage: "en-US,en;q=0.9",
      market: "en-US",
    }]);

    expect(emptyProvider.execute).toHaveBeenCalled();
    expect(successfulProvider.execute).toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("MCP Guide");
  });
});

async function callPrivate<T>(target: unknown, method: string, args: unknown[] = []): Promise<T> {
  const callable = (target as Record<string, (...params: unknown[]) => Promise<T>>)[method];
  return callable.apply(target, args);
}
