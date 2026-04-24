import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ChatComposer } from "@/components/ChatComposer";
import { MessageList, type DisplayMessage } from "@/components/MessageList";
import { getConversation } from "@/lib/conversations.functions";
import { streamChat } from "@/lib/streamChat";
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

  const { data, isLoading } = useQuery({
    queryKey: ["conversation", id],
    queryFn: () => getConversation({ data: { id } }),
  });

  // Local streaming state on top of server-cached messages
  const [streamingMessages, setStreamingMessages] = useState<DisplayMessage[]>([]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Merge server messages + local streaming additions
  const serverMessages: DisplayMessage[] = (data?.messages ?? []).map((m) => ({
    id: m.id,
    role: m.role as "user" | "assistant",
    content: m.content,
    is_edited: m.is_edited,
    metadata: m.metadata,
  }));
  const messages = [...serverMessages, ...streamingMessages];

  const send = async (text: string) => {
    const tempUserId = `temp-user-${Date.now()}`;
    const tempAsstId = `temp-asst-${Date.now()}`;
    setStreamingMessages([
      { id: tempUserId, role: "user", content: text },
      { id: tempAsstId, role: "assistant", content: "", pending: true },
    ]);
    setStreamingId(tempAsstId);

    const controller = await streamChat(id, text, {
      onUserMessage: (realId) => {
        setStreamingMessages((cur) =>
          cur.map((m) => (m.id === tempUserId ? { ...m, id: realId } : m)),
        );
      },
      onDelta: (chunk) => {
        setStreamingMessages((cur) =>
          cur.map((m) =>
            m.id === tempAsstId ? { ...m, content: m.content + chunk, pending: false } : m,
          ),
        );
      },
      onDone: () => {
        setStreamingId(null);
        setStreamingMessages([]);
        qc.invalidateQueries({ queryKey: ["conversation", id] });
        qc.invalidateQueries({ queryKey: ["conversations"] });
      },
      onError: (msg) => {
        setStreamingId(null);
        toast.error(msg);
        setStreamingMessages((cur) =>
          cur.map((m) =>
            m.id === tempAsstId
              ? { ...m, content: msg, pending: false }
              : m,
          ),
        );
      },
    });
    abortRef.current = controller;
  };

  // If we arrived here from a "new chat" submission, send the pending first message
  useEffect(() => {
    if (isLoading) return;
    try {
      const pending = sessionStorage.getItem(`cortex.pending.${id}`);
      if (pending) {
        sessionStorage.removeItem(`cortex.pending.${id}`);
        void send(pending);
      }
    } catch {
      /* noop */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isLoading]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!data?.conversation) {
    throw notFound();
  }

  return (
    <div className="flex h-full flex-col">
      {messages.length === 0 ? (
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex h-full max-w-3xl items-center justify-center px-4 text-center">
            <p className="text-muted-foreground">Start the conversation.</p>
          </div>
        </div>
      ) : (
        <MessageList conversationId={id} messages={messages} streamingId={streamingId} />
      )}
      <ChatComposer
        onSend={send}
        onStop={() => {
          abortRef.current?.abort();
          setStreamingId(null);
        }}
        isStreaming={streamingId !== null}
        draftKey={`cortex.draft.${id}`}
        autoFocus
      />
    </div>
  );
}
