import { describe, expect, it } from "vitest";
import { formatSearchResults } from "../answer-extraction.js";

describe("formatSearchResults", () => {
  it("uses cautious snippet language for version hints", () => {
    const text = formatSearchResults("node latest", [
      {
        title: "Node.js 20.11.1 release",
        url: "https://example.com/node",
        snippet: "Current release details",
        source: "test",
      },
    ]);

    expect(text).toContain("Version hint from search snippets:");
    expect(text).not.toContain("Answer: The latest version found");
  });

  it("adds a freshness hint for old dated snippets", () => {
    const text = formatSearchResults("old docs", [
      {
        title: "Old API Guide",
        url: "https://example.com/old",
        snippet: "Last updated 2019-01-01 with legacy API details.",
        source: "test",
      },
    ]);

    expect(text).toContain("Freshness: possibly stale (2019-01-01).");
  });
});
