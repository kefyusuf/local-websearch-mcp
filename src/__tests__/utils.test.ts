import { describe, it, expect } from "vitest";
import { cosineSimilarity } from "../cache/utils.js";

describe("cosineSimilarity", () => {
  it("should return 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("should return 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("should return 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("should compute correct similarity for partial match", () => {
    const sim = cosineSimilarity([1, 1, 0], [1, 1, 1]);
    expect(sim).toBeGreaterThan(0.8);
    expect(sim).toBeLessThan(1);
  });
});
