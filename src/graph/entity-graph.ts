import Database from "better-sqlite3";
import { createHash } from "node:crypto";

export type ExtractedEntity = {
  name: string;
  count: number;
};

export type EntityDocLink = {
  docId: string;
  source: string;
  title: string;
  count: number;
};

export type EntityNeighbor = {
  name: string;
  cooccurrence: number;
};

export type IndexDocumentInput = {
  docId: string;
  source: string;
  title: string;
  content: string;
};

const STOPWORDS = new Set([
  "The", "A", "An", "And", "Or", "But", "If", "Then", "Else", "When", "At", "By",
  "For", "With", "About", "Against", "Between", "Into", "Through", "During",
  "Before", "After", "Above", "Below", "To", "From", "Up", "Down", "In", "Out",
  "On", "Off", "Over", "Under", "Again", "Further", "Once", "Here", "There",
  "All", "Any", "Both", "Each", "Few", "More", "Most", "Other", "Some", "Such",
  "No", "Nor", "Not", "Only", "Own", "Same", "So", "Than", "Too", "Very", "Can",
  "Will", "Just", "Do", "Does", "Did", "Is", "Are", "Was", "Were", "Be", "Been",
  "Being", "Have", "Has", "Had", "Having", "Of", "As", "It", "Its", "This",
  "That", "These", "Those", "I", "Me", "My", "We", "Our", "You", "Your", "He",
  "She", "They", "Them", "His", "Her", "Their", "What", "Which", "Who", "Whom",
  "How", "Why", "Where", "Please", "Note", "Example", "Examples",
]);

const TECH_TOKEN = /^[A-Za-z][A-Za-z0-9+#.\-_]{2,30}$/;

export function extractEntities(text: string): ExtractedEntity[] {
  if (!text || !text.trim()) return [];

  const counts = new Map<string, number>();

  // Multi-word capitalized phrases: "Machine Learning", "React Native"
  const phrasePattern = /\b([A-Z][A-Za-z0-9+#.\-_]*(?:\s+[A-Z][A-Za-z0-9+#.\-_]*){0,3})\b/g;
  let match: RegExpExecArray | null;
  while ((match = phrasePattern.exec(text)) !== null) {
    const phrase = match[1].replace(/\s+/g, " ").trim();
    const first = phrase.split(" ")[0];
    if (STOPWORDS.has(first) || phrase.length < 3) continue;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }

  // Standalone tech-looking tokens: PgBouncer, kubernetes, PostgreSQL
  const tokenPattern = /\b([A-Za-z][A-Za-z0-9+#.\-_]{2,30})\b/g;
  while ((match = tokenPattern.exec(text)) !== null) {
    const token = match[1];
    if (STOPWORDS.has(token) || !TECH_TOKEN.test(token)) continue;
    // Skip generic lowercase words unless they look technical (camelCase / mixed / digits).
    const looksTechnical =
      /[A-Z]/.test(token.slice(1)) ||
      /\d/.test(token) ||
      /[+#._-]/.test(token) ||
      /^[A-Z][a-z]+[A-Z]/.test(token);
    const startsCapital = /^[A-Z]/.test(token);
    if (!looksTechnical && !startsCapital) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .filter((entity) => entity.name.length >= 3)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function entityId(name: string): string {
  return createHash("sha1").update(name.toLowerCase()).digest("hex");
}

export class EntityGraph {
  private db: Database.Database;

  constructor(dbPath: string = "websearch_cache.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = MEMORY");
    this.db.pragma("temp_store = MEMORY");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        mention_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS graph_docs (
        doc_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS graph_doc_entities (
        doc_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (doc_id, entity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_graph_doc_entities_entity ON graph_doc_entities(entity_id);
    `);
  }

  indexDocument(input: IndexDocumentInput): number {
    const entities = extractEntities(input.content);
    const timestamp = Date.now();

    const run = this.db.transaction(() => {
      // Replace any previous index for this doc.
      this.db.prepare("DELETE FROM graph_doc_entities WHERE doc_id = ?").run(input.docId);
      this.db.prepare("DELETE FROM graph_docs WHERE doc_id = ?").run(input.docId);

      this.db.prepare(
        "INSERT INTO graph_docs (doc_id, source, title, timestamp) VALUES (?, ?, ?, ?)",
      ).run(input.docId, input.source, input.title, timestamp);

      const upsertEntity = this.db.prepare(`
        INSERT INTO graph_entities (id, name, mention_count) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET mention_count = mention_count + excluded.mention_count
      `);
      const link = this.db.prepare(
        "INSERT OR REPLACE INTO graph_doc_entities (doc_id, entity_id, count) VALUES (?, ?, ?)",
      );

      for (const entity of entities) {
        const id = entityId(entity.name);
        upsertEntity.run(id, entity.name, entity.count);
        link.run(input.docId, id, entity.count);
      }
    });
    run();

    return entities.length;
  }

  entitiesForDoc(docId: string): ExtractedEntity[] {
    return this.db.prepare(`
      SELECT e.name AS name, de.count AS count
      FROM graph_doc_entities de
      JOIN graph_entities e ON e.id = de.entity_id
      WHERE de.doc_id = ?
      ORDER BY de.count DESC, e.name ASC
    `).all(docId) as ExtractedEntity[];
  }

  docsForEntity(name: string, limit: number = 10): EntityDocLink[] {
    return this.db.prepare(`
      SELECT d.doc_id AS docId, d.source AS source, d.title AS title, de.count AS count
      FROM graph_entities e
      JOIN graph_doc_entities de ON de.entity_id = e.id
      JOIN graph_docs d ON d.doc_id = de.doc_id
      WHERE LOWER(e.name) = LOWER(?)
      ORDER BY de.count DESC, d.timestamp DESC
      LIMIT ?
    `).all(name, limit) as EntityDocLink[];
  }

  relatedEntities(name: string, limit: number = 10): EntityNeighbor[] {
    return this.db.prepare(`
      SELECT e2.name AS name, COUNT(*) AS cooccurrence
      FROM graph_entities e1
      JOIN graph_doc_entities de1 ON de1.entity_id = e1.id
      JOIN graph_doc_entities de2 ON de2.doc_id = de1.doc_id AND de2.entity_id != de1.entity_id
      JOIN graph_entities e2 ON e2.id = de2.entity_id
      WHERE LOWER(e1.name) = LOWER(?)
      GROUP BY e2.name
      ORDER BY cooccurrence DESC, e2.name ASC
      LIMIT ?
    `).all(name, limit) as EntityNeighbor[];
  }

  getStats(): { entityCount: number; docCount: number; linkCount: number } {
    const entityCount = (this.db.prepare("SELECT COUNT(*) AS c FROM graph_entities").get() as { c: number }).c;
    const docCount = (this.db.prepare("SELECT COUNT(*) AS c FROM graph_docs").get() as { c: number }).c;
    const linkCount = (this.db.prepare("SELECT COUNT(*) AS c FROM graph_doc_entities").get() as { c: number }).c;
    return { entityCount, docCount, linkCount };
  }

  close(): void {
    this.db.close();
  }
}
