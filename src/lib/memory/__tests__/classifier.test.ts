import { describe, it, expect } from "vitest";
import { detectCorrection, detectRephrasing } from "../classifier";

describe("detectCorrection", () => {
  it("detects 'no, I meant'", () => {
    expect(detectCorrection("No, I meant the other approach")).toBe(true);
  });

  it("detects 'that's wrong'", () => {
    expect(detectCorrection("That's wrong, the answer is 42")).toBe(true);
  });

  it("detects 'actually,'", () => {
    expect(detectCorrection("Actually, I think you misunderstood")).toBe(true);
  });

  it("detects 'not quite'", () => {
    expect(detectCorrection("not quite, let me clarify")).toBe(true);
  });

  it("does not flag normal messages", () => {
    expect(detectCorrection("Can you explain how neural networks work?")).toBe(false);
    expect(detectCorrection("That's great, thanks!")).toBe(false);
  });

  it("detects 'you misunderstood'", () => {
    expect(detectCorrection("I said X but you misunderstood")).toBe(true);
  });
});

describe("detectRephrasing", () => {
  it("detects near-identical rephrasing", () => {
    // "What is the revenue of Apple" → 6 unique words
    // "What is the revenue of Apple company" → 7 unique words, Jaccard = 6/7 ≈ 0.857 > 0.8
    const prev = ["What is the revenue of Apple"];
    const newMsg = "What is the revenue of Apple company";
    expect(detectRephrasing(newMsg, prev)).toBe(true);
  });

  it("returns false for clearly different questions", () => {
    const prev = ["How does photosynthesis work?"];
    const newMsg = "What are the best JavaScript frameworks for building APIs?";
    expect(detectRephrasing(newMsg, prev)).toBe(false);
  });

  it("returns false when there are no previous messages", () => {
    expect(detectRephrasing("hello", [])).toBe(false);
  });

  it("only considers last 3 previous messages", () => {
    const prev = [
      "What is the revenue of Apple?", // old — should be ignored
      "unrelated message one",
      "unrelated message two",
      "unrelated message three",
    ];
    // The exact match is at index 0, which is older than the last 3
    const newMsg = "What is the revenue of Apple?";
    expect(detectRephrasing(newMsg, prev)).toBe(false);
  });

  it("uses configurable threshold", () => {
    const prev = ["What is the revenue?"];
    const newMsg = "What is the revenue of Apple?";
    // Should pass with a low threshold
    expect(detectRephrasing(newMsg, prev, 0.3)).toBe(true);
    // Should fail with a very high threshold
    expect(detectRephrasing(newMsg, prev, 0.99)).toBe(false);
  });
});
