import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, ThumbsUp, ThumbsDown, Pencil, X } from "lucide-react";
import { MessageContent } from "@/components/MessageContent";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { editMessage, setMessageFeedback } from "@/lib/conversations.functions";
import type { Message } from "@/integrations/supabase/client";

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  is_edited?: boolean;
  metadata?: Message["metadata"];
  pending?: boolean;
}

interface Props {
  conversationId: string;
  messages: DisplayMessage[];
  streamingId: string | null;
}

export function MessageList({ conversationId, messages, streamingId }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingId]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="space-y-6">
          {messages.map((m) => (
            <MessageRow
              key={m.id}
              conversationId={conversationId}
              message={m}
              isStreaming={streamingId === m.id}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function MessageRow({
  conversationId,
  message,
  isStreaming,
}: {
  conversationId: string;
  message: DisplayMessage;
  isStreaming: boolean;
}) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const isUser = message.role === "user";
  const feedback = message.metadata?.feedback;

  const editMut = useMutation({
    mutationFn: (content: string) => editMessage({ data: { id: message.id, content } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
      setEditing(false);
      toast.success("Message updated");
    },
    onError: () => toast.error("Couldn't save the edit."),
  });

  const fbMut = useMutation({
    mutationFn: (rating: "up" | "down") =>
      setMessageFeedback({ data: { id: message.id, rating } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };

  if (isUser) {
    return (
      <div className="group flex flex-col items-end gap-1.5">
        {editing ? (
          <div className="w-full max-w-2xl rounded-2xl border border-input bg-card p-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-[60px] w-full resize-none bg-transparent px-2 py-1 text-sm outline-none"
              autoFocus
            />
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => editMut.mutate(draft.trim())}
                disabled={!draft.trim() || editMut.isPending}
              >
                Save
              </Button>
            </div>
          </div>
        ) : (
          <div className="max-w-[85%] rounded-2xl bg-bubble px-4 py-2.5 text-sm text-bubble-foreground">
            <div className="whitespace-pre-wrap">{message.content}</div>
          </div>
        )}
        {!editing && (
          <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
            {message.is_edited && (
              <span className="mr-1 text-[10px] text-muted-foreground">edited</span>
            )}
            <IconBtn label="Edit" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn label="Copy" onClick={copy}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </IconBtn>
          </div>
        )}
      </div>
    );
  }

  // Assistant
  return (
    <div className="group flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
        C
      </div>
      <div className="flex-1 min-w-0">
        <div className={cn("text-sm", isStreaming && "streaming-caret")}>
          {message.content ? (
            <MessageContent content={message.content} />
          ) : (
            <div className="flex gap-1.5 py-2">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
            </div>
          )}
        </div>
        {!isStreaming && message.content && !message.pending && (
          <div className="mt-1 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
            <IconBtn label="Copy" onClick={copy}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </IconBtn>
            <IconBtn
              label="Good response"
              active={feedback?.rating === "up"}
              onClick={() => fbMut.mutate("up")}
            >
              <ThumbsUp className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn
              label="Bad response"
              active={feedback?.rating === "down"}
              onClick={() => fbMut.mutate("down")}
            >
              <ThumbsDown className="h-3.5 w-3.5" />
            </IconBtn>
          </div>
        )}
      </div>
    </div>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground",
        active && "text-primary",
      )}
    >
      {children}
    </button>
  );
}

// Suppress unused import warning
void X;
