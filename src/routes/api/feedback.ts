import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  processNegativeFeedback,
  processPositiveFeedback,
  type FeedbackReason,
} from "@/lib/memory/behavioral-learning";

const SUPABASE_URL = process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string);
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string);

const BodySchema = z.object({
  message_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  feedback_type: z.enum(["thumbs_up", "thumbs_down"]),
  reason: z
    .enum(["inaccurate", "not_helpful", "too_long", "too_short", "wrong_format", "other"])
    .optional(),
  free_text: z.string().max(1000).nullable().optional(),
});

export const Route = createFileRoute("/api/feedback")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authHeader =
          request.headers.get("authorization") ?? request.headers.get("Authorization");
        if (!authHeader?.toLowerCase().startsWith("bearer ")) {
          return json({ error: "Unauthorized" }, 401);
        }
        const token = authHeader.slice(7).trim();

        const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const { data: userData, error: userErr } = await supabase.auth.getUser(token);
        if (userErr || !userData.user) return json({ error: "Unauthorized" }, 401);
        const userId = userData.user.id;

        let body: z.infer<typeof BodySchema>;
        try {
          body = BodySchema.parse(await request.json());
        } catch {
          return json({ error: "Invalid request" }, 400);
        }

        // Verify message belongs to user (RLS enforces this but be explicit)
        const { data: msg } = await supabase
          .from("messages")
          .select("id, role, content, conversation_id, conversations!inner(user_id)")
          .eq("id", body.message_id)
          .eq("conversations.user_id", userId)
          .eq("conversation_id", body.conversation_id)
          .maybeSingle();

        if (!msg) return json({ error: "Message not found" }, 404);
        if (msg.role !== "assistant") return json({ error: "Can only rate assistant messages" }, 400);

        const assistantContent = msg.content as string;

        // Load the preceding user message for context
        const { data: prevMsgs } = await supabase
          .from("messages")
          .select("role, content, created_at")
          .eq("conversation_id", body.conversation_id)
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(4);

        const userMessage =
          (prevMsgs ?? []).find((m) => m.role === "user")?.content ?? "";

        if (body.feedback_type === "thumbs_down") {
          void processNegativeFeedback(
            userId,
            body.conversation_id,
            body.message_id,
            userMessage,
            assistantContent,
            (body.reason ?? "not_helpful") as FeedbackReason,
            body.free_text ?? null,
            supabase,
          ).catch((e) => console.error("[feedback] processNegativeFeedback", e));
        } else {
          void processPositiveFeedback(
            userId,
            body.conversation_id,
            body.message_id,
            supabase,
          ).catch((e) => console.error("[feedback] processPositiveFeedback", e));
        }

        return json({ ok: true });
      },
    },
  },
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
