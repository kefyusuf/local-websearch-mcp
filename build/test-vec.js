import { SQLiteVectorStore } from "./cache/sqlite-store.js";
import fs from "fs";
async function testVec() {
    const dbFile = "test_vec.db";
    if (fs.existsSync(dbFile))
        fs.unlinkSync(dbFile);
    console.log("--- Testing sqlite-vec Integration ---");
    const store = new SQLiteVectorStore(dbFile);
    const vec1 = Array(384).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    const vec2 = Array(384).fill(0).map((_, i) => (i === 0 ? 0.9 : 0.1));
    const vec3 = Array(384).fill(0).map((_, i) => (i === 10 ? 1 : 0));
    console.log("Adding vectors...");
    await store.add("v1", vec1, { name: "Perfect Match" });
    await store.add("v2", vec2, { name: "Similar Match" });
    await store.add("v3", vec3, { name: "Different" });
    console.log("Searching for vec1...");
    const results = await store.search(vec1, 3);
    console.log("Results:", JSON.stringify(results, null, 2));
    store.close();
    if (fs.existsSync(dbFile))
        fs.unlinkSync(dbFile);
}
testVec().catch(console.error);
