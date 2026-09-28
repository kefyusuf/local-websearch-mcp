import { describe, expect, it, afterEach } from "vitest";
import { SessionMemory } from "../memory/session-memory.js";

describe("SessionMemory", () => {
  let memory: SessionMemory;

  afterEach(() => {
    memory?.close();
  });

  it("stores and recalls notes by id", () => {
    memory = new SessionMemory(":memory:");
    const note = memory.remember("Postgres pool size is cores*2+spindles", {
      topic: "postgres",
      tags: ["pooling", "sizing"],
    });

    expect(note.id).toBeTruthy();
    const recalled = memory.get(note.id);
    expect(recalled?.text).toContain("pool size");
    expect(recalled?.topic).toBe("postgres");
  });

  it("lists notes newest first and supports topic filter", () => {
    memory = new SessionMemory(":memory:");
    memory.remember("First note about caching", { topic: "cache" });
    memory.remember("Second note about search", { topic: "search" });
    memory.remember("Third note also about caching", { topic: "cache" });

    const all = memory.list();
    expect(all).toHaveLength(3);
    expect(all[0].text).toContain("Third note");

    const cacheNotes = memory.list({ topic: "cache" });
    expect(cacheNotes).toHaveLength(2);
  });

  it("deletes a note by id", () => {
    memory = new SessionMemory(":memory:");
    const note = memory.remember("temporary", { topic: "temp" });
    expect(memory.delete(note.id)).toBe(true);
    expect(memory.get(note.id)).toBeNull();
    expect(memory.delete(note.id)).toBe(false);
  });

  it("supports plain-text search over notes", () => {
    memory = new SessionMemory(":memory:");
    memory.remember("Use PgBouncer for transaction pooling", { topic: "postgres" });
    memory.remember("Playwright fallback is slow for SPAs", { topic: "fetch" });

    const hits = memory.search("pooling");
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain("PgBouncer");
  });

  it("enforces a max note count with LRU eviction", () => {
    memory = new SessionMemory(":memory:", { maxNotes: 2 });
    memory.remember("note one", { topic: "a" });
    memory.remember("note two", { topic: "a" });
    memory.remember("note three", { topic: "a" });

    const notes = memory.list();
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.text)).not.toContain("note one");
  });

  it("scopes notes by session id", () => {
    memory = new SessionMemory(":memory:");
    memory.remember("alpha note", { session: "s1" });
    memory.remember("beta note", { session: "s2" });

    expect(memory.list({ session: "s1" })).toHaveLength(1);
    expect(memory.list()).toHaveLength(2);
  });

  it("returns empty results for empty search", () => {
    memory = new SessionMemory(":memory:");
    memory.remember("something", {});
    expect(memory.search("")).toHaveLength(0);
    expect(memory.search("   ")).toHaveLength(0);
  });
});
