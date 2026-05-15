import { TransformersEmbeddingProvider } from "./cache/embedding.js";
import { SQLiteVectorStore } from "./cache/sqlite-store.js";
import { SemanticCache } from "./cache/semantic-cache.js";
import fs from "fs";
async function testAdvanced() {
    const dbFile = "test_advanced.db";
    if (fs.existsSync(dbFile))
        fs.unlinkSync(dbFile);
    const embedding = new TransformersEmbeddingProvider();
    const store = new SQLiteVectorStore(dbFile);
    const cache = new SemanticCache(embedding, store, 0.70);
    console.log("--- 1. Testing Category Detection & Content Cache ---");
    const urls = [
        { url: "https://www.bbc.com/news/world-123", title: "World News Today" },
        { url: "https://docs.mcp.io/intro", title: "MCP Documentation" },
        { url: "https://medium.com/@user/my-blog", title: "My Awesome Blog Post" }
    ];
    for (const item of urls) {
        await cache.setCachedContent(item.url, `Content for ${item.title}`, item.title);
        const entry = await store.getContent(item.url);
        console.log(`URL: ${item.url} -> Detected Category: ${entry.category}`);
    }
    console.log("\n--- 2. Testing Semantic Re-ranking ---");
    const query = "How to use Model Context Protocol?";
    const rawResults = [
        { title: "Cooking Pasta", snippet: "Learn how to cook the best pasta at home.", url: "1" },
        { title: "MCP Guide", snippet: "A comprehensive guide on using the Model Context Protocol for AI.", url: "2" },
        { title: "Weather Today", snippet: "Cloudy with a chance of rain in Istanbul.", url: "3" }
    ];
    console.log("Re-ranking results for:", query);
    const ranked = await cache.reRankResults(query, rawResults);
    ranked.forEach((r, i) => {
        console.log(`${i + 1}. ${r.title} (Score: ${r.semanticScore?.toFixed(4)})`);
    });
    store.close();
    if (fs.existsSync(dbFile))
        fs.unlinkSync(dbFile);
}
testAdvanced().catch(console.error);
