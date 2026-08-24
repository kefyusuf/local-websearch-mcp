import { pipeline } from "@huggingface/transformers";
import { detectHeuristicIntent } from "./heuristics.js";

export type SearchIntent =
  | "technical"
  | "research"
  | "news"
  | "commercial"
  | "shopping"
  | "local"
  | "navigational"
  | "general";

export type IntentDetection = {
  intent: SearchIntent;
  source: "heuristic" | "classifier";
};

export interface IntentClassifier {
  classify(query: string): Promise<SearchIntent>;
}

const LABEL_TO_INTENT: Record<string, SearchIntent> = {
  "software development and technical documentation": "technical",
  "research comparison and evidence gathering": "research",
  "current news and recent events": "news",
  "companies vendors and competitors": "commercial",
  "shopping products prices and deals": "shopping",
  "local places and nearby services": "local",
  "official website documentation or specific page": "navigational",
  "general information": "general",
};

const LABELS = Object.keys(LABEL_TO_INTENT);

type ZeroShotRunner = (
  query: string,
  labels: string[],
) => Promise<{ labels: string[]; scores: number[] }>;

export type PipelineLoader = (
  task: "zero-shot-classification",
  model: string,
) => Promise<ZeroShotRunner>;

export class SearchIntentClassifier implements IntentClassifier {
  private classifier: ZeroShotRunner | null = null;
  private classifierFailed = false;

  constructor(
    private readonly modelName = "Xenova/nli-deberta-v3-xsmall",
    private readonly loadPipeline: PipelineLoader = pipeline as unknown as PipelineLoader,
  ) {}

  async classify(query: string): Promise<SearchIntent> {
    if (this.classifierFailed) return "general";

    try {
      if (!this.classifier) {
        this.classifier = await this.loadPipeline("zero-shot-classification", this.modelName);
      }
      const output = await this.classifier(query, LABELS);
      return LABEL_TO_INTENT[output.labels[0]] ?? "general";
    } catch (error) {
      this.classifierFailed = true;
      console.error("Intent classification model permanently failed:", error);
      return "general";
    }
  }
}

export class SearchIntentDetector {
  constructor(
    private readonly classifier: IntentClassifier = new SearchIntentClassifier(),
  ) {}

  async detect(query: string): Promise<IntentDetection> {
    const heuristic = detectHeuristicIntent(query);
    if (heuristic) return { intent: heuristic, source: "heuristic" };
    return {
      intent: await this.classifier.classify(query),
      source: "classifier",
    };
  }
}
