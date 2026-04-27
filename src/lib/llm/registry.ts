import type { ModelConfig } from "./types";

// Model registry. IDs are the actual versioned API strings.
// Display names appear ONLY in the model selector — never in chat UI.
//
// latencyP95Ms: ~2-3× P50; used for tail-latency routing signal.
// tokensPerSecond: post-first-token streaming throughput.
// hallucinationRisk: 0=low, 1=high; penalizes precision/analysis tasks.
// reliabilityScore: 0=low, 1=high; typical API success rate.
// contextStrengths: content types the model handles especially well.
export const MODEL_REGISTRY: ModelConfig[] = [
  {
    id: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku",
    provider: "anthropic",
    capability: 0.6,
    costPerMTokInput: 0.25,
    costPerMTokOutput: 1.25,
    latencyP50Ms: 300,
    latencyP95Ms: 700,
    tokensPerSecond: 150,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    multimodal: true,
    hallucinationRisk: 0.35,
    reliabilityScore: 0.95,
    domains: { general: 0.6, code: 0.5, creative: 0.55 },
    contextStrengths: ["chat"],
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet",
    provider: "anthropic",
    capability: 0.87,
    costPerMTokInput: 3.0,
    costPerMTokOutput: 15.0,
    latencyP50Ms: 600,
    latencyP95Ms: 1_400,
    tokensPerSecond: 80,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    multimodal: true,
    hallucinationRisk: 0.15,
    reliabilityScore: 0.97,
    domains: { general: 0.87, code: 0.82, analysis: 0.92, reasoning: 0.87 },
    contextStrengths: ["code", "structured", "chat"],
  },
  {
    id: "claude-opus-4-7",
    displayName: "Claude Opus",
    provider: "anthropic",
    capability: 0.97,
    costPerMTokInput: 15.0,
    costPerMTokOutput: 75.0,
    latencyP50Ms: 1_200,
    latencyP95Ms: 2_800,
    tokensPerSecond: 40,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    multimodal: true,
    hallucinationRisk: 0.08,
    reliabilityScore: 0.95,
    domains: { general: 0.97, analysis: 0.97, reasoning: 0.99, code: 0.93 },
    contextStrengths: ["document", "code", "structured"],
  },
  {
    id: "gpt-4o-mini",
    displayName: "GPT-4o mini",
    provider: "openai",
    capability: 0.65,
    costPerMTokInput: 0.15,
    costPerMTokOutput: 0.6,
    latencyP50Ms: 250,
    latencyP95Ms: 600,
    tokensPerSecond: 200,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    multimodal: true,
    hallucinationRisk: 0.30,
    reliabilityScore: 0.96,
    domains: { general: 0.65, code: 0.6, creative: 0.7 },
    contextStrengths: ["chat", "structured"],
  },
  {
    id: "gpt-4o",
    displayName: "GPT-4o",
    provider: "openai",
    capability: 0.88,
    costPerMTokInput: 5.0,
    costPerMTokOutput: 15.0,
    latencyP50Ms: 500,
    latencyP95Ms: 1_200,
    tokensPerSecond: 100,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    multimodal: true,
    hallucinationRisk: 0.15,
    reliabilityScore: 0.97,
    domains: { general: 0.88, code: 0.85, creative: 0.9, analysis: 0.85 },
    contextStrengths: ["code", "structured", "chat", "mixed"],
  },
  {
    id: "gemini-2.0-flash",
    displayName: "Gemini 2.0 Flash",
    provider: "google",
    capability: 0.78,
    costPerMTokInput: 0.1,
    costPerMTokOutput: 0.4,
    latencyP50Ms: 300,
    latencyP95Ms: 700,
    tokensPerSecond: 180,
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    multimodal: true,
    hallucinationRisk: 0.25,
    reliabilityScore: 0.93,
    domains: { general: 0.78, code: 0.72, creative: 0.75, analysis: 0.76 },
    contextStrengths: ["chat", "structured", "mixed"],
  },
  {
    id: "gemini-1.5-pro",
    displayName: "Gemini 1.5 Pro",
    provider: "google",
    capability: 0.85,
    costPerMTokInput: 1.25,
    costPerMTokOutput: 5.0,
    latencyP50Ms: 600,
    latencyP95Ms: 1_400,
    tokensPerSecond: 90,
    contextWindow: 2_097_152,
    maxOutputTokens: 8_192,
    multimodal: true,
    hallucinationRisk: 0.15,
    reliabilityScore: 0.94,
    domains: { general: 0.85, code: 0.8, analysis: 0.88, reasoning: 0.85 },
    contextStrengths: ["document", "structured", "code", "mixed"],
  },
  {
    id: "gemini-1.5-flash",
    displayName: "Gemini 1.5 Flash",
    provider: "google",
    capability: 0.70,
    costPerMTokInput: 0.075,
    costPerMTokOutput: 0.3,
    latencyP50Ms: 250,
    latencyP95Ms: 600,
    tokensPerSecond: 220,
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    multimodal: true,
    hallucinationRisk: 0.30,
    reliabilityScore: 0.95,
    domains: { general: 0.70, code: 0.65, creative: 0.68 },
    contextStrengths: ["chat", "mixed"],
  },
];

export const HAIKU_MODEL_ID = "claude-haiku-4-5-20251001";
export const SONNET_MODEL_ID = "claude-sonnet-4-6";

export const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

export function getModel(id: string): ModelConfig | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

// Map user-facing selector values to API model IDs
export const SELECTOR_TO_MODEL_ID: Record<string, string> = {
  auto: "", // empty = routing engine decides
  "claude-haiku": "claude-haiku-4-5-20251001",
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-opus": "claude-opus-4-7",
  "gpt-4o-mini": "gpt-4o-mini",
  "gpt-4o": "gpt-4o",
  "gemini-flash": "gemini-2.0-flash",
  "gemini-pro": "gemini-1.5-pro",
  "gemini-flash-lite": "gemini-1.5-flash",
};

// Per-model health state (error rate in last 60s)
// In production this would be a shared KV. For Phase 1 it's in-process.
const errorCounts: Record<string, { errors: number; total: number; windowStart: number }> = {};

export function recordModelResult(modelId: string, isError: boolean): void {
  const now = Date.now();
  const entry = errorCounts[modelId] ?? { errors: 0, total: 0, windowStart: now };
  // Reset window every 60 seconds; count the current event in the new window.
  // The current event is counted inside the reset branch (total: 1) so the
  // first event after a window reset is never skipped.
  if (now - entry.windowStart > 60_000) {
    errorCounts[modelId] = {
      errors: isError ? 1 : 0,
      total: 1,
      windowStart: now,
    };
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
