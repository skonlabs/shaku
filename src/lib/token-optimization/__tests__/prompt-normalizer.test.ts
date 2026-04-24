import { describe, expect, it } from "vitest";
import { PromptNormalizer } from "../prompt-normalizer";

const norm = new PromptNormalizer();

describe("PromptNormalizer.normalize", () => {
  it("leaves short texts unchanged (< 60 chars)", () => {
    const short = "Hello world";
    expect(norm.normalize(short)).toBe(short);
  });

  it("replaces 'in order to' with 'to'", () => {
    const r = norm.normalize(
      "We need in order to complete this task before the deadline arrives today.",
    );
    expect(r).not.toMatch(/in order to/i);
    expect(r).toContain("to");
  });

  it("replaces 'due to the fact that' with 'because'", () => {
    const r = norm.normalize(
      "This failed due to the fact that the server was unreachable during testing.",
    );
    expect(r).not.toMatch(/due to the fact that/i);
    expect(r).toContain("because");
  });

  it("replaces 'prior to' with 'before'", () => {
    const r = norm.normalize(
      "Please complete the form prior to the scheduled meeting tomorrow morning.",
    );
    expect(r).not.toMatch(/prior to/i);
    expect(r).toContain("before");
  });

  it("preserves dates", () => {
    const r = norm.normalize(
      "The release is scheduled for 2024-12-31 in order to meet the year-end target.",
    );
    expect(r).toContain("2024-12-31");
  });

  it("preserves dollar amounts", () => {
    const r = norm.normalize(
      "The budget is $1,500,000 and we have the ability to deliver on time.",
    );
    expect(r).toContain("$1,500,000");
  });

  it("result is trimmed", () => {
    const r = norm.normalize(
      "  We have the ability to deliver due to the fact that the team is skilled enough.  ",
    );
    expect(r).toBe(r.trim());
  });
});

describe("PromptNormalizer.extractTaskTypeHint", () => {
  it("detects classification", () => {
    expect(norm.extractTaskTypeHint("Can you classify this review?")).toBe("classification");
  });

  it("detects extraction", () => {
    expect(norm.extractTaskTypeHint("Extract all dates from the document.")).toBe("extraction");
  });

  it("detects summarization", () => {
    expect(norm.extractTaskTypeHint("Summarize this article in three points.")).toBe("summarization");
  });

  it("detects tldr", () => {
    expect(norm.extractTaskTypeHint("TLDR of the following text")).toBe("summarization");
  });

  it("detects coding from 'debug'", () => {
    expect(norm.extractTaskTypeHint("Debug this Python function for me.")).toBe("coding");
  });

  it("detects coding from 'implement'", () => {
    expect(norm.extractTaskTypeHint("Implement a binary search tree.")).toBe("coding");
  });

  it("detects reasoning from 'analyze'", () => {
    expect(norm.extractTaskTypeHint("Analyze the root cause of this failure.")).toBe("reasoning");
  });

  it("detects generation from 'write'", () => {
    expect(norm.extractTaskTypeHint("Write a blog post about serverless.")).toBe("generation");
  });

  it("returns undefined for unmatched text", () => {
    expect(norm.extractTaskTypeHint("Hello, how are you?")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(norm.extractTaskTypeHint("")).toBeUndefined();
  });
});

describe("PromptNormalizer.extractCriticalDetails", () => {
  it("extracts ISO date", () => {
    const d = norm.extractCriticalDetails("The deadline is 2024-12-31.");
    expect(d.dates).toContain("2024-12-31");
  });

  it("extracts percentage", () => {
    const d = norm.extractCriticalDetails("Revenue grew by 15.5% this year.");
    expect(d.numbers.some((n) => n.includes("15.5%"))).toBe(true);
  });

  it("extracts dollar amount", () => {
    const d = norm.extractCriticalDetails("The budget is $50,000 for Q1.");
    expect(d.numbers.some((n) => n.includes("50,000"))).toBe(true);
  });

  it("extracts 'must' constraint", () => {
    const d = norm.extractCriticalDetails("The output must include a summary.");
    expect(d.constraints).toContain("must");
  });

  it("extracts 'at most' constraint", () => {
    const d = norm.extractCriticalDetails("Use at most 500 words.");
    expect(d.constraints).toContain("at most");
  });

  it("detects JSON format hint", () => {
    const d = norm.extractCriticalDetails("Return the result as json.");
    expect(d.formatHints).toContain("json");
  });

  it("detects table format hint", () => {
    const d = norm.extractCriticalDetails("Present data as a table please.");
    expect(d.formatHints).toContain("as a table");
  });

  it("deduplicates dates", () => {
    const d = norm.extractCriticalDetails("Date 2024-01-01 and again 2024-01-01.");
    expect(d.dates.filter((x) => x === "2024-01-01").length).toBe(1);
  });

  it("no entities → empty arrays", () => {
    const d = norm.extractCriticalDetails("Hello, how are you today?");
    expect(d.constraints).toHaveLength(0);
  });
});
