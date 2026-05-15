export interface IEmbeddingProvider {
  getEmbedding(text: string): Promise<number[]>;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata: any;
}

export interface IVectorStore {
  add(id: string, vector: number[], metadata: any): Promise<void>;
  search(vector: number[], limit: number): Promise<VectorMatch[]>;
  clear(): Promise<void>;
  
  // Content Cache Methods
  getContent(url: string): Promise<ContentEntry | null>;
  setContent(url: string, content: string, category: string): Promise<void>;
}

export interface ContentEntry {
  url: string;
  content: string;
  category: string;
  timestamp: number;
}

export interface CacheEntry {
  query: string;
  results: any;
  timestamp: number;
}
