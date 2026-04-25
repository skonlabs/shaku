import { describe, it, expect, vi } from "vitest";
import { assembleContext, updateConversationState } from "../context-assembly";
import type { RetrievedChunk } from "../retrieval";

function makeChunk(content: string, title = "TestDoc"): RetrievedChunk {
  return {
    id: "c1",
    sourceType: "datasource",
    sourceId: "s1",
    sourceItemId: null,
    content,
    metadata: { title },
    score: 0.9,
  };
}

function makeSupabase(overrides: Record<string, unknown> = {}) {
  const from = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    upsert: vi.fn().mockResolvedValue({ error: null }),
    update: vi.fn().mockReturnThis(),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  });
  return { from, rpc: vi.fn().mockResolvedValue({ data: [], error: null }), ...overrides };
}

// Mock embed so no real network calls are made
vi.mock("@/lib/embeddings", () => ({
  embed: vi.fn().mockResolvedValue(Array(1536).fill(0.1)),
  embedBatch: vi.fn().mockResolvedValue([Array(1536).fill(0.1)]),
}));

describe("assembleContext", () => {
  it("returns a systemPrompt string", async () => {
    const supabase = makeSupabase() as unknown as Parameters<typeof assembleContext>[0]["supabase"];
    const result = await assembleContext({
      userId: "user-1",
      conversationId: "conv-1",
      projectId: null,
      currentMessage: "What is the capital of France?",
      retrievedChunks: [],
      supabase,
      systemInstructions: "You are a helpful assistant.",
    });
    expect(typeof result.systemPrompt).toBe("string");
    expect(result.systemPrompt).toContain("You are a helpful assistant.");
  });

  it("includes retrieval context in system prompt", async () => {
    const supabase = makeSupabase() as unknown as Parameters<typeof assembleContext>[0]["supabase"];
    const result = await assembleContext({
      userId: "user-1",
      conversationId: "conv-1",
      projectId: null,
      currentMessage: "Tell me about TestDoc",
      retrievedChunks: [makeChunk("Important content from TestDoc")],
      supabase,
      systemInstructions: "You are helpful.",
    });
    expect(result.systemPrompt).toContain("TestDoc");
    expect(result.systemPrompt).toContain("Important content from TestDoc");
  });

  it("returns convState with default values when no DB record exists", async () => {
    const supabase = makeSupabase() as unknown as Parameters<typeof assembleContext>[0]["supabase"];
    const result = await assembleContext({
      userId: "user-1",
      conversationId: "conv-1",
      projectId: null,
      currentMessage: "hello",
      retrievedChunks: [],
      supabase,
      systemInstructions: "You are helpful.",
    });
    expect(result.convState).toBeDefined();
    expect(Array.isArray(result.convState.conversationFacts)).toBe(true);
    expect(Array.isArray(result.convState.activeTopics)).toBe(true);
  });

  it("uses preloadedHistory instead of DB query", async () => {
    const supabase = makeSupabase() as unknown as Parameters<typeof assembleContext>[0]["supabase"];
    const preloadedHistory = [
      { role: "user" as const, content: "Hello there", createdAt: "2024-01-01T00:00:00Z" },
      { role: "assistant" as const, content: "Hi! How can I help?", createdAt: "2024-01-01T00:00:01Z" },
    ];
    const result = await assembleContext({
      userId: "user-1",
      conversationId: "conv-1",
      projectId: null,
      currentMessage: "Follow up question",
      retrievedChunks: [],
      supabase,
      systemInstructions: "You are helpful.",
      preloadedHistory,
    });
    // Messages should include the preloaded history
    expect(result.messages.some((m) => m.content === "Hello there")).toBe(true);
  });

  it("returns empty messages array when history is empty", async () => {
    const supabase = makeSupabase() as unknown as Parameters<typeof assembleContext>[0]["supabase"];
    const result = await assembleContext({
      userId: "user-1",
      conversationId: "conv-1",
      projectId: null,
      currentMessage: "Hello",
      retrievedChunks: [],
      supabase,
      systemInstructions: "Base instructions.",
      preloadedHistory: [],
    });
    expect(result.messages).toHaveLength(0);
  });
});

describe("updateConversationState", () => {
  it("calls upsert on conversation_states", async () => {
    const upsertMock = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { conversation_facts: [], active_topics: [], summary_covers_until: 0 },
        }),
        upsert: upsertMock,
      }),
    } as unknown as Parameters<typeof updateConversationState>[3];

    await updateConversationState("conv-1", ["user prefers dark mode"], ["preferences"], supabase);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: "conv-1",
        conversation_facts: expect.arrayContaining(["user prefers dark mode"]),
      }),
    );
  });

  it("limits facts to 20 most recent", async () => {
    const upsertMock = vi.fn().mockResolvedValue({ error: null });
    const existing = Array.from({ length: 20 }, (_, i) => `fact ${i}`);
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { conversation_facts: existing, active_topics: [], summary_covers_until: 0 },
        }),
        upsert: upsertMock,
      }),
    } as unknown as Parameters<typeof updateConversationState>[3];

    await updateConversationState("conv-1", ["new fact"], [], supabase);
    const call = upsertMock.mock.calls[0][0];
    expect(call.conversation_facts).toHaveLength(20);
    expect(call.conversation_facts[19]).toBe("new fact");
  });
});
