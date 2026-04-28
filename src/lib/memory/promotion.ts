// Memory-to-knowledge promotion pipeline.
// Promotes conversation facts to long-term memories after conversation ends.
// Run via the durable memory_jobs queue (see jobs.ts), not fire-and-forget.

import { embed } from "@/lib/embeddings";
import { extractFullMemory } from "./classifier";
import { detectContradictions } from "./contradiction";
import { upsertTask } from "./tasks";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PromotionResult {
  created: string[]; // memory IDs created
  suggested: string[]; // memory contents to suggest to user
}

// Memory types that are semantically related for update matching.
// When looking for an existing memory to supersede, prefer same-type or
// a related type over cross-type matches to avoid clobbering unrelated facts.
const UPDATE_TYPE_GROUPS: Record<string, string[]> = {
  preference:      ["preference", "anti_preference"],
  anti_preference: ["preference", "anti_preference"],
  correction:      ["correction", "semantic", "long_term", "behavioral"],
  response_style:  ["response_style"],
  behavioral:      ["behavioral", "correction"],
  semantic:        ["semantic", "long_term", "episodic"],
  long_term:       ["long_term", "semantic"],
  project:         ["project"],
  episodic:        ["episodic", "semantic"],
  short_term:      ["short_term"],
  document:        ["document"],
};

export async function promoteConversationMemories(
  userId: string,
  conversationId: string,
  projectId: string | null,
  supabase: SupabaseClient,
): Promise<PromotionResult> {
  const { data: rawMessages } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .eq("is_active", true)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(6);

  if (!rawMessages || rawMessages.length < 2) return { created: [], suggested: [] };

  const messages = [...rawMessages].reverse();
  const userMsg = messages.findLast((m) => m.role === "user")?.content ?? "";
  const assistantMsg = messages.findLast((m) => m.role === "assistant")?.content ?? "";

  if (!userMsg || !assistantMsg) return { created: [], suggested: [] };

  const extraction = await extractFullMemory(userMsg, assistantMsg);
  const created: string[] = [];
  const suggested: string[] = [];

  for (const update of extraction.memoryUpdates) {
    await applyMemoryUpdate(userId, projectId, conversationId, update, supabase);
  }

  for (const candidate of extraction.newMemories) {
    if (candidate.shouldPromote) {
      const id = await saveMemory(userId, conversationId, projectId, candidate, supabase);
      if (id) created.push(id);
    } else {
      suggested.push(candidate.content);
    }
  }

  if (extraction.taskUpdates) {
    await upsertTask(conversationId, extraction.taskUpdates, supabase).catch((e) => {
      console.error("[promotion] task upsert failed", e);
    });
  }

  if (extraction.conversationSummaryUpdate) {
    const { error: convStateErr } = await supabase
      .from("conversation_states")
      .upsert({
        conversation_id: conversationId,
        summary: extraction.conversationSummaryUpdate,
        updated_at: new Date().toISOString(),
      });
    if (convStateErr) console.error("[promotion] conversation_states upsert failed:", convStateErr);
  }

  return { created, suggested };
}

async function applyMemoryUpdate(
  userId: string,
  projectId: string | null,
  conversationId: string,
  update: { existingContent: string; updatedContent: string; confidence: number; type?: string },
  supabase: SupabaseClient,
): Promise<void> {
  // Build a type filter so updates only target semantically related memory types,
  // preventing cross-type clobbering (e.g. a "preference" update superseding a
  // "project" memory that happens to share a keyword).
  const updateType = update.type ?? "semantic";
  const allowedTypes = UPDATE_TYPE_GROUPS[updateType] ?? [updateType];

  const { data: matches } = await supabase
    .from("memories")
    .select("id, confidence, type")
    .eq("user_id", userId)
    .is("superseded_by", null)
    .in("type", allowedTypes)
    .ilike("content", `%${update.existingContent.slice(0, 100)}%`)
    .limit(3);

  if (!matches || matches.length === 0) return;

  const newId = await saveMemory(
    userId,
    conversationId,
    projectId,
    {
      type: updateType,
      content: update.updatedContent,
      confidence: update.confidence,
      isExplicitCorrection: updateType === "correction",
    },
    supabase,
  );
  if (!newId) return;

  for (const old of matches) {
    await supabase.from("memories").update({ superseded_by: newId }).eq("id", old.id);
  }
}

async function saveMemory(
  userId: string,
  conversationId: string,
  projectId: string | null,
  candidate: {
    type: string;
    content: string;
    confidence: number;
    isExplicitCorrection?: boolean;
  },
  supabase: SupabaseClient,
): Promise<string | null> {
  const contradictions = await detectContradictions(userId, candidate.content, supabase, {
    projectId,
    isExplicitCorrection: candidate.isExplicitCorrection ?? candidate.type === "correction",
  });

  // Explicit corrections always win over old memories regardless of confidence.
  // For non-corrections, block save only when an existing memory has strictly higher
  // confidence — the new memory might simply be a lower-confidence observation about
  // the same topic, which is still useful to record.
  const isCorrection = candidate.isExplicitCorrection ?? candidate.type === "correction";
  if (!isCorrection) {
    const blockedByHigherConfidence = contradictions.some(
      (contra) => contra.confidence > candidate.confidence,
    );
    if (blockedByHigherConfidence) return null;
  }

  let embedding: number[] | undefined;
  try {
    embedding = await embed(candidate.content);
  } catch {
    // Save without embedding; FTS still works
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

  // Supersede all contradicting memories (corrections supersede regardless of confidence).
  for (const contra of contradictions) {
    try {
      await supabase.from("memories").update({ superseded_by: data.id }).eq("id", contra.id);
    } catch (e) {
      console.error("[promotion] supersession update failed", contra.id, e);
    }
  }

  return data.id;
}
