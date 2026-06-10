import { describe, it, expect, vi } from "vitest";

// We mock transformers to avoid loading actual models
vi.mock("@xenova/transformers", () => {
  const mockPipeline = vi.fn(async (task: string, model: string) => {
    return async (text: string, options?: any) => {
      return { data: new Float32Array(384).fill(0.1) };
    };
  });
  return { pipeline: mockPipeline };
});

import { TransformersEmbeddingProvider } from "../cache/embedding.js";

describe("TransformersEmbeddingProvider", () => {
  it("should truncate text longer than 512 characters", async () => {
    const provider = new TransformersEmbeddingProvider();
    const longText = "a".repeat(1000);
    const embedding = await provider.getEmbedding(longText);
    expect(embedding.length).toBe(384);
  });

  it("should handle empty string", async () => {
    const provider = new TransformersEmbeddingProvider();
    const embedding = await provider.getEmbedding("");
    expect(embedding.length).toBe(384);
  });

  it("should return empty array when extractor fails", async () => {
    vi.mocked(await import("@xenova/transformers")).pipeline.mockRejectedValueOnce(new Error("Load failed"));
    const provider = new TransformersEmbeddingProvider();
    const embedding = await provider.getEmbedding("hello");
    expect(embedding).toEqual([]);
    expect(provider.isAvailable()).toBe(false);
  });
});
