import { TransformersEmbeddingProvider } from "./cache/embedding.js";
import { InMemoryVectorStore } from "./cache/vector-store.js";
import { SemanticCache } from "./cache/semantic-cache.js";
async function testCache() {
    console.log("--- Initializing Semantic Cache ---");
    const embedding = new TransformersEmbeddingProvider();
    const store = new InMemoryVectorStore();
    const cache = new SemanticCache(embedding, store, 0.70);
    const query1 = "What is Model Context Protocol?";
    const results1 = [{ title: "MCP Intro", url: "https://example.com/mcp" }];
    console.log(`\n1. Saving: "${query1}"`);
    await cache.set(query1, results1);
    const query2 = "Explain Model Context Protocol";
    const vec1 = await embedding.getEmbedding(query1);
    const vec2 = await embedding.getEmbedding(query2);
    let dot = 0;
    for (let i = 0; i < vec1.length; i++)
        dot += vec1[i] * vec2[i];
    console.log(`Debug Similarity between "${query1}" and "${query2}": ${dot.toFixed(4)}`);
    console.log(`\n2. Searching for similar query: "${query2}"`);
    const hit = await cache.get(query2);
    if (hit) {
        console.log("SUCCESS: Semantic Cache Hit!");
        console.log("Cached Results:", JSON.stringify(hit, null, 2));
    }
    else {
        console.log("MISS: Cache could not find similar query.");
    }
    const query3 = "Hava durumu nasıl?"; // Different
    console.log(`\n3. Searching for different query: "${query3}"`);
    const hit3 = await cache.get(query3);
    if (!hit3) {
        console.log("SUCCESS: Correct Cache Miss for unrelated query.");
    }
}
testCache().catch(console.error);
