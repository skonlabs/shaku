import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getContextLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ conversation_id: z.string().uuid() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: rows, error } = await supabase.rpc("get_context_log", {
      p_conversation_id: data.conversation_id,
      p_limit: 1,
    });
    if (error || !rows || rows.length === 0) {
      const { data: msg } = await supabase
        .from("messages")
        .select("metadata, created_at, conversations!inner(user_id)")
        .eq("conversation_id", data.conversation_id)
        .eq("role", "assistant")
        .eq("is_active", true)
        .eq("conversations.user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const metadata = (msg?.metadata ?? {}) as Record<string, unknown>;
      if (!msg || (metadata.tokens_in == null && metadata.tokens_out == null)) return null;
      return {
        id: "message-metadata",
        provider: "chat",
        model: (metadata.model as string | undefined) ?? "chat",
        tokensIn: (metadata.tokens_in as number | null) ?? null,
        tokensOut: (metadata.tokens_out as number | null) ?? null,
        tokensSaved: (metadata.tokens_saved as number) ?? 0,
        savingsPct: (metadata.savings_pct as number) ?? 0,
        costUsd: null,
        latencyMs: null,
        retrievedMemoryIds: Array.isArray(metadata.memories_used)
          ? metadata.memories_used.map((m) => (typeof m === "object" && m ? String((m as Record<string, unknown>).id ?? "") : "")).filter(Boolean)
          : [],
        retrievedChunkIds: [],
        taskId: null,
        rankingScores: {},
        contextSections: {
          memories: Array.isArray(metadata.memories_used) ? metadata.memories_used.length : 0,
          source: "message metadata",
        },
        warnings: [],
        createdAt: msg.created_at as string,
      };
    }
    const r = rows[0] as Record<string, unknown>;
    const sections = (r.context_sections ?? {}) as Record<string, string | number | boolean>;
    const scores = (r.ranking_scores ?? {}) as Record<string, number>;
    return {
      id: r.id as string,
      provider: r.provider as string,
      model: r.model as string,
      tokensIn: r.tokens_in as number | null,
      tokensOut: r.tokens_out as number | null,
      tokensSaved: (r.tokens_saved as number) ?? 0,
      savingsPct: (r.savings_pct as number) ?? 0,
      costUsd: r.cost_usd as number | null,
      latencyMs: r.latency_ms as number | null,
      retrievedMemoryIds: (r.retrieved_memory_ids as string[]) ?? [],
      retrievedChunkIds: (r.retrieved_chunk_ids as string[]) ?? [],
      taskId: (r.task_id as string | null) ?? null,
      rankingScores: scores as Record<string, number>,
      contextSections: sections as Record<string, string | number | boolean>,
      warnings: (r.warnings as string[]) ?? [],
      createdAt: r.created_at as string,
    };
  });

export const getActiveTaskForConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ conversation_id: z.string().uuid() }))
  .handler(async ({ context, data }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase.rpc("get_active_task", {
      target_conversation_id: data.conversation_id,
    });
    if (error || !rows || rows.length === 0) return null;
    const t = rows[0] as Record<string, unknown>;
    const decisionsRaw = t.decisions;
    const decisions: string[] = Array.isArray(decisionsRaw)
      ? decisionsRaw.map((d) => (typeof d === "string" ? d : JSON.stringify(d)))
      : [];
    return {
      id: t.id as string,
      title: (t.title as string) ?? "",
      goal: (t.goal as string) ?? "",
      status: (t.status as string) ?? "active",
      currentStep: (t.current_step as string | null) ?? null,
      completedSteps: (t.completed_steps as string[]) ?? [],
      openQuestions: (t.open_questions as string[]) ?? [],
      decisions,
      nextActions: (t.next_actions as string[]) ?? [],
      updatedAt: t.updated_at as string,
    };
  });
