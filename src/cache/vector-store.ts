import { IVectorStore, VectorMatch } from "./types.js";

export class InMemoryVectorStore implements IVectorStore {
  private store: Map<string, { vector: number[]; metadata: any }> = new Map();
  private contentStore: Map<string, { content: string; category: string; timestamp: number }> = new Map();

  async add(id: string, vector: number[], metadata: any): Promise<void> {
    this.store.set(id, { vector, metadata });
  }

  async search(vector: number[], limit: number): Promise<VectorMatch[]> {
    const results: VectorMatch[] = [];

    for (const [id, entry] of this.store.entries()) {
      const score = this.cosineSimilarity(vector, entry.vector);
      results.push({ id, score, metadata: entry.metadata });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async clear(): Promise<void> {
    this.store.clear();
    this.contentStore.clear();
  }

  async getContent(url: string): Promise<any | null> {
    const entry = this.contentStore.get(url);
    if (!entry) return null;
    return { url, ...entry };
  }

  async setContent(url: string, content: string, category: string): Promise<void> {
    this.contentStore.set(url, { content, category, timestamp: Date.now() });
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
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
