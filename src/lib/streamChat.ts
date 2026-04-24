import { supabase } from "@/integrations/supabase/client";

export interface StreamCallbacks {
  onUserMessage: (id: string, createdAt: string) => void;
  onDelta: (text: string) => void;
  onDone: (assistantMessageId: string | undefined) => void;
  onError: (message: string) => void;
}

/**
 * Calls /api/chat/stream and parses Server-Sent Events.
 * Returns an AbortController so the caller can cancel.
 */
export async function streamChat(
  conversationId: string,
  userMessage: string,
  cb: StreamCallbacks,
): Promise<AbortController> {
  const controller = new AbortController();

  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) {
    cb.onError("Please sign in again.");
    return controller;
  }

  void (async () => {
    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ conversation_id: conversationId, user_message: userMessage }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "I ran into a problem." }));
        cb.onError(err.error ?? "I ran into a problem.");
        return;
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
            if (event === "user_message") cb.onUserMessage(parsed.id, parsed.created_at);
            else if (event === "delta") cb.onDelta(parsed.text);
            else if (event === "done") cb.onDone(parsed.assistant_message_id);
            else if (event === "error") cb.onError(parsed.message ?? "I ran into a problem.");
          } catch {
            /* skip malformed */
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        cb.onDone(undefined);
        return;
      }
      console.error("[streamChat]", err);
      cb.onError("I ran into a problem. Please try again.");
    }
  })();

  return controller;
}
