import type { SearchIntent } from "./intent.js";

export const ROUTING_PROFILE_VERSION = "v1";

export type RoutingExecutionStrategy = "fallback" | "aggregate";

export type RoutingProfile = {
  strategy: RoutingExecutionStrategy;
  preference: string[];
  primaryTarget: number | "all";
  preserveConfiguredOrder?: boolean;
};

export const ROUTING_PROFILES: Record<SearchIntent, RoutingProfile> = {
  technical: {
    strategy: "aggregate",
    preference: ["brave", "google", "bing", "duckduckgo"],
    primaryTarget: 2,
  },
  research: {
    strategy: "aggregate",
    preference: ["brave", "google", "bing", "duckduckgo"],
    primaryTarget: 3,
  },
  news: {
    strategy: "aggregate",
    preference: ["google", "bing", "brave", "duckduckgo"],
    primaryTarget: 3,
  },
  commercial: {
    strategy: "aggregate",
    preference: ["brave", "google", "bing", "duckduckgo"],
    primaryTarget: 3,
  },
  shopping: {
    strategy: "aggregate",
    preference: ["google", "bing", "duckduckgo", "brave"],
    primaryTarget: 2,
  },
  local: {
    strategy: "aggregate",
    preference: ["google", "bing", "duckduckgo", "brave"],
    primaryTarget: 2,
  },
  navigational: {
    strategy: "fallback",
    preference: ["google", "bing", "duckduckgo", "brave"],
    primaryTarget: "all",
  },
  general: {
    strategy: "fallback",
    preference: [],
    primaryTarget: "all",
    preserveConfiguredOrder: true,
  },
};
