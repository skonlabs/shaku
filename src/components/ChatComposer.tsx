import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square, Paperclip, X, FileText, Loader2, ScanLine, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { uploadChatFile } from "@/lib/uploads.functions";
import { useUploadMaxMb } from "@/lib/upload-settings";

export interface Attachment {
  name: string;
  url: string | null;
  path?: string | null;
  size: number;
  type: string;
  kind?: string;
  extracted_text?: string | null;
  extraction_error?: string | null;
  storage_error?: string | null;
}

type PendingUpload = {
  id: string;
  name: string;
  size: number;
  type: string;
  isImage: boolean;
  stage: "uploading" | "ocr" | "parsing";
};

interface Props {
  conversationId?: string; // required to enable upload
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop?: () => void;
  isStreaming: boolean;
  draftKey: string;
  autoFocus?: boolean;
  placeholder?: string;
  disabled?: boolean;
  disabledMessage?: string;
  onArrowUpEmpty?: () => void;
  initialValue?: string;
}

export function ChatComposer({
  conversationId,
  onSend,
  onStop,
  isStreaming,
  draftKey,
  autoFocus,
  placeholder = "Ask me anything…",
  disabled,
  disabledMessage,
  onArrowUpEmpty,
  initialValue,
}: Props) {
  const [value, setValue] = useState(initialValue ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = pending.length;
  const [maxMb] = useUploadMaxMb();

  // Hydrate draft on mount only
  useEffect(() => {
    try {
      const draft = localStorage.getItem(draftKey);
      if (draft && !initialValue) setValue(draft);
    } catch {
      /* noop */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  useEffect(() => {
    try {
      if (value) localStorage.setItem(draftKey, value);
      else localStorage.removeItem(draftKey);
    } catch {
      /* noop */
    }
  }, [draftKey, value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [value]);

  // Drag-and-drop on the whole window when this composer is mounted
  useEffect(() => {
    if (!conversationId || disabled) return;
    let counter = 0;
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      counter++;
      setIsDragging(true);
    };
    const onDragLeave = () => {
      counter = Math.max(0, counter - 1);
      if (counter === 0) setIsDragging(false);
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      counter = 0;
      setIsDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void handleFiles(files);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, disabled]);

  const handleFiles = async (files: File[]) => {
    if (!conversationId) return;
    const maxBytes = maxMb * 1024 * 1024;
    for (const file of files) {
      if (file.size > maxBytes) {
        toast.error(`${file.name} is too large (max ${maxMb} MB — change in Settings).`);
        continue;
      }
      const isImage =
        (file.type || "").startsWith("image/") ||
        /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(file.name);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const initialStage: PendingUpload["stage"] = isImage ? "uploading" : "uploading";
      setPending((cur) => [
        ...cur,
        { id, name: file.name, size: file.size, type: file.type, isImage, stage: initialStage },
      ]);
      try {
        const data_b64 = await fileToBase64(file);
        // Once bytes are encoded, the server-side OCR / parsing kicks in.
        // Switch the indicator to a clearer "Reading…" stage.
        setPending((cur) =>
          cur.map((p) => (p.id === id ? { ...p, stage: isImage ? "ocr" : "parsing" } : p)),
        );
        const result = await uploadChatFile({
          data: {
            conversation_id: conversationId,
            name: file.name,
            type: file.type || "application/octet-stream",
            data_b64,
            max_mb: maxMb,
          },
        });
        setAttachments((cur) => [...cur, result]);
      } catch (err) {
        console.error(err);
        toast.error(`Couldn't upload ${file.name}.`);
      } finally {
        setPending((cur) => cur.filter((p) => p.id !== id));
      }
    }
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp" && value === "" && attachments.length === 0) {
      onArrowUpEmpty?.();
    }
  };

  const submit = () => {
    const text = value.trim();
    if ((!text && attachments.length === 0) || isStreaming || disabled || uploading > 0) return;
    onSend(text || "(attachment)", attachments);
    setValue("");
    setAttachments([]);
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="relative mx-auto w-full max-w-3xl px-4 pb-5 pt-2 sm:px-6">
      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-primary/10 backdrop-blur-md">
          <div className="rounded-2xl border-2 border-dashed border-primary bg-card px-10 py-7 text-sm font-medium text-primary shadow-xl">
            Drop files to attach
          </div>
        </div>
      )}

      {disabled && disabledMessage && (
        <div className="mb-2 animate-fade-in rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {disabledMessage}
        </div>
      )}

      {(attachments.length > 0 || pending.length > 0) && (
        <div className="mb-2 flex flex-col gap-1.5">
          {attachments.map((a, i) => (
            <ComposerAttachmentPreview
              key={i}
              attachment={a}
              onRemove={() => setAttachments((cur) => cur.filter((_, j) => j !== i))}
            />
          ))}
          {pending.map((p) => (
            <div
              key={p.id}
              className="flex animate-fade-in items-center gap-1.5 self-start rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm"
            >
              {p.stage === "ocr" ? (
                <ScanLine className="h-3.5 w-3.5 animate-pulse text-primary" />
              ) : (
                <Loader2 className="h-3 w-3 animate-spin" />
              )}
              <span className="max-w-[140px] truncate font-medium text-foreground">{p.name}</span>
              <span>
                {p.stage === "ocr"
                  ? "Reading image…"
                  : p.stage === "parsing"
                    ? "Parsing…"
                    : "Uploading…"}
              </span>
            </div>
          ))}
        </div>
      )}

      <div
        className={cn(
          "relative flex items-end gap-1.5 rounded-[20px] border border-input bg-card px-2.5 py-2 shadow-[0_2px_8px_-2px_oklch(0.18_0.01_250/0.06)] transition-all duration-200",
          "focus-within:border-primary/50 focus-within:shadow-[0_4px_20px_-4px_oklch(0.6_0.16_245/0.25)]",
          disabled && "opacity-60",
        )}
      >
        {conversationId && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) void handleFiles(files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              aria-label="Attach files"
              disabled={disabled}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Paperclip className="h-[18px] w-[18px]" />
            </button>
          </>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKey}
          placeholder={disabled ? (disabledMessage ?? placeholder) : placeholder}
          disabled={disabled}
          className="min-h-[28px] flex-1 resize-none border-0 bg-transparent px-1 py-2 text-[15px] leading-6 outline-none placeholder:text-muted-foreground/80 disabled:cursor-not-allowed"
          aria-label="Message"
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            aria-label="Stop generating"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-background transition-all duration-150 hover:scale-105 active:scale-95"
          >
            <Square className="h-3.5 w-3.5" fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={disabled || (!value.trim() && attachments.length === 0) || uploading > 0}
            aria-label="Send"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_2px_8px_-2px_oklch(0.6_0.16_245/0.5)] transition-all duration-150 hover:shadow-[0_4px_12px_-2px_oklch(0.6_0.16_245/0.6)] enabled:hover:scale-105 enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 disabled:shadow-none"
          >
            <ArrowUp className="h-[18px] w-[18px]" />
          </button>
        )}
      </div>
      <p className="mt-2.5 text-center text-[11px] text-muted-foreground/80">
        Cortex can make mistakes. Verify important information.
      </p>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result as string;
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function ComposerAttachmentPreview({
  attachment: a,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  const isImage = a.kind === "image" || (a.type ?? "").startsWith("image/");
  const hasText = !!a.extracted_text && a.extracted_text.trim().length > 0;
  const hasError = !!a.extraction_error;
  const [open, setOpen] = useState(hasError);

  const status = hasError
    ? { label: "Extraction failed", tone: "text-destructive", Icon: AlertTriangle }
    : hasText
      ? {
          label: isImage ? `OCR · ${a.extracted_text!.length.toLocaleString()} chars` : `Parsed · ${a.extracted_text!.length.toLocaleString()} chars`,
          tone: "text-emerald-600 dark:text-emerald-400",
          Icon: CheckCircle2,
        }
      : { label: isImage ? "Image" : "No text extracted", tone: "text-muted-foreground", Icon: FileText };

  return (
    <div className="self-start w-full max-w-[520px] overflow-hidden rounded-lg border border-border bg-card text-xs">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="max-w-[200px] truncate font-medium">{a.name}</span>
        <span className="text-muted-foreground">{formatBytes(a.size)}</span>
        <span className={cn("flex items-center gap-1", status.tone)}>
          <status.Icon className="h-3 w-3" />
          {status.label}
        </span>
        {(hasText || hasError) && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="ml-auto flex items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            aria-expanded={open}
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Preview
          </button>
        )}
        <button
          onClick={onRemove}
          aria-label="Remove attachment"
          className={cn("text-muted-foreground transition hover:text-foreground", !(hasText || hasError) && "ml-auto")}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {open && (
        <div className="border-t border-border bg-background/40 p-2">
          {hasError && !hasText ? (
            <p className="text-xs text-destructive">{a.extraction_error}</p>
          ) : (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90">
              {a.extracted_text}
            </pre>
          )}
          {a.storage_error && (
            <p className="mt-2 text-[11px] text-muted-foreground">{a.storage_error}</p>
          )}
        </div>
      )}
    </div>
  );
}
