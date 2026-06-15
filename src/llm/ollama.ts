export class OllamaClient {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string = "http://localhost:11434", model: string = "llama3.2") {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async summarize(content: string, question: string): Promise<string | null> {
    const prompt =
      "Answer the following question based only on the provided content. Be concise and direct.\n\nQuestion: " +
      question +
      "\n\nContent:\n" +
      content.slice(0, 8000) +
      "\n\nAnswer:";

    try {
      const response = await fetch(this.baseUrl + "/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) return null;
      const data = await response.json() as { response?: string };
      return data.response?.trim() ?? null;
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(this.baseUrl + "/api/tags", {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
