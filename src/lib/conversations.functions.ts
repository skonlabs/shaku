import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { checkRateLimit } from "@/lib/utils/rate-limit";
import { storeFeedbackMemory } from "@/lib/memory/behavioral-learning";

export const listConversations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("conversations")
      .select("id, title, status, pinned, project_id, updated_at, created_at, messages(count)")
      .eq("user_id", userId)
      .neq("status", "deleted")
      .order("pinned", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) {
      console.error("[listConversations]", error);
      return { conversations: [], error: "Couldn't load your chats." };
    }
    // Hide empty drafts (no title and no messages). These are pre-created on
    // /app to support file uploads and are harmless but clutter the history.
    const filtered = (data ?? []).filter((c) => {
      const msgCount = Array.isArray((c as { messages?: { count: number }[] }).messages)
        ? ((c as { messages?: { count: number }[] }).messages?.[0]?.count ?? 0)
        : 0;
      return !!c.title || msgCount > 0 || c.pinned;
    }).map(({ messages: _messages, ...rest }) => rest);
    return { conversations: filtered, error: null };
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

export const setConversationProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      id: z.string().uuid(),
      project_id: z.string().uuid().nullable(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("conversations")
      .update({ project_id: data.project_id })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error("Couldn't move this chat.");
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
    // @ts-expect-error — Supabase type inference doesn't resolve nested join types yet
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

    // Soft-delete subsequent messages. Use >= to catch same-millisecond inserts,
    // and exclude the just-edited message itself to avoid deactivating it.
    const { error: trimErr } = await supabase
      .from("messages")
      .update({ is_active: false })
      .eq("conversation_id", msg.conversation_id)
      .gte("created_at", msg.created_at)
      .neq("id", msg.id);
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
      .select("id, role, content, conversation_id, metadata, conversations!inner(user_id)")
      .eq("id", data.id)
      .single();
    // @ts-expect-error — Supabase type inference doesn't resolve nested join types yet
    if (!msg || msg.conversations.user_id !== userId) throw new Error("Not allowed");

    const metadata = {
      ...((msg.metadata as Record<string, unknown> | null) ?? {}),
      feedback: { rating: data.rating, reasons: data.reasons, note: data.note },
    };

    // Write to both messages.metadata (Sprint 1) and feedback_events table (Sprint 3)
    const [updateResult] = await Promise.all([
      supabase.from("messages").update({ metadata }).eq("id", data.id),
      supabase.from("feedback_events").insert({
        user_id: userId,
        message_id: data.id,
        conversation_id: msg.conversation_id,
        feedback_type: data.rating === "up" ? "thumbs_up" : "thumbs_down",
        reason: data.reasons?.join(", ") ?? null,
        free_text: data.note ?? null,
      }),
    ]);
    if (updateResult.error) throw new Error("Couldn't save feedback.");

    // Thumbs-down: immediately create an anti_preference memory so the behavioral
    // learning loop is closed. storeFeedbackMemory skips LLM analysis to keep
    // the feedback handler fast — deeper mismatch analysis runs via the memory job.
    if (data.rating === "down" && msg.role === "assistant") {
      storeFeedbackMemory(
        userId,
        msg.conversation_id,
        msg.content as string,
        data.reasons ?? [],
        data.note ?? null,
        supabase,
      ).catch((e) => console.error("[setMessageFeedback] storeFeedbackMemory failed", e));
    }

    return { success: true };
  });

export const getRateLimitStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: userRow } = await supabase.from("users").select("plan").eq("id", userId).single();
    const plan = userRow?.plan ?? "free";
    const rl = await checkRateLimit(userId, plan, supabase);
    const used = rl.limit - rl.remaining;
    return { used, limit: rl.limit, reset_at: rl.resetAt, plan };
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

/**
 * Update a single attachment's `extracted_text` (OCR transcript) on a message.
 * Used when the user edits the detected text inline in the chat UI.
 */
export const updateAttachmentOcr = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      message_id: z.string().uuid(),
      attachment_index: z.number().int().min(0).max(20),
      extracted_text: z.string().max(120_000),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: msg } = await supabase
      .from("messages")
      .select("id, metadata, conversations!inner(user_id)")
      .eq("id", data.message_id)
      .single();
    // @ts-expect-error — Supabase type inference doesn't resolve nested join types yet
    if (!msg || msg.conversations.user_id !== userId) throw new Error("Not allowed");

    const meta = (msg.metadata as Record<string, unknown> | null) ?? {};
    const attachments = Array.isArray(meta.attachments)
      ? ([...meta.attachments] as Array<Record<string, unknown>>)
      : [];
    if (!attachments[data.attachment_index]) throw new Error("Attachment not found.");
    attachments[data.attachment_index] = {
      ...attachments[data.attachment_index],
      extracted_text: data.extracted_text,
      extraction_error: null,
      ocr_edited: true,
    };
    const newMeta = { ...meta, attachments };
    const { error } = await supabase
      .from("messages")
      .update({ metadata: newMeta })
      .eq("id", data.message_id);
    if (error) throw new Error("Couldn't save the edit.");
    return { success: true };
  });

/**
 * Full-text search across the user's messages, including OCR transcripts and
 * other extracted attachment text. Returns matching conversations with a
 * snippet from the best-matching message.
 */
export const searchMessages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ query: z.string().min(1).max(200) }))
  .handler(async ({ context, data }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase.rpc("search_user_messages", {
      q: data.query,
      max_results: 30,
    });
    if (error) {
      console.error("[searchMessages]", error);
      return { results: [] as never[], error: "Search is unavailable right now." };
    }
    return { results: rows ?? [], error: null };
  });
