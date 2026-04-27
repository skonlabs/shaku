// Memory-to-knowledge promotion pipeline.
// Promotes conversation facts to long-term memories after conversation ends.
// Run async after exchange completes (via waitUntil in CF Workers).

import { embed } from "@/lib/embeddings";
import { extractFullMemory } from "./classifier";
import { detectContradictions } from "./contradiction";
import { upsertTask } from "./tasks";
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

  const extraction = await extractFullMemory(userMsg, assistantMsg);
  const created: string[] = [];
  const suggested: string[] = [];

  // Apply memory updates — supersede existing memories matching the substring
  for (const update of extraction.memoryUpdates) {
    await applyMemoryUpdate(userId, projectId, conversationId, update, supabase);
  }

  // Create new memories
  for (const candidate of extraction.newMemories) {
    if (candidate.shouldPromote) {
      const id = await saveMemory(userId, conversationId, projectId, candidate, supabase);
      if (id) created.push(id);
    } else {
      suggested.push(candidate.content);
    }
  }

  // Upsert task state if the extraction found task progress
  if (extraction.taskUpdates) {
    await upsertTask(conversationId, extraction.taskUpdates, supabase).catch((e) => {
      console.error("[promotion] task upsert failed", e);
    });
  }

  // Update conversation summary if provided
  if (extraction.conversationSummaryUpdate) {
    await supabase
      .from("conversation_states")
      .upsert({
        conversation_id: conversationId,
        summary: extraction.conversationSummaryUpdate,
        updated_at: new Date().toISOString(),
      })
      .then(() => {});
  }

  return { created, suggested };
}

async function applyMemoryUpdate(
  userId: string,
  projectId: string | null,
  conversationId: string,
  update: { existingContent: string; updatedContent: string; confidence: number },
  supabase: SupabaseClient,
): Promise<void> {
  // Find memories containing the substring
  const { data: matches } = await supabase
    .from("memories")
    .select("id, confidence")
    .eq("user_id", userId)
    .is("superseded_by", null)
    .ilike("content", `%${update.existingContent.slice(0, 100)}%`)
    .limit(3);

  if (!matches || matches.length === 0) return;

  // Save the updated memory
  const newId = await saveMemory(
    userId,
    conversationId,
    projectId,
    { type: "semantic", content: update.updatedContent, confidence: update.confidence },
    supabase,
  );
  if (!newId) return;

  // Supersede old memories
  for (const old of matches) {
    await supabase.from("memories").update({ superseded_by: newId }).eq("id", old.id);
  }
}

async function saveMemory(
  userId: string,
  conversationId: string,
  projectId: string | null,
  candidate: { type: string; content: string; confidence: number },
  supabase: SupabaseClient,
): Promise<string | null> {
  const contradictions = await detectContradictions(userId, candidate.content, supabase, {
    projectId,
  });

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
      search_fallback: !embedding,
    })
    .select("id")
    .single();

  if (error || !data) return null;

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
