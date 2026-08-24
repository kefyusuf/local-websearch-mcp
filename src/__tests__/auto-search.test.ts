import { describe, expect, it, vi } from "vitest";
import type { SearchProvider } from "../providers/base.js";
import { ProviderHealthTracker } from "../providers/health.js";
import { executeSearchPlan } from "../search/executor.js";
import type { SearchPlan } from "../search/planner.js";
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

function plan(overrides: Partial<SearchPlan> = {}): SearchPlan {
  return {
    intent: "technical",
    strategy: "aggregate",
    primaryProviderNames: ["brave", "google"],
    fallbackProviderNames: ["bing", "duckduckgo"],
    profileVersion: "v1",
    ...overrides,
  };
}

describe("planned search execution", () => {
  it("does not call secondary providers when any aggregate primary succeeds", async () => {
    const brave = provider("brave", ["https://example.com/brave"]);
    const google = provider("google", []);
    const bing = provider("bing", ["https://example.com/bing"]);

    const results = await executeSearchPlan({
      providers: [brave, google, bing],
      query: "postgres pooling",
      locale,
      plan: plan(),
      healthTracker: new ProviderHealthTracker(),
    });

    expect(results.map((result) => result.url)).toEqual(["https://example.com/brave"]);
    expect(brave.execute).toHaveBeenCalledTimes(1);
    expect(google.execute).toHaveBeenCalledTimes(1);
    expect(bing.execute).not.toHaveBeenCalled();
  });

  it("falls back in planned order when all aggregate primaries fail", async () => {
    const brave = provider("brave", []);
    const google = provider("google", []);
    const bing = provider("bing", []);
    const duckduckgo = provider("duckduckgo", ["https://example.com/ddg"]);

    const results = await executeSearchPlan({
      providers: [duckduckgo, bing, brave, google],
      query: "postgres pooling",
      locale,
      plan: plan(),
      healthTracker: new ProviderHealthTracker(),
    });

    expect(results.map((result) => result.url)).toEqual(["https://example.com/ddg"]);
    expect(brave.execute).toHaveBeenCalledTimes(1);
    expect(google.execute).toHaveBeenCalledTimes(1);
    expect(bing.execute).toHaveBeenCalledTimes(1);
    expect(duckduckgo.execute).toHaveBeenCalledTimes(1);
  });

  it("uses plan order for fallback plans and stops after first success", async () => {
    const google = provider("google", []);
    const bing = provider("bing", ["https://example.com/bing"]);
    const duckduckgo = provider("duckduckgo", ["https://example.com/ddg"]);

    const results = await executeSearchPlan({
      providers: [duckduckgo, bing, google],
      query: "postgres docs",
      locale,
      plan: plan({
        intent: "navigational",
        strategy: "fallback",
        primaryProviderNames: ["google", "bing", "duckduckgo"],
        fallbackProviderNames: [],
      }),
      healthTracker: new ProviderHealthTracker(),
    });

    expect(results.map((result) => result.url)).toEqual(["https://example.com/bing"]);
    expect(google.execute).toHaveBeenCalledTimes(1);
    expect(bing.execute).toHaveBeenCalledTimes(1);
    expect(duckduckgo.execute).not.toHaveBeenCalled();
  });
});
