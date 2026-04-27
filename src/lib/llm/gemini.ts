import type { LLMProvider, CanonicalRequest, StreamChunk } from "./types";

// Gemini REST API streaming endpoint (v1beta supports streamGenerateContent)
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiContentPart {
  text: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiContentPart[];
}

interface GeminiCandidate {
  content?: { parts?: GeminiContentPart[] };
  finishReason?: string;
}

interface GeminiStreamChunk {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export class GeminiProvider implements LLMProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  supports(modelId: string): boolean {
    return modelId.startsWith("gemini-");
  }

  async *generate(request: CanonicalRequest): AsyncIterable<StreamChunk> {
    const contents: GeminiContent[] = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: typeof m.content === "string" ? m.content : extractText(m.content) }],
      }));

    const url = `${GEMINI_API_BASE}/${request.model.id}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    const body = JSON.stringify({
      system_instruction: request.systemPrompt
        ? { parts: [{ text: request.systemPrompt }] }
        : undefined,
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        temperature: request.temperature ?? 1.0,
      },
    });

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Gemini API error ${res.status}: ${errText}`);
    }

    if (!res.body) throw new Error("Gemini: no response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;
        try {
          const chunk = JSON.parse(jsonStr) as GeminiStreamChunk;
          const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
          if (text) yield { text };
        } catch {
          // Malformed SSE chunk — skip
        }
      }
    }

    // Flush remaining buffer
    if (buffer.startsWith("data: ")) {
      const jsonStr = buffer.slice(6).trim();
      if (jsonStr && jsonStr !== "[DONE]") {
        try {
          const chunk = JSON.parse(jsonStr) as GeminiStreamChunk;
          const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
          if (text) yield { text };
        } catch {
          // Ignore
        }
      }
    }
  }
}

function extractText(content: CanonicalRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}
