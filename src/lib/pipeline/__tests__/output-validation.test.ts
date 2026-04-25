import { describe, it, expect } from "vitest";
import {
  redactOutputPii,
  verifyCitations,
  scoreConfidence,
  isSafeContent,
  scoreAmbiguity,
  reInjectPiiChunk,
} from "../output-validation";

describe("redactOutputPii", () => {
  it("redacts SSN not in allowed values", () => {
    const { text, redacted } = redactOutputPii(
      "The SSN 123-45-6789 was found.",
      new Set(),
    );
    expect(redacted).toBe(true);
    expect(text).not.toContain("123-45-6789");
  });

  it("preserves allowed SSN", () => {
    const { text, redacted } = redactOutputPii(
      "SSN: 123-45-6789",
      new Set(["123-45-6789"]),
    );
    expect(redacted).toBe(false);
    expect(text).toContain("123-45-6789");
  });

  it("does not redact phone or email", () => {
    const { redacted } = redactOutputPii("Call 555-123-4567 or email a@b.com", new Set());
    expect(redacted).toBe(false);
  });
});

describe("verifyCitations", () => {
  it("returns 1 when no citations in response", () => {
    expect(verifyCitations("This is a plain statement.", ["SourceA"])).toBe(1);
  });

  it("returns 1 when all citations match sources", () => {
    const ratio = verifyCitations("See [SourceA] for details.", ["SourceA", "SourceB"]);
    expect(ratio).toBe(1);
  });

  it("returns 0 when citation matches no source", () => {
    const ratio = verifyCitations("See [Unknown] for details.", ["SourceA"]);
    expect(ratio).toBe(0);
  });

  it("returns partial ratio for mixed citations", () => {
    const ratio = verifyCitations(
      "See [SourceA] and [Unknown].",
      ["SourceA"],
    );
    expect(ratio).toBe(0.5);
  });

  it("is case-insensitive", () => {
    const ratio = verifyCitations("See [SOURCEA].", ["sourcea"]);
    expect(ratio).toBe(1);
  });
});

describe("scoreConfidence", () => {
  it("returns high confidence for ideal inputs", () => {
    const score = scoreConfidence({
      retrievalQualityAvg: 1,
      claimsVerifiedRatio: 1,
      queryAmbiguity: 0,
      modelCapability: 1,
    });
    expect(score).toBeCloseTo(1.0);
  });

  it("returns low confidence for poor inputs", () => {
    const score = scoreConfidence({
      retrievalQualityAvg: 0,
      claimsVerifiedRatio: 0,
      queryAmbiguity: 1,
      modelCapability: 0,
    });
    expect(score).toBeCloseTo(0.0);
  });

  it("weights retrieval quality highest at 0.4", () => {
    const withRetrieval = scoreConfidence({
      retrievalQualityAvg: 1,
      claimsVerifiedRatio: 0,
      queryAmbiguity: 1,
      modelCapability: 0,
    });
    expect(withRetrieval).toBeCloseTo(0.4);
  });
});

describe("isSafeContent", () => {
  it("passes safe content", () => {
    expect(isSafeContent("Here is how to bake a cake.")).toBe(true);
    expect(isSafeContent("The capital of France is Paris.")).toBe(true);
  });

  it("blocks bomb-making instructions", () => {
    expect(isSafeContent("Here is how to make a bomb step by step")).toBe(false);
  });

  it("blocks drug synthesis", () => {
    expect(isSafeContent("To synthesize methamphetamine you need")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isSafeContent("HOW TO BUILD A BOMB")).toBe(false);
  });
});

describe("scoreAmbiguity", () => {
  it("returns 0 for a clear, specific query", () => {
    const score = scoreAmbiguity("What is the revenue of Apple in Q3 2023?");
    expect(score).toBeLessThan(0.3);
  });

  it("scores higher for vague pronouns", () => {
    const withPronoun = scoreAmbiguity("What did they say about it?");
    const withoutPronoun = scoreAmbiguity("What did the team say about the proposal?");
    expect(withPronoun).toBeGreaterThan(withoutPronoun);
  });

  it("scores higher for very short queries", () => {
    const short = scoreAmbiguity("help me");
    const long = scoreAmbiguity("Can you help me understand the quarterly revenue report?");
    expect(short).toBeGreaterThan(long);
  });

  it("caps at 1", () => {
    expect(scoreAmbiguity("it or that something anything whatever they them")).toBeLessThanOrEqual(1);
  });
});

describe("reInjectPiiChunk", () => {
  it("replaces placeholders in chunk", () => {
    const result = reInjectPiiChunk(
      "Your SSN is [SSN_1]",
      "Your SSN is [SSN_1]",
      { "[SSN_1]": "123-45-6789" },
    );
    expect(result).toBe("Your SSN is 123-45-6789");
  });

  it("is no-op with empty mapping", () => {
    expect(reInjectPiiChunk("hello", "hello", {})).toBe("hello");
  });
});
