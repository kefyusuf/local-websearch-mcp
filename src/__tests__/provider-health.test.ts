import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderHealthTracker } from "../providers/health.js";

describe("ProviderHealthTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("triggers backoff after 5 consecutive failures", () => {
    const tracker = new ProviderHealthTracker();

    for (let i = 0; i < 5; i++) {
      tracker.record("duckduckgo", false);
    }

    expect(tracker.isAvailable("duckduckgo")).toBe(false);
    expect(tracker.getSnapshot("duckduckgo")).toMatchObject({
      available: false,
      recentAttempts: 5,
      recentSuccesses: 0,
      recentFailures: 5,
      successRate: 0,
      backoffRemainingMs: 2 * 60 * 1000,
    });
  });

  it("does not trigger backoff with 3 successes out of 5", () => {
    const tracker = new ProviderHealthTracker();

    [true, false, true, false, true].forEach((success) => {
      tracker.record("bing", success);
    });

    expect(tracker.isAvailable("bing")).toBe(true);
  });

  it("triggers backoff with 2 successes out of 5", () => {
    const tracker = new ProviderHealthTracker();

    [true, false, true, false, false].forEach((success) => {
      tracker.record("brave", success);
    });

    expect(tracker.isAvailable("brave")).toBe(false);
  });

  it("becomes available again after backoff expires", () => {
    const tracker = new ProviderHealthTracker();

    for (let i = 0; i < 5; i++) {
      tracker.record("google", false);
    }

    expect(tracker.isAvailable("google")).toBe(false);

    vi.advanceTimersByTime(2 * 60 * 1000 + 1);

    expect(tracker.isAvailable("google")).toBe(true);
    expect(tracker.backoffUntil.has("google")).toBe(false);
  });
});
