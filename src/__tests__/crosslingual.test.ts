import { describe, it, expect } from "vitest";
import { CrossLingualEngine } from "../cache/crosslingual.js";

describe("CrossLingualEngine", () => {
  it("should detect English queries as non-cross-search", () => {
    const engine = new CrossLingualEngine();
    expect(engine.shouldCrossSearch("technical", "eng_Latn")).toBe(false);
  });

  it("should trigger cross-search for technical non-English queries", () => {
    const engine = new CrossLingualEngine();
    expect(engine.shouldCrossSearch("technical", "tur_Latn")).toBe(true);
    expect(engine.shouldCrossSearch("technical", "fra_Latn")).toBe(true);
    expect(engine.shouldCrossSearch("technical", "deu_Latn")).toBe(true);
  });

  it("should not trigger cross-search for non-technical non-English queries", () => {
    const engine = new CrossLingualEngine();
    expect(engine.shouldCrossSearch("news", "tur_Latn")).toBe(false);
    expect(engine.shouldCrossSearch("general", "tur_Latn")).toBe(false);
  });

  it("should not trigger cross-search for general intent", () => {
    const engine = new CrossLingualEngine();
    expect(engine.shouldCrossSearch("general", "tur_Latn")).toBe(false);
  });
});
