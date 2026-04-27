// Canonical LLM types used across the multi-model pipeline.

export type ModelProvider = "anthropic" | "openai" | "google";

// Context type describes the dominant shape of content in the request.
// Used by the router to prefer models with matching contextStrengths.
export type ContextType = "chat" | "structured" | "document" | "code" | "mixed";

// Routing task type maps intent → model capability axis.
// Distinct from the BudgetManager TaskType (token sizing); this one drives model selection.
export type RoutingTaskType =
  | "reasoning"     // deep analysis, multi-step inference
  | "retrieval"     // fact lookup, search, grounding
  | "transformation"// summarization, reformatting, translation
  | "generation"    // creative, open-ended output
  | "execution";    // code writing, tool use, action

export interface ModelConfig {
  id: string; // API model ID (versioned, e.g. "claude-sonnet-4-5")
  displayName: string; // User-facing label in model selector
  provider: ModelProvider;
  capability: number; // 0.0–1.0 general quality score
  costPerMTokInput: number; // USD per million input tokens
  costPerMTokOutput: number; // USD per million output tokens
  latencyP50Ms: number; // Median first-token latency (ms)
  latencyP95Ms: number; // P95 first-token latency (ms) — tail latency signal
  tokensPerSecond: number; // Streaming throughput after first token
  contextWindow: number; // Max input tokens
  maxOutputTokens: number;
  multimodal: boolean; // Supports image inputs
  hallucinationRisk: number; // 0.0 (low) – 1.0 (high); penalizes precision-required tasks
  reliabilityScore: number; // 0.0 – 1.0 observed API success rate
  domains: Record<string, number>; // Domain-specific capability adjustments
  contextStrengths: ContextType[]; // Content types this model handles especially well
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
