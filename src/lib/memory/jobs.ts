// Durable memory job queue — replaces fire-and-forget waitUntil() pattern.
//
// Enqueue after each completed assistant turn. A background worker (or the next
// request's runAfterResponse) claims pending jobs and processes them with retries.
// Failed jobs back off exponentially (2^retries minutes) up to max_retries.

import type { SupabaseClient } from "@supabase/supabase-js";
import { promoteConversationMemories } from "./promotion";

export async function enqueueMemoryJob(
  userId: string,
  conversationId: string,
  projectId: string | null,
  supabase: SupabaseClient,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("memory_jobs")
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      project_id: projectId,
      payload: { version: 1 },
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[memory-jobs] enqueue failed", error);
    if (error?.code === "PGRST205" || /memory_jobs/i.test(error?.message ?? "")) {
      try {
        await promoteConversationMemories(userId, conversationId, projectId, supabase);
      } catch (fallbackError) {
        console.error("[memory-jobs] inline fallback failed", fallbackError);
      }
    }
    return null;
  }
  return data.id as string;
}

export async function processMemoryJob(
  jobId: string,
  supabase: SupabaseClient,
): Promise<void> {
  // Atomic claim: only transitions 'pending' → 'processing'.
  // Concurrent workers cannot double-claim the same job.
  const { data: job, error: claimErr } = await supabase
    .from("memory_jobs")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "pending")
    .lte("scheduled_at", new Date().toISOString())
    .select("user_id, conversation_id, project_id, retries, max_retries")
    .maybeSingle();

  if (claimErr || !job) return; // already claimed or not yet due

  try {
    await promoteConversationMemories(
      job.user_id as string,
      job.conversation_id as string,
      (job.project_id as string | null) ?? null,
      supabase,
    );

    await supabase
      .from("memory_jobs")
      .update({ status: "completed", updated_at: new Date().toISOString() })
      .eq("id", jobId);
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    const newRetries = (job.retries as number) + 1;
    const maxRetries = job.max_retries as number;

    if (newRetries >= maxRetries) {
      await supabase
        .from("memory_jobs")
        .update({
          status: "failed",
          retries: newRetries,
          error: errorMsg,
          updated_at: new Date().toISOString(),
        })
        .eq("id", jobId);
      console.error("[memory-jobs] job permanently failed", { jobId, errorMsg });
    } else {
      // Exponential backoff: 2^retries minutes (2, 4, 8 min)
      const backoffMs = Math.pow(2, newRetries) * 60 * 1000;
      await supabase
        .from("memory_jobs")
        .update({
          status: "pending",
          retries: newRetries,
          error: errorMsg,
          scheduled_at: new Date(Date.now() + backoffMs).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", jobId);
    }
  }
}

// Process a batch of pending, due jobs. Safe to call on every request's runAfterResponse —
// the atomic claim prevents double processing across concurrent Workers instances.
export async function processPendingMemoryJobs(
  supabase: SupabaseClient,
  limit = 5,
): Promise<void> {
  const { data: jobs } = await supabase
    .from("memory_jobs")
    .select("id")
    .eq("status", "pending")
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(limit);

  if (!jobs?.length) return;

  await Promise.allSettled(jobs.map((j) => processMemoryJob(j.id as string, supabase)));
}
