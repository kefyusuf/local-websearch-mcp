import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectHeuristicIntent } from "../search/heuristics.js";
import { planSearch } from "../search/planner.js";
import type { SearchIntent } from "../search/intent.js";

type Fixture = {
  query: string;
  intent: SearchIntent;
  heuristic: SearchIntent | null;
};

const fixtures = readFileSync("evals/search-routing/queries.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Fixture);

const expectedIntents = new Set<SearchIntent>([
  "technical",
  "research",
  "news",
  "commercial",
  "shopping",
  "local",
  "navigational",
  "general",
]);

describe("search routing eval fixture", () => {
  it("covers all eight intents", () => {
    expect(new Set(fixtures.map((row) => row.intent))).toEqual(expectedIntents);
  });

  it("contains both heuristic hits and classifier-defer cases", () => {
    expect(fixtures.some((row) => row.heuristic !== null)).toBe(true);
    expect(fixtures.some((row) => row.heuristic === null)).toBe(true);
  });

  it.each(fixtures)("heuristic expectation: $query", ({ query, heuristic }) => {
    expect(detectHeuristicIntent(query)).toBe(heuristic);
  });

  it.each(fixtures)("planner never escapes the configured allowlist: $query", ({ intent }) => {
    const configured = ["duckduckgo", "bing"];
    const plan = planSearch({ intent, configuredProviderNames: configured });
    const selected = [...plan.primaryProviderNames, ...plan.fallbackProviderNames];

    expect(selected.every((name) => configured.includes(name))).toBe(true);
    expect(new Set(selected).size).toBe(selected.length);
  });
});
