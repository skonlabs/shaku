// Memory retrieval: semantic search via search_memories RPC.
// Used in context assembly (Step 6b) and settings display.

import { embed } from "@/lib/embeddings";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface RetrievedMemory {
  id: string;
  type: string;
  content: string;
  confidence: number;
  importance: number;
  pinned: boolean;
  accessCount: number;
  lastAccessedAt: string | null;
  similarity: number;
  hybridScore: number;
  sourceConversationId: string | null;
}

export async function retrieveMemories(
  userId: string,
  query: string,
  supabase: SupabaseClient,
  opts: {
    projectId?: string | null;
    limit?: number;
    /** Defer access-count increment via this callback (e.g. ctx.waitUntil). */
    runAfterResponse?: (p: Promise<unknown>) => void;
  } = {},
): Promise<RetrievedMemory[]> {
  const { projectId = null, limit = 10, runAfterResponse } = opts;

  try {
    const embedding = await embed(query);
    const { data, error } = await supabase.rpc("search_memories", {
      query_embedding: `[${embedding.join(",")}]`,
      target_user_id: userId,
      target_project_id: projectId,
      match_count: limit,
      query_text: query,
    });

    if (error || !data) return [];

    // Update access metrics atomically. In CF Workers we MUST keep the request
    // alive via ctx.waitUntil — bare `void` lets the runtime cancel mid-flight
    // when the response stream closes. Caller passes runAfterResponse for that.
    const ids = data.map((m: { id: string }) => m.id);
    if (ids.length) {
      const incrementPromise = Promise.resolve(
        supabase.rpc("increment_memory_access", { memory_ids: ids }).then(() => {}),
      );
      if (runAfterResponse) runAfterResponse(incrementPromise);
      else void incrementPromise;
    }

    return data.map((m: Record<string, unknown>) => ({
      id: m.id as string,
      type: m.type as string,
      content: m.content as string,
      confidence: m.confidence as number,
      importance: m.importance as number,
      pinned: (m.pinned as boolean | undefined) ?? false,
      accessCount: m.access_count as number,
      lastAccessedAt: m.last_accessed_at as string | null,
      similarity: m.similarity as number,
      hybridScore: (m.hybrid_score as number | undefined) ?? (m.similarity as number),
      sourceConversationId: (m.source_conversation_id as string | null) ?? null,
    }));
  } catch {
    return [];
  }
}

// Load all memories for a user (for settings display)
export async function listMemories(
  userId: string,
  supabase: SupabaseClient,
  opts: { type?: string; limit?: number; offset?: number } = {},
): Promise<RetrievedMemory[]> {
  const { type, limit = 50, offset = 0 } = opts;
  let query = supabase
    .from("memories")
    .select(
      "id, type, content, confidence, importance, pinned, access_count, last_accessed_at, source_conversation_id, created_at",
    )
    .eq("user_id", userId)
    .is("superseded_by", null)
    .order("pinned", { ascending: false })
    .order("importance", { ascending: false })
    .range(offset, offset + limit - 1);

  if (type) query = query.eq("type", type);

  const { data } = await query;
  return (data ?? []).map((m) => ({
    id: m.id,
    type: m.type,
    content: m.content,
    confidence: m.confidence,
    importance: m.importance,
    pinned: m.pinned ?? false,
    accessCount: m.access_count,
    lastAccessedAt: m.last_accessed_at,
    similarity: 1,
    hybridScore: 1,
    sourceConversationId: m.source_conversation_id ?? null,
  }));
}
