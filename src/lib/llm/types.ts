// Canonical LLM types used across the multi-model pipeline.

export type ModelProvider = "anthropic" | "openai";

export interface ModelConfig {
  id: string; // API model ID (versioned, e.g. "claude-sonnet-4-5")
  displayName: string; // User-facing label in model selector
  provider: ModelProvider;
  capability: number; // 0.0–1.0 general quality score
  costPerMTokInput: number; // USD per million input tokens
  costPerMTokOutput: number; // USD per million output tokens
  latencyP50Ms: number; // Median first-token latency
  contextWindow: number; // Max input tokens
  maxOutputTokens: number;
  multimodal: boolean; // Supports image inputs
  domains: Record<string, number>; // Domain-specific capability adjustments
}

export interface CanonicalMessage {
  role: "user" | "assistant" | "system";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mediaType: string } // base64
        | { type: "image_url"; url: string } // signed URL
      >;
}

export interface CanonicalRequest {
  model: ModelConfig;
  messages: CanonicalMessage[];
  systemPrompt: string;
  maxTokens: number;
  temperature?: number;
}

export interface StreamChunk {
  text: string;
}

export interface LLMResponse {
  content: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  stopReason: "end_turn" | "max_tokens" | "stop_sequence" | "error";
}

export interface LLMProvider {
  generate(request: CanonicalRequest): AsyncIterable<StreamChunk>;
  supports(modelId: string): boolean;
}

export interface RoutingDecision {
  selected: ModelConfig;
  fallback: ModelConfig[];
  reason: "auto" | "user_override" | "hard_filter" | "exhaustion";
  score: number;
}

export type Intent =
  | "question"
  | "creative"
  | "action"
  | "search"
  | "analysis"
  | "casual_chat"
  | "multi_part"
  | "follow_up"
  | "acknowledgment";

export interface IntentResult {
  intent: Intent;
  confidence: number;
  isFollowUp: boolean;
  followUpReference: string | null;
  complexity: number; // 0.0–1.0
  domain: string; // general, code, analysis, creative, etc.
}
