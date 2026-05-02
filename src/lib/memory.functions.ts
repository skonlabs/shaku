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

export const getMemoriesByIds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ ids: z.array(z.string().uuid()).max(50) }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    if (data.ids.length === 0) return { memories: [] };
    const { data: rows, error } = await supabase
      .from("memories")
      .select("id, content, type, confidence")
      .eq("user_id", userId)
      .in("id", data.ids);
    if (error) return { memories: [] };
    return {
      memories: (rows ?? []).map((r) => ({
        id: r.id as string,
        content: (r.content as string) ?? "",
        type: (r.type as string) ?? "fact",
        confidence: (r.confidence as number) ?? 0,
      })),
    };
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
    const [ukm, userRow, recentMessages] = await Promise.all([
      loadUkm(userId, supabase),
      supabase.from("users").select("memory_enabled").eq("id", userId).maybeSingle(),
      supabase
        .from("messages")
        .select("content, created_at, conversations!inner(user_id)")
        .eq("role", "user")
        .eq("is_active", true)
        .eq("conversations.user_id", userId)
        .order("created_at", { ascending: false })
        .limit(5),
    ]);
    const recentSignals = ((recentMessages.data ?? []) as Array<{ content: string; created_at: string }>).map(
      (message) => ({
        content: message.content.length > 160 ? `${message.content.slice(0, 157)}…` : message.content,
        createdAt: message.created_at,
      }),
    );
    return { ukm, memoryEnabled: (userRow.data?.memory_enabled ?? true) as boolean, recentSignals };
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
    const { data, error } = await supabase
      .from("user_memory_preferences")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    const fallback = await getFallbackMemoryPreferences(supabase, userId);
    if (error) {
      console.error("[memory.preferences] read failed, using fallback", error);
    }
    return {
      memoryEnabled: (data?.memory_enabled ?? fallback.memoryEnabled) as boolean,
      autoExtract: (data?.auto_extract ?? fallback.autoExtract) as boolean,
      minConfidenceThreshold: (data?.min_confidence_threshold ?? fallback.minConfidenceThreshold) as number,
      maxMemoriesPerCall: (data?.max_memories_per_call ?? fallback.maxMemoriesPerCall) as number,
      maxChunksPerCall: (data?.max_chunks_per_call ?? fallback.maxChunksPerCall) as number,
      storeConversationSummaries: (data?.store_conversation_summaries ?? fallback.storeConversationSummaries) as boolean,
      excludedTypes: (data?.excluded_types ?? fallback.excludedTypes) as string[],
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
    const updatedAt = new Date().toISOString();
    const { error } = await supabase
      .from("user_memory_preferences")
      .upsert({ user_id: userId, ...data, updated_at: updatedAt }, { onConflict: "user_id" });
    if (error) {
      console.error("[memory.preferences] primary save failed, saving fallback", error);
      await saveFallbackMemoryPreferences(supabase, userId, data, updatedAt);
    }
    return { success: true };
  });

type MemoryPreferencePatch = {
  min_confidence_threshold?: number;
  max_memories_per_call?: number;
  auto_extract?: boolean;
  store_conversation_summaries?: boolean;
};

type SupabaseLike = {
  from: (table: string) => any;
};

const DEFAULT_MEMORY_PREFERENCES = {
  memoryEnabled: true,
  autoExtract: true,
  minConfidenceThreshold: 0.6,
  maxMemoriesPerCall: 10,
  maxChunksPerCall: 8,
  storeConversationSummaries: true,
  excludedTypes: [] as string[],
};

async function getFallbackMemoryPreferences(supabase: SupabaseLike, userId: string) {
  const { data } = await supabase.from("users").select("pii_preferences").eq("id", userId).maybeSingle();
  const prefs = (data?.pii_preferences as { memoryPreferences?: Partial<typeof DEFAULT_MEMORY_PREFERENCES> } | null)
    ?.memoryPreferences;
  return { ...DEFAULT_MEMORY_PREFERENCES, ...(prefs ?? {}) };
}

async function saveFallbackMemoryPreferences(
  supabase: SupabaseLike,
  userId: string,
  patch: MemoryPreferencePatch,
  updatedAt: string,
) {
  const current = await getFallbackMemoryPreferences(supabase, userId);
  const next = {
    ...current,
    ...(patch.auto_extract === undefined ? {} : { autoExtract: patch.auto_extract }),
    ...(patch.min_confidence_threshold === undefined
      ? {}
      : { minConfidenceThreshold: patch.min_confidence_threshold }),
    ...(patch.max_memories_per_call === undefined ? {} : { maxMemoriesPerCall: patch.max_memories_per_call }),
    ...(patch.store_conversation_summaries === undefined
      ? {}
      : { storeConversationSummaries: patch.store_conversation_summaries }),
  };
  const { data: userRow } = await supabase.from("users").select("pii_preferences").eq("id", userId).maybeSingle();
  const piiPreferences = (userRow?.pii_preferences ?? {}) as Record<string, unknown>;
  const { error } = await supabase
    .from("users")
    .update({ pii_preferences: { ...piiPreferences, memoryPreferences: next }, updated_at: updatedAt })
    .eq("id", userId);
  if (error) throw new Error("Couldn't save preferences.");
}
