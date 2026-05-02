import { supabase } from "@/integrations/supabase/client";
import { logger } from "@/lib/logger";

export interface CitationSource {
  title: string;
  url: string;
}

export interface UpgradeRequiredInfo {
  /** out_of_credits | plan_required */
  reason: "out_of_credits" | "plan_required";
  /** What's blocked, in friendly copy. */
  message: string;
  /** What feature/model triggered the block, if any. */
  blocked?: "model" | "memory" | "documents" | "credits";
  currentPlan?: string;
  requiredPlan?: string;
  upgradeUrl: string;
}

export interface ProgressInfo {
  /** Lifecycle stage: started | processing | complete */
  stage: "started" | "processing" | "complete";
  /** Friendly user-facing message, e.g. "Reading your document end-to-end…" */
  label?: string;
  /** Which auto-continue pass we're on (1-indexed). */
  pass?: number;
  /** Approx total characters of buffered output so far. */
  chars?: number;
}

export interface StreamCallbacks {
  onUserMessage: (id: string, createdAt: string) => void;
  onDelta: (text: string) => void;
  onCitations?: (sources: CitationSource[]) => void;
  /**
   * Fires during long-running document processing. The server buffers the
   * model's output and emits friendly progress updates so the UI can show
   * "what's happening" without revealing partial answers.
   */
  onProgress?: (info: ProgressInfo) => void;
  onDone: (info: {
    assistantMessageId?: string;
    followups?: string[];
    memoriesUsed?: number;
    tokensIn?: number;
    tokensOut?: number;
    citations?: CitationSource[];
  }) => void;
  onInterrupted?: () => void;
  onError: (message: string) => void;
  onRateLimit?: (resetAt: string) => void;
  /** Called when the server returns 402 — show an upgrade prompt with a link to /billing. */
  onUpgradeRequired?: (info: UpgradeRequiredInfo) => void;
}

export interface StreamRequest {
  conversationId: string;
  userMessage?: string;
  regenerate?: boolean;
  attachments?: Array<{
    name: string;
    url: string | null;
    path?: string | null;
    size: number;
    type: string;
    kind?: string;
    extracted_text?: string | null;
    extraction_error?: string | null;
    storage_error?: string | null;
  }>;
}

/**
 * Calls /api/chat/stream with up to 3 retries (exponential backoff)
 * for transient network failures BEFORE any tokens are received.
 * Once the stream has started, we don't retry — the partial reply is preserved.
 */
export async function streamChat(
  req: StreamRequest,
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

        if (res.status === 402) {
          const data = await res.json().catch(() => ({}));
          const reason: "out_of_credits" | "plan_required" =
            data.error === "out_of_credits" ? "out_of_credits" : "plan_required";
          const blocked: UpgradeRequiredInfo["blocked"] =
            reason === "out_of_credits"
              ? "credits"
              : /memory/i.test(data.message ?? "")
                ? "memory"
                : /document/i.test(data.message ?? "")
                  ? "documents"
                  : "model";
          cb.onUpgradeRequired?.({
            reason,
            message:
              data.message ??
              "This needs the Basic plan. Upgrade to keep going with Ekonomical's full toolkit.",
            blocked,
            currentPlan: data.plan,
            requiredPlan: data.required_plan ?? "basic",
            upgradeUrl: data.upgrade_url ?? "/billing",
          });
          // Also surface a short error so the composer doesn't hang silently.
          cb.onError(data.message ?? "Upgrade required.");
          return;
        }

        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({ error: "I ran into a problem." }));
          throw new Error(err.error ?? "I ran into a problem.");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let sawDoneEvent = false;

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
              } else if (event === "citations") {
                if (Array.isArray(parsed.sources)) {
                  cb.onCitations?.(parsed.sources);
                }
              } else if (event === "progress") {
                // Progress events mean the server has committed to this turn —
                // long-document processing has begun and may be running for
                // minutes. Treat the stream as in-flight so a transient
                // disconnect surfaces as `onInterrupted` rather than triggering
                // a full retry that would discard the server's accumulated work.
                receivedAnyToken = true;
                cb.onProgress?.({
                  stage: parsed.stage,
                  label: parsed.label,
                  pass: parsed.pass,
                  chars: parsed.chars,
                });
              } else if (event === "done") {
                sawDoneEvent = true;
                cb.onDone({
                  assistantMessageId: parsed.assistant_message_id,
                  followups: parsed.followups,
                  memoriesUsed: parsed.memories_used,
                  tokensIn: parsed.tokens_in,
                  tokensOut: parsed.tokens_out,
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

        if (sawDoneEvent) return;
        if (receivedAnyToken) {
          cb.onInterrupted?.();
          return;
        }
        throw new Error("Stream ended before completion.");
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // User pressed Stop — don't fire onDone (which would clear UI). Just exit.
          return;
        }
        // Don't retry once we've started receiving tokens
        if (receivedAnyToken) {
          cb.onInterrupted?.();
          return;
        }
        if (attempt >= 3) {
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
