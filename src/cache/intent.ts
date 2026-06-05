import { pipeline } from "@xenova/transformers";

export type SearchIntent = "technical" | "news" | "general";

export class SearchIntentClassifier {
  private classifier: any = null;
  private classifierFailed = false;
  private modelName: string;

  constructor(modelName: string = "Xenova/nli-deberta-v3-xsmall") {
    this.modelName = modelName;
  }

  private async getClassifier() {
    if (this.classifierFailed) return null;

    if (!this.classifier) {
      try {
        this.classifier = await pipeline("zero-shot-classification", this.modelName);
      } catch (e) {
        this.classifierFailed = true;
        console.error("Intent classification model permanently failed:", e);
        return null;
      }
    }
    return this.classifier;
  }

  async classify(query: string): Promise<SearchIntent> {
    const classifier = await this.getClassifier();
    if (!classifier) return "general";
    const candidateLabels = ["technical", "news", "general info"];
    
    try {
      const output = await classifier(query, candidateLabels) as { labels: string[], scores: number[] };
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
