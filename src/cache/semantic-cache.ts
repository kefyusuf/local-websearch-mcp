import { IEmbeddingProvider, IVectorStore } from "./types.js";
import { SearchIntentClassifier, SearchIntent } from "./intent.js";

const TTL_MAP: Record<string, number> = {
  news: 1 * 24 * 60 * 60 * 1000,    // 1 Day
  blog: 5 * 24 * 60 * 60 * 1000,    // 5 Days
  docs: 30 * 24 * 60 * 60 * 1000,   // 30 Days
  technical: 30 * 24 * 60 * 60 * 1000, // 30 Days
  social: 3 * 24 * 60 * 60 * 1000,  // 3 Days
  general: 7 * 24 * 60 * 60 * 1000, // 7 Days
};

export class SemanticCache {
  private embeddingProvider: IEmbeddingProvider;
  private vectorStore: IVectorStore;
  private intentClassifier: SearchIntentClassifier;
  private threshold: number;

  constructor(
    embeddingProvider: IEmbeddingProvider,
    vectorStore: IVectorStore,
    threshold: number = 0.90
  ) {
    this.embeddingProvider = embeddingProvider;
    this.vectorStore = vectorStore;
    this.intentClassifier = new SearchIntentClassifier();
    this.threshold = threshold;
  }

  async detectIntent(query: string): Promise<SearchIntent> {
    return await this.intentClassifier.classify(query);
  }

  // --- Semantic Search Cache ---

  async get(query: string): Promise<any | null> {
    try {
      const vector = await this.embeddingProvider.getEmbedding(query);
      const matches = await this.vectorStore.search(vector, 1);

      if (matches.length > 0 && matches[0].score >= this.threshold) {
        console.error(`Cache Hit! Similarity: ${matches[0].score.toFixed(4)}`);
        return matches[0].metadata.results;
      }
    } catch (error) {
      console.error("Cache lookup error:", error);
    }
    return null;
  }

  async set(query: string, results: any): Promise<void> {
    try {
      const vector = await this.embeddingProvider.getEmbedding(query);
      const id = Buffer.from(query).toString("base64");
      await this.vectorStore.add(id, vector, {
        query,
        results,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error("Cache set error:", error);
    }
  }

  // --- Full Content Cache with TTL ---

  async getCachedContent(url: string): Promise<string | null> {
    const entry = await this.vectorStore.getContent(url);
    if (!entry) return null;

    const ttl = TTL_MAP[entry.category] || TTL_MAP.general;
    const isExpired = Date.now() - entry.timestamp > ttl;

    if (isExpired) {
      console.error(`Cache expired for ${url} (Category: ${entry.category})`);
      return null;
    }

    console.error(`Content Cache Hit for ${url}`);
    return entry.content;
  }

  async setCachedContent(url: string, content: string, title: string): Promise<void> {
    const category = this.detectCategory(url, title);
    await this.vectorStore.setContent(url, content, category);
  }

  private detectCategory(url: string, title: string): string {
    const combined = (url + " " + title).toLowerCase();
    
    if (/\b(docs|wiki|tutorial|learn|documentation|guide|stackoverflow|api)\b/.test(combined)) return "docs";
    if (/\b(news|haber|breaking|daily|journal|gazete)\b/.test(combined)) return "news";
    if (/\b(reddit|forum|community|discord)\b/.test(combined)) return "social";
    if (/\b(blog|article|medium\.com|substack)\b/.test(combined)) return "blog";
    
    return "general";
  }

  // --- Semantic Re-ranking ---

  async reRankResults(query: string, results: any[]): Promise<any[]> {
    if (results.length === 0) return results;

    try {
      const queryVector = await this.embeddingProvider.getEmbedding(query);
      const rankedResults = await Promise.all(
        results.map(async (res) => {
          const text = `${res.title} ${res.snippet}`;
          const resVector = await this.embeddingProvider.getEmbedding(text);
          const score = this.cosineSimilarity(queryVector, resVector);
          return { ...res, semanticScore: score };
        })
      );

      return rankedResults.sort((a, b) => b.semanticScore - a.semanticScore);
    } catch (error) {
      console.error("Re-ranking error:", error);
      return results;
    }
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
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
