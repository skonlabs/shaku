import { createFileRoute, notFound } from "@tanstack/react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChatComposer, type Attachment } from "@/components/ChatComposer";
import { MessageList, type DisplayMessage } from "@/components/MessageList";
import { getConversation } from "@/lib/conversations.functions";
import { streamChat } from "@/lib/streamChat";
import { showUpgradeToast } from "@/lib/upgrade-toast";
import { RateLimitBanner } from "@/components/RateLimitBanner";
import { ActiveTaskBanner } from "@/components/ActiveTaskBanner";
import { ChatHistoryRail } from "@/components/ChatHistoryRail";
import { SpaceNudge } from "@/components/SpaceNudge";
import { ChatContextHeader } from "@/components/ChatContextHeader";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/c/$id")({
  component: ChatPage,
  errorComponent: ({ error }) => (
    <div className="flex h-full items-center justify-center p-6">
      <p className="text-sm text-muted-foreground">{error.message}</p>
    </div>
  ),
});

function ChatPage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const { user, loading: authLoading } = useAuth();

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["conversation", id],
    queryFn: () => getConversation({ data: { id } }),
    enabled: !authLoading && !!user,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const [streamingMessages, setStreamingMessages] = useState<DisplayMessage[]>([]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [rateLimitedUntil, setRateLimitedUntil] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendInFlightRef = useRef(false);

  // Reset transient streaming state when switching conversations so prior
  // chat's in-flight bubbles don't leak into the new one and cause flicker.
  const lastIdRef = useRef(id);
  if (lastIdRef.current !== id) {
    lastIdRef.current = id;
    if (streamingMessages.length) setStreamingMessages([]);
    if (streamingId) setStreamingId(null);
    abortRef.current?.abort();
    abortRef.current = null;
    sendInFlightRef.current = false;
  }

  const serverMessages: DisplayMessage[] = useMemo(
    () =>
      (data?.messages ?? []).map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
        is_edited: m.is_edited,
        metadata: m.metadata,
      })),
    [data?.messages],
  );
  const messages = useMemo(() => {
    const serverIds = new Set(serverMessages.map((m) => m.id));
    const visibleStreaming = streamingMessages.filter((m) => !serverIds.has(m.id));
    return [...serverMessages, ...visibleStreaming];
  }, [serverMessages, streamingMessages]);

  const send = async (text: string, attachments: Attachment[] = []) => {
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    const tempUserId = `temp-user-${Date.now()}`;
    const tempAsstId = `temp-asst-${Date.now()}`;
    setStreamingMessages([
      {
        id: tempUserId,
        role: "user",
        content: text,
        metadata: attachments.length ? { attachments } : undefined,
      },
      { id: tempAsstId, role: "assistant", content: "", pending: true },
    ]);
    setStreamingId(tempAsstId);

    const controller = await streamChat(
      { conversationId: id, userMessage: text, attachments },
      {
        onUserMessage: (realId) => {
          setStreamingMessages((cur) =>
            cur.map((m) => (m.id === tempUserId ? { ...m, id: realId } : m)),
          );
        },
        onDelta: (chunk) => {
          setStreamingMessages((cur) =>
            cur.map((m) =>
              m.id === tempAsstId ? { ...m, content: m.content + chunk, pending: false, progress: undefined } : m,
            ),
          );
        },
        onCitations: (sources) => {
          setStreamingMessages((cur) =>
            cur.map((m) =>
              m.id === tempAsstId
                ? { ...m, metadata: { ...(m.metadata ?? {}), web_citations: sources, web_grounded: true } }
                : m,
            ),
          );
        },
        onProgress: ({ stage, label }) => {
          setStreamingMessages((cur) =>
            cur.map((m) =>
              m.id === tempAsstId
                ? { ...m, progress: stage === "complete" ? undefined : label }
                : m,
            ),
          );
        },
        onDone: async ({ assistantMessageId }) => {
          sendInFlightRef.current = false;
          setStreamingId(null);
          // Refetch first, THEN clear streaming buffer to avoid flicker.
          await qc.refetchQueries({ queryKey: ["conversation", id] });
          if (assistantMessageId) {
            setStreamingMessages([]);
          } else {
            setStreamingMessages((cur) =>
              cur.map((m) => (m.id === tempAsstId ? { ...m, pending: false } : m)),
            );
          }
          qc.invalidateQueries({ queryKey: ["conversations"] });
        },
        onInterrupted: () => {
          sendInFlightRef.current = false;
          setStreamingId(null);
          setStreamingMessages((cur) =>
            cur.map((m) => (m.id === tempAsstId ? { ...m, pending: false } : m)),
          );
        },
        onError: (msg) => {
          sendInFlightRef.current = false;
          setStreamingId(null);
          toast.error(msg);
          setStreamingMessages((cur) =>
            cur.map((m) => (m.id === tempAsstId ? { ...m, content: msg, pending: false } : m)),
          );
        },
        onRateLimit: (resetAt) => setRateLimitedUntil(resetAt),
        onUpgradeRequired: (info) => {
          sendInFlightRef.current = false;
          setStreamingId(null);
          showUpgradeToast(info);
          setStreamingMessages([]);
        },
      },
    );
    abortRef.current = controller;
  };

  const regenerate = async () => {
    const tempAsstId = `temp-asst-${Date.now()}`;
    // Hide the existing last assistant message optimistically by appending a fresh streaming row
    setStreamingMessages([{ id: tempAsstId, role: "assistant", content: "", pending: true }]);
    setStreamingId(tempAsstId);
    const controller = await streamChat(
      { conversationId: id, regenerate: true },
      {
        onUserMessage: () => {},
        onDelta: (chunk) => {
          setStreamingMessages((cur) =>
            cur.map((m) =>
              m.id === tempAsstId ? { ...m, content: m.content + chunk, pending: false, progress: undefined } : m,
            ),
          );
        },
        onCitations: (sources) => {
          setStreamingMessages((cur) =>
            cur.map((m) =>
              m.id === tempAsstId
                ? { ...m, metadata: { ...(m.metadata ?? {}), web_citations: sources, web_grounded: true } }
                : m,
            ),
          );
        },
        onProgress: ({ stage, label }) => {
          setStreamingMessages((cur) =>
            cur.map((m) =>
              m.id === tempAsstId
                ? { ...m, progress: stage === "complete" ? undefined : label }
                : m,
            ),
          );
        },
        onDone: async ({ assistantMessageId }) => {
          sendInFlightRef.current = false;
          setStreamingId(null);
          await qc.refetchQueries({ queryKey: ["conversation", id] });
          if (assistantMessageId) {
            setStreamingMessages([]);
          } else {
            setStreamingMessages((cur) =>
              cur.map((m) => (m.id === tempAsstId ? { ...m, pending: false } : m)),
            );
          }
        },
        onInterrupted: () => {
          sendInFlightRef.current = false;
          setStreamingId(null);
          setStreamingMessages((cur) =>
            cur.map((m) => (m.id === tempAsstId ? { ...m, pending: false } : m)),
          );
        },
        onError: (msg) => {
          sendInFlightRef.current = false;
          setStreamingId(null);
          toast.error(msg);
          setStreamingMessages([]);
        },
        onUpgradeRequired: (info) => {
          sendInFlightRef.current = false;
          setStreamingId(null);
          showUpgradeToast(info);
          setStreamingMessages([]);
        },
      },
    );
    abortRef.current = controller;
  };

  const sendEditedThenRestream = async (_id: string, _content: string) => {
    // The edit already trimmed subsequent messages server-side. Now regenerate.
    await qc.invalidateQueries({ queryKey: ["conversation", id] });
    await regenerate();
  };

  // Pending first-message handoff from "/" — accepts JSON {text, attachments} or legacy plain string.
  const pendingHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (isLoading) return;
    if (pendingHandledRef.current === id) return;
    try {
      const pending = sessionStorage.getItem(`cortex.pending.${id}`);
      if (pending) {
        sessionStorage.removeItem(`cortex.pending.${id}`);
        pendingHandledRef.current = id;
        let text = pending;
        let attachments: Attachment[] = [];
        try {
          const parsed = JSON.parse(pending);
          if (parsed && typeof parsed === "object" && "text" in parsed) {
            text = String(parsed.text ?? "");
            attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
          }
        } catch {
          /* legacy plain string */
        }
        if (text || attachments.length) void send(text || "(attachment)", attachments);
      }
    } catch {
      /* noop */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isLoading]);

  if (isLoading && !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (!data?.conversation) throw notFound();
  // While placeholder data is shown for a different conversation id, render
  // a soft fade rather than swapping in a stale chat.
  const showingStale = isFetching && data?.conversation?.id !== id;

  const isRateLimited =
    rateLimitedUntil !== null && new Date(rateLimitedUntil).getTime() > Date.now();

  return (
    <div className="flex h-full w-full">
      <ChatHistoryRail />
      <div
        className="flex h-full min-w-0 flex-1 flex-col transition-opacity duration-150"
        style={{ opacity: showingStale ? 0.6 : 1 }}
      >
      <ActiveTaskBanner conversationId={id} />
      <ChatContextHeader
        conversationId={id}
        projectId={(data.conversation as { project_id: string | null }).project_id ?? null}
        isEmpty={messages.length === 0}
      />
      <div className="px-4">
        <SpaceNudge />
      </div>
      <div className="flex-1 overflow-hidden">
        {messages.length === 0 ? (
          <div className="flex h-full animate-fade-in items-center justify-center px-4 text-center">
            <div className="flex max-w-md flex-col items-center gap-3 text-muted-foreground">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <span className="text-lg font-bold">C</span>
              </div>
              <p className="text-sm font-medium text-foreground">
                What's on your mind?
              </p>
              <p className="text-xs leading-relaxed">
                Type below to start. Share preferences naturally — Cortex will
                remember them for next time.
              </p>
            </div>
          </div>
        ) : (
          <MessageList
            conversationId={id}
            messages={messages}
            streamingId={streamingId}
            onRegenerate={regenerate}
            onEdit={sendEditedThenRestream}
            onFollowupClick={(t) => void send(t, [])}
          />
        )}
      </div>
      <RateLimitBanner />
      <ChatComposer
        conversationId={id}
        onSend={send}
        onStop={() => {
          // Preserve partial assistant text in the UI; just stop the network/stream.
          abortRef.current?.abort();
          sendInFlightRef.current = false;
          setStreamingId(null);
          setStreamingMessages((cur) => cur.map((m) => (m.pending ? { ...m, pending: false } : m)));
        }}
        isStreaming={streamingId !== null}
        draftKey={`cortex.draft.${id}`}
        autoFocus
        disabled={isRateLimited}
        disabledMessage={
          isRateLimited
            ? `You've reached your free message limit. Resets ${formatReset(rateLimitedUntil!)}.`
            : undefined
        }
      />
      </div>
    </div>
  );
}

function formatReset(iso: string) {
  const mins = Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  return `in ${mins} min`;
}
