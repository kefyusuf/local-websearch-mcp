import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteVectorStore } from "../cache/sqlite-store.js";
import fs from "node:fs";

const TEST_DB = "test_store.db";

describe("SQLiteVectorStore", () => {
  let store: SQLiteVectorStore | null = null;

  beforeEach(() => {
    if (store) { store.close(); store = null; }
    if (fs.existsSync(TEST_DB)) {
      try { fs.unlinkSync(TEST_DB); } catch {}
    }
    store = new SQLiteVectorStore(TEST_DB);
  });

  afterEach(() => {
    if (store) { store.close(); store = null; }
    if (fs.existsSync(TEST_DB)) {
      try { fs.unlinkSync(TEST_DB); } catch {}
    }
  });

  it("should store and retrieve vectors", async () => {
    const vec = new Array(384).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    await store!.add("test1", vec, { name: "Test Entry" });

    const results = await store!.search(vec, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].metadata.name).toBe("Test Entry");
  });

  it("should store and retrieve content", async () => {
    await store!.setContent("https://example.com", "Hello World", "docs");

    const entry = await store!.getContent("https://example.com");
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("Hello World");
    expect(entry!.category).toBe("docs");
  });

  it("should return null for missing content", async () => {
    const entry = await store!.getContent("https://nonexistent.com");
    expect(entry).toBeNull();
  });
});
