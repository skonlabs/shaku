import { describe, expect, it } from "vitest";
import { TokenCounter } from "../token-counter";

const counter = new TokenCounter();

describe("TokenCounter.count", () => {
  it("returns 0 for empty string", () => {
    expect(counter.count("")).toBe(0);
  });

  it("returns at least 1 for a single word", () => {
    expect(counter.count("hello")).toBeGreaterThanOrEqual(1);
  });

  it("longer text has more tokens", () => {
    expect(counter.count("The quick brown fox")).toBeGreaterThan(counter.count("hi"));
  });

  it("is deterministic", () => {
    const t = "Some deterministic test sentence.";
    expect(counter.count(t)).toBe(counter.count(t));
  });

  it("returns an integer", () => {
    expect(Number.isInteger(counter.count("hello world"))).toBe(true);
  });
});

describe("TokenCounter.countMessages", () => {
  it("returns base overhead for empty array", () => {
    expect(counter.countMessages([])).toBe(3);
  });

  it("single message exceeds base overhead", () => {
    const msgs = [{ role: "user", content: "hello" }];
    expect(counter.countMessages(msgs)).toBeGreaterThan(3);
  });

  it("more messages → more tokens", () => {
    const one = counter.countMessages([{ role: "user", content: "hello" }]);
    const two = counter.countMessages([
      { role: "user",      content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    expect(two).toBeGreaterThan(one);
  });

  it("anthropic overhead ≥ openai overhead", () => {
    const msgs = [{ role: "user", content: "Test" }];
    expect(counter.countMessages(msgs, "anthropic")).toBeGreaterThanOrEqual(
      counter.countMessages(msgs, "openai"),
    );
  });

  it("handles empty content", () => {
    expect(counter.countMessages([{ role: "user", content: "" }])).toBeGreaterThanOrEqual(3);
  });
});

describe("TokenCounter.estimateCharBudget", () => {
  it("returns 0 for budget 0", () => {
    expect(counter.estimateCharBudget(0)).toBe(0);
  });

  it("scales with budget", () => {
    expect(counter.estimateCharBudget(1_000)).toBeGreaterThan(counter.estimateCharBudget(100));
  });

  it("returns an integer", () => {
    expect(Number.isInteger(counter.estimateCharBudget(500))).toBe(true);
  });
});
