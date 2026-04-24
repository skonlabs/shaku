// Multi-model routing engine.
//
// Priority:
//   1. If conversation.model_override is set → skip all routing, use it directly.
//   2. Hard filters: eliminate models with insufficient context window, bad health,
//      or wrong modality.
//   3. Score remaining models on quality, cost, latency, domain match.
//   4. Return primary + 2-model fallback chain (cross-provider).

import {
  MODEL_REGISTRY,
  isModelHealthy,
  DEFAULT_MODEL_ID,
  getModel,
} from "./registry";
import type { ModelConfig, IntentResult, RoutingDecision } from "./types";
import { countTokens, fitsInContext } from "@/lib/tokens";

export interface RoutingContext {
  intent: IntentResult;
  estimatedContextTokens: number;
  hasImages: boolean;
  modelOverride: string | null; // from conversations.model_override
  conversationMomentum: number; // avg complexity of last 3 messages
}

export function route(ctx: RoutingContext): RoutingDecision {
  // 1. User override: use specified model, build fallback from same + other provider
  if (ctx.modelOverride) {
    const selected = getModel(ctx.modelOverride);
    if (selected) {
      const fallback = MODEL_REGISTRY.filter(
        (m) => m.id !== selected.id && m.capability >= selected.capability * 0.8,
      )
        .sort((a, b) => {
          // Prefer cross-provider for first fallback
          const aXP = a.provider !== selected.provider ? 1 : 0;
          const bXP = b.provider !== selected.provider ? 1 : 0;
          return bXP - aXP || b.capability - a.capability;
        })
        .slice(0, 2);

      return { selected, fallback, reason: "user_override", score: 1 };
    }
  }

  // 2. Complexity adjustment for follow-ups and conversation momentum
  let adjustedComplexity = ctx.intent.complexity;
  const momentum = ctx.conversationMomentum * 0.7;
  adjustedComplexity = Math.max(adjustedComplexity, momentum);
  if (ctx.intent.isFollowUp) {
    adjustedComplexity = Math.min(1.0, adjustedComplexity + 0.2);
  }

  // 3. Hard filters
  const eligible = MODEL_REGISTRY.filter((m) => {
    if (!isModelHealthy(m.id)) return false;
    if (!fitsInContext(m.id, ctx.estimatedContextTokens)) return false;
    if (ctx.hasImages && !m.multimodal) return false;
    return true;
  });

  if (eligible.length === 0) {
    // Nothing passed filters — fall back to default
    const fallback = getModel(DEFAULT_MODEL_ID)!;
    return { selected: fallback, fallback: [], reason: "exhaustion", score: 0 };
  }

  // 4. Score each eligible model
  const costRange = modelRange(eligible, (m) => m.costPerMTokInput);
  const latencyRange = modelRange(eligible, (m) => m.latencyP50Ms);

  const scored = eligible.map((m) => ({
    model: m,
    score: computeScore(m, adjustedComplexity, ctx.intent.domain, costRange, latencyRange),
  }));

  scored.sort((a, b) => b.score - a.score);

  const selected = scored[0].model;
  // Fallback: next 2 by score, prefer cross-provider for first fallback
  const remainders = scored.slice(1).map((s) => s.model);
  remainders.sort((a, b) => {
    const aXP = a.provider !== selected.provider ? 1 : 0;
    const bXP = b.provider !== selected.provider ? 1 : 0;
    return bXP - aXP;
  });
  const fallback = remainders.slice(0, 2);

  return { selected, fallback, reason: "auto", score: scored[0].score };
}

function computeScore(
  m: ModelConfig,
  complexity: number,
  domain: string,
  costRange: { min: number; max: number },
  latencyRange: { min: number; max: number },
): number {
  const qualityMatch =
    m.capability >= complexity
      ? 0.4 * (m.capability - complexity * 0.1)
      : 0.4 * m.capability * 0.3; // heavy penalty for under-powered model

  const costScore = 0.3 * (1 - normalize(m.costPerMTokInput, costRange.min, costRange.max));
  const latencyScore = 0.2 * (1 - normalize(m.latencyP50Ms, latencyRange.min, latencyRange.max));
  const domainScore = 0.1 * (m.domains[domain] ?? m.domains["general"] ?? m.capability);

  return qualityMatch + costScore + latencyScore + domainScore;
}

function normalize(val: number, min: number, max: number): number {
  if (max === min) return 0;
  return Math.min(1, Math.max(0, (val - min) / (max - min)));
}

function modelRange(
  models: ModelConfig[],
  fn: (m: ModelConfig) => number,
): { min: number; max: number } {
  const vals = models.map(fn);
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

// Estimate context tokens before retrieval (used for routing hard filter)
export function estimatePreRetrievalTokens(
  systemPromptTokens: number,
  historyTokens: number,
  messageTokens: number,
  expectedRetrievalTokens = 6_000,
  memoryTokens = 500,
  ukmTokens = 200,
): number {
  return (
    systemPromptTokens +
    ukmTokens +
    messageTokens +
    expectedRetrievalTokens +
    memoryTokens +
    historyTokens +
    300 // overhead
  );
}

// Build provider adapter for a model
export function getProvider(modelId: string) {
  if (modelId.startsWith("claude-")) {
    const { AnthropicProvider } = require("./anthropic");
    return new AnthropicProvider();
  }
  if (modelId.startsWith("gpt-")) {
    const { OpenAIProvider } = require("./openai");
    return new OpenAIProvider();
  }
  throw new Error(`Unknown model provider for: ${modelId}`);
}
