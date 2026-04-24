import type { ModelConfig } from "./types";

// Model registry. IDs are the actual versioned API strings.
// Display names appear ONLY in the model selector — never in chat UI.
export const MODEL_REGISTRY: ModelConfig[] = [
  {
    id: "claude-haiku-4-5",
    displayName: "Claude Haiku",
    provider: "anthropic",
    capability: 0.6,
    costPerMTokInput: 0.25,
    costPerMTokOutput: 1.25,
    latencyP50Ms: 300,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    multimodal: true,
    domains: { general: 0.6, code: 0.5, creative: 0.55 },
  },
  {
    id: "claude-sonnet-4-5",
    displayName: "Claude Sonnet",
    provider: "anthropic",
    capability: 0.85,
    costPerMTokInput: 3.0,
    costPerMTokOutput: 15.0,
    latencyP50Ms: 600,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    multimodal: true,
    domains: { general: 0.85, code: 0.8, analysis: 0.9, reasoning: 0.85 },
  },
  {
    id: "claude-opus-4-5",
    displayName: "Claude Opus",
    provider: "anthropic",
    capability: 0.95,
    costPerMTokInput: 15.0,
    costPerMTokOutput: 75.0,
    latencyP50Ms: 1200,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    multimodal: true,
    domains: { general: 0.95, analysis: 0.95, reasoning: 0.98, code: 0.9 },
  },
  {
    id: "gpt-4o-mini",
    displayName: "GPT-4o mini",
    provider: "openai",
    capability: 0.65,
    costPerMTokInput: 0.15,
    costPerMTokOutput: 0.6,
    latencyP50Ms: 250,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    multimodal: true,
    domains: { general: 0.65, code: 0.6, creative: 0.7 },
  },
  {
    id: "gpt-4o",
    displayName: "GPT-4o",
    provider: "openai",
    capability: 0.88,
    costPerMTokInput: 5.0,
    costPerMTokOutput: 15.0,
    latencyP50Ms: 500,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    multimodal: true,
    domains: { general: 0.88, code: 0.85, creative: 0.9, analysis: 0.85 },
  },
];

export const DEFAULT_MODEL_ID = "claude-sonnet-4-5";

export function getModel(id: string): ModelConfig | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

// Map user-facing selector values to API model IDs
export const SELECTOR_TO_MODEL_ID: Record<string, string> = {
  auto: "", // empty = routing engine decides
  "claude-haiku": "claude-haiku-4-5",
  "claude-sonnet": "claude-sonnet-4-5",
  "claude-opus": "claude-opus-4-5",
  "gpt-4o-mini": "gpt-4o-mini",
  "gpt-4o": "gpt-4o",
};

// Per-model health state (error rate in last 60s)
// In production this would be a shared KV. For Phase 1 it's in-process.
const errorCounts: Record<string, { errors: number; total: number; windowStart: number }> = {};

export function recordModelResult(modelId: string, isError: boolean): void {
  const now = Date.now();
  const entry = errorCounts[modelId] ?? { errors: 0, total: 0, windowStart: now };
  // Reset window every 60 seconds
  if (now - entry.windowStart > 60_000) {
    errorCounts[modelId] = { errors: 0, total: 0, windowStart: now };
    return;
  }
  entry.total++;
  if (isError) entry.errors++;
  errorCounts[modelId] = entry;
}

export function isModelHealthy(modelId: string): boolean {
  const entry = errorCounts[modelId];
  if (!entry || entry.total < 5) return true; // not enough data
  return entry.errors / entry.total <= 0.05; // unhealthy if >5% errors
}
