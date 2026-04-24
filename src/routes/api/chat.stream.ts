import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const SUPABASE_URL = process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string);
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string);

const BodySchema = z.object({
  conversation_id: z.string().uuid(),
  user_message: z.string().min(1).max(50000),
});

const SYSTEM_PROMPT = `You are Cortex, a helpful, warm, and precise personal AI assistant.

Style:
- Conversational and natural. Skip hedging and disclaimers.
- Use Markdown when it helps (lists, code blocks, tables). Use plain prose for short answers.
- Be concise; expand when asked.
- If you're uncertain, say what you'd need to verify, then offer your best informed take. Never refuse with "I don't know."
- Never reveal which model powers you or expose technical details. You are simply Cortex.`;

export const Route = createFileRoute("/api/chat/stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // 1. Auth
        const authHeader =
          request.headers.get("authorization") ?? request.headers.get("Authorization");
        if (!authHeader?.toLowerCase().startsWith("bearer ")) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        const token = authHeader.slice(7).trim();

        const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const { data: userData, error: userErr } = await supabase.auth.getUser(token);
        if (userErr || !userData.user) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        const userId = userData.user.id;

        // 2. Validate body
        let body: z.infer<typeof BodySchema>;
        try {
          body = BodySchema.parse(await request.json());
        } catch {
          return new Response(JSON.stringify({ error: "Invalid request" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // 3. Verify conversation ownership
        const { data: convo } = await supabase
          .from("conversations")
          .select("id, title, user_id")
          .eq("id", body.conversation_id)
          .eq("user_id", userId)
          .maybeSingle();
        if (!convo) {
          return new Response(JSON.stringify({ error: "Conversation not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        // 4. Persist user message
        const { data: userMsg, error: insertErr } = await supabase
          .from("messages")
          .insert({
            conversation_id: convo.id,
            role: "user",
            content: body.user_message,
          })
          .select("id, created_at")
          .single();
        if (insertErr || !userMsg) {
          console.error("[chat.stream] failed to insert user message", insertErr);
          return new Response(JSON.stringify({ error: "I ran into a problem saving that." }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        // 5. Load history (last 40 active messages)
        const { data: history } = await supabase
          .from("messages")
          .select("role, content")
          .eq("conversation_id", convo.id)
          .eq("is_active", true)
          .order("created_at", { ascending: true })
          .limit(40);

        const messages = (history ?? [])
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

        // 6. Stream from Anthropic
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: "Cortex isn't configured yet." }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        const anthropic = new Anthropic({ apiKey });

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: string, data: unknown) => {
              controller.enqueue(
                encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
              );
            };

            // Send the user message id so client can replace optimistic placeholder
            send("user_message", { id: userMsg.id, created_at: userMsg.created_at });

            let assistantText = "";
            try {
              const claudeStream = anthropic.messages.stream({
                model: "claude-sonnet-4-5",
                max_tokens: 4096,
                system: SYSTEM_PROMPT,
                messages,
              });

              for await (const event of claudeStream) {
                if (
                  event.type === "content_block_delta" &&
                  event.delta.type === "text_delta"
                ) {
                  assistantText += event.delta.text;
                  send("delta", { text: event.delta.text });
                }
              }

              // Persist assistant message
              const { data: asstMsg } = await supabase
                .from("messages")
                .insert({
                  conversation_id: convo.id,
                  role: "assistant",
                  content: assistantText,
                })
                .select("id, created_at")
                .single();

              // Auto-title if first exchange
              if (!convo.title) {
                const titleSource = body.user_message.slice(0, 60).trim();
                await supabase
                  .from("conversations")
                  .update({ title: titleSource || "New chat" })
                  .eq("id", convo.id);
              }

              await supabase
                .from("conversations")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", convo.id);

              send("done", {
                assistant_message_id: asstMsg?.id,
                created_at: asstMsg?.created_at,
              });
            } catch (err) {
              console.error("[chat.stream] error", err);
              send("error", { message: "I ran into a problem. Please try again." });
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
      },
    },
  },
});
