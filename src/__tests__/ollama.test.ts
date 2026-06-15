import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaClient } from "../llm/ollama.js";

describe("OllamaClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("summarize returns null when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network failed");
    }));

    const client = new OllamaClient();

    await expect(client.summarize("content", "question")).resolves.toBeNull();
  });

  it("summarize returns null when response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));

    const client = new OllamaClient();

    await expect(client.summarize("content", "question")).resolves.toBeNull();
  });

  it("summarize returns response text on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ response: "Paris" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }))
    );

    const client = new OllamaClient();

    await expect(client.summarize("content", "question")).resolves.toBe("Paris");
  });

  it("isAvailable returns false when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("unreachable");
    }));

    const client = new OllamaClient();

    await expect(client.isAvailable()).resolves.toBe(false);
  });

  it("isAvailable returns true when tags endpoint responds ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })));

    const client = new OllamaClient();

    await expect(client.isAvailable()).resolves.toBe(true);
  });
});
