import { TransformersEmbeddingProvider } from "./cache/embedding.js";
import { SQLiteVectorStore } from "./cache/sqlite-store.js";
import { SemanticCache } from "./cache/semantic-cache.js";
import fs from "fs";
async function testSQLiteCache() {
    const dbFile = "test_cache.db";
    if (fs.existsSync(dbFile))
        fs.unlinkSync(dbFile);
    console.log("--- Initializing SQLite Semantic Cache ---");
    const embedding = new TransformersEmbeddingProvider();
    const store = new SQLiteVectorStore(dbFile);
    const cache = new SemanticCache(embedding, store, 0.90);
    const query = "What is Model Context Protocol?";
    const results = [{ title: "MCP Intro", url: "https://example.com/mcp" }];
    console.log(`\n1. Saving to SQLite: "${query}"`);
    await cache.set(query, results);
    console.log("\n2. Closing and re-opening database to test persistence...");
    store.close();
    const newStore = new SQLiteVectorStore(dbFile);
    const newCache = new SemanticCache(embedding, newStore, 0.90);
    const querySimilar = "Tell me about Model Context Protocol";
    console.log(`\n3. Searching for similar query from persistent store: "${querySimilar}"`);
    const hit = await newCache.get(querySimilar);
    if (hit) {
        console.log("SUCCESS: Persistent Semantic Cache Hit!");
        console.log("Cached Results:", JSON.stringify(hit, null, 2));
    }
    else {
        console.log("MISS: Persistence test failed.");
    }
    newStore.close();
    if (fs.existsSync(dbFile))
        fs.unlinkSync(dbFile);
}
testSQLiteCache().catch(console.error);
