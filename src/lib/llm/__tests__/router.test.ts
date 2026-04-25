import { describe, it, expect } from "vitest";
import { route, estimatePreRetrievalTokens } from "../router";
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

describe("route", () => {
  it("returns a selected model and reason", () => {
    const decision = route({
      intent: makeIntent(),
      estimatedContextTokens: 1000,
      hasImages: false,
      modelOverride: null,
      conversationMomentum: 0.3,
    });
    expect(decision.selected).toBeDefined();
    expect(decision.selected.id).toBeTruthy();
    expect(["auto", "user_override", "hard_filter", "exhaustion"]).toContain(decision.reason);
  });

  it("respects model override when valid", () => {
    const decision = route({
      intent: makeIntent(),
      estimatedContextTokens: 1000,
      hasImages: false,
      modelOverride: "claude-haiku-4-5-20251001",
      conversationMomentum: 0.3,
    });
    expect(decision.selected.id).toBe("claude-haiku-4-5-20251001");
    expect(decision.reason).toBe("user_override");
  });

  it("ignores invalid override and auto-routes", () => {
    const decision = route({
      intent: makeIntent(),
      estimatedContextTokens: 1000,
      hasImages: false,
      modelOverride: "nonexistent-model-xyz",
      conversationMomentum: 0.3,
    });
    expect(decision.reason).not.toBe("user_override");
  });

  it("always returns a fallback chain with at most 2 models", () => {
    const decision = route({
      intent: makeIntent({ complexity: 0.9 }),
      estimatedContextTokens: 5000,
      hasImages: false,
      modelOverride: null,
      conversationMomentum: 0.5,
    });
    expect(decision.fallback.length).toBeLessThanOrEqual(2);
  });

  it("filters out models that do not support images when hasImages=true", () => {
    const decision = route({
      intent: makeIntent(),
      estimatedContextTokens: 1000,
      hasImages: true,
      modelOverride: null,
      conversationMomentum: 0,
    });
    // All returned models must be multimodal
    expect(decision.selected.multimodal).toBe(true);
  });

  it("selects higher-capability model for high-complexity reasoning", () => {
    const highComplexity = route({
      intent: makeIntent({ complexity: 0.95, domain: "reasoning" }),
      estimatedContextTokens: 1000,
      hasImages: false,
      modelOverride: null,
      conversationMomentum: 0.9,
    });
    const lowComplexity = route({
      intent: makeIntent({ complexity: 0.1, domain: "general" }),
      estimatedContextTokens: 1000,
      hasImages: false,
      modelOverride: null,
      conversationMomentum: 0,
    });
    expect(highComplexity.selected.capability).toBeGreaterThanOrEqual(
      lowComplexity.selected.capability,
    );
  });

  it("returns exhaustion fallback when context is too large for all models", () => {
    const decision = route({
      intent: makeIntent(),
      estimatedContextTokens: 999_999_999, // exceeds all context windows
      hasImages: false,
      modelOverride: null,
      conversationMomentum: 0,
    });
    expect(decision.reason).toBe("exhaustion");
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
