import { pipeline } from "@xenova/transformers";

const OPUS_MT_REGISTRY: Record<string, string> = {
  "tur_Latn": "Xenova/opus-mt-tr-en",
};

const LANG_DETECT_MODEL = "onnx-community/language_detection-ONNX";

class TranslationProvider {
  private models = new Map<string, any>();

  async translate(text: string, sourceLang: string): Promise<string> {
    const modelName = OPUS_MT_REGISTRY[sourceLang];
    if (!modelName) return text;

    let model = this.models.get(modelName);
    if (!model) {
      model = await pipeline("translation", modelName);
      this.models.set(modelName, model);
      console.error(`Translation model loaded: ${modelName}`);
    }
    const [result] = await model(text);
    return result.translation_text;
  }
}

export class CrossLingualEngine {
  private langDetector: any = null;
  private translator: TranslationProvider;

  constructor() {
    this.translator = new TranslationProvider();
  }

  private async getLangDetector() {
    if (!this.langDetector) {
      this.langDetector = await pipeline("text-classification", LANG_DETECT_MODEL);
      console.error("Language detection model loaded.");
    }
    return this.langDetector;
  }

  async detectLanguage(text: string): Promise<string> {
    try {
      const detector = await this.getLangDetector();
      const [result] = await detector(text);
      return result.label;
    } catch (error) {
      console.error("Language detection error:", error);
      return "eng_Latn";
    }
  }

  shouldCrossSearch(intent: string, lang: string): boolean {
    const isEnglish = lang?.startsWith("eng_");
    return intent === "technical" && !isEnglish;
  }

  async translateToEnglish(text: string, lang: string): Promise<string> {
    return this.translator.translate(text, lang);
  }
}
