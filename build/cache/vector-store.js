export class InMemoryVectorStore {
    store = new Map();
    contentStore = new Map();
    async add(id, vector, metadata) {
        this.store.set(id, { vector, metadata });
    }
    async search(vector, limit) {
        const results = [];
        for (const [id, entry] of this.store.entries()) {
            const score = this.cosineSimilarity(vector, entry.vector);
            results.push({ id, score, metadata: entry.metadata });
        }
        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }
    async clear() {
        this.store.clear();
        this.contentStore.clear();
    }
    async getContent(url) {
        const entry = this.contentStore.get(url);
        if (!entry)
            return null;
        return { url, ...entry };
    }
    async setContent(url, content, category) {
        this.contentStore.set(url, { content, category, timestamp: Date.now() });
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
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}
