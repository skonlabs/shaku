import {
  FileText,
  Image as ImageIcon,
  Eye,
  Download,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
  conversationId: _conversationId,
  messageId: _messageId,
  index: _index,
  attachment: a,
}: {
  conversationId: string;
  messageId: string;
  index: number;
  attachment: AttachmentLike;
}) {
  const { openDocument } = usePanel();
  const isImage = a.kind === "image" || (a.type ?? "").startsWith("image/");
  const hasTranscript = typeof a.extracted_text === "string" && a.extracted_text.trim().length > 0;
  // Previewable in side panel when we have either extracted text OR a fetchable URL (non-image).
  const canPreview = hasTranscript || (!!a.url && !isImage);
  const canDownload = !!a.url || hasTranscript;

  const openInPanel = () =>
    openDocument({
      title: a.name,
      content: a.extracted_text ?? "",
      mime: a.type || "text/plain",
      url: a.url,
    });

  const onDownload = () => {
    if (a.url) {
      const link = window.document.createElement("a");
      link.href = a.url;
      link.download = a.name;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.click();
      return;
    }
    if (hasTranscript) {
      const blob = new Blob([a.extracted_text ?? ""], {
        type: a.type || "text/plain",
      });
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = a.name;
      link.click();
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="w-full max-w-[420px] overflow-hidden rounded-lg border border-border bg-card">
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
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-label="Preview"
              title="Preview"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          )}
          {canDownload && (
            <button
              onClick={onDownload}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-label="Download"
              title="Download"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {isImage && a.url && (
        <a href={a.url} target="_blank" rel="noreferrer" className="block">
          <img src={a.url} alt={a.name} className="max-h-56 w-full object-cover" loading="lazy" />
        </a>
      )}
    </div>
  );
}

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

