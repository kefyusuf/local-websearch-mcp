import { describe, expect, it } from "vitest";
import { planSearch } from "../search/planner.js";

const all = ["duckduckgo", "bing", "brave", "google"];

describe("search planner", () => {
  it.each([
    ["technical", "aggregate", ["brave", "google"], ["duckduckgo", "bing"]],
    ["research", "aggregate", ["brave", "google", "bing"], ["duckduckgo"]],
    ["news", "aggregate", ["google", "bing", "brave"], ["duckduckgo"]],
    ["commercial", "aggregate", ["brave", "google", "bing"], ["duckduckgo"]],
    ["shopping", "aggregate", ["google", "bing"], ["duckduckgo", "brave"]],
    ["local", "aggregate", ["google", "bing"], ["duckduckgo", "brave"]],
  ] as const)("plans %s intent", (intent, strategy, primary, fallback) => {
    expect(planSearch({ intent, configuredProviderNames: all })).toEqual({
      intent,
      strategy,
      primaryProviderNames: primary,
      fallbackProviderNames: fallback,
      profileVersion: "v1",
    });
  });

  it("orders navigational fallback by profile preference", () => {
    expect(planSearch({
      intent: "navigational",
      configuredProviderNames: all,
    })).toEqual({
      intent: "navigational",
      strategy: "fallback",
      primaryProviderNames: ["google", "bing", "duckduckgo", "brave"],
      fallbackProviderNames: [],
      profileVersion: "v1",
    });
  });

  it("preserves configured order for general fallback", () => {
    expect(planSearch({
      intent: "general",
      configuredProviderNames: ["bing", "duckduckgo", "google"],
    })).toEqual({
      intent: "general",
      strategy: "fallback",
      primaryProviderNames: ["bing", "duckduckgo", "google"],
      fallbackProviderNames: [],
      profileVersion: "v1",
    });
  });

  it("intersects preferences with the configured-provider allowlist", () => {
    expect(planSearch({
      intent: "technical",
      configuredProviderNames: ["duckduckgo", "bing"],
    })).toEqual({
      intent: "technical",
      strategy: "aggregate",
      primaryProviderNames: ["bing", "duckduckgo"],
      fallbackProviderNames: [],
      profileVersion: "v1",
    });
  });

  it("deduplicates configured provider names deterministically", () => {
    expect(planSearch({
      intent: "technical",
      configuredProviderNames: ["bing", "bing", "duckduckgo"],
    }).primaryProviderNames).toEqual(["bing", "duckduckgo"]);
  });
});
