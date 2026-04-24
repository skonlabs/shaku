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
  // Load the most recent exchange (last user + assistant message pair)
  const { data: messages } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .eq("is_active", true)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(4);

  if (!messages || messages.length < 2) return { created: [], suggested: [] };

  const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
  const assistantMsg = messages.find((m) => m.role === "assistant")?.content ?? "";

  const candidates = await extractMemories(userMsg, assistantMsg);
  const created: string[] = [];
  const suggested: string[] = [];

  for (const candidate of candidates) {
    if (candidate.shouldPromote) {
      const id = await saveMemory(userId, conversationId, projectId, candidate, supabase);
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
  // Check for contradictions before saving
  const contradictions = await detectContradictions(userId, candidate.content, supabase);
  for (const contra of contradictions) {
    if (candidate.confidence > contra.confidence) {
      // Supersede the old memory
      await supabase
        .from("memories")
        .update({ superseded_by: "pending" }) // will be updated below
        .eq("id", contra.id);
    } else {
      // New memory has lower confidence — skip
      return null;
    }
  }

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
    })
    .select("id")
    .single();

  if (error || !data) return null;

  // Update the superseded memories to point to the new one
  for (const contra of contradictions) {
    await supabase
      .from("memories")
      .update({ superseded_by: data.id })
      .eq("id", contra.id);
  }

  return data.id;
}
