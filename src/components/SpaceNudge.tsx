import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, X } from "lucide-react";
import { listConversations } from "@/lib/conversations.functions";
import { listProjects } from "@/lib/projects.functions";
import { usePanel } from "@/lib/ui-context";
import { cn } from "@/lib/utils";

const DISMISS_KEY = "ekonomical.nudge.first-space.dismissed";
const MIN_CHATS = 5;

/**
 * Shown above the chat input when the user has 5+ unprojected chats and no
 * spaces yet. One-time dismissible. Encourages users to discover spaces.
 */
export function SpaceNudge() {
  const { setActive } = usePanel();
  const [dismissed, setDismissed] = useState(true); // start hidden until we read storage

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  const { data: convs } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => listConversations({ data: undefined as never }),
    enabled: !dismissed,
  });
  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: () => listProjects({ data: undefined as never }),
    enabled: !dismissed,
  });

  if (dismissed) return null;

  const unprojected = (convs?.conversations ?? []).filter((c) => !c.project_id);
  const hasNoSpaces = (projects?.projects ?? []).length === 0;

  if (unprojected.length < MIN_CHATS || !hasNoSpaces) return null;

  const handleDismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <div
      className={cn(
        "mx-auto mb-2 flex max-w-3xl items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2",
        "animate-fade-in",
      )}
      role="status"
    >
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="flex-1">
        <p className="text-xs leading-relaxed text-foreground">
          You've got {unprojected.length} chats going. Group related ones into a{" "}
          <button
            onClick={() => setActive("projects")}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            space
          </button>{" "}
          so Ekonomical can remember context across all of them.
        </p>
      </div>
      <button
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="-m-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
