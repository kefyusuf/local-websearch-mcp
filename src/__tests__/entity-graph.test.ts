import { describe, expect, it, afterEach } from "vitest";
import { EntityGraph, extractEntities } from "../graph/entity-graph.js";

describe("extractEntities", () => {
  it("pulls capitalized multi-word terms and tech tokens", () => {
    const entities = extractEntities(
      "PgBouncer is used with PostgreSQL. Kubernetes and Docker Compose are common. See the React documentation.",
    );

    const names = entities.map((e) => e.name);
    expect(names).toContain("PgBouncer");
    expect(names).toContain("PostgreSQL");
    expect(names).toContain("Kubernetes");
    expect(names).toContain("React");
  });

  it("ignores common sentence starters and very short tokens", () => {
    const entities = extractEntities("The The and A A cat sat. PostgreSQL remains.");
    const names = entities.map((e) => e.name);
    expect(names).toContain("PostgreSQL");
    expect(names.filter((n) => n === "The")).toHaveLength(0);
    expect(names.filter((n) => n === "A")).toHaveLength(0);
  });

  it("returns empty for blank text", () => {
    expect(extractEntities("   ")).toEqual([]);
    expect(extractEntities("")).toEqual([]);
  });
});

describe("EntityGraph", () => {
  let graph: EntityGraph;

  afterEach(() => {
    graph?.close();
  });

  it("indexes entities from a document and links them to the source", () => {
    graph = new EntityGraph(":memory:");
    graph.indexDocument({
      docId: "doc-1",
      source: "https://example.com/pgbouncer",
      title: "PgBouncer Guide",
      content: "PgBouncer multiplexes PostgreSQL connections. Kubernetes operators can manage it.",
    });

    const related = graph.entitiesForDoc("doc-1");
    const names = related.map((e) => e.name);
    expect(names).toContain("PgBouncer");
    expect(names).toContain("PostgreSQL");
  });

  it("finds related documents by entity name", () => {
    graph = new EntityGraph(":memory:");
    graph.indexDocument({
      docId: "doc-a",
      source: "https://a.example",
      title: "A",
      content: "Kubernetes networking basics for PostgreSQL.",
    });
    graph.indexDocument({
      docId: "doc-b",
      source: "https://b.example",
      title: "B",
      content: "Gardening tips for summer.",
    });

    const docs = graph.docsForEntity("Kubernetes");
    expect(docs).toHaveLength(1);
    expect(docs[0].source).toBe("https://a.example");
  });

  it("returns co-occurring entities for an entity", () => {
    graph = new EntityGraph(":memory:");
    graph.indexDocument({
      docId: "doc-1",
      source: "https://example.com",
      title: "Stack",
      content: "Kubernetes runs PostgreSQL and Redis together.",
    });

    const neighbors = graph.relatedEntities("Kubernetes");
    const names = neighbors.map((e) => e.name);
    expect(names).toContain("PostgreSQL");
    expect(names).toContain("Redis");
  });

  it("re-indexing a doc replaces its entity links", () => {
    graph = new EntityGraph(":memory:");
    graph.indexDocument({ docId: "doc-1", source: "s", title: "t", content: "Kubernetes rocks." });
    graph.indexDocument({ docId: "doc-1", source: "s", title: "t", content: "PostgreSQL rocks." });

    const entities = graph.entitiesForDoc("doc-1").map((e) => e.name);
    expect(entities).toContain("PostgreSQL");
    expect(entities).not.toContain("Kubernetes");
  });

  it("reports graph stats", () => {
    graph = new EntityGraph(":memory:");
    graph.indexDocument({ docId: "d1", source: "s1", title: "t", content: "Kubernetes and PostgreSQL." });
    const stats = graph.getStats();
    expect(stats.entityCount).toBeGreaterThanOrEqual(2);
    expect(stats.linkCount).toBeGreaterThanOrEqual(2);
    expect(stats.docCount).toBe(1);
  });
});
