import OpenAI from "openai";
import type { LLMProvider, CanonicalRequest, StreamChunk } from "./types";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  supports(modelId: string): boolean {
    return modelId.startsWith("gpt-");
  }

  async *generate(request: CanonicalRequest): AsyncIterable<StreamChunk> {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: request.systemPrompt },
      ...request.messages.filter((m) => m.role !== "system").map((m) =>
        this.toOpenAIMessage(m),
      ),
    ];

    const stream = await this.client.chat.completions.create({
      model: request.model.id,
      messages,
      stream: true,
      max_tokens: request.maxTokens,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? "";
      if (text) yield { text };
    }
  }

  private toOpenAIMessage(
    msg: CanonicalRequest["messages"][number],
  ): ChatCompletionMessageParam {
    if (typeof msg.content === "string") {
      return { role: msg.role as "user" | "assistant", content: msg.content };
    }

    const parts: OpenAI.ChatCompletionContentPart[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
      } else if (part.type === "image") {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${part.mediaType};base64,${part.data}` },
        });
      } else if (part.type === "image_url") {
        parts.push({ type: "image_url", image_url: { url: part.url } });
      }
    }
    return msg.role === "assistant"
      ? { role: "assistant", content: parts }
      : { role: "user", content: parts };
  }
}
