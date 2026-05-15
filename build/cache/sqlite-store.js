import Database from "better-sqlite3";
import * as sqlite_vec from "sqlite-vec";
export class SQLiteVectorStore {
    db;
    isVecEnabled = false;
    constructor(dbPath = "cache.db") {
        this.db = new Database(dbPath);
        this.tryEnableVec();
        this.init();
    }
    tryEnableVec() {
        try {
            sqlite_vec.load(this.db);
            this.isVecEnabled = true;
            console.error("sqlite-vec extension loaded successfully.");
        }
        catch (error) {
            console.error("Failed to load sqlite-vec, falling back to JS-based search:", error);
            this.isVecEnabled = false;
        }
    }
    init() {
        // Content cache table
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_cache (
        url TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);
        if (this.isVecEnabled) {
            // High-performance vector table
            this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS semantic_cache_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[384]
        );
        
        CREATE TABLE IF NOT EXISTS semantic_cache_metadata (
          id TEXT PRIMARY KEY,
          metadata TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        );
      `);
        }
        else {
            // Fallback JS-based table
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS vector_cache_fallback (
          id TEXT PRIMARY KEY,
          vector TEXT NOT NULL,
          metadata TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        );
      `);
        }
    }
    async add(id, vector, metadata) {
        if (this.isVecEnabled) {
            const vecStmt = this.db.prepare("INSERT OR REPLACE INTO semantic_cache_vec(id, embedding) VALUES (?, ?)");
            const metaStmt = this.db.prepare("INSERT OR REPLACE INTO semantic_cache_metadata(id, metadata, timestamp) VALUES (?, ?, ?)");
            const transaction = this.db.transaction((id, vec, meta) => {
                vecStmt.run(id, new Float32Array(vec));
                metaStmt.run(id, JSON.stringify(meta), Date.now());
            });
            transaction(id, vector, metadata);
        }
        else {
            const stmt = this.db.prepare("INSERT OR REPLACE INTO vector_cache_fallback (id, vector, metadata, timestamp) VALUES (?, ?, ?, ?)");
            stmt.run(id, JSON.stringify(vector), JSON.stringify(metadata), Date.now());
        }
    }
    async search(vector, limit) {
        if (this.isVecEnabled) {
            // SQLite-vec KNN search
            const rows = this.db.prepare(`
        SELECT 
          v.id,
          vec_distance_cosine(v.embedding, ?) as distance,
          m.metadata
        FROM semantic_cache_vec v
        JOIN semantic_cache_metadata m ON v.id = m.id
        ORDER BY distance ASC
        LIMIT ?
      `).all(new Float32Array(vector), limit);
            return rows.map(row => ({
                id: row.id,
                score: 1 - row.distance, // Convert cosine distance to similarity
                metadata: JSON.parse(row.metadata)
            }));
        }
        else {
            // Fallback JS-based search
            const rows = this.db.prepare("SELECT id, vector, metadata FROM vector_cache_fallback").all();
            const results = rows.map((row) => {
                const storedVector = JSON.parse(row.vector);
                const score = this.cosineSimilarity(vector, storedVector);
                return {
                    id: row.id,
                    score,
                    metadata: JSON.parse(row.metadata),
                };
            });
            return results
                .sort((a, b) => b.score - a.score)
                .slice(0, limit);
        }
    }
    async clear() {
        this.db.prepare("DELETE FROM content_cache").run();
        if (this.isVecEnabled) {
            this.db.prepare("DELETE FROM semantic_cache_vec").run();
            this.db.prepare("DELETE FROM semantic_cache_metadata").run();
        }
        else {
            this.db.prepare("DELETE FROM vector_cache_fallback").run();
        }
    }
    async getContent(url) {
        const row = this.db.prepare("SELECT * FROM content_cache WHERE url = ?").get(url);
        return row || null;
    }
    async setContent(url, content, category) {
        const stmt = this.db.prepare("INSERT OR REPLACE INTO content_cache (url, content, category, timestamp) VALUES (?, ?, ?, ?)");
        stmt.run(url, content, category, Date.now());
    }
    cosineSimilarity(vecA, vecB) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0)
            return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
    close() {
        this.db.close();
    }
}
