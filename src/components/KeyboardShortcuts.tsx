import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useKbHelp, usePanel } from "@/lib/ui-context";

/**
 * Global keyboard shortcuts (spec Sprint 1):
 * - Cmd/Ctrl+K  → focus Chats panel search (opens panel)
 * - Cmd/Ctrl+N  → new chat
 * - Cmd/Ctrl+Shift+S → open Settings
 * - Cmd/Ctrl+/  → toggle shortcut help
 * - Escape      → close panel
 */
export function KeyboardShortcuts() {
  const navigate = useNavigate();
  const { setActive } = usePanel();
  const { setOpen: setHelpOpen, open: helpOpen } = useKbHelp();

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setActive("chats");
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void navigate({ to: "/" });
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setActive("settings");
      } else if (mod && e.key === "/") {
        e.preventDefault();
        setHelpOpen(!helpOpen);
      } else if (e.key === "Escape") {
        setActive(null);
        setHelpOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate, setActive, setHelpOpen, helpOpen]);

  return null;
}
