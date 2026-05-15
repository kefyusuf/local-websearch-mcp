import { pipeline } from "@xenova/transformers";

export type SearchIntent = "technical" | "news" | "general";

export class SearchIntentClassifier {
  private classifier: any = null;
  private modelName: string;

  constructor(modelName: string = "Xenova/nli-deberta-v3-xsmall") {
    this.modelName = modelName;
  }

  private async getClassifier() {
    if (!this.classifier) {
      this.classifier = await pipeline("zero-shot-classification", this.modelName);
    }
    return this.classifier;
  }

  async classify(query: string): Promise<SearchIntent> {
    const classifier = await this.getClassifier();
    const candidateLabels = ["technical", "news", "general info"];
    
    try {
      const output = await classifier(query, candidateLabels);
      const topLabel = output.labels[0];
      
      if (topLabel === "technical") return "technical";
      if (topLabel === "news") return "news";
      return "general";
    } catch (error) {
      console.error("Intent classification error:", error);
      return "general";
    }
  }
}
