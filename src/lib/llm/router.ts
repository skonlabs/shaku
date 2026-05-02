// Multi-model routing engine.
//
// Priority:
//   1. If conversation.model_override is set → skip scoring, use it directly.
//      Exception: multimodal hard filter still applies even on override.
//   2. Hard filters: eliminate models with bad health, insufficient context window,
//      or wrong modality.
//   3. Multi-dimensional scoring across 6 axes (see computeScore).
//   4. Return primary + 4-model tiered fallback chain (cross-provider biased).
//
// Scoring formula:
//   score = 0.40 * capabilityFit   ← optimal-band match; penalises both under- and over-powered
//         + 0.20 * domainMatch     ← domain + context-type affinity
//         + 0.15 * contextFit      ← headroom + fidelity (hallucination risk × criticality)
//         + 0.10 * costEfficiency  ← relative cheapness
//         + 0.10 * latencyScore    ← P50 (50%) + P95 (30%) + TPS (20%)
//         + 0.05 * reliability     ← success rate minus hallucination penalty on precision tasks

import {
  MODEL_REGISTRY,
  isModelHealthy,
  DEFAULT_MODEL_ID,
  getModel,
} from "./registry";
import type { ModelConfig, IntentResult, RoutingDecision, ContextType, RoutingTaskType } from "./types";
import { countTokens, fitsInContext } from "@/lib/tokens";

export interface RoutingContext {
  intent: IntentResult;
  estimatedContextTokens: number;
  hasImages: boolean;
  modelOverride: string | null;
  // Conversation momentum: avg complexity of last 3 messages (0–1)
  conversationMomentum: number;
  // Unix ms of the most recent high-complexity user turn; drives time-decay of momentum
  lastComplexTurnAt: number | null;
  // Multi-dimensional routing signals (derived by caller from intent + content + context)
  reasoningDepth: number;     // 0–1: depth of inference required
  precisionRequired: number;  // 0–1: tolerance for hallucination/error
  contextType: ContextType;   // dominant shape of request content
  contextCriticality: number; // 0–1: how important it is that model faithfully uses context
  taskType: RoutingTaskType;  // routing-level task classification
  // Optional: providers with runtime API keys available. When set, models from
  // other providers are filtered out before scoring so we never route to a
  // model whose API key is missing (which would cause "no runnable models").
  availableProviders?: Set<string>;
}

interface Range { min: number; max: number }

export function route(ctx: RoutingContext): RoutingDecision {
  // 1. User override: use specified model; still enforce the multimodal hard filter.
  if (ctx.modelOverride) {
    const selected = getModel(ctx.modelOverride);
    const overrideOk = selected && (!ctx.hasImages || selected.multimodal);
    if (selected && overrideOk) {
      const candidates = MODEL_REGISTRY.filter(
        (m) => m.id !== selected.id && (!ctx.hasImages || m.multimodal),
      );
      return {
        selected,
        fallback: buildFallbackChain(selected, candidates),
        reason: "user_override",
        score: 1,
      };
    }
    // Override invalid (wrong modality or unknown id) → fall through to auto-routing.
  }

  // 2. Momentum with time-based decay.
  // Flat 70% blend causes "stickiness" that traps conversations on expensive models.
  // Decay over a 5-minute half-life so a burst of complexity doesn't lock routing forever.
  const decayFactor = ctx.lastComplexTurnAt
    ? Math.exp(-(Date.now() - ctx.lastComplexTurnAt) / 300_000)
    : 0;
  const effectiveMomentum = ctx.conversationMomentum * 0.7 * decayFactor;

  // Blend reasoning depth with decayed momentum; follow-ups need deeper reasoning.
  let adjustedReasoningDepth = Math.max(ctx.reasoningDepth, effectiveMomentum);
  if (ctx.intent.isFollowUp) {
    adjustedReasoningDepth = Math.min(1.0, adjustedReasoningDepth + 0.15);
  }

  // 3. Hard filters: health, context window, modality, provider availability.
  const eligible = MODEL_REGISTRY.filter((m) => {
    if (!isModelHealthy(m.id)) return false;
    if (!fitsInContext(m.id, ctx.estimatedContextTokens)) return false;
    if (ctx.hasImages && !m.multimodal) return false;
    if (ctx.availableProviders && !ctx.availableProviders.has(m.provider)) return false;
    return true;
  });

  if (eligible.length === 0) {
    const fallback = getModel(DEFAULT_MODEL_ID)!;
    return { selected: fallback, fallback: [], reason: "exhaustion", score: 0 };
  }

  // 4. Pre-compute ranges for normalization (relative to eligible set only).
  const costRange = modelRange(eligible, (m) => m.costPerMTokInput);
  const p50Range  = modelRange(eligible, (m) => m.latencyP50Ms);
  const p95Range  = modelRange(eligible, (m) => m.latencyP95Ms);
  const tpsRange  = modelRange(eligible, (m) => m.tokensPerSecond);

  // 5. Score and rank.
  const scored = eligible
    .map((m) => ({
      model: m,
      score: computeScore(m, ctx, adjustedReasoningDepth, costRange, p50Range, p95Range, tpsRange),
    }))
    .sort((a, b) => b.score - a.score);

  const selected = scored[0].model;
  const candidates = scored.slice(1).map((s) => s.model);

  return {
    selected,
    fallback: buildFallbackChain(selected, candidates),
    reason: "auto",
    score: scored[0].score,
  };
}

// ---------------------------------------------------------------------------
// Scoring components
// ---------------------------------------------------------------------------

function computeScore(
  m: ModelConfig,
  ctx: RoutingContext,
  adjustedReasoningDepth: number,
  costRange: Range,
  p50Range: Range,
  p95Range: Range,
  tpsRange: Range,
): number {
  return (
    0.40 * computeCapabilityFit(m.capability, adjustedReasoningDepth) +
    0.20 * computeDomainMatch(m, ctx.intent.domain, ctx.contextType, ctx.taskType) +
    0.15 * computeContextFit(m, ctx.estimatedContextTokens, ctx.contextCriticality) +
    0.10 * computeCostEfficiency(m, costRange) +
    0.10 * computeLatencyScore(m, p50Range, p95Range, tpsRange) +
    0.05 * computeReliabilityScore(m, ctx.taskType, ctx.precisionRequired)
  );
}

// Optimal band: [requirement, requirement + BAND_WIDTH].
// Under-powered models get a 70% penalty (×0.3).
// Over-powered models beyond the band get a proportional penalty that floors at 0.4,
// preventing expensive models from dominating when cheaper ones are adequate.
function computeCapabilityFit(capability: number, requirement: number): number {
  const BAND_WIDTH = 0.15;
  if (capability < requirement) {
    return capability * 0.3; // under-powered: heavy penalty
  }
  const excess = capability - requirement;
  if (excess <= BAND_WIDTH) {
    return 1.0; // in optimal band
  }
  // Overkill: diminishing returns beyond the band, floor at 0.4
  return Math.max(0.4, 1.0 - (excess - BAND_WIDTH) * 0.8);
}

// Domain affinity (0.20 weight) + context type strength (+0.10 bonus) + task bonus (+0.05).
// Weight increased from 10% to 20% to properly reward specialised models.
function computeDomainMatch(
  m: ModelConfig,
  domain: string,
  contextType: ContextType,
  taskType: RoutingTaskType,
): number {
  const domainScore = m.domains[domain] ?? m.domains["general"] ?? 0.5;
  const contextBonus = m.contextStrengths.includes(contextType) ? 0.10 : 0;

  let taskBonus = 0;
  if (taskType === "execution" && (m.domains["code"] ?? 0) > 0.80) taskBonus = 0.05;
  if (taskType === "reasoning" && (m.domains["reasoning"] ?? 0) > 0.85) taskBonus = 0.05;
  if (taskType === "retrieval" && m.contextStrengths.includes("document")) taskBonus = 0.05;

  return Math.min(1.0, domainScore + contextBonus + taskBonus);
}

// Context fit: headroom score + hallucination-risk × criticality.
// Models that would be nearly full on context score lower; high-hallucination models
// are penalised when context fidelity matters (e.g. memory-heavy or retrieval-grounded turns).
function computeContextFit(
  m: ModelConfig,
  estimatedTokens: number,
  contextCriticality: number,
): number {
  const fillRatio = estimatedTokens / m.contextWindow;
  // Three-tier headroom: plenty (1.0), moderate (0.7), tight (0.3)
  const headroomScore = fillRatio > 0.8 ? 0.3 : fillRatio > 0.5 ? 0.7 : 1.0;

  // Fidelity: scale hallucination risk by how critical context accuracy is
  const fidelityScore = 1.0 - m.hallucinationRisk * contextCriticality;

  return 0.5 * headroomScore + 0.5 * fidelityScore;
}

function computeCostEfficiency(m: ModelConfig, costRange: Range): number {
  return 1 - normalize(m.costPerMTokInput, costRange.min, costRange.max);
}

// Three-part latency score: P50 first-token (50%), P95 tail (30%), streaming TPS (20%).
function computeLatencyScore(
  m: ModelConfig,
  p50Range: Range,
  p95Range: Range,
  tpsRange: Range,
): number {
  const p50Score = 1 - normalize(m.latencyP50Ms, p50Range.min, p50Range.max);
  const p95Score = 1 - normalize(m.latencyP95Ms, p95Range.min, p95Range.max);
  const tpsScore = normalize(m.tokensPerSecond, tpsRange.min, tpsRange.max);
  return 0.5 * p50Score + 0.3 * p95Score + 0.2 * tpsScore;
}

// Base reliability score; penalised when the task needs high precision and the
// model carries notable hallucination risk.
function computeReliabilityScore(
  m: ModelConfig,
  taskType: RoutingTaskType,
  precisionRequired: number,
): number {
  let score = m.reliabilityScore;
  if (precisionRequired > 0.6 || taskType === "reasoning") {
    score -= m.hallucinationRisk * precisionRequired * 0.5;
  }
  return Math.max(0, score);
}

// ---------------------------------------------------------------------------
// Fallback chain
// ---------------------------------------------------------------------------

// Builds a 4-tier fallback chain so the system degrades gracefully under failure:
//   Tier 1 — same-provider backup: avoids cross-provider latency on first retry
//   Tier 2 — cross-provider equivalent: different provider, similar capability
//   Tier 3 — cheaper degraded: significantly cheaper, still capable
//   Tier 4 — fastest available: minimal latency safe fallback
// Duplicates are removed; up to 4 total.
function buildFallbackChain(selected: ModelConfig, candidates: ModelConfig[]): ModelConfig[] {
  const tier1 = candidates.find((m) => m.provider === selected.provider) ?? null;

  const tier2 =
    candidates.find(
      (m) => m.provider !== selected.provider && m.capability >= selected.capability * 0.8,
    ) ?? null;

  const tier3 =
    candidates.find(
      (m) =>
        m.costPerMTokInput < selected.costPerMTokInput * 0.4 &&
        m.capability >= 0.6,
    ) ?? null;

  // Fastest by P50 among remaining candidates
  const tier4 = [...candidates].sort((a, b) => a.latencyP50Ms - b.latencyP50Ms)[0] ?? null;

  const seen = new Set([selected.id]);
  const chain: ModelConfig[] = [];
  for (const m of [tier1, tier2, tier3, tier4]) {
    if (m && !seen.has(m.id)) {
      seen.add(m.id);
      chain.push(m);
    }
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function normalize(val: number, min: number, max: number): number {
  if (max === min) return 0;
  return Math.min(1, Math.max(0, (val - min) / (max - min)));
}

function modelRange(models: ModelConfig[], fn: (m: ModelConfig) => number): Range {
  const vals = models.map(fn);
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

// Estimate context tokens before retrieval (used for routing hard filter).
// Expected retrieval and memory budgets are conservative upper bounds.
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

// Build provider adapter for a model (async for CF Workers ESM compatibility).
export async function getProvider(modelId: string) {
  if (modelId.startsWith("claude-")) {
    const { AnthropicProvider } = await import("./anthropic");
    return new AnthropicProvider();
  }
  if (modelId.startsWith("gpt-")) {
    const { OpenAIProvider } = await import("./openai");
    return new OpenAIProvider();
  }
  if (modelId.startsWith("gemini-")) {
    const { GeminiProvider } = await import("./gemini");
    const apiKey = process.env.GEMINI_API_KEY ?? "";
    return new GeminiProvider(apiKey);
  }
  throw new Error(`Unknown model provider for: ${modelId}`);
}
