import { describe, it, expect, vi, beforeEach } from "vitest";
import { SemanticCache } from "../cache/semantic-cache.js";
import { InMemoryVectorStore } from "../cache/vector-store.js";
import type { IEmbeddingProvider } from "../cache/types.js";

function createMockEmbedding(vectors: Record<string, number[]>): IEmbeddingProvider {
  return {
    getEmbedding: vi.fn(async (text: string) => {
      if (vectors[text]) return vectors[text];
      return new Array(384).fill(0.01);
    }),
  };
}

function makeVec(values: number[]): number[] {
  const vec = new Array(384).fill(0);
  values.forEach((v, i) => { vec[i] = v; });
  return vec;
}

describe("SemanticCache", () => {
  let store: InMemoryVectorStore;
  let cache: SemanticCache;

  beforeEach(() => {
    store = new InMemoryVectorStore();
  });

  it("should return cached results for semantically similar query", async () => {
    const mockEmbed = createMockEmbedding({
      "weather london":  makeVec([1, 0]),
      "london forecast": makeVec([0.99, 0.14]),
    });
    cache = new SemanticCache(mockEmbed, store, 0.70);

    await cache.set("weather london", [{ title: "London Weather" }]);
    const hit = await cache.get("london forecast");
    expect(hit).not.toBeNull();
    expect(hit[0].title).toBe("London Weather");
  });

  it("should miss for unrelated queries", async () => {
    const mockEmbed = createMockEmbedding({
      "weather london": makeVec([1, 0]),
      "unrelated":       makeVec([0, 1]),
    });
    cache = new SemanticCache(mockEmbed, store, 0.70);

    await cache.set("weather london", [{ title: "London Weather" }]);
    const hit = await cache.get("unrelated");
    expect(hit).toBeNull();
  });

  it("should detect content category from URL and title", async () => {
    const mockEmbed = createMockEmbedding({});
    cache = new SemanticCache(mockEmbed, store);

    await cache.setCachedContent("https://docs.example.com/api", "Content", "API Guide");
    const entry = await store.getContent("https://docs.example.com/api");
    expect(entry!.category).toBe("docs");
  });

  it("should re-rank results by semantic relevance", async () => {
    const mockEmbed = createMockEmbedding({
      "MCP protocol":        makeVec([1, 0]),
      "MCP Guide A guide on Model Context Protocol":   makeVec([0.95, 0.3]),
      "Cooking Pasta How to cook pasta at home":        makeVec([0.1, 1]),
    });
    cache = new SemanticCache(mockEmbed, store);

    const raw = [
      { title: "Cooking Pasta", snippet: "How to cook pasta at home", url: "1" },
      { title: "MCP Guide", snippet: "A guide on Model Context Protocol", url: "2" },
    ];
    const ranked = await cache.reRankResults("MCP protocol", raw);
    expect(ranked[0].title).toBe("MCP Guide");
  });
});
