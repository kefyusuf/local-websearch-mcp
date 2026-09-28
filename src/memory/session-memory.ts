import Database from "better-sqlite3";
import { createHash } from "node:crypto";

export type SessionNoteInput = {
  text: string;
  topic?: string;
  tags?: string[];
  session?: string;
};

export type RememberOptions = {
  topic?: string;
  tags?: string[];
  session?: string;
};

export type SessionNote = {
  id: string;
  text: string;
  topic: string;
  tags: string[];
  session: string;
  timestamp: number;
};

export type ListFilter = {
  topic?: string;
  session?: string;
  limit?: number;
};

export type SessionMemoryOptions = {
  maxNotes?: number;
};

const DEFAULT_MAX_NOTES = 500;

export class SessionMemory {
  private db: Database.Database;
  private maxNotes: number;

  constructor(dbPath: string = "websearch_cache.db", options?: SessionMemoryOptions) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = MEMORY");
    this.db.pragma("temp_store = MEMORY");
    this.maxNotes = options?.maxNotes ?? DEFAULT_MAX_NOTES;
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_notes (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        topic TEXT NOT NULL DEFAULT 'general',
        tags TEXT NOT NULL DEFAULT '[]',
        session TEXT NOT NULL DEFAULT 'default',
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_notes_topic ON session_notes(topic);
      CREATE INDEX IF NOT EXISTS idx_session_notes_session ON session_notes(session);
      CREATE INDEX IF NOT EXISTS idx_session_notes_ts ON session_notes(timestamp);
    `);
  }

  remember(textOrInput: string | SessionNoteInput, options?: RememberOptions): SessionNote {
    const input: SessionNoteInput = typeof textOrInput === "string"
      ? { text: textOrInput, ...options }
      : textOrInput;

    const text = input.text.trim();
    if (!text) {
      throw new Error("remember requires non-empty text");
    }

    const id = createHash("sha1")
      .update(`${input.session ?? "default"}|${text}|${Date.now()}|${Math.random()}`)
      .digest("hex");
    const topic = (input.topic || "general").trim() || "general";
    const tags = input.tags ?? [];
    const session = (input.session || "default").trim() || "default";
    const timestamp = Date.now();

    this.db.prepare(
      "INSERT INTO session_notes (id, text, topic, tags, session, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, text, topic, JSON.stringify(tags), session, timestamp);

    this.enforceMaxNotes();

    return { id, text, topic, tags, session, timestamp };
  }

  get(id: string): SessionNote | null {
    const row = this.db.prepare("SELECT * FROM session_notes WHERE id = ?").get(id) as
      | { id: string; text: string; topic: string; tags: string; session: string; timestamp: number }
      | undefined;
    return row ? this.hydrate(row) : null;
  }

  list(filter?: ListFilter): SessionNote[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter?.topic) {
      clauses.push("topic = ?");
      params.push(filter.topic);
    }
    if (filter?.session) {
      clauses.push("session = ?");
      params.push(filter.session);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 500);

    const rows = this.db.prepare(
      `SELECT * FROM session_notes ${where} ORDER BY timestamp DESC LIMIT ?`,
    ).all(...params, limit) as Array<{
      id: string;
      text: string;
      topic: string;
      tags: string;
      session: string;
      timestamp: number;
    }>;

    return rows.map((row) => this.hydrate(row));
  }

  search(query: string, filter?: ListFilter): SessionNote[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const tokens = trimmed
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((token) => token.length >= 2)
      .map((token) => token.toLowerCase());
    if (tokens.length === 0) return [];

    const limit = Math.min(Math.max(filter?.limit ?? 20, 1), 100);
    const candidates = this.list({ ...filter, limit: 500 });

    const scored = candidates
      .map((note) => {
        const haystack = `${note.text} ${note.topic} ${note.tags.join(" ")}`.toLowerCase();
        let score = 0;
        for (const token of tokens) {
          if (haystack.includes(token)) score += 1;
        }
        return { note, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.note.timestamp - a.note.timestamp);

    return scored.slice(0, limit).map((entry) => entry.note);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM session_notes WHERE id = ?").run(id);
    return result.changes > 0;
  }

  clear(session?: string): number {
    if (session) {
      return this.db.prepare("DELETE FROM session_notes WHERE session = ?").run(session).changes;
    }
    return this.db.prepare("DELETE FROM session_notes").run().changes;
  }

  getStats(): { count: number; sessions: number } {
    const count = (this.db.prepare("SELECT COUNT(*) AS c FROM session_notes").get() as { c: number }).c;
    const sessions = (
      this.db.prepare("SELECT COUNT(DISTINCT session) AS c FROM session_notes").get() as { c: number }
    ).c;
    return { count, sessions };
  }

  private enforceMaxNotes(): void {
    const count = (this.db.prepare("SELECT COUNT(*) AS c FROM session_notes").get() as { c: number }).c;
    if (count <= this.maxNotes) return;

    const excess = count - this.maxNotes;
    this.db.prepare(
      `DELETE FROM session_notes WHERE id IN (
         SELECT id FROM session_notes ORDER BY timestamp ASC LIMIT ?
       )`,
    ).run(excess);
  }

  private hydrate(row: {
    id: string;
    text: string;
    topic: string;
    tags: string;
    session: string;
    timestamp: number;
  }): SessionNote {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags);
      if (Array.isArray(parsed)) tags = parsed.map(String);
    } catch {
      tags = [];
    }
    return {
      id: row.id,
      text: row.text,
      topic: row.topic,
      tags,
      session: row.session,
      timestamp: row.timestamp,
    };
  }

  close(): void {
    this.db.close();
  }
}
