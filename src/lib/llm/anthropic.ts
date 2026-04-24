import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, CanonicalRequest, StreamChunk } from "./types";

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  supports(modelId: string): boolean {
    return modelId.startsWith("claude-");
  }

  async *generate(request: CanonicalRequest): AsyncIterable<StreamChunk> {
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => this.toAnthropicMessage(m));

    const stream = this.client.messages.stream({
      model: request.model.id,
      max_tokens: request.maxTokens,
      system: request.systemPrompt,
      messages,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { text: event.delta.text };
      }
    }
  }

  private toAnthropicMessage(
    msg: CanonicalRequest["messages"][number],
  ): Anthropic.MessageParam {
    if (typeof msg.content === "string") {
      return { role: msg.role as "user" | "assistant", content: msg.content };
    }

    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        blocks.push({ type: "text", text: part.text });
      } else if (part.type === "image") {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: part.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data: part.data,
          },
        });
      } else if (part.type === "image_url") {
        blocks.push({
          type: "image",
          source: { type: "url", url: part.url },
        });
      }
    }
    return { role: msg.role as "user" | "assistant", content: blocks };
  }
}
