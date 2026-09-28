import { describe, expect, it } from "vitest";
import { SearchTrace, formatTraceSummary } from "../observability/search-trace.js";

describe("SearchTrace", () => {
  it("records stages with duration and status", () => {
    const trace = new SearchTrace("postgres pooling");
    trace.startStage("provider:brave");
    trace.endStage("provider:brave", { status: "ok", resultCount: 3 });
    trace.startStage("provider:google");
    trace.endStage("provider:google", { status: "empty" });

    const json = trace.toJSON();
    expect(json.query).toBe("postgres pooling");
    expect(json.stages).toHaveLength(2);
    expect(json.stages[0].name).toBe("provider:brave");
    expect(json.stages[0].status).toBe("ok");
    expect(json.stages[0].resultCount).toBe(3);
    expect(json.stages[1].status).toBe("empty");
    expect(json.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("records errors without throwing", () => {
    const trace = new SearchTrace("q");
    trace.startStage("provider:bing");
    trace.failStage("provider:bing", "HTTP 429");
    const json = trace.toJSON();
    expect(json.stages[0].status).toBe("error");
    expect(json.stages[0].error).toBe("HTTP 429");
  });

  it("tracks cache hits and intent metadata", () => {
    const trace = new SearchTrace("q");
    trace.setMeta({ cache: "miss", strategy: "auto", intent: "technical", plan: "aggregate[brave,google]" });

    const json = trace.toJSON();
    expect(json.meta.cache).toBe("miss");
    expect(json.meta.intent).toBe("technical");
    expect(json.stages).toHaveLength(0);
  });

  it("is safe when ending an unknown stage", () => {
    const trace = new SearchTrace("q");
    expect(() => trace.endStage("never-started")).not.toThrow();
  });
});

describe("formatTraceSummary", () => {
  it("renders a compact multi-line summary", () => {
    const trace = new SearchTrace("pg pooling");
    trace.setMeta({ strategy: "fallback", cache: "miss" });
    trace.startStage("provider:duckduckgo");
    trace.endStage("provider:duckduckgo", { status: "ok", resultCount: 5 });

    const text = formatTraceSummary(trace);
    expect(text).toContain("pg pooling");
    expect(text).toContain("provider:duckduckgo");
    expect(text).toContain("fallback");
    expect(text).toContain("cache=miss");
  });
});
