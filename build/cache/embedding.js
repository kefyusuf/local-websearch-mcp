import { pipeline } from "@xenova/transformers";
export class TransformersEmbeddingProvider {
    extractor = null;
    modelName;
    constructor(modelName = "Xenova/paraphrase-multilingual-MiniLM-L12-v2") {
        this.modelName = modelName;
    }
    async getExtractor() {
        if (!this.extractor) {
            this.extractor = await pipeline("feature-extraction", this.modelName);
        }
        return this.extractor;
    }
    async getEmbedding(text) {
        const extractor = await this.getExtractor();
        const output = await extractor(text, { pooling: "mean", normalize: true });
        return Array.from(output.data);
    }
}
