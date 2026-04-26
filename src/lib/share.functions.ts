// TODO: wire share feature — frontend route missing
// Share response: generates a public shared_responses record.
// The share feature IS implemented in Phase 1 (Sprint 6).
// Public page lives at /share/[shareId] with no auth required.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const shareResponse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      message_id: z.string().uuid(), // assistant message to share
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;

    // Load the assistant message and its preceding user message
    const { data: assistantMsg } = await supabase
      .from("messages")
      .select("id, content, metadata, conversation_id, created_at, conversations!inner(user_id)")
      .eq("id", data.message_id)
      .eq("role", "assistant")
      .single();

    // @ts-expect-error joined relation
    if (!assistantMsg || assistantMsg.conversations.user_id !== userId) {
      throw new Error("Message not found");
    }

    // Find the user message that preceded this specific assistant message
    const { data: userMsg } = await supabase
      .from("messages")
      .select("content")
      .eq("conversation_id", assistantMsg.conversation_id)
      .eq("role", "user")
      .eq("is_active", true)
      .lt("created_at", assistantMsg.created_at)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    const citations = (assistantMsg.metadata as Record<string, unknown>)?.citations ?? [];

    const { data: shared, error } = await supabase
      .from("shared_responses")
      .insert({
        message_id: assistantMsg.id,
        user_id: userId,
        user_message_content: userMsg?.content ?? "",
        assistant_message_content: assistantMsg.content,
        citations,
      })
      .select("id")
      .single();

    if (error) throw new Error("Couldn't create share link.");
    return { share_id: shared.id };
  });

export const getSharedResponse = createServerFn({ method: "POST" })
  .inputValidator(z.object({ share_id: z.string().uuid() }))
  .handler(async ({ data }) => {
    // No auth required — this is a public endpoint
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(
      process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string),
      process.env.SUPABASE_PUBLISHABLE_KEY ?? (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string),
    );

    const { data: shared, error } = await supabase
      .from("shared_responses")
      .select("id, user_message_content, assistant_message_content, citations, created_at, view_count")
      .eq("id", data.share_id)
      .single();

    if (error || !shared) throw new Error("Shared response not found.");

    // Atomic view count increment (avoids read-modify-write race condition)
    void supabase.rpc("increment_shared_view_count", { share_id: data.share_id });

    return { response: shared };
  });
