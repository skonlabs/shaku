import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const SUPABASE_URL = process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string);
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string);

const FREE_MSGS_PER_HOUR = 20;
const ACK_RESPONSES = [
  "You're welcome! Let me know if you need anything else.",
  "Anytime! Happy to help.",
  "Glad I could help. What's next?",
  "Of course — just say the word if you need more.",
  "Sounds good! I'm here if anything else comes up.",
  "Happy to help. Let me know if you'd like to dig deeper.",
];

function isAcknowledgment(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!.?,]+$/g, "");
  if (t.length > 25) return false;
  const patterns = [
    "thanks",
    "thank you",
    "ty",
    "thx",
    "ok",
    "okay",
    "got it",
    "perfect",
    "great",
    "cool",
    "nice",
    "awesome",
    "sounds good",
    "👍",
    "👌",
    "ok thanks",
    "thanks!",
    "got it thanks",
    "appreciate it",
  ];
  return patterns.some((p) => t === p || t === p + "!" || t === p + ".");
}

const BodySchema = z.object({
  conversation_id: z.string().uuid(),
  user_message: z.string().min(1).max(50000).optional(),
  // Regenerate path: re-stream a new assistant reply for the most recent user message
  regenerate: z.boolean().optional(),
  // Optional attachment metadata to store on the user message
  attachments: z
    .array(
      z.object({
        name: z.string().max(255),
        url: z.string().url(),
        size: z.number().nonnegative(),
        type: z.string().max(120),
      }),
    )
    .max(10)
    .optional(),
});

const SYSTEM_PROMPT = `You are Cortex, a helpful, warm, and precise personal AI assistant.

Style:
- Conversational and natural. Skip hedging and disclaimers.
- Use Markdown when it helps (lists, code blocks, tables). Use plain prose for short answers.
- Be concise; expand when asked.
- If you're uncertain, say what you'd need to verify, then offer your best informed take. Never refuse with "I don't know."
- Never reveal which model powers you or expose technical details. You are simply Cortex.

After substantive responses (more than ~3 sentences), suggest 2–3 natural follow-up questions the user is likely to want next. Append them at the very end of your reply on its own line, exactly in this format and nowhere else:
<followups>["question 1", "question 2"]</followups>
The JSON array must be valid. Omit the tag entirely for short / acknowledging replies.`;

const TITLE_PROMPT = `Generate a concise 3-6 word title for this conversation. Return ONLY the title text, no quotes, no punctuation at the end.`;

export const Route = createFileRoute("/api/chat/stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // ---- Auth ----
        const authHeader =
          request.headers.get("authorization") ?? request.headers.get("Authorization");
        if (!authHeader?.toLowerCase().startsWith("bearer ")) {
          return jsonError("Unauthorized", 401);
        }
        const token = authHeader.slice(7).trim();

        const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const { data: userData, error: userErr } = await supabase.auth.getUser(token);
        if (userErr || !userData.user) return jsonError("Unauthorized", 401);
        const userId = userData.user.id;

        // ---- Validate body ----
        let body: z.infer<typeof BodySchema>;
        try {
          body = BodySchema.parse(await request.json());
        } catch {
          return jsonError("Invalid request", 400);
        }
        if (!body.regenerate && !body.user_message) {
          return jsonError("Missing message", 400);
        }

        // ---- Verify conversation ownership ----
        const { data: convo } = await supabase
          .from("conversations")
          .select("id, title, user_id")
          .eq("id", body.conversation_id)
          .eq("user_id", userId)
          .maybeSingle();
        if (!convo) return jsonError("Conversation not found", 404);

        // ---- Rate limit (free: 20 msg/hr) ----
        if (!body.regenerate) {
          const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
          const { count } = await supabase
            .from("messages")
            .select("id, conversations!inner(user_id)", { count: "exact", head: true })
            .eq("role", "user")
            .eq("conversations.user_id", userId)
            .gte("created_at", oneHourAgo);
          if ((count ?? 0) >= FREE_MSGS_PER_HOUR) {
            const { data: oldest } = await supabase
              .from("messages")
              .select("created_at, conversations!inner(user_id)")
              .eq("role", "user")
              .eq("conversations.user_id", userId)
              .gte("created_at", oneHourAgo)
              .order("created_at", { ascending: true })
              .limit(1);
            const resetAt = oldest?.[0]?.created_at
              ? new Date(new Date(oldest[0].created_at).getTime() + 60 * 60 * 1000).toISOString()
              : new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return new Response(
              JSON.stringify({
                error: "rate_limited",
                message: `You've used all ${FREE_MSGS_PER_HOUR} messages this hour.`,
                reset_at: resetAt,
              }),
              { status: 429, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        // ---- Persist user message OR identify the last user message for regenerate ----
        let userMsg: { id: string; created_at: string } | null = null;
        if (!body.regenerate) {
          const insert = await supabase
            .from("messages")
            .insert({
              conversation_id: convo.id,
              role: "user",
              content: body.user_message!,
              metadata: body.attachments?.length ? { attachments: body.attachments } : {},
            })
            .select("id, created_at")
            .single();
          if (insert.error || !insert.data) {
            console.error("[chat.stream] insert user message", insert.error);
            return jsonError("I ran into a problem saving that.", 500);
          }
          userMsg = insert.data;
        }

        // ---- Acknowledgment fast path ----
        if (!body.regenerate && body.user_message && isAcknowledgment(body.user_message)) {
          const reply = ACK_RESPONSES[Math.floor(Math.random() * ACK_RESPONSES.length)];
          const asst = await supabase
            .from("messages")
            .insert({
              conversation_id: convo.id,
              role: "assistant",
              content: reply,
              metadata: { ack: true },
            })
            .select("id, created_at")
            .single();
          await supabase
            .from("conversations")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", convo.id);
          return sse(async (send) => {
            send("user_message", userMsg);
            // Stream the canned reply word-by-word for nice UX
            for (const word of reply.split(" ")) {
              send("delta", { text: word + " " });
              await new Promise((r) => setTimeout(r, 18));
            }
            send("done", {
              assistant_message_id: asst.data?.id,
              created_at: asst.data?.created_at,
              followups: [],
            });
          });
        }

        // ---- Load history ----
        const { data: historyAll } = await supabase
          .from("messages")
          .select("id, role, content, created_at")
          .eq("conversation_id", convo.id)
          .eq("is_active", true)
          .order("created_at", { ascending: true })
          .limit(40);

        let history = historyAll ?? [];

        // For regenerate: drop trailing assistant messages so we re-prompt from the user turn
        if (body.regenerate) {
          while (history.length > 0 && history[history.length - 1].role === "assistant") {
            const last = history[history.length - 1];
            // Soft-delete the prior assistant reply (preserve as version)
            await supabase
              .from("messages")
              .update({ is_active: false })
              .eq("id", last.id);
            history.pop();
          }
          if (history.length === 0 || history[history.length - 1].role !== "user") {
            return jsonError("Nothing to regenerate.", 400);
          }
        }

        const claudeMessages = history
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

        // ---- Stream from Anthropic ----
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return jsonError("Cortex isn't configured yet.", 500);
        const anthropic = new Anthropic({ apiKey });

        return sse(async (send) => {
          if (userMsg) send("user_message", userMsg);

          let assistantText = "";
          try {
            const claudeStream = anthropic.messages.stream({
              model: "claude-sonnet-4-5",
              max_tokens: 4096,
              system: SYSTEM_PROMPT,
              messages: claudeMessages,
            });

            for await (const event of claudeStream) {
              if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                assistantText += event.delta.text;
                // Strip the followup tag from streamed deltas so user doesn't see it
                const visible = stripFollowupsTagPartial(event.delta.text, assistantText);
                if (visible) send("delta", { text: visible });
              }
            }

            // Parse out followups + visible content
            const { visible, followups } = splitFollowups(assistantText);

            // Persist assistant message (active)
            const asst = await supabase
              .from("messages")
              .insert({
                conversation_id: convo.id,
                role: "assistant",
                content: visible,
                metadata: followups.length ? { follow_ups: followups } : {},
              })
              .select("id, created_at")
              .single();

            // Auto-title via Haiku for the first exchange (async — doesn't block)
            if (!convo.title && claudeMessages.length >= 1) {
              void (async () => {
                try {
                  const titleRes = await anthropic.messages.create({
                    model: "claude-haiku-4-5",
                    max_tokens: 32,
                    system: TITLE_PROMPT,
                    messages: [
                      {
                        role: "user",
                        content: `User: ${claudeMessages[0]?.content ?? ""}\n\nAssistant: ${visible.slice(0, 400)}`,
                      },
                    ],
                  });
                  const block = titleRes.content[0];
                  const text =
                    block && block.type === "text" ? block.text.trim().slice(0, 80) : null;
                  if (text) {
                    await supabase
                      .from("conversations")
                      .update({ title: text })
                      .eq("id", convo.id);
                  }
                } catch (e) {
                  console.error("[chat.stream] title gen", e);
                }
              })();
            }

            await supabase
              .from("conversations")
              .update({ updated_at: new Date().toISOString() })
              .eq("id", convo.id);

            send("done", {
              assistant_message_id: asst.data?.id,
              created_at: asst.data?.created_at,
              followups,
            });
          } catch (err) {
            console.error("[chat.stream] error", err);
            send("error", { message: "I ran into a problem. Please try again." });
          }
        });
      },
    },
  },
});

// ---------- helpers ----------

function jsonError(error: string, status: number) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sse(start: (send: (event: string, data: unknown) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      try {
        await start(send);
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** Remove an in-progress <followups>...</followups> tag from streamed text.
 * If the accumulated text contains "<followups>", suppress further deltas
 * by returning empty until the closing tag arrives.
 */
function stripFollowupsTagPartial(_delta: string, accumulated: string): string {
  const tagStart = accumulated.indexOf("<followups>");
  if (tagStart === -1) return _delta;
  // We've started the tag — figure out what visible portion of THIS delta belongs before it
  const newlyFromDelta = _delta;
  const visibleBeforeTag = accumulated.slice(0, tagStart);
  // If the visible-before-tag length >= (accumulated.length - delta.length) we already streamed it
  const alreadyStreamed = accumulated.length - newlyFromDelta.length;
  if (alreadyStreamed >= visibleBeforeTag.length) return "";
  return visibleBeforeTag.slice(alreadyStreamed);
}

function splitFollowups(text: string): { visible: string; followups: string[] } {
  const m = text.match(/<followups>([\s\S]*?)<\/followups>/);
  if (!m) return { visible: text.trim(), followups: [] };
  const visible = (text.slice(0, m.index!) + text.slice(m.index! + m[0].length)).trim();
  let followups: string[] = [];
  try {
    const parsed = JSON.parse(m[1].trim());
    if (Array.isArray(parsed)) {
      followups = parsed
        .filter((q) => typeof q === "string" && q.trim().length > 0)
        .map((q) => q.trim().slice(0, 200))
        .slice(0, 3);
    }
  } catch {
    /* ignore */
  }
  return { visible, followups };
}
