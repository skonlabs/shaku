import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listConversations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("conversations")
      .select("id, title, status, pinned, project_id, updated_at, created_at")
      .eq("user_id", userId)
      .neq("status", "deleted")
      .order("pinned", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) {
      console.error("[listConversations]", error);
      return { conversations: [], error: "Couldn't load your chats." };
    }
    return { conversations: data ?? [], error: null };
  });

export const createConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      title: z.string().min(1).max(200).optional(),
      project_id: z.string().uuid().nullable().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("conversations")
      .insert({
        user_id: userId,
        title: data.title ?? null,
        project_id: data.project_id ?? null,
      })
      .select("*")
      .single();
    if (error) {
      console.error("[createConversation]", error);
      throw new Error("Couldn't create the chat.");
    }
    return { conversation: row };
  });

export const getConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: convo, error: cErr } = await supabase
      .from("conversations")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (cErr || !convo) {
      return { conversation: null, messages: [] as never[] };
    }
    const { data: messages } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", data.id)
      .eq("is_active", true)
      .order("created_at", { ascending: true });
    return { conversation: convo, messages: messages ?? [] };
  });

export const renameConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid(), title: z.string().min(1).max(200) }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("conversations")
      .update({ title: data.title })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error("Couldn't rename the chat.");
    return { success: true };
  });

export const togglePinConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid(), pinned: z.boolean() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("conversations")
      .update({ pinned: data.pinned })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error("Couldn't pin the chat.");
    return { success: true };
  });

export const deleteConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("conversations")
      .update({ status: "deleted" })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error("Couldn't delete the chat.");
    return { success: true };
  });

/**
 * Edit a user message: stamp original_content (first edit only),
 * mark is_edited, and DEACTIVATE all subsequent active messages
 * in the conversation so the chat re-streams from this point.
 */
export const editMessageAndTrim = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid(), content: z.string().min(1).max(50000) }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: msg } = await supabase
      .from("messages")
      .select(
        "id, conversation_id, content, original_content, created_at, conversations!inner(user_id)",
      )
      .eq("id", data.id)
      .single();
    // @ts-expect-error joined relation
    if (!msg || msg.conversations.user_id !== userId) throw new Error("Not allowed");

    const { error: updateErr } = await supabase
      .from("messages")
      .update({
        content: data.content,
        original_content: msg.original_content ?? msg.content,
        is_edited: true,
      })
      .eq("id", data.id);
    if (updateErr) throw new Error("Couldn't save the edit.");

    // Soft-delete subsequent messages
    const { error: trimErr } = await supabase
      .from("messages")
      .update({ is_active: false })
      .eq("conversation_id", msg.conversation_id)
      .gt("created_at", msg.created_at);
    if (trimErr) throw new Error("Couldn't trim follow-up messages.");

    return { success: true, conversation_id: msg.conversation_id, content: data.content };
  });

export const setMessageFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      id: z.string().uuid(),
      rating: z.enum(["up", "down"]),
      reasons: z.array(z.string().max(100)).max(10).optional(),
      note: z.string().max(2000).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: msg } = await supabase
      .from("messages")
      .select("id, metadata, conversations!inner(user_id)")
      .eq("id", data.id)
      .single();
    // @ts-expect-error joined relation
    if (!msg || msg.conversations.user_id !== userId) throw new Error("Not allowed");

    const metadata = {
      ...((msg.metadata as Record<string, unknown> | null) ?? {}),
      feedback: { rating: data.rating, reasons: data.reasons, note: data.note },
    };
    const { error } = await supabase.from("messages").update({ metadata }).eq("id", data.id);
    if (error) throw new Error("Couldn't save feedback.");
    return { success: true };
  });

export const getRateLimitStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("messages")
      .select("id, conversations!inner(user_id)", { count: "exact", head: true })
      .eq("role", "user")
      .eq("conversations.user_id", userId)
      .gte("created_at", oneHourAgo);

    let resetAt: string | null = null;
    if ((count ?? 0) > 0) {
      const { data: oldest } = await supabase
        .from("messages")
        .select("created_at, conversations!inner(user_id)")
        .eq("role", "user")
        .eq("conversations.user_id", userId)
        .gte("created_at", oneHourAgo)
        .order("created_at", { ascending: true })
        .limit(1);
      if (oldest?.[0]?.created_at) {
        resetAt = new Date(
          new Date(oldest[0].created_at).getTime() + 60 * 60 * 1000,
        ).toISOString();
      }
    }
    return { used: count ?? 0, limit: 20, reset_at: resetAt };
  });

export const completeOnboarding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ name: z.string().min(1).max(100).optional() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const update: Record<string, unknown> = { has_completed_onboarding: true };
    if (data.name) update.name = data.name;
    const { error } = await supabase.from("users").update(update).eq("id", userId);
    if (error) {
      console.error("[completeOnboarding]", error);
      throw new Error("Couldn't save your preferences.");
    }
    return { success: true };
  });

export const recordSeen = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await supabase
      .from("users")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", userId);
    return { success: true };
  });
