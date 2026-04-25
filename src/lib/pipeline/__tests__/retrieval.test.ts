import { describe, it, expect } from "vitest";
import { buildRetrievalContext } from "../retrieval";
import type { RetrievedChunk } from "../retrieval";

function makeChunk(content: string, title?: string, type = "datasource"): RetrievedChunk {
  return {
    id: Math.random().toString(36),
    sourceType: type,
    sourceId: "src-1",
    sourceItemId: null,
    content,
    metadata: title ? { title } : {},
    score: 0.9,
  };
}

describe("buildRetrievalContext", () => {
  it("returns empty string for no chunks", () => {
    expect(buildRetrievalContext([])).toBe("");
  });

  it("wraps each chunk in source tags", () => {
    const result = buildRetrievalContext([makeChunk("some content", "MyDoc")]);
    expect(result).toContain('<source name="MyDoc" type="datasource">');
    expect(result).toContain("some content");
    expect(result).toContain("</source>");
  });

  it("uses sourceType as name when no title", () => {
    const result = buildRetrievalContext([makeChunk("content", undefined, "connector")]);
    expect(result).toContain('name="connector"');
  });

  it("joins multiple chunks with double newline", () => {
    const chunks = [makeChunk("A", "Doc1"), makeChunk("B", "Doc2")];
    const result = buildRetrievalContext(chunks);
    expect(result).toContain("Doc1");
    expect(result).toContain("Doc2");
    expect(result).toContain("\n\n");
  });

  it("respects token budget — stops before exceeding char limit", () => {
    const bigContent = "x".repeat(10_000);
    const chunks = Array.from({ length: 20 }, () => makeChunk(bigContent, "Big"));
    // Default budget = 6000 tokens = 24000 chars
    const result = buildRetrievalContext(chunks);
    expect(result.length).toBeLessThanOrEqual(25_000);
  });

  it("respects custom token budget", () => {
    const chunks = Array.from({ length: 10 }, (_, i) =>
      makeChunk("x".repeat(1000), `Doc${i}`),
    );
    const small = buildRetrievalContext(chunks, 100); // 400 char budget
    const large = buildRetrievalContext(chunks, 10_000);
    expect(small.length).toBeLessThan(large.length);
  });
});
