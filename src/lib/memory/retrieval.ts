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
  accessCount: number;
  lastAccessedAt: string | null;
  similarity: number;
}

export async function retrieveMemories(
  userId: string,
  query: string,
  supabase: SupabaseClient,
  opts: { projectId?: string | null; limit?: number } = {},
): Promise<RetrievedMemory[]> {
  const { projectId = null, limit = 10 } = opts;

  try {
    const embedding = await embed(query);
    const { data, error } = await supabase.rpc("search_memories", {
      query_embedding: `[${embedding.join(",")}]`,
      target_user_id: userId,
      target_project_id: projectId,
      match_count: limit,
    });

    if (error || !data) return [];

    // Update access metrics
    const ids = data.map((m: { id: string }) => m.id);
    if (ids.length) {
      // Use supabase admin for this update to bypass RLS complexity
      void supabase
        .from("memories")
        .update({ last_accessed_at: new Date().toISOString() })
        .in("id", ids);
    }

    return data.map((m: Record<string, unknown>) => ({
      id: m.id as string,
      type: m.type as string,
      content: m.content as string,
      confidence: m.confidence as number,
      importance: m.importance as number,
      accessCount: m.access_count as number,
      lastAccessedAt: m.last_accessed_at as string | null,
      similarity: m.similarity as number,
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
    .select("id, type, content, confidence, importance, access_count, last_accessed_at, created_at")
    .eq("user_id", userId)
    .is("superseded_by", null)
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
    accessCount: m.access_count,
    lastAccessedAt: m.last_accessed_at,
    similarity: 1,
  }));
}
