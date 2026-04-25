import { describe, it, expect, beforeEach } from "vitest";
import {
  getModel,
  isModelHealthy,
  recordModelResult,
  MODEL_REGISTRY,
  DEFAULT_MODEL_ID,
  SELECTOR_TO_MODEL_ID,
} from "../registry";

describe("getModel", () => {
  it("returns model config by id", () => {
    const m = getModel("claude-sonnet-4-6");
    expect(m).toBeDefined();
    expect(m!.id).toBe("claude-sonnet-4-6");
    expect(m!.provider).toBe("anthropic");
  });

  it("returns undefined for unknown id", () => {
    expect(getModel("nonexistent-model")).toBeUndefined();
  });
});

describe("MODEL_REGISTRY", () => {
  it("has 5 models", () => {
    expect(MODEL_REGISTRY).toHaveLength(5);
  });

  it("all models have required fields", () => {
    for (const m of MODEL_REGISTRY) {
      expect(m.id).toBeTruthy();
      expect(m.provider).toMatch(/^(anthropic|openai)$/);
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxOutputTokens).toBeGreaterThan(0);
      expect(m.capability).toBeGreaterThan(0);
      expect(m.capability).toBeLessThanOrEqual(1);
    }
  });

  it("Anthropic models have 200K context", () => {
    const anthropic = MODEL_REGISTRY.filter((m) => m.provider === "anthropic");
    for (const m of anthropic) {
      expect(m.contextWindow).toBe(200_000);
    }
  });
});

describe("DEFAULT_MODEL_ID", () => {
  it("exists in registry", () => {
    expect(getModel(DEFAULT_MODEL_ID)).toBeDefined();
  });
});

describe("SELECTOR_TO_MODEL_ID", () => {
  it("maps claude-sonnet to correct model id", () => {
    expect(SELECTOR_TO_MODEL_ID["claude-sonnet"]).toBe("claude-sonnet-4-6");
  });

  it("maps claude-haiku to correct model id", () => {
    expect(SELECTOR_TO_MODEL_ID["claude-haiku"]).toBe("claude-haiku-4-5-20251001");
  });

  it("maps gpt-4o to correct model id", () => {
    expect(SELECTOR_TO_MODEL_ID["gpt-4o"]).toBe("gpt-4o");
  });
});

describe("isModelHealthy / recordModelResult", () => {
  it("returns true with no recorded results", () => {
    expect(isModelHealthy("claude-opus-4-7")).toBe(true);
  });

  it("returns true when error rate is below 5%", () => {
    const id = "gpt-4o-mini";
    // Record 10 successes
    for (let i = 0; i < 10; i++) recordModelResult(id, false);
    expect(isModelHealthy(id)).toBe(true);
  });

  it("returns false when error rate exceeds 5%", () => {
    const id = "gpt-4o";
    // 6 errors, 4 successes = 60% error rate
    for (let i = 0; i < 4; i++) recordModelResult(id, false);
    for (let i = 0; i < 6; i++) recordModelResult(id, true);
    expect(isModelHealthy(id)).toBe(false);
  });
});
