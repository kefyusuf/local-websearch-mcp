import { describe, it, expect, vi, beforeEach } from "vitest";
import { SemanticCache } from "../cache/semantic-cache.js";
import { InMemoryVectorStore } from "./helpers.js";
import type { IEmbeddingProvider } from "../cache/types.js";

function createMockEmbedding(vectors: Record<string, number[]>): IEmbeddingProvider {
  return {
    getEmbedding: vi.fn(async (text: string) => {
      if (vectors[text]) return vectors[text];
      return new Array(384).fill(0.01);
    }),
    isAvailable: vi.fn(() => true),
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

  it("should bootstrap embeddings even when provider reports unavailable before first call", async () => {
    const lazyProvider: IEmbeddingProvider = {
      getEmbedding: vi.fn(async (text: string) => {
        if (text === "gold price") return makeVec([1, 0]);
        if (text === "Gold live market rate") return makeVec([0.95, 0.2]);
        return makeVec([0, 1]);
      }),
      isAvailable: vi.fn(() => false),
    };
    cache = new SemanticCache(lazyProvider, store, 0.7);

    await cache.set("gold price", [{ title: "Gold", url: "https://example.com/gold", snippet: "live market rate", source: "test" }]);
    const hit = await cache.get("gold price");

    expect(hit).not.toBeNull();
    expect(lazyProvider.getEmbedding).toHaveBeenCalled();
  });
});
