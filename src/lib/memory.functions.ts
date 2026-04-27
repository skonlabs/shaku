import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { embed } from "@/lib/embeddings";
import { listMemories } from "@/lib/memory/retrieval";
import { loadUkm } from "@/lib/knowledge/ukm";

export const getMemories = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      type: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const memories = await listMemories(userId, supabase, {
      type: data.type,
      limit: data.limit ?? 50,
      offset: data.offset ?? 0,
    });
    return { memories, error: null };
  });

export const updateMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      id: z.string().uuid(),
      content: z.string().min(1).max(1000),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;

    let embedding: number[] | undefined;
    try {
      embedding = await embed(data.content);
    } catch {
      // Proceed without updated embedding
    }

    const update: Record<string, unknown> = { content: data.content };
    if (embedding) update.embedding = `[${embedding.join(",")}]`;

    const { error } = await supabase
      .from("memories")
      .update(update)
      .eq("id", data.id)
      .eq("user_id", userId);

    if (error) throw new Error("Couldn't update memory.");
    return { success: true };
  });

export const deleteMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("memories")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error("Couldn't delete memory.");
    return { success: true };
  });

export const toggleMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ enabled: z.boolean() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("users")
      .update({ memory_enabled: data.enabled })
      .eq("id", userId);
    if (error) throw new Error("Couldn't update memory preference.");
    return { success: true };
  });

export const getUkm = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({}))
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [ukm, userRow] = await Promise.all([
      loadUkm(userId, supabase),
      supabase.from("users").select("memory_enabled").eq("id", userId).maybeSingle(),
    ]);
    return { ukm, memoryEnabled: (userRow.data?.memory_enabled ?? true) as boolean };
  });

export const getMemoryStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({}))
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    // RLS on messages (via conversations.user_id = auth.uid()) scopes these to the current user
    const [{ count: totalResponses }, { data: withMemory }] = await Promise.all([
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("role", "assistant")
        .eq("is_active", true),
      supabase
        .from("messages")
        .select("metadata")
        .eq("role", "assistant")
        .eq("is_active", true)
        .not("metadata->memories_used", "is", null),
    ]);

    const responsesWithMemory = withMemory?.length ?? 0;
    const totalMemoriesInjected = (withMemory ?? []).reduce((sum, m) => {
      const mu = (m.metadata as Record<string, unknown>)?.memories_used;
      return sum + (Array.isArray(mu) ? mu.length : 0);
    }, 0);

    return {
      totalResponses: totalResponses ?? 0,
      responsesWithMemory,
      totalMemoriesInjected,
      avgMemoriesPerResponse:
        responsesWithMemory > 0
          ? Math.round((totalMemoriesInjected / responsesWithMemory) * 10) / 10
          : 0,
    };
  });

export const createMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      type: z.enum([
        "preference",
        "semantic",
        "episodic",
        "behavioral",
        "anti_preference",
        "correction",
        "response_style",
        "project",
        "long_term",
        "short_term",
        "document",
      ]),
      content: z.string().min(1).max(1000),
      project_id: z.string().uuid().nullable().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;

    let embedding: number[] | undefined;
    try {
      embedding = await embed(data.content);
    } catch {
      // ok
    }

    const { data: row, error } = await supabase
      .from("memories")
      .insert({
        user_id: userId,
        type: data.type,
        content: data.content,
        project_id: data.project_id ?? null,
        confidence: 1.0,
        importance: 0.7,
        embedding: embedding ? `[${embedding.join(",")}]` : null,
      })
      .select("id")
      .single();

    if (error) throw new Error("Couldn't create memory.");
    return { id: row.id };
  });

export const pinMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid(), pinned: z.boolean() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("memories")
      .update({ pinned: data.pinned })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error("Couldn't update pin.");
    return { success: true };
  });

export const getMemoryPreferences = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({}))
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data } = await supabase
      .from("user_memory_preferences")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    return {
      memoryEnabled: (data?.memory_enabled ?? true) as boolean,
      autoExtract: (data?.auto_extract ?? true) as boolean,
      minConfidenceThreshold: (data?.min_confidence_threshold ?? 0.6) as number,
      maxMemoriesPerCall: (data?.max_memories_per_call ?? 10) as number,
      maxChunksPerCall: (data?.max_chunks_per_call ?? 8) as number,
      storeConversationSummaries: (data?.store_conversation_summaries ?? true) as boolean,
      excludedTypes: (data?.excluded_types ?? []) as string[],
    };
  });

export const updateMemoryPreferences = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      min_confidence_threshold: z.number().min(0).max(1).optional(),
      max_memories_per_call: z.number().int().min(1).max(50).optional(),
      auto_extract: z.boolean().optional(),
      store_conversation_summaries: z.boolean().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("user_memory_preferences")
      .upsert({ user_id: userId, ...data, updated_at: new Date().toISOString() });
    if (error) throw new Error("Couldn't save preferences.");
    return { success: true };
  });
