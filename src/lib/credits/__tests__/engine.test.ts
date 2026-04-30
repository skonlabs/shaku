/**
 * Tests for the pricing engine.
 *
 * The spec example "GPT-4o, 2k in + 800 out, no memory":
 *   tokenCost  = 2.8
 *   ctxMult    = 1.0 (under 10k)
 *   raw        = 4 * 2.8 * 1.0 = 11.2
 *   credits    = 12  (ceil)
 *
 * Free Haiku, 500 in + 200 out, no memory:
 *   raw = 1.2 * 0.7 * 1.0 = 0.84  → floor to 1
 *
 * Sonnet with memory + docs, 30k in + 1.5k out:
 *   raw = 5 * 31.5 * 1.5 = 236.25  → capped at 100
 */
import { describe, it, expect } from "vitest";
import {
  calculateCredits,
  contextMultiplier,
  planAllowsModel,
  planAllowsFeature,
  pickFallbackModel,
  MAX_CREDITS_PER_REQUEST,
} from "../engine";

describe("contextMultiplier", () => {
  it("buckets correctly", () => {
    expect(contextMultiplier(0)).toBe(1);
    expect(contextMultiplier(9_999)).toBe(1);
    expect(contextMultiplier(10_000)).toBe(1.5);
    expect(contextMultiplier(49_999)).toBe(1.5);
    expect(contextMultiplier(50_000)).toBe(2.5);
  });
});

describe("calculateCredits", () => {
  it("prices a typical GPT-4o request near the spec example", () => {
    const r = calculateCredits({ modelId: "gpt-4o", inputTokens: 2000, outputTokens: 800 });
    expect(r.total).toBe(12);
    expect(r.contextMult).toBe(1);
    expect(r.model.multiplier).toBe(4);
  });

  it("applies the 1-credit floor for tiny Haiku calls", () => {
    const r = calculateCredits({ modelId: "claude-haiku-4-5-20251001", inputTokens: 500, outputTokens: 200 });
    expect(r.total).toBe(1);
  });

  it("caps at MAX_CREDITS_PER_REQUEST for huge requests", () => {
    const r = calculateCredits({
      modelId: "claude-sonnet-4-6",
      inputTokens: 30_000,
      outputTokens: 1_500,
      memoryRead: true,
      documentRead: true,
    });
    expect(r.total).toBe(MAX_CREDITS_PER_REQUEST);
    expect(r.capped).toBe(true);
  });

  it("falls back to multiplier=4 for unknown models", () => {
    const r = calculateCredits({ modelId: "unknown-model-x", inputTokens: 1000, outputTokens: 1000 });
    expect(r.model.multiplier).toBe(4);
    // 4 * 2.0 * 1.0 = 8 → 8
    expect(r.total).toBe(8);
  });

  it("adds memory/document/embedding flat costs", () => {
    const r = calculateCredits({
      modelId: "gpt-4o-mini",
      inputTokens: 100,
      outputTokens: 100,
      memoryRead: true,
      memoryWrite: true,
      documentRead: true,
      embeddingsRun: true,
    });
    // 1 * 0.2 * 1 = 0.2 ; +2+3+2+4 = 11.2 → 12
    expect(r.total).toBe(12);
  });
});

describe("plan helpers", () => {
  const free = {
    models: ["gpt-4o-mini", "claude-haiku-4-5-20251001"],
    memory: false,
    documents: false,
    max_context_tokens: 10_000,
    advanced_routing: false,
  };
  const pro = {
    models: ["*"],
    memory: true,
    documents: true,
    max_context_tokens: 200_000,
    advanced_routing: true,
  };

  it("planAllowsModel respects wildcard", () => {
    expect(planAllowsModel(pro, "claude-opus-4-7")).toBe(true);
    expect(planAllowsModel(free, "gpt-4o")).toBe(false);
    expect(planAllowsModel(free, "gpt-4o-mini")).toBe(true);
  });

  it("planAllowsFeature gates memory/docs", () => {
    expect(planAllowsFeature(free, "memory")).toBe(false);
    expect(planAllowsFeature(pro, "documents")).toBe(true);
  });

  it("pickFallbackModel prefers gpt-4o-mini", () => {
    expect(pickFallbackModel(free)).toBe("gpt-4o-mini");
    expect(pickFallbackModel({ ...free, models: ["claude-haiku-4-5-20251001"] })).toBe(
      "claude-haiku-4-5-20251001",
    );
  });
});
