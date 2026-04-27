import { describe, it, expect } from "vitest";
import { route, estimatePreRetrievalTokens } from "../router";
import type { RoutingContext } from "../router";
import type { IntentResult } from "../types";

function makeIntent(overrides: Partial<IntentResult> = {}): IntentResult {
  return {
    intent: "question",
    confidence: 0.9,
    isFollowUp: false,
    followUpReference: null,
    complexity: 0.5,
    domain: "general",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    intent: makeIntent(),
    estimatedContextTokens: 1000,
    hasImages: false,
    modelOverride: null,
    conversationMomentum: 0.3,
    lastComplexTurnAt: null,
    reasoningDepth: 0.5,
    precisionRequired: 0.5,
    contextType: "chat",
    contextCriticality: 0.3,
    taskType: "generation",
    ...overrides,
  };
}

describe("route", () => {
  it("returns a selected model and reason", () => {
    const decision = route(makeCtx());
    expect(decision.selected).toBeDefined();
    expect(decision.selected.id).toBeTruthy();
    expect(["auto", "user_override", "hard_filter", "exhaustion"]).toContain(decision.reason);
  });

  it("respects model override when valid", () => {
    const decision = route(makeCtx({ modelOverride: "claude-haiku-4-5-20251001" }));
    expect(decision.selected.id).toBe("claude-haiku-4-5-20251001");
    expect(decision.reason).toBe("user_override");
  });

  it("ignores invalid override and auto-routes", () => {
    const decision = route(makeCtx({ modelOverride: "nonexistent-model-xyz" }));
    expect(decision.reason).not.toBe("user_override");
  });

  it("returns a fallback chain with at most 4 models", () => {
    const decision = route(makeCtx({ intent: makeIntent({ complexity: 0.9 }), estimatedContextTokens: 5000 }));
    expect(decision.fallback.length).toBeLessThanOrEqual(4);
  });

  it("filters out models that do not support images when hasImages=true", () => {
    const decision = route(makeCtx({ hasImages: true, conversationMomentum: 0 }));
    expect(decision.selected.multimodal).toBe(true);
  });

  it("selects higher-capability model for high-complexity reasoning", () => {
    const highComplexity = route(
      makeCtx({
        intent: makeIntent({ complexity: 0.95, domain: "reasoning" }),
        reasoningDepth: 0.95,
        precisionRequired: 0.9,
        taskType: "reasoning",
        conversationMomentum: 0.9,
      }),
    );
    const lowComplexity = route(
      makeCtx({
        intent: makeIntent({ complexity: 0.1, domain: "general" }),
        reasoningDepth: 0.1,
        precisionRequired: 0.2,
        taskType: "generation",
        conversationMomentum: 0,
      }),
    );
    expect(highComplexity.selected.capability).toBeGreaterThanOrEqual(
      lowComplexity.selected.capability,
    );
  });

  it("returns exhaustion fallback when context is too large for all models", () => {
    const decision = route(
      makeCtx({ estimatedContextTokens: 999_999_999, conversationMomentum: 0 }),
    );
    expect(decision.reason).toBe("exhaustion");
  });

  it("applies overkill penalty: does not always pick the most capable model for simple tasks", () => {
    const simple = route(
      makeCtx({
        intent: makeIntent({ complexity: 0.1, domain: "general" }),
        reasoningDepth: 0.1,
        precisionRequired: 0.2,
        taskType: "generation",
        conversationMomentum: 0,
      }),
    );
    // Most capable model (Opus, capability 0.97) should be overkill for a 0.1 reasoning-depth task
    expect(simple.selected.capability).toBeLessThan(0.97);
  });

  it("momentum decays to zero when lastComplexTurnAt is far in the past", () => {
    const decayed = route(
      makeCtx({
        conversationMomentum: 1.0,
        lastComplexTurnAt: Date.now() - 60 * 60 * 1000, // 1 hour ago
        reasoningDepth: 0.1,
        precisionRequired: 0.2,
        taskType: "generation",
      }),
    );
    // With decayed momentum, should not select an expensive high-cap model
    expect(decayed.selected.capability).toBeLessThan(0.97);
  });
});

describe("estimatePreRetrievalTokens", () => {
  it("sums all components with defaults", () => {
    const total = estimatePreRetrievalTokens(400, 1000, 100);
    // 400 + 200 (ukm) + 100 + 6000 (retrieval) + 500 (memory) + 1000 + 300 (overhead) = 8500
    expect(total).toBe(8500);
  });

  it("uses provided optional params", () => {
    const total = estimatePreRetrievalTokens(100, 200, 50, 1000, 200, 100);
    // 100 + 100 (ukm) + 50 + 1000 + 200 + 200 + 300 = 1950
    expect(total).toBe(1950);
  });

  it("grows with larger inputs", () => {
    const small = estimatePreRetrievalTokens(100, 100, 100);
    const large = estimatePreRetrievalTokens(500, 5000, 500);
    expect(large).toBeGreaterThan(small);
  });
});
