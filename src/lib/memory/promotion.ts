// Memory-to-knowledge promotion pipeline.
// Promotes conversation facts to long-term memories after conversation ends.
// Run async after exchange completes (via waitUntil in CF Workers).

import { embed } from "@/lib/embeddings";
import { extractMemories } from "./classifier";
import { detectContradictions } from "./contradiction";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PromotionResult {
  created: string[]; // memory IDs created
  suggested: string[]; // memory contents to suggest to user
}

export async function promoteConversationMemories(
  userId: string,
  conversationId: string,
  projectId: string | null,
  supabase: SupabaseClient,
): Promise<PromotionResult> {
  // Load the most recent exchange (last user + assistant message pair).
  // Fetch descending then reverse to get chronological order [..., user, assistant].
  const { data: rawMessages } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .eq("is_active", true)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(4);

  if (!rawMessages || rawMessages.length < 2) return { created: [], suggested: [] };

  // Reverse to chronological (oldest → newest) so findLast returns the truly most recent.
  const messages = [...rawMessages].reverse();
  const userMsg = messages.findLast((m) => m.role === "user")?.content ?? "";
  const assistantMsg = messages.findLast((m) => m.role === "assistant")?.content ?? "";

  if (!userMsg || !assistantMsg) return { created: [], suggested: [] };

  const candidates = await extractMemories(userMsg, assistantMsg);
  const created: string[] = [];
  const suggested: string[] = [];

  for (const candidate of candidates) {
    if (candidate.shouldPromote) {
      const id = await saveMemory(userId, conversationId, projectId, candidate, supabase);
      // (projectId is also threaded into contradiction detection inside saveMemory)
      if (id) created.push(id);
    } else {
      suggested.push(candidate.content);
    }
  }

  return { created, suggested };
}

async function saveMemory(
  userId: string,
  conversationId: string,
  projectId: string | null,
  candidate: { type: string; content: string; confidence: number },
  supabase: SupabaseClient,
): Promise<string | null> {
  // Check contradictions scoped to this project (or global memories when projectId is null)
  const contradictions = await detectContradictions(userId, candidate.content, supabase, {
    projectId,
  });

  // If any existing memory has higher or equal confidence, the existing knowledge wins
  const blockedByHigherConfidence = contradictions.some(
    (contra) => contra.confidence > candidate.confidence,
  );
  if (blockedByHigherConfidence) return null;

  let embedding: number[] | undefined;
  try {
    embedding = await embed(candidate.content);
  } catch {
    // Save without embedding; search will still work via FTS
  }

  const { data, error } = await supabase
    .from("memories")
    .insert({
      user_id: userId,
      project_id: projectId,
      type: candidate.type,
      content: candidate.content,
      source_conversation_id: conversationId,
      confidence: candidate.confidence,
      importance: 0.5,
      embedding: embedding ? `[${embedding.join(",")}]` : null,
      search_fallback: !embedding, // flag for FTS-only retrieval when embedding unavailable
    })
    .select("id")
    .single();

  if (error || !data) return null;

  // Point superseded (lower-confidence) memories at the new one
  for (const contra of contradictions.filter((c) => c.confidence <= candidate.confidence)) {
    try {
      await supabase
        .from("memories")
        .update({ superseded_by: data.id })
        .eq("id", contra.id);
    } catch (e) {
      console.error("[promotion] supersession update failed", contra.id, e);
    }
  }

  return data.id;
}
