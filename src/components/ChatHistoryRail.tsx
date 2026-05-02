import { useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PanelLeftClose, PanelLeftOpen, Plus, Search } from "lucide-react";
import { listConversations } from "@/lib/conversations.functions";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Section, groupConversationsByDate } from "@/components/SidePanel";
import { cn } from "@/lib/utils";

const RAIL_KEY = "cortex.chathistoryrail.open";

export function ChatHistoryRail() {
  const params = useParams({ strict: false }) as { id?: string };
  const activeId = params.id;

  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const v = window.localStorage.getItem(RAIL_KEY);
    return v === null ? true : v === "1";
  });
  const toggle = () => {
    setOpen((p) => {
      const next = !p;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(RAIL_KEY, next ? "1" : "0");
      }
      return next;
    });
  };

  const [query, setQuery] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => listConversations({ data: undefined as never }),
    staleTime: 30_000,
  });

  const conversations = data?.conversations ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) =>
      (c.title ?? "").toLowerCase().includes(q),
    );
  }, [conversations, query]);

  const pinned = filtered.filter((c) => c.pinned);
  const recent = filtered.filter((c) => !c.pinned);

  if (!open) {
    return (
      <aside className="flex h-full w-9 shrink-0 flex-col items-center border-r border-border/60 bg-background/40 py-2">
        <button
          type="button"
          onClick={toggle}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Show chat history"
          title="Show chat history"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border/60 bg-background/40">
      <div className="flex items-center gap-1 px-2 pt-2">
        <Link
          to="/app"
          className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <Plus className="h-3.5 w-3.5" /> New chat
        </Link>
        <button
          type="button"
          onClick={toggle}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Hide chat history"
          title="Hide chat history"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>
      <div className="px-2 pb-2 pt-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter chats…"
            className="h-7 w-full rounded-md border border-input bg-background pl-6 pr-2 text-xs outline-none focus:border-ring/60"
          />
        </div>
      </div>
      <ScrollArea className="flex-1 px-1.5">
        {isLoading ? (
          <div className="space-y-1.5 p-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-7 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No chats yet.
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No matches.
          </p>
        ) : (
          <div className="space-y-2 pb-3">
            {pinned.length > 0 && (
              <Section
                title="Pinned"
                storageKey="cortex.rail.section.pinned"
                defaultOpen
                count={pinned.length}
              >
                {pinned.map((c) => (
                  <RailItem
                    key={c.id}
                    id={c.id}
                    title={c.title ?? "New chat"}
                    active={c.id === activeId}
                  />
                ))}
              </Section>
            )}
            {groupConversationsByDate(recent).map((group) => (
              <Section
                key={group.key}
                title={group.title}
                storageKey={`cortex.rail.section.${group.key}`}
                defaultOpen={group.key === "today"}
                count={group.items.length}
              >
                {group.items.map((c) => (
                  <RailItem
                    key={c.id}
                    id={c.id}
                    title={c.title ?? "New chat"}
                    active={c.id === activeId}
                  />
                ))}
              </Section>
            ))}
          </div>
        )}
      </ScrollArea>
    </aside>
  );
}

function RailItem({
  id,
  title,
  active,
}: {
  id: string;
  title: string;
  active: boolean;
}) {
  return (
    <Link
      to="/c/$id"
      params={{ id }}
      className={cn(
        "block w-full truncate rounded-md px-2 py-1 text-left text-xs transition-colors",
        active
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
      title={title}
    >
      {title}
    </Link>
  );
}
