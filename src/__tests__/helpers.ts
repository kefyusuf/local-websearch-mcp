import { IVectorStore, VectorMatch, CacheMetadata, ContentEntry } from "../cache/types.js";
import { cosineSimilarity } from "../cache/utils.js";

export class InMemoryVectorStore implements IVectorStore {
  private store: Map<string, { vector: number[]; metadata: CacheMetadata }> = new Map();
  private contentStore: Map<string, { content: string; category: string; timestamp: number }> = new Map();

  async add(id: string, vector: number[], metadata: CacheMetadata): Promise<void> {
    this.store.set(id, { vector, metadata });
  }

  async search(vector: number[], limit: number): Promise<VectorMatch[]> {
    const results: VectorMatch[] = [];

    for (const [id, entry] of this.store.entries()) {
      const score = cosineSimilarity(vector, entry.vector);
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

  close(): void {
  }

  async getContent(url: string): Promise<ContentEntry | null> {
    const entry = this.contentStore.get(url);
    if (!entry) return null;
    return { url, ...entry };
  }

  async setContent(url: string, content: string, category: string): Promise<void> {
    this.contentStore.set(url, { content, category, timestamp: Date.now() });
  }
}
