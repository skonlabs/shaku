import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Check,
  ThumbsUp,
  ThumbsDown,
  Pencil,
  RefreshCw,
  ArrowDown,
  FileText,
  Sparkles,
  PanelRightOpen,
  Brain,
  Share2,
} from "lucide-react";
import { usePanel } from "@/lib/ui-context";
import { MessageContent } from "@/components/MessageContent";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  editMessageAndTrim,
  setMessageFeedback,
  updateAttachmentOcr,
} from "@/lib/conversations.functions";
import { shareResponse } from "@/lib/share.functions";
import type { Message } from "@/integrations/supabase/client";
import { AttachmentList } from "@/components/AttachmentList";

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
  onRegenerate?: () => void;
  onEdit?: (id: string, newContent: string) => void;
  onFollowupClick?: (text: string) => void;
}

export function MessageList({
  conversationId,
  messages,
  streamingId,
  onRegenerate,
  onEdit,
  onFollowupClick,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showJumpPill, setShowJumpPill] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);

  // Track whether the user has scrolled up
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
    const atBottom = distance < 80;
    setAutoFollow(atBottom);
    setShowJumpPill(!atBottom && streamingId !== null);
  };

  // Auto-scroll if following
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !autoFollow) return;
    el.scrollTop = el.scrollHeight;
  });

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAutoFollow(true);
    setShowJumpPill(false);
  };

  // Find last assistant message to attach Regenerate
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  return (
    <div className="relative h-full">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto scroll-smooth">
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
          <div className="space-y-8">
            {messages.map((m) => (
              <div key={m.id} className="animate-fade-rise">
                <MessageRow
                  conversationId={conversationId}
                  message={m}
                  isStreaming={streamingId === m.id}
                  isLastAssistant={m.id === lastAssistantId}
                  onRegenerate={onRegenerate}
                  onEdit={onEdit}
                  onFollowupClick={onFollowupClick}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      {showJumpPill && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 animate-fade-in items-center gap-1.5 rounded-full border border-border bg-card/90 px-3.5 py-2 text-xs font-medium text-foreground shadow-md backdrop-blur transition-all duration-200 hover:bg-card hover:shadow-lg"
        >
          <ArrowDown className="h-3 w-3" />
          New message
        </button>
      )}
    </div>
  );
}

function MessageRow({
  conversationId,
  message,
  isStreaming,
  isLastAssistant,
  onRegenerate,
  onEdit,
  onFollowupClick,
}: {
  conversationId: string;
  message: DisplayMessage;
  isStreaming: boolean;
  isLastAssistant: boolean;
  onRegenerate?: () => void;
  onEdit?: (id: string, newContent: string) => void;
  onFollowupClick?: (text: string) => void;
}) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [showOriginal, setShowOriginal] = useState(false);
  const isUser = message.role === "user";
  const feedback = message.metadata?.feedback;
  const followups = message.metadata?.follow_ups ?? [];
  const attachments = message.metadata?.attachments ?? [];
  // Must be called before any conditional return (Rules of Hooks)
  const { openDocument } = usePanel();

  const editMut = useMutation({
    mutationFn: (content: string) => editMessageAndTrim({ data: { id: message.id, content } }),
    onSuccess: ({ content }) => {
      setEditing(false);
      onEdit?.(message.id, content);
    },
    onError: () => toast.error("Couldn't save the edit."),
  });

  const fbMut = useMutation({
    mutationFn: (input: { rating: "up" | "down"; reasons?: string[]; note?: string }) =>
      setMessageFeedback({ data: { id: message.id, ...input } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversation", conversationId] }),
    onError: () => toast.error("Couldn't save feedback."),
  });

  const shareMut = useMutation({
    mutationFn: () => shareResponse({ data: { message_id: message.id } }),
    onSuccess: ({ share_id }) => {
      const url = `${window.location.origin}/share/${share_id}`;
      navigator.clipboard.writeText(url).catch(() => {});
      toast.success("Share link copied to clipboard.");
    },
    onError: () => toast.error("Couldn't create share link."),
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(displayContent());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };

  const displayContent = () => {
    if (showOriginal && message.metadata?.versions?.[0]) {
      return message.metadata.versions[0].content;
    }
    return message.content;
  };

  if (isUser) {
    const isPlaceholder = message.content.trim() === "(attachment)" && attachments.length > 0;
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
                Save & re-send
              </Button>
            </div>
          </div>
        ) : (
          <div className="max-w-[85%] space-y-1.5">
            {!isPlaceholder && (
              <div className="rounded-2xl rounded-tr-md bg-bubble px-4 py-2.5 text-sm leading-relaxed text-bubble-foreground shadow-sm">
                <div className="whitespace-pre-wrap">{message.content}</div>
              </div>
            )}
            {attachments.length > 0 && (
              <AttachmentList
                conversationId={conversationId}
                messageId={message.id}
                attachments={attachments as never}
                align="end"
              />
            )}
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
  const hasPriorVersion = !!message.metadata?.versions?.[0];
  const fullContent = displayContent();
  const isDocument =
    !!fullContent &&
    (fullContent.length > 800 ||
      /```[\s\S]*?```/.test(fullContent) ||
      (fullContent.match(/\n#+\s/g)?.length ?? 0) >= 2);
  const docTitle = (() => {
    const h = fullContent.match(/^\s*#\s+(.+)/m)?.[1];
    if (h) return h.trim().slice(0, 80);
    const firstLine = fullContent.split("\n").find((l) => l.trim().length > 0) ?? "Document";
    return firstLine.replace(/^[#>*\-\s]+/, "").slice(0, 80) || "Document";
  })();

  return (
    <div className="group flex gap-3.5">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-[oklch(0.55_0.18_255)] text-primary-foreground shadow-[0_4px_10px_-4px_oklch(0.6_0.16_245/0.5)]">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className={cn("text-sm", isStreaming && "streaming-caret")}>
          {message.content ? (
            <MessageContent content={fullContent} />
          ) : (
            <div className="flex gap-1.5 py-2">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
            </div>
          )}
        </div>

        {!isStreaming && isDocument && (
          <button
            onClick={() =>
              openDocument({
                title: docTitle,
                content: fullContent,
                mime: "text/markdown",
              })
            }
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground transition hover:border-primary/40 hover:bg-accent"
          >
            <FileText className="h-3.5 w-3.5 text-primary" />
            <span className="max-w-[260px] truncate">{docTitle}</span>
            <span className="text-muted-foreground">
              · {Math.max(1, Math.round(fullContent.length / 1000))}k chars
            </span>
            <PanelRightOpen className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}

        {!isStreaming && attachments.length > 0 && (
          <div className="mt-3">
            <AttachmentList
              conversationId={conversationId}
              messageId={message.id}
              attachments={attachments as never}
              align="start"
            />
          </div>
        )}

        {/* Follow-up suggestion pills */}
        {!isStreaming && followups.length > 0 && onFollowupClick && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {followups.map((q, i) => (
              <button
                key={i}
                onClick={() => onFollowupClick(q)}
                className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-foreground transition hover:border-primary/40 hover:bg-accent"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {/* "Behind the answer" — per-message transparency affordance */}
        {!isStreaming && message.role === "assistant" && message.content && !message.pending && (
          <BehindAnswerChip metadata={message.metadata} />
        )}

        {!isStreaming && message.content && !message.pending && (
          <div className="mt-1 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
            <IconBtn label="Copy" onClick={copy}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </IconBtn>
            {isLastAssistant && onRegenerate && (
              <IconBtn label="Regenerate" onClick={onRegenerate}>
                <RefreshCw className="h-3.5 w-3.5" />
              </IconBtn>
            )}
            <IconBtn
              label="Good response"
              active={feedback?.rating === "up"}
              onClick={() => fbMut.mutate({ rating: "up" })}
            >
              <ThumbsUp className="h-3.5 w-3.5" />
            </IconBtn>
            <FeedbackDownButton
              active={feedback?.rating === "down"}
              onSubmit={(reasons, note) => fbMut.mutate({ rating: "down", reasons, note })}
            />
            <IconBtn label="Share" onClick={() => shareMut.mutate()}>
              {shareMut.isPending ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <Share2 className="h-3.5 w-3.5" />
              )}
            </IconBtn>
            {hasPriorVersion && (
              <button
                onClick={() => setShowOriginal((s) => !s)}
                className="ml-2 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
              >
                {showOriginal ? "Show new response" : "Previous response"}
              </button>
            )}
            {/* Token usage intentionally not shown here — see Settings → Usage. */}

          </div>
        )}
      </div>
    </div>
  );
}

function FeedbackDownButton({
  active,
  onSubmit,
}: {
  active?: boolean;
  onSubmit: (reasons: string[], note?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const options = ["Inaccurate", "Not helpful", "Too long", "Too short", "Wrong format", "Other"];

  const toggle = (r: string) =>
    setReasons((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label="Bad response"
          title="Bad response"
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground",
            active && "text-primary",
          )}
        >
          <ThumbsDown className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <p className="mb-2 text-sm font-medium">What went wrong?</p>
        <div className="space-y-2">
          {options.map((opt) => (
            <label key={opt} className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={reasons.includes(opt)} onCheckedChange={() => toggle(opt)} />
              <Label className="cursor-pointer font-normal">{opt}</Label>
            </label>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything else? (optional)"
          maxLength={2000}
          className="mt-3 w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs outline-none focus:border-ring"
          rows={2}
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onSubmit(reasons, note.trim() || undefined);
              setOpen(false);
              toast.success("Thanks for the feedback.");
            }}
            disabled={reasons.length === 0}
          >
            Submit
          </Button>
        </div>
      </PopoverContent>
    </Popover>
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

interface MemoryChipEntry {
  id: string;
  type: string;
  content: string;
}

const MEMORY_EMOJI: Record<string, string> = {
  preference: "💡",
  episodic: "📅",
  semantic: "🧠",
  behavioral: "🎯",
  anti_preference: "🚫",
  correction: "✏️",
  response_style: "✍️",
  project: "📁",
};

function MemoryUsedChip({ memories }: { memories: MemoryChipEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-primary/30 hover:text-foreground">
          <Brain className="h-3 w-3" />
          {memories.length} {memories.length === 1 ? "memory" : "memories"} used
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <p className="mb-2.5 text-xs font-medium">Memories that shaped this response</p>
        <div className="space-y-2">
          {memories.map((m) => (
            <div key={m.id} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 text-sm">{MEMORY_EMOJI[m.type] ?? "💡"}</span>
              <p className="text-xs leading-relaxed text-foreground/90">{m.content}</p>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function fmtTok(n: number | undefined): string {
  if (!n) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
