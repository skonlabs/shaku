import { supabase } from "@/integrations/supabase/client";

export interface StreamCallbacks {
  onUserMessage: (id: string, createdAt: string) => void;
  onDelta: (text: string) => void;
  onDone: (info: { assistantMessageId?: string; followups?: string[] }) => void;
  onError: (message: string) => void;
  onRateLimit?: (resetAt: string) => void;
}

export interface StreamRequest {
  conversationId: string;
  userMessage?: string;
  regenerate?: boolean;
  attachments?: Array<{ name: string; url: string; size: number; type: string }>;
}

/**
 * Calls /api/chat/stream with up to 3 retries (exponential backoff)
 * for transient network failures BEFORE any tokens are received.
 * Once the stream has started, we don't retry — the partial reply is preserved.
 */
export async function streamChat(req: StreamRequest, cb: StreamCallbacks): Promise<AbortController> {
  const controller = new AbortController();

  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) {
    cb.onError("Please sign in again.");
    return controller;
  }

  void (async () => {
    let receivedAnyToken = false;
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        const res = await fetch("/api/chat/stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            conversation_id: req.conversationId,
            user_message: req.userMessage,
            regenerate: req.regenerate,
            attachments: req.attachments,
          }),
          signal: controller.signal,
        });

        if (res.status === 429) {
          const data = await res.json().catch(() => ({}));
          if (data.reset_at) cb.onRateLimit?.(data.reset_at);
          cb.onError(data.message ?? "You've hit the message limit for this hour.");
          return;
        }

        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({ error: "I ran into a problem." }));
          throw new Error(err.error ?? "I ran into a problem.");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const lines = raw.split("\n");
            let event = "message";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (!data) continue;
            try {
              const parsed = JSON.parse(data);
              if (event === "user_message") {
                if (parsed) cb.onUserMessage(parsed.id, parsed.created_at);
              } else if (event === "delta") {
                receivedAnyToken = true;
                cb.onDelta(parsed.text);
              } else if (event === "done") {
                cb.onDone({
                  assistantMessageId: parsed.assistant_message_id,
                  followups: parsed.followups,
                });
                return;
              } else if (event === "error") {
                cb.onError(parsed.message ?? "I ran into a problem.");
                return;
              }
            } catch {
              /* skip malformed */
            }
          }
        }
        // Stream ended without an explicit "done" event
        cb.onDone({});
        return;
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // User pressed Stop — don't fire onDone (which would clear UI). Just exit.
          return;
        }
        // Don't retry once we've started receiving tokens
        if (receivedAnyToken || attempt >= 3) {
          console.error("[streamChat] giving up after", attempt, "attempts", err);
          cb.onError("I lost the connection. Please try again.");
          return;
        }
        const delay = 400 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  })();

  return controller;
}
