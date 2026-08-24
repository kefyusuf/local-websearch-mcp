export interface TranslationResult {
  translation_text: string;
}

export interface ClassificationResult {
  label: string;
  score: number;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
  sources?: string[];
  providerRanks?: Record<string, number>;
  fusionScore?: number;
  semanticScore?: number;
}

export interface CacheMetadata {
  query: string;
  results: SearchResultItem[];
  timestamp: number;
}

export interface IEmbeddingProvider {
  getEmbedding(text: string): Promise<number[]>;
  isAvailable(): boolean;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata: CacheMetadata;
}

export interface IVectorStore {
  add(id: string, vector: number[], metadata: CacheMetadata): Promise<void>;
  search(vector: number[], limit: number): Promise<VectorMatch[]>;
  clear(): Promise<void>;
  getStats(): { contentCount: number; vectorCount: number };
  close(): void;
  
  // Content Cache Methods
  getContent(url: string): Promise<ContentEntry | null>;
  setContent(url: string, content: string, category: string): Promise<void>;
  deleteExpiredContent(maxAgeMs: number): number;
}

export interface ContentEntry {
  url: string;
  content: string;
  category: string;
  timestamp: number;
}

export interface CacheEntry {
  query: string;
  results: SearchResultItem[];
  timestamp: number;
}
