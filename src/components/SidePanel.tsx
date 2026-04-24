import { useEffect, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useLocation } from "@tanstack/react-router";
import {
  X,
  Plus,
  Pin,
  MoreHorizontal,
  Trash2,
  LogOut,
  Moon,
  Sun,
  Monitor,
  Search,
  Download,
  Copy,
  Check,
} from "lucide-react";
import { usePanel } from "@/lib/ui-context";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import { HARD_UPLOAD_MAX_MB, useUploadMaxMb } from "@/lib/upload-settings";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  listConversations,
  createConversation,
  togglePinConversation,
  deleteConversation,
  searchMessages,
} from "@/lib/conversations.functions";

export function SidePanel() {
  const { active, setActive, document } = usePanel();

  // Close on Esc handled globally; keep panel mounted so animations work
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, setActive]);

  if (!active) return null;

  const isDoc = active === "document";
  return (
    <div
      className={cn(
        "z-20 flex h-svh shrink-0 flex-col border-r border-border bg-card",
        isDoc ? "w-[480px]" : "w-[300px]",
      )}
    >
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
        <h2 className="truncate text-sm font-semibold capitalize">
          {isDoc ? (document?.title ?? "Document") : labelFor(active)}
        </h2>
        <button
          onClick={() => setActive(null)}
          aria-label="Close panel"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        {active === "chats" && <ChatsPanel />}
        {active === "projects" && <ComingSoon label="Projects" />}
        {active === "datasources" && <ComingSoon label="Data sources" />}
        {active === "connectors" && <ComingSoon label="Connectors" />}
        {active === "settings" && <SettingsPanel />}
        {active === "account" && <AccountPanel />}
        {active === "document" && <DocumentPanel />}
      </div>
    </div>
  );
}

function labelFor(p: string) {
  switch (p) {
    case "chats":
      return "Chats";
    case "projects":
      return "Projects";
    case "datasources":
      return "Data sources";
    case "connectors":
      return "Connectors";
    case "settings":
      return "Settings";
    case "account":
      return "Account";
    default:
      return p;
  }
}

function ChatsPanel() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const location = useLocation();
  const { setActive } = usePanel();
  const { user, loading } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => listConversations({ data: undefined as never }),
    enabled: !loading && !!user,
  });

  const createMut = useMutation({
    mutationFn: () => createConversation({ data: {} }),
    onSuccess: ({ conversation }) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      navigate({ to: "/c/$id", params: { id: conversation.id } });
      setActive(null);
    },
    onError: () => toast.error("I ran into a problem creating the chat."),
  });

  const pinMut = useMutation({
    mutationFn: (v: { id: string; pinned: boolean }) => togglePinConversation({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => deleteConversation({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
  });

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const searchQ = useQuery({
    queryKey: ["search-messages", debounced],
    queryFn: () => searchMessages({ data: { query: debounced } }),
    enabled: debounced.length >= 2 && !loading && !!user,
  });

  const conversations = data?.conversations ?? [];
  const pinned = conversations.filter((c) => c.pinned);
  const recent = conversations.filter((c) => !c.pinned);
  const isSearching = debounced.length >= 2;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 px-3 pb-2">
        <Button
          onClick={() => createMut.mutate()}
          disabled={createMut.isPending}
          className="w-full justify-start gap-2"
          size="sm"
        >
          <Plus className="h-4 w-4" /> New chat
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats & images…"
            className="h-8 w-full rounded-md border border-input bg-background pl-7 pr-2 text-xs outline-none focus:border-ring/60"
          />
        </div>
      </div>
      <ScrollArea className="flex-1 px-2">
        {isSearching ? (
          <SearchResults
            isLoading={searchQ.isLoading}
            results={searchQ.data?.results ?? []}
            error={searchQ.data?.error ?? null}
            onPick={() => setActive(null)}
          />
        ) : isLoading ? (
          <div className="space-y-1.5 p-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            No chats yet. Start one above.
          </div>
        ) : (
          <div className="space-y-4 pb-4">
            {pinned.length > 0 && (
              <Section title="Pinned">
                {pinned.map((c) => (
                  <ChatItem
                    key={c.id}
                    id={c.id}
                    title={c.title ?? "New chat"}
                    pinned
                    activePath={location.pathname}
                    onPin={(id, pinned) => pinMut.mutate({ id, pinned })}
                    onDelete={(id) => delMut.mutate(id)}
                    onNavigate={() => setActive(null)}
                  />
                ))}
              </Section>
            )}
            <Section title="Recent">
              {recent.map((c) => (
                <ChatItem
                  key={c.id}
                  id={c.id}
                  title={c.title ?? "New chat"}
                  pinned={false}
                  activePath={location.pathname}
                  onPin={(id, pinned) => pinMut.mutate({ id, pinned })}
                  onDelete={(id) => delMut.mutate(id)}
                  onNavigate={() => setActive(null)}
                />
              ))}
            </Section>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface SearchResult {
  conversation_id: string;
  conversation_title: string | null;
  message_id: string;
  snippet: string;
  role: string;
}

function SearchResults({
  isLoading,
  results,
  error,
  onPick,
}: {
  isLoading: boolean;
  results: SearchResult[];
  error: string | null;
  onPick: () => void;
}) {
  if (isLoading) {
    return <div className="p-3 text-xs text-muted-foreground">Searching…</div>;
  }
  if (error) {
    return <div className="p-3 text-xs text-destructive">{error}</div>;
  }
  if (results.length === 0) {
    return <div className="p-3 text-xs text-muted-foreground">No matches.</div>;
  }
  return (
    <div className="space-y-1 pb-4">
      {results.map((r) => (
        <Link
          key={r.message_id}
          to="/c/$id"
          params={{ id: r.conversation_id }}
          onClick={onPick}
          className="block rounded-md px-2 py-1.5 text-xs transition hover:bg-accent"
        >
          <div className="truncate font-medium">{r.conversation_title ?? "Untitled chat"}</div>
          <div
            className="line-clamp-2 text-muted-foreground [&>mark]:rounded [&>mark]:bg-primary/20 [&>mark]:px-0.5 [&>mark]:text-foreground"
            dangerouslySetInnerHTML={{ __html: r.snippet }}
          />
        </Link>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function ChatItem({
  id,
  title,
  pinned,
  activePath,
  onPin,
  onDelete,
  onNavigate,
}: {
  id: string;
  title: string;
  pinned: boolean;
  activePath: string;
  onPin: (id: string, pinned: boolean) => void;
  onDelete: (id: string) => void;
  onNavigate: () => void;
}) {
  const isActive = activePath === `/c/${id}`;
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md pr-1 transition",
        isActive ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <Link
        to="/c/$id"
        params={{ id }}
        onClick={onNavigate}
        className="flex-1 truncate px-2 py-1.5 text-sm"
      >
        {title}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Chat options"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-background hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={() => onPin(id, !pinned)}>
            <Pin className="mr-2 h-4 w-4" /> {pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onDelete(id)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-muted-foreground">Coming in a future sprint.</p>
    </div>
  );
}

function SettingsPanel() {
  const { theme, setTheme } = useTheme();
  const [maxMb, setMaxMb] = useUploadMaxMb();
  return (
    <div className="space-y-6 px-4 py-2">
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Appearance
        </p>
        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              { v: "light", icon: Sun, label: "Light" },
              { v: "dark", icon: Moon, label: "Dark" },
              { v: "system", icon: Monitor, label: "System" },
            ] as const
          ).map((opt) => {
            const Icon = opt.icon;
            return (
              <button
                key={opt.v}
                onClick={() => setTheme(opt.v)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-md border border-border px-2 py-3 text-xs transition",
                  theme === opt.v ? "border-primary bg-accent" : "hover:bg-accent/60",
                )}
              >
                <Icon className="h-4 w-4" />
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Uploads
        </p>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Max file size</span>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              max={HARD_UPLOAD_MAX_MB}
              value={maxMb}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setMaxMb(n);
              }}
              className="h-8 w-16 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ring/60"
            />
            <span className="text-xs text-muted-foreground">MB</span>
          </div>
        </label>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Per-file limit, 1–{HARD_UPLOAD_MAX_MB} MB. Default 1 MB.
        </p>
      </div>
    </div>
  );
}

function AccountPanel() {
  const { user, profile, signOut } = useAuth();
  return (
    <div className="space-y-4 px-4 py-2">
      <div className="space-y-1">
        <p className="text-sm font-medium">{profile?.name ?? "Cortex user"}</p>
        <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
      </div>
      <Button variant="outline" size="sm" className="w-full justify-start gap-2" onClick={signOut}>
        <LogOut className="h-4 w-4" /> Sign out
      </Button>
    </div>
  );
}
