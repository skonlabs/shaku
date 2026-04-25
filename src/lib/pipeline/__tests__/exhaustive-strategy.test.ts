import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exhaustiveRetrieve } from "../exhaustive-strategy";
import type { RetrievedChunk } from "../retrieval";

function makeChunk(id: string, content: string): RetrievedChunk {
  return {
    id,
    sourceType: "datasource",
    sourceId: "s1",
    sourceItemId: null,
    content,
    metadata: {},
    score: 0.5,
  };
}

// Mock embed
vi.mock("@/lib/embeddings", () => ({
  embed: vi.fn().mockResolvedValue(Array(1536).fill(0.1)),
}));

function makeSupabase(chunks: RetrievedChunk[] = []) {
  const rpcData = chunks.map((c) => ({
    id: c.id,
    source_type: c.sourceType,
    source_id: c.sourceId,
    source_item_id: c.sourceItemId,
    content: c.content,
    metadata: c.metadata,
    rrf_score: c.score,
  }));

  return {
    rpc: vi.fn().mockResolvedValue({ data: rpcData, error: null }),
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      textSearch: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    }),
  };
}

// Mock fetch to simulate broadenQuery failure + no web search
beforeEach(() => {
  vi.stubGlobal("fetch", async () => { throw new Error("network"); });
  delete process.env.BING_SEARCH_API_KEY;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("exhaustiveRetrieve", () => {
  it("returns level 1 when broadened retrieval is good quality", async () => {
    // Mock high-quality retrieval: 5 chunks with score >= 0.08 avg (≥ 0.4 quality)
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk(`c${i}`, `relevant content ${i}`),
    );
    // Override rpc to return high-score data
    const rpcData = chunks.map((c) => ({
      id: c.id,
      source_type: c.sourceType,
      source_id: c.sourceId,
      source_item_id: c.sourceItemId,
      content: c.content,
      metadata: c.metadata,
      rrf_score: 0.5, // high score → quality > 0.4
    }));
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: rpcData, error: null }),
      from: makeSupabase().from,
    } as unknown as Parameters<typeof exhaustiveRetrieve>[4];

    const result = await exhaustiveRetrieve("user-1", "conv-1", "test query", "question", supabase);
    expect(result.level).toBe(1);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.webSearched).toBe(false);
  });

  it("progresses to level 2 when retrieval quality is low", async () => {
    // All chunks have low score → quality stays < 0.4
    const rpcData = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i}`,
      source_type: "datasource",
      source_id: "s1",
      source_item_id: null,
      content: `content ${i}`,
      metadata: {},
      rrf_score: 0.01,
    }));

    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: rpcData, error: null }),
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        textSearch: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: [] }),
        }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      }),
    } as unknown as Parameters<typeof exhaustiveRetrieve>[4];

    const result = await exhaustiveRetrieve("user-1", "conv-1", "obscure query", "question", supabase);
    // Level ≥ 2 since quality is low
    expect(result.level).toBeGreaterThanOrEqual(2);
  });

  it("does not web-search when BING_SEARCH_API_KEY is absent", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        textSearch: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [] }) }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      }),
    } as unknown as Parameters<typeof exhaustiveRetrieve>[4];

    const result = await exhaustiveRetrieve("user-1", "conv-1", "query", "question", supabase);
    expect(result.webSearched).toBe(false);
  });

  it("sends status updates via callback", async () => {
    const updates: string[] = [];
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        textSearch: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [] }) }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      }),
    } as unknown as Parameters<typeof exhaustiveRetrieve>[4];

    await exhaustiveRetrieve("user-1", "conv-1", "query", "question", supabase, (msg) =>
      updates.push(msg),
    );
    expect(updates.length).toBeGreaterThan(0);
  });
});
