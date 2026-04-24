import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileText,
  Image as ImageIcon,
  ChevronDown,
  ChevronRight,
  Pencil,
  Check,
  X,
  PanelRightOpen,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { updateAttachmentOcr } from "@/lib/conversations.functions";
import { usePanel } from "@/lib/ui-context";

export interface AttachmentLike {
  name: string;
  url: string | null;
  path?: string | null;
  size: number;
  type: string;
  kind?: string;
  extracted_text?: string | null;
  extraction_error?: string | null;
  storage_error?: string | null;
  ocr_edited?: boolean;
}

interface Props {
  conversationId: string;
  messageId: string;
  attachments: AttachmentLike[];
  align?: "start" | "end";
}

export function AttachmentList({ conversationId, messageId, attachments, align = "end" }: Props) {
  if (attachments.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-1.5", align === "end" ? "items-end" : "items-start")}>
      {attachments.map((a, i) => (
        <AttachmentRow
          key={`${messageId}-${i}`}
          conversationId={conversationId}
          messageId={messageId}
          index={i}
          attachment={a}
        />
      ))}
    </div>
  );
}

function AttachmentRow({
  conversationId,
  messageId,
  index,
  attachment: a,
}: {
  conversationId: string;
  messageId: string;
  index: number;
  attachment: AttachmentLike;
}) {
  const qc = useQueryClient();
  const { openDocument } = usePanel();
  const isImage = a.kind === "image" || (a.type ?? "").startsWith("image/");
  const hasTranscript = typeof a.extracted_text === "string" && a.extracted_text.trim().length > 0;
  const isTempMessage = messageId.startsWith("temp-");
  // Previewable in side panel when we have either extracted text OR a fetchable URL (non-image).
  const canPreview = hasTranscript || (!!a.url && !isImage);

  const openInPanel = () =>
    openDocument({
      title: a.name,
      content: a.extracted_text ?? "",
      mime: a.type || "text/plain",
      url: a.url,
    });

  // Default: expand image transcripts when present (so users immediately see/review).
  const [open, setOpen] = useState<boolean>(isImage && hasTranscript);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.extracted_text ?? "");

  const mut = useMutation({
    mutationFn: (text: string) =>
      updateAttachmentOcr({
        data: { message_id: messageId, attachment_index: index, extracted_text: text },
      }),
    onSuccess: () => {
      setEditing(false);
      toast.success("Transcript updated.");
      qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
    onError: () => toast.error("Couldn't save the transcript."),
  });

  return (
    <div className="w-full max-w-[420px] overflow-hidden rounded-lg border border-border bg-card">
      {/* Header row: file name + size + open/expand */}
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
        {isImage ? (
          <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        {canPreview && !isImage ? (
          <button
            onClick={openInPanel}
            className="max-w-[180px] truncate text-left font-medium text-foreground hover:underline"
            title="Open preview"
          >
            {a.name}
          </button>
        ) : a.url ? (
          <a
            href={a.url}
            target="_blank"
            rel="noreferrer"
            className="max-w-[180px] truncate font-medium text-foreground hover:underline"
          >
            {a.name}
          </a>
        ) : (
          <span className="max-w-[180px] truncate font-medium text-foreground">{a.name}</span>
        )}
        <span className="text-muted-foreground">{formatBytes(a.size)}</span>
        {a.ocr_edited && (
          <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
            edited
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {canPreview && (
            <button
              onClick={openInPanel}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-label="Open in side panel"
              title="Open in side panel"
            >
              <PanelRightOpen className="h-3 w-3" />
              Open
            </button>
          )}
          {(hasTranscript || a.extraction_error || a.storage_error) && (
            <button
              onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-expanded={open}
              aria-label={open ? "Hide transcript" : "Show transcript"}
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {isImage ? "Transcript" : "Preview"}
            </button>
          )}
        </div>
      </div>

      {isImage && a.url && (
        <a href={a.url} target="_blank" rel="noreferrer" className="block">
          <img src={a.url} alt={a.name} className="max-h-56 w-full object-cover" loading="lazy" />
        </a>
      )}

      {open && (
        <div className="border-t border-border bg-background/40 p-2">
          {a.storage_error && (
            <p className="mb-2 text-xs text-muted-foreground">{a.storage_error}</p>
          )}
          {a.extraction_error && !hasTranscript ? (
            <p className="text-xs text-destructive">{a.extraction_error}</p>
          ) : editing ? (
            <div className="space-y-1.5">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.min(12, Math.max(4, draft.split("\n").length + 1))}
                className="w-full resize-y rounded border border-input bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus:border-ring/60"
              />
              <div className="flex justify-end gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraft(a.extracted_text ?? "");
                    setEditing(false);
                  }}
                >
                  <X className="mr-1 h-3 w-3" /> Cancel
                </Button>
                <Button size="sm" onClick={() => mut.mutate(draft)} disabled={mut.isPending}>
                  <Check className="mr-1 h-3 w-3" /> Save
                </Button>
              </div>
            </div>
          ) : hasTranscript ? (
            <div className="space-y-1.5">
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90">
                {a.extracted_text}
              </pre>
              {!isTempMessage && (
                <button
                  onClick={() => {
                    setDraft(a.extracted_text ?? "");
                    setEditing(true);
                  }}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                >
                  <Pencil className="h-3 w-3" /> Edit transcript
                </button>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
