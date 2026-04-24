/** Shared types for the token-optimization middleware. */

export type TaskType =
  | "classification"
  | "extraction"
  | "summarization"
  | "generation"
  | "reasoning"
  | "coding";

export type Provider = "openai" | "anthropic";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TokenBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
}

export interface OptimizationConfig {
  budget: TokenBudget;
  historyKeepTurns: number;
  contextTopKChunks: number;
  chunkSizeTokens: number;
  chunkOverlapTokens: number;
  enableCleaning: boolean;
  enableNormalization: boolean;
  enableHistoryTrimming: boolean;
  enableContextPruning: boolean;
  enableCaching: boolean;
  taskType?: TaskType;
  provider: Provider;
  /** Domains where aggressive compression must not be applied. */
  sensitiveDomains: string[];
}

export interface OptimizationResult {
  messages: Message[];
  systemPrompt: string | null;
  maxOutputTokens: number;
  inputTokensBefore: number;
  inputTokensAfter: number;
  savingsTokens: number;
  savingsPct: number;
  warnings: string[];
  cacheHits: number;
}

/** Default configuration factory — safe to mutate the returned object. */
export function defaultConfig(overrides?: Partial<OptimizationConfig>): OptimizationConfig {
  return {
    budget: {
      maxInputTokens: 8_000,
      maxOutputTokens: 2_048,
      maxTotalTokens: 10_048,
    },
    historyKeepTurns: 10,
    contextTopKChunks: 5,
    chunkSizeTokens: 512,
    chunkOverlapTokens: 64,
    enableCleaning: true,
    enableNormalization: true,
    enableHistoryTrimming: true,
    enableContextPruning: true,
    enableCaching: true,
    provider: "openai",
    sensitiveDomains: ["legal", "medical", "financial", "compliance"],
    ...overrides,
  };
}
