import { describe, expect, it, vi } from "vitest";
import type { SearchProvider } from "../providers/base.js";
import { ProviderHealthTracker } from "../providers/health.js";
import { executeProviderSearch } from "../search/executor.js";
import { fuseSearchResults, normalizeSearchUrl } from "../search/fusion.js";
import type { SearchLocale } from "../search-utils.js";

const locale: SearchLocale = {
  acceptLanguage: "en-US,en;q=0.9",
  market: "en-US",
};

function provider(name: string, urls: string[]): SearchProvider {
  return {
    name,
    execute: vi.fn(async () => urls.map((url, index) => ({
      title: `${name} result ${index + 1}`,
      url,
      snippet: `${name} snippet ${index + 1}`,
      source: name,
    }))),
  };
}

describe("federated search", () => {
  it("normalizes tracking parameters, fragments, www, and trailing slashes for deduplication", () => {
    expect(normalizeSearchUrl("https://www.Example.com/docs/?utm_source=test&b=2&a=1#intro"))
      .toBe("https://example.com/docs?a=1&b=2");
  });

  it("fuses duplicate URLs across providers, preserves the representative URL, and records provider ranks", () => {
    const fused = fuseSearchResults([
      {
        provider: "brave",
        results: [
          { title: "Brave A", url: "https://example.com/a?utm_source=brave", snippet: "A", source: "brave" },
          { title: "Brave B", url: "https://example.com/b", snippet: "B", source: "brave" },
        ],
      },
      {
        provider: "google",
        results: [
          { title: "Google A", url: "https://www.example.com/a#section", snippet: "A2", source: "google" },
          { title: "Google C", url: "https://example.com/c", snippet: "C", source: "google" },
        ],
      },
    ]);

    expect(fused).toHaveLength(3);
    expect(fused[0]).toMatchObject({
      url: "https://example.com/a?utm_source=brave",
      sources: ["brave", "google"],
      providerRanks: { brave: 1, google: 1 },
    });
    expect(fused[0].fusionScore).toBeGreaterThan(fused[1].fusionScore ?? 0);
  });

  it("keeps fallback behavior by stopping after the first successful provider", async () => {
    const brave = provider("brave", ["https://example.com/brave"]);
    const google = provider("google", ["https://example.com/google"]);

    const results = await executeProviderSearch({
      providers: [brave, google],
      query: "postgres pooling",
      locale,
      strategy: "fallback",
      healthTracker: new ProviderHealthTracker(),
    });

    expect(results.map((result) => result.url)).toEqual(["https://example.com/brave"]);
    expect(brave.execute).toHaveBeenCalledTimes(1);
    expect(google.execute).not.toHaveBeenCalled();
  });

  it("aggregates successful providers and ranks consensus URLs first", async () => {
    const brave = provider("brave", [
      "https://example.com/shared?utm_source=brave",
      "https://example.com/brave-only",
    ]);
    const google = provider("google", [
      "https://www.example.com/shared#top",
      "https://example.com/google-only",
    ]);

    const results = await executeProviderSearch({
      providers: [brave, google],
      query: "postgres pooling",
      locale,
      strategy: "aggregate",
      healthTracker: new ProviderHealthTracker(),
    });

    expect(brave.execute).toHaveBeenCalledTimes(1);
    expect(google.execute).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      url: "https://example.com/shared?utm_source=brave",
      sources: ["brave", "google"],
      providerRanks: { brave: 1, google: 1 },
    });
  });

  it("executes each provider name only once in aggregate mode", async () => {
    const brave = provider("brave", ["https://example.com/brave"]);

    const results = await executeProviderSearch({
      providers: [brave, brave],
      query: "postgres pooling",
      locale,
      strategy: "aggregate",
      healthTracker: new ProviderHealthTracker(),
    });

    expect(brave.execute).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].sources).toEqual(["brave"]);
    expect(results[0].fusionScore).toBeCloseTo(1 / 61);
  });
});
