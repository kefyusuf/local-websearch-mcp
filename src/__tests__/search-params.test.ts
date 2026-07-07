import { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import { SearchSchema } from "../index.js";

describe("SearchSchema", () => {
  it("accepts a query without optional parameters", () => {
    const parsed = SearchSchema.parse({ query: "test" });

    expect(parsed.query).toBe("test");
    expect(parsed.deep).toBeUndefined();
    expect(parsed.max_results).toBeUndefined();
  });

  it("accepts deep mode and bounded max_results", () => {
    const parsed = SearchSchema.parse({ query: "test", deep: true, max_results: 3 });

    expect(parsed).toEqual({
      query: "test",
      deep: true,
      max_results: 3,
    });
  });

  it("accepts an optional domain filter", () => {
    const parsed = SearchSchema.parse({ query: "docs", domain: "react.dev" });

    expect(parsed).toEqual({
      query: "docs",
      domain: "react.dev",
    });
  });

  it("rejects max_results above the upper bound", () => {
    expect(() => SearchSchema.parse({ query: "test", max_results: 11 })).toThrowError(ZodError);
  });

  it("rejects max_results below the lower bound", () => {
    expect(() => SearchSchema.parse({ query: "test", max_results: 0 })).toThrowError(ZodError);
  });

  it("rejects an empty query", () => {
    expect(() => SearchSchema.parse({ query: "" })).toThrowError(ZodError);
  });
});
