import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  onSend: (text: string) => void;
  onStop?: () => void;
  isStreaming: boolean;
  draftKey: string;
  autoFocus?: boolean;
  placeholder?: string;
}

export function ChatComposer({
  onSend,
  onStop,
  isStreaming,
  draftKey,
  autoFocus,
  placeholder = "Message Cortex…",
}: Props) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Hydrate draft
  useEffect(() => {
    try {
      const draft = localStorage.getItem(draftKey);
      if (draft) setValue(draft);
    } catch {
      /* noop */
    }
  }, [draftKey]);

  // Persist draft (debounced via microtask on every change)
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

  // Auto-resize
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [value]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const submit = () => {
    const text = value.trim();
    if (!text || isStreaming) return;
    onSend(text);
    setValue("");
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4 pt-2">
      <div
        className={cn(
          "relative flex items-end gap-2 rounded-2xl border border-input bg-card px-3 py-2 shadow-sm transition focus-within:border-ring/60 focus-within:shadow-md",
        )}
      >
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKey}
          placeholder={placeholder}
          className="min-h-[24px] flex-1 resize-none border-0 bg-transparent px-1 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground"
          aria-label="Message"
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            aria-label="Stop generating"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background transition hover:opacity-90"
          >
            <Square className="h-3.5 w-3.5" fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!value.trim()}
            aria-label="Send"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
      <p className="mt-2 text-center text-[11px] text-muted-foreground">
        Cortex can make mistakes. Verify important information.
      </p>
    </div>
  );
}
