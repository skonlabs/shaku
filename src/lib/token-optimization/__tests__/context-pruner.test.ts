import { describe, expect, it } from "vitest";
import { ContextPruner } from "../context-pruner";
import { TokenCounter } from "../token-counter";

const counter = new TokenCounter();

const DOCS = [
  "Python is a high-level programming language known for simplicity and readability. It is widely used in data science, machine learning, and automation.",
  "JavaScript is primarily a frontend web development language. React, Vue, and Angular are popular frameworks for building user interfaces.",
  "Machine learning is a subset of artificial intelligence. Neural networks learn patterns from large datasets to make predictions.",
  "SQL is a domain-specific language for managing relational databases. Common operations include SELECT, INSERT, UPDATE, and DELETE.",
  "Docker is a containerisation platform that packages applications with their dependencies to simplify deployment.",
];

describe("ContextPruner — chunking", () => {
  it("single short document yields one chunk", () => {
    const p = new ContextPruner(counter, 200, 0, 5);
    const result = p.prune(["Short document."], "query");
    expect(result).toHaveLength(1);
  });

  it("empty documents return empty array", () => {
    const p = new ContextPruner(counter, 200, 0, 5);
    expect(p.prune([], "query")).toHaveLength(0);
  });

  it("long document without punctuation is split by words", () => {
    const p = new ContextPruner(counter, 20, 0, 10);
    // 200 words, no sentence punctuation
    const longDoc = Array.from({ length: 200 }, (_, i) => `Word${i}`).join(" ");
    const result  = p.prune([longDoc], "Word5");
    expect(result.length).toBeGreaterThan(1);
  });

  it("top-K limit is respected", () => {
    const p = new ContextPruner(counter, 200, 0, 2);
    const result = p.prune(DOCS, "programming language");
    expect(result.length).toBeLessThanOrEqual(2);
  });
});

describe("ContextPruner — BM25 ranking", () => {
  it("ML query returns ML-related content first", () => {
    const p = new ContextPruner(counter, 500, 0, 1);
    const result = p.prune(DOCS, "machine learning neural networks");
    expect(result[0].toLowerCase()).toMatch(/machine learning|neural/);
  });

  it("Python query returns Python-related content", () => {
    const p = new ContextPruner(counter, 500, 0, 1);
    const result = p.prune(DOCS, "Python programming language");
    expect(result[0].toLowerCase()).toContain("python");
  });

  it("SQL query returns database content", () => {
    const p = new ContextPruner(counter, 500, 0, 1);
    const result = p.prune(DOCS, "SQL database queries SELECT");
    expect(result[0].toLowerCase()).toMatch(/sql|database/);
  });
});

describe("ContextPruner — token budget", () => {
  it("result fits within token budget", () => {
    const p = new ContextPruner(counter, 500, 0, 10);
    const budget = 50;
    const result = p.prune(DOCS, "Python", budget);
    const total  = result.reduce((s, c) => s + counter.count(c), 0);
    expect(total).toBeLessThanOrEqual(budget + 5); // small margin
  });

  it("always returns at least one chunk when budget > 0", () => {
    const p = new ContextPruner(counter, 200, 0, 5);
    const result = p.prune(DOCS, "Python", 10);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

describe("ContextPruner — document order", () => {
  it("selected chunks are in original document order", () => {
    const p = new ContextPruner(counter, 500, 0, 3);
    const result = p.prune(DOCS, "Python JavaScript SQL");
    if (result.length >= 2) {
      const combined = result.join(" ");
      const pyIdx  = combined.indexOf("Python");
      const sqlIdx = combined.indexOf("SQL");
      if (pyIdx !== -1 && sqlIdx !== -1) {
        expect(pyIdx).toBeLessThan(sqlIdx);
      }
    }
  });
});
