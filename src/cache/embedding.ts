import { pipeline } from "@xenova/transformers";
import { IEmbeddingProvider } from "./types.js";

export class TransformersEmbeddingProvider implements IEmbeddingProvider {
  private extractor: any = null;
  private modelName: string;

  constructor(modelName: string = "Xenova/paraphrase-multilingual-MiniLM-L12-v2") {
    this.modelName = modelName;
  }

  private async getExtractor() {
    if (!this.extractor) {
      this.extractor = await pipeline("feature-extraction", this.modelName);
    }
    return this.extractor;
  }

  async getEmbedding(text: string): Promise<number[]> {
    const extractor = await this.getExtractor();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  }
}
