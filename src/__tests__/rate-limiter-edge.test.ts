import { describe, it, expect } from "vitest";
import { TokenBucket } from "../rate-limiter.js";

describe("Rate Limiter Edge Cases", () => {
  it("should handle zero max tokens gracefully", () => {
    const bucket = new TokenBucket({ maxTokens: 0, refillRatePerSecond: 1 });
    const result = bucket.tryConsume();
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("should handle NaN-like config without throwing", () => {
    const bucket = new TokenBucket({ maxTokens: 5, refillRatePerSecond: 0 });
    const result = bucket.tryConsume(2);
    expect(result.allowed).toBe(true);
  });

  it("should handle very large token consumption", () => {
    const bucket = new TokenBucket({ maxTokens: 5, refillRatePerSecond: 1 });
    const result = bucket.tryConsume(100);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("should report stats correctly after consumption", () => {
    const bucket = new TokenBucket({ maxTokens: 10, refillRatePerSecond: 10 });
    bucket.tryConsume(3);
    const stats = bucket.getStats();
    expect(stats.available).toBeLessThanOrEqual(7);
    expect(stats.max).toBe(10);
  });
});
