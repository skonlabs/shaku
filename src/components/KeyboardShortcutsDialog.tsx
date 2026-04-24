import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useKbHelp } from "@/lib/ui-context";

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl";

const shortcuts: Array<{ keys: string[]; label: string }> = [
  { keys: [mod, "N"], label: "New chat" },
  { keys: [mod, "K"], label: "Open chats panel" },
  { keys: [mod, "Shift", "S"], label: "Open settings" },
  { keys: [mod, "/"], label: "Toggle this help" },
  { keys: ["Esc"], label: "Close panel / dialog" },
  { keys: ["↑"], label: "Edit last message (when input empty)" },
  { keys: ["Enter"], label: "Send message" },
  { keys: ["Shift", "Enter"], label: "New line" },
];

export function KeyboardShortcutsDialog() {
  const { open, setOpen } = useKbHelp();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <ul className="mt-2 divide-y divide-border">
          {shortcuts.map((s) => (
            <li key={s.label} className="flex items-center justify-between py-2.5 text-sm">
              <span className="text-foreground">{s.label}</span>
              <span className="flex items-center gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="inline-flex h-6 min-w-[24px] items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[11px] font-medium text-muted-foreground"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
