import { useEffect, useState, useRef, type ReactNode } from "react";
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
  Pencil,
  Brain,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File,
  FileText,
  FileCode,
  FileSpreadsheet,
  FileImage,
  Folder,
  FolderPlus,
  FolderUp,
  Loader2,
  Pause,
  Play,
  Upload,
  Sparkles,
  Eye,
  ArrowLeft,
} from "lucide-react";
import { usePanel } from "@/lib/ui-context";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import { HARD_UPLOAD_MAX_MB, useUploadMaxMb } from "@/lib/upload-settings";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { HelpCircle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  listConversations,
  createConversation,
  togglePinConversation,
  deleteConversation,
  renameConversation,
  searchMessages,
} from "@/lib/conversations.functions";
import { getUsageByConversation, getUsageSummary } from "@/lib/usage.functions";
import {
  getMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  toggleMemory,
  pinMemory,
  getUkm,
  getMemoryStats,
  getMemoryPreferences,
  updateMemoryPreferences,
} from "@/lib/memory.functions";
import {
  listProjects,
  createProject,
  deleteProject,
  updateProject,
  listProjectConversations,
} from "@/lib/projects.functions";
// getContextLog and getActiveTaskForConversation are now consumed inline by
// MessageList (BehindAnswerChip) and ActiveTaskBanner respectively.
import { listFiles, createDatasourceFile, deleteDatasourceFile } from "@/lib/datasources.functions";
import {
  listConnectors,
  initiateConnectorAuth,
  pauseConnector,
  disconnectConnector,
  getConnectorAvailability,
} from "@/lib/connectors.functions";
import { verifyGoogleConnection } from "@/lib/connectors/verify.functions";
import { supabase } from "@/integrations/supabase/client";
import type { UserKnowledgeModel } from "@/lib/knowledge/ukm";
import { MessageContent } from "@/components/MessageContent";

export function SidePanel({ side = "left" }: { side?: "left" | "right" }) {
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
  // Document panel renders on the right; all other panels on the left.
  if (side === "right" && !isDoc) return null;
  if (side === "left" && isDoc) return null;

  return (
    <div
      className={cn(
        "z-20 flex h-svh shrink-0 animate-fade-in flex-col bg-sidebar/80 backdrop-blur-xl",
        side === "right" ? "border-l border-border" : "border-r border-border",
        isDoc ? "w-[480px]" : "w-[320px]",
      )}
    >
      <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-4">
        <h2 className="truncate text-[13px] font-semibold tracking-tight text-foreground">
          {isDoc ? (document?.title ?? "Document") : labelFor(active)}
        </h2>
        <button
          onClick={() => setActive(null)}
          aria-label="Close panel"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        {active === "chats" && <ChatsPanel />}
        {active === "projects" && <ProjectsPanel />}
        {active === "datasources" && <DatasourcesPanel />}
        {active === "connectors" && <ConnectorsPanel />}
        {active === "memory" && <MemoryPanel />}
        {/* "context" and "task" panels were retired — see ActiveTaskBanner & BehindAnswerChip. */}
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
      return "Spaces";
    case "datasources":
      return "Data sources";
    case "connectors":
      return "Connectors";
    case "memory":
      return "Memory & Persona";
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
    onError: () => toast.error("Couldn't update pin."),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => deleteConversation({ data: { id } }),
    onSuccess: (_result, id) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      if (location.pathname === `/c/${id}`) navigate({ to: "/app" });
    },
    onError: () => toast.error("Couldn't delete chat."),
  });

  const renameMut = useMutation({
    mutationFn: (v: { id: string; title: string }) => renameConversation({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
    onError: () => toast.error("Couldn't rename chat."),
  });
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

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
        ) : conversations.length === 0 ? null : (
          <div className="space-y-4 pb-4">
            {pinned.length > 0 && (
              <Section
                title="Pinned"
                storageKey="cortex.sidebar.section.pinned"
                defaultOpen
                count={pinned.length}
              >
                {pinned.map((c) => (
                  <ChatItem
                    key={c.id}
                    id={c.id}
                    title={c.title ?? "New chat"}
                    pinned
                    activePath={location.pathname}
                    onPin={(id, pinned) => pinMut.mutate({ id, pinned })}
                    onDelete={(id) => setPendingDeleteId(id)}
                    onRename={(id, title) => renameMut.mutate({ id, title })}
                    onNavigate={() => setActive(null)}
                  />
                ))}
              </Section>
            )}
            {groupConversationsByDate(recent).map((group) => (
              <Section
                key={group.key}
                title={group.title}
                storageKey={`cortex.sidebar.section.${group.key}`}
                defaultOpen={group.key === "today"}
                count={group.items.length}
              >
                {group.items.map((c) => (
                  <ChatItem
                    key={c.id}
                    id={c.id}
                    title={c.title ?? "New chat"}
                    pinned={false}
                    activePath={location.pathname}
                    onPin={(id, pinned) => pinMut.mutate({ id, pinned })}
                    onDelete={(id) => setPendingDeleteId(id)}
                    onRename={(id, title) => renameMut.mutate({ id, title })}
                    onNavigate={() => setActive(null)}
                  />
                ))}
              </Section>
            ))}
          </div>
        )}
      </ScrollArea>
      <AlertDialog
        open={!!pendingDeleteId}
        onOpenChange={(o) => {
          if (!o) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDeleteId) {
                  delMut.mutate(pendingDeleteId);
                  setPendingDeleteId(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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

export function Section({
  title,
  children,
  storageKey,
  defaultOpen = false,
  count,
}: {
  title: string;
  children: React.ReactNode;
  storageKey?: string;
  defaultOpen?: boolean;
  count?: number;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined" || !storageKey) return defaultOpen;
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return defaultOpen;
  });
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (typeof window !== "undefined" && storageKey) {
        window.localStorage.setItem(storageKey, next ? "1" : "0");
      }
      return next;
    });
  };
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="group flex w-full items-center gap-1 rounded-md px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>{title}</span>
        {typeof count === "number" && (
          <span className="ml-1 text-muted-foreground/70">({count})</span>
        )}
      </button>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
  );
}

type ConversationLike = {
  id: string;
  title: string | null;
  pinned: boolean;
  updated_at?: string | null;
  created_at?: string | null;
};

export function groupConversationsByDate<T extends ConversationLike>(
  items: T[],
): { key: string; title: string; items: T[] }[] {
  if (items.length === 0) return [];
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfYesterday = startOfToday - dayMs;
  const startOf7 = startOfToday - 7 * dayMs;
  const startOf30 = startOfToday - 30 * dayMs;
  const startOfThisYear = new Date(now.getFullYear(), 0, 1).getTime();

  const buckets = new Map<string, { title: string; order: number; items: T[] }>();
  const push = (key: string, title: string, order: number, item: T) => {
    const b = buckets.get(key) ?? { title, order, items: [] };
    b.items.push(item);
    buckets.set(key, b);
  };

  for (const c of items) {
    const ts = new Date(c.updated_at ?? c.created_at ?? now.toISOString()).getTime();
    if (ts >= startOfToday) push("today", "Today", 0, c);
    else if (ts >= startOfYesterday) push("yesterday", "Yesterday", 1, c);
    else if (ts >= startOf7) push("prev7", "Previous 7 Days", 2, c);
    else if (ts >= startOf30) push("prev30", "Previous 30 Days", 3, c);
    else if (ts >= startOfThisYear) {
      const d = new Date(ts);
      const key = `m-${d.getFullYear()}-${d.getMonth()}`;
      const title = d.toLocaleString(undefined, { month: "long" });
      push(key, title, 4 + (11 - d.getMonth()), c);
    } else {
      const d = new Date(ts);
      const key = `y-${d.getFullYear()}`;
      push(key, String(d.getFullYear()), 1000 - d.getFullYear(), c);
    }
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[1].order - b[1].order)
    .map(([key, { title, items }]) => ({
      key,
      title,
      items,
    }));
}

function ChatItem({
  id,
  title,
  pinned,
  activePath,
  onPin,
  onDelete,
  onRename,
  onNavigate,
}: {
  id: string;
  title: string;
  pinned: boolean;
  activePath: string;
  onPin: (id: string, pinned: boolean) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onNavigate: () => void;
}) {
  const isActive = activePath === `/c/${id}`;
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(title);
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md pr-1 transition",
        isActive ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      {editing ? (
        <form
          className="flex-1 px-1"
          onSubmit={(e) => {
            e.preventDefault();
            const t = editTitle.trim();
            if (t && t !== title) onRename(id, t);
            setEditing(false);
          }}
        >
          <input
            autoFocus
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={() => {
              const t = editTitle.trim();
              if (t && t !== title) onRename(id, t);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
            maxLength={200}
            className="h-7 w-full rounded border border-input bg-background px-2 text-sm outline-none focus:border-ring/60"
          />
        </form>
      ) : (
        <Link
          to="/c/$id"
          params={{ id }}
          onClick={onNavigate}
          className="flex-1 truncate px-2 py-1.5 text-sm"
        >
          {title}
        </Link>
      )}
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
            onClick={() => {
              setEditing(true);
              setEditTitle(title);
            }}
          >
            <Pencil className="mr-2 h-4 w-4" /> Rename
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

type DatasourceFile = {
  id: string;
  name: string;
  file_type: string;
  file_size_bytes: number;
  status: "uploading" | "processing" | "ready" | "error";
  chunk_count: number | null;
  last_refreshed_at: string | null;
  created_at: string;
  storage_path?: string | null;
};

function SettingsPanel() {
  const { theme, setTheme } = useTheme();
  const [maxMb, setMaxMb] = useUploadMaxMb();
  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 px-4 py-2 pb-8">
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
        <TokenUsageSection />
      </div>
    </ScrollArea>
  );
}

function MemoryPreferencesSection() {
  const qc = useQueryClient();
  const { data: prefs, isLoading } = useQuery({
    queryKey: ["memory-preferences"],
    queryFn: () => getMemoryPreferences({ data: {} }),
    staleTime: 60_000,
  });

  const updateMut = useMutation({
    mutationFn: (patch: Parameters<typeof updateMemoryPreferences>[0]["data"]) =>
      updateMemoryPreferences({ data: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["memory-preferences"] });
      toast.success("Memory preferences saved.");
    },
    onError: () => toast.error("Couldn't save preferences."),
  });

  if (isLoading || !prefs) return null;

  // Map raw confidence threshold (0.1–1.0) to 3 friendly presets.
  const confPreset: "eager" | "balanced" | "cautious" =
    prefs.minConfidenceThreshold <= 0.45
      ? "eager"
      : prefs.minConfidenceThreshold >= 0.75
        ? "cautious"
        : "balanced";
  const confValue = { eager: 0.4, balanced: 0.6, cautious: 0.8 } as const;

  return (
    <TooltipProvider delayDuration={150}>
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Memory preferences
        </p>
        <div className="space-y-5 rounded-lg border border-border bg-card p-3">
          {/* Confidence */}
          <div>
            <p className="mb-1 flex items-center gap-1.5 text-sm font-medium">
              How sure should Cortex be before saving?
              <HelpTip>
                <p className="mb-1 font-medium">What this changes</p>
                <p className="mb-2 text-muted-foreground">
                  Sets the bar Cortex uses before turning something into a memory.
                </p>
                <p className="mb-1 font-medium">Examples</p>
                <ul className="space-y-1.5 text-muted-foreground">
                  <li>
                    <b className="text-foreground">Eager —</b> "I think I'd like to learn French
                    someday" gets saved. You'll see more reminders, some off-base.
                  </li>
                  <li>
                    <b className="text-foreground">Balanced —</b> "I'm learning French" gets saved.
                    Casual asides usually don't.
                  </li>
                  <li>
                    <b className="text-foreground">Cautious —</b> only clear statements like "My
                    name is Sam" or "I live in Berlin" stick.
                  </li>
                </ul>
              </HelpTip>
            </p>
            <p className="mb-2 text-[12px] leading-snug text-muted-foreground">
              Higher means fewer, more reliable memories. Lower means more memories but some may be
              wrong.
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { v: "eager", label: "Eager", hint: "Save more" },
                  { v: "balanced", label: "Balanced", hint: "Recommended" },
                  { v: "cautious", label: "Cautious", hint: "Only sure things" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.v}
                  onClick={() => updateMut.mutate({ min_confidence_threshold: confValue[opt.v] })}
                  className={cn(
                    "rounded-md border border-border px-2 py-2 text-center text-xs transition",
                    confPreset === opt.v ? "border-primary bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div className="text-[10px] text-muted-foreground">{opt.hint}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Memories per response */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                How much to remember per chat
                <HelpTip>
                  <p className="mb-1 font-medium">What this changes</p>
                  <p className="mb-2 text-muted-foreground">
                    The most facts Cortex will pull out of a single conversation.
                  </p>
                  <p className="mb-1 font-medium">Examples</p>
                  <ul className="space-y-1.5 text-muted-foreground">
                    <li>
                      <b className="text-foreground">1–3 (Just essentials) —</b> from a long
                      planning chat, Cortex might only save "trip to Lisbon in June."
                    </li>
                    <li>
                      <b className="text-foreground">5–8 (Recommended) —</b> also saves "traveling
                      with partner," "wants museums and food," "budget €1500."
                    </li>
                    <li>
                      <b className="text-foreground">15–20 (Capture everything) —</b> adds smaller
                      details like preferred neighborhoods and dietary notes.
                    </li>
                  </ul>
                </HelpTip>
              </p>
              <span className="text-xs tabular-nums text-muted-foreground">
                up to {prefs.maxMemoriesPerCall}
              </span>
            </div>
            <p className="mb-2 text-[12px] leading-snug text-muted-foreground">
              Most chats produce 1–3 useful facts. A higher limit lets Cortex capture more from long
              conversations.
            </p>
            <Slider
              min={1}
              max={20}
              step={1}
              value={[Math.min(prefs.maxMemoriesPerCall, 20)]}
              onValueChange={(vals) => updateMut.mutate({ max_memories_per_call: vals[0] })}
            />
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>Just essentials</span>
              <span>Capture everything</span>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

function HelpTip({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="More info"
          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/70 hover:text-foreground"
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" align="start" className="max-w-[280px] text-[12px] leading-snug">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

function TokenUsageSection() {
  const { user, loading } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["usage-by-conversation"],
    queryFn: () => getUsageByConversation({ data: undefined as never }),
    enabled: !loading && !!user,
    staleTime: 30_000,
  });

  const { data: summaryData } = useQuery({
    queryKey: ["usage-summary"],
    queryFn: () => getUsageSummary({ data: undefined as never }),
    enabled: !loading && !!user,
    staleTime: 60_000,
  });

  const events = (data?.events ?? []) as Array<{
    model_used: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    cost_usd: number | string | null;
    created_at: string;
  }>;

  const byModel = new Map<string, { in: number; out: number; cost: number; calls: number }>();
  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  for (const e of events) {
    const model = e.model_used ?? "unknown";
    const tin = e.tokens_in ?? 0;
    const tout = e.tokens_out ?? 0;
    const cost = Number(e.cost_usd ?? 0);
    totalIn += tin;
    totalOut += tout;
    totalCost += cost;
    const cur = byModel.get(model) ?? { in: 0, out: 0, cost: 0, calls: 0 };
    cur.in += tin;
    cur.out += tout;
    cur.cost += cost;
    cur.calls += 1;
    byModel.set(model, cur);
  }
  const totalTokens = totalIn + totalOut;
  const rows = [...byModel.entries()]
    .map(([model, v]) => ({ model, ...v, total: v.in + v.out }))
    .sort((a, b) => b.total - a.total);

  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Token usage
      </p>
      {isLoading ? (
        <div className="space-y-1.5">
          <div className="h-10 animate-pulse rounded-md bg-muted/60" />
          <div className="h-10 animate-pulse rounded-md bg-muted/60" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No usage recorded yet. Send a message to start tracking.
        </p>
      ) : (
        <>
          {/* Total across all models */}
          <div className="rounded-lg border border-border bg-card/60 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Total · {rows.length} model{rows.length === 1 ? "" : "s"}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {events.length} call{events.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <UsageStat label="Input" value={formatTokens(totalIn)} tone="text-foreground" />
              <UsageStat label="Output" value={formatTokens(totalOut)} tone="text-primary" />
              <UsageStat label="Cost" value={`$${totalCost.toFixed(4)}`} tone="text-foreground" />
            </div>
          </div>

          {summaryData && (
            <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg border border-border bg-card/60 p-3 text-center">
              <UsageStat
                label="Msgs today"
                value={String(summaryData.messagesToday)}
                tone="text-foreground"
              />
              <UsageStat
                label="30-day cost"
                value={`$${summaryData.totalCostUsd.toFixed(4)}`}
                tone="text-foreground"
              />
            </div>
          )}

          {/* Per-model breakdown */}
          <p className="mb-1.5 mt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            By model
          </p>
          <div className="space-y-1.5">
            {rows.map((r) => {
              const sharePct = totalTokens > 0 ? (r.total / totalTokens) * 100 : 0;
              const inPct = r.total > 0 ? (r.in / r.total) * 100 : 0;
              return (
                <div
                  key={r.model}
                  className="rounded-md border border-border bg-card/60 px-2.5 py-2 text-[11px]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-foreground" title={r.model}>
                      {prettyModel(r.model)}
                    </span>
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                      {sharePct.toFixed(0)}%
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>
                      {r.calls} call{r.calls === 1 ? "" : "s"}
                    </span>
                    <span>${r.cost.toFixed(4)}</span>
                  </div>
                  <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="bg-foreground/70"
                      style={{ width: `${inPct}%` }}
                      title={`Input: ${r.in.toLocaleString()}`}
                    />
                    <div
                      className="bg-primary"
                      style={{ width: `${100 - inPct}%` }}
                      title={`Output: ${r.out.toLocaleString()}`}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                    <span>↓ {formatTokens(r.in)} in</span>
                    <span>↑ {formatTokens(r.out)} out</span>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">
            Last {events.length} call{events.length === 1 ? "" : "s"} across all chats.
          </p>
        </>
      )}
    </div>
  );
}

function prettyModel(id: string): string {
  if (!id || id === "unknown" || id === "chat") return "Unknown model";
  // Strip provider prefix e.g. "openai/gpt-4o-mini" -> "gpt-4o-mini"
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

function UsageStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={cn("text-sm font-semibold tabular-nums", tone)}>{value}</span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
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

function DocumentPanel() {
  const { document: doc } = usePanel();
  const [copied, setCopied] = useState(false);
  const [fetched, setFetched] = useState<{ url: string; content: string } | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const initialContent = doc?.content ?? "";
  const needsFetch = !!doc && !initialContent.trim() && !!doc.url;

  useEffect(() => {
    if (!needsFetch || !doc?.url) return;
    if (fetched?.url === doc.url) return;
    let cancelled = false;
    setFetching(true);
    setFetchError(null);
    fetch(doc.url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (!cancelled) setFetched({ url: doc.url!, content: text });
      })
      .catch((e) => {
        if (!cancelled) setFetchError(e?.message || "Couldn't load document");
      })
      .finally(() => {
        if (!cancelled) setFetching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [needsFetch, doc?.url, fetched?.url]);

  if (!doc) {
    return <div className="p-4 text-xs text-muted-foreground">No document selected.</div>;
  }

  const content = initialContent.trim() ? initialContent : (fetched?.content ?? "");

  const isMarkdown =
    !doc.mime || doc.mime.startsWith("text/markdown") || /\.(md|markdown)$/i.test(doc.title);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };

  const onDownload = () => {
    const ext = isMarkdown ? "md" : "txt";
    const safe = doc.title.replace(/[^a-zA-Z0-9._-]/g, "_") || `document.${ext}`;
    const filename = /\.[a-z0-9]+$/i.test(safe) ? safe : `${safe}.${ext}`;
    const blob = new Blob([content], {
      type: doc.mime ?? (isMarkdown ? "text/markdown" : "text/plain"),
    });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-xs"
          onClick={onCopy}
          disabled={!content}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-xs"
          onClick={onDownload}
          disabled={!content}
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </Button>
        {doc.url && (
          <a
            href={doc.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          >
            Open original
          </a>
        )}
      </div>
      <ScrollArea className="flex-1">
        <div className="px-4 py-3">
          {fetching && !content ? (
            <p className="text-xs text-muted-foreground">Loading document…</p>
          ) : fetchError && !content ? (
            <p className="text-xs text-destructive">{fetchError}</p>
          ) : !content ? (
            <p className="text-xs text-muted-foreground">No preview available.</p>
          ) : isMarkdown ? (
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <MessageContent content={content} />
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-foreground/90">
              {content}
            </pre>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------- Memory & Persona Panel ----------

type MemoryType =
  | "preference"
  | "semantic"
  | "episodic"
  | "behavioral"
  | "anti_preference"
  | "correction"
  | "response_style"
  | "project"
  | "short_term"
  | "long_term"
  | "document";

const MEMORY_TYPE_META: { value: MemoryType; label: string; emoji: string }[] = [
  { value: "preference", label: "Preferences", emoji: "💡" },
  { value: "anti_preference", label: "Dislikes", emoji: "🚫" },
  { value: "behavioral", label: "Behavioral", emoji: "🎯" },
  { value: "response_style", label: "Response style", emoji: "✍️" },
  { value: "correction", label: "Corrections", emoji: "✏️" },
  { value: "project", label: "Spaces", emoji: "📁" },
  { value: "episodic", label: "Events", emoji: "📅" },
  { value: "semantic", label: "Facts", emoji: "🧠" },
  { value: "long_term", label: "Long-term", emoji: "🔒" },
  { value: "short_term", label: "Short-term", emoji: "⏱️" },
  { value: "document", label: "Documents", emoji: "📄" },
];

interface MemoryEntry {
  id: string;
  type: string;
  content: string;
  confidence: number;
  importance: number;
  pinned: boolean;
  accessCount: number;
  lastAccessedAt: string | null;
  sourceConversationId?: string | null;
}

type RecentPersonaSignal = {
  content: string;
  createdAt: string;
};

// ─── Spaces (formerly Projects) ─────────────────────────────────────────────

function ProjectsPanel() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: () => listProjects({ data: undefined as never }),
  });

  const projects = data?.projects ?? [];

  const createMut = useMutation({
    mutationFn: (name: string) => createProject({ data: { name } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setCreating(false);
      setNewName("");
      toast.success("Space created.");
    },
    onError: () => toast.error("Couldn't create space."),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteProject({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Space archived.");
    },
    onError: () => toast.error("Couldn't archive space."),
  });
  const [pendingDeleteProjectId, setPendingDeleteProjectId] = useState<string | null>(null);

  return (
    <div className="flex h-full flex-col">
      {/* Always-visible explainer */}
      <div className="mx-3 mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">What's a space?</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              A space groups chats and memories around a topic — like a job search, a trip, or a
              long project. Cortex remembers context across every chat inside it.
            </p>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center px-4 py-2">
        <button
          onClick={() => {
            setCreating(true);
            setNewName("");
          }}
          className="ml-auto flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <FolderPlus className="h-3.5 w-3.5" /> New space
        </button>
      </div>

      {creating && (
        <form
          className="mx-3 mb-3 space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) createMut.mutate(newName.trim());
          }}
        >
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Job search, Trip to Japan"
            maxLength={100}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ring/60"
          />
          <div className="flex gap-1">
            <Button
              size="sm"
              type="submit"
              disabled={!newName.trim() || createMut.isPending}
              className="h-7 flex-1 text-xs"
            >
              {createMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Create"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              className="h-7 text-xs"
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      <ScrollArea className="flex-1">
        {isLoading && (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">Loading…</p>
        )}
        {!isLoading && projects.length === 0 && !creating && (
          <div className="mx-3 rounded-lg border border-dashed border-border bg-card/50 p-4 text-center">
            <FolderPlus className="mx-auto mb-2 h-6 w-6 text-primary/40" />
            <p className="text-xs font-medium text-foreground">No spaces yet</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Try one for something you'll keep coming back to — Cortex will get smarter every time.
            </p>
            <Button
              size="sm"
              className="mt-3 h-7 text-xs"
              onClick={() => {
                setCreating(true);
                setNewName("");
              }}
            >
              Create your first space
            </Button>
          </div>
        )}
        <div className="space-y-0.5 px-2 pb-2">
          {projects.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              isExpanded={expanded === p.id}
              onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
              onDelete={() => setPendingDeleteProjectId(p.id)}
            />
          ))}
        </div>
      </ScrollArea>
      <AlertDialog
        open={!!pendingDeleteProjectId}
        onOpenChange={(o) => {
          if (!o) setPendingDeleteProjectId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this space?</AlertDialogTitle>
            <AlertDialogDescription>
              The chats inside will remain accessible individually.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDeleteProjectId) {
                  deleteMut.mutate(pendingDeleteProjectId);
                  setPendingDeleteProjectId(null);
                }
              }}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProjectRow({
  project,
  isExpanded,
  onToggle,
  onDelete,
}: {
  project: { id: string; name: string; color: string; chats?: number; memories?: number };
  isExpanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { setActive } = usePanel();

  const { data: convData } = useQuery({
    queryKey: ["project-convs", project.id],
    queryFn: () => listProjectConversations({ data: { project_id: project.id } }),
    enabled: isExpanded,
  });

  const createMut = useMutation({
    mutationFn: () => createConversation({ data: { project_id: project.id } }),
    onSuccess: ({ conversation }) => {
      qc.invalidateQueries({ queryKey: ["project-convs", project.id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      navigate({ to: "/c/$id", params: { id: conversation.id } });
      setActive(null);
    },
    onError: () => toast.error("Couldn't create chat."),
  });

  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState(project.name);

  const renameMut = useMutation({
    mutationFn: (name: string) => updateProject({ data: { id: project.id, name } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
    onError: () => toast.error("Couldn't rename space."),
  });

  const convs = convData?.conversations ?? [];
  const chatCount = project.chats ?? 0;
  const memCount = project.memories ?? 0;

  return (
    <div>
      <div className="group flex items-center rounded-md px-2 py-1.5 hover:bg-accent/60">
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: project.color }} />
          {editingName ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const n = editName.trim();
                if (n && n !== project.name) renameMut.mutate(n);
                setEditingName(false);
              }}
              onClick={(e) => e.stopPropagation()}
              className="flex-1"
            >
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => {
                  const n = editName.trim();
                  if (n && n !== project.name) renameMut.mutate(n);
                  setEditingName(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditingName(false);
                }}
                maxLength={100}
                className="h-6 w-full rounded border border-input bg-background px-1.5 text-sm outline-none focus:border-ring/60"
              />
            </form>
          ) : (
            <span className="truncate text-sm">{project.name}</span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation();
              createMut.mutate();
            }}
            title="New chat in this space"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setEditingName(true);
              setEditName(project.name);
            }}
            title="Rename space"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Archive space"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="mb-0.5 ml-5 border-l border-border pl-2">
          {/* What's in this space — mini-card */}
          <div className="mb-1.5 mt-1 flex items-center gap-3 rounded-md bg-accent/30 px-2 py-1.5 text-[11px] text-muted-foreground">
            <span title="Chats in this space" className="flex items-center gap-1">
              <span className="font-medium text-foreground">{chatCount}</span> chat
              {chatCount === 1 ? "" : "s"}
            </span>
            <span aria-hidden className="opacity-30">
              ·
            </span>
            <span
              title="Memories saved from chats in this space"
              className="flex items-center gap-1"
            >
              <span className="font-medium text-foreground">{memCount}</span> memor
              {memCount === 1 ? "y" : "ies"}
            </span>
          </div>

          {convs.length === 0 ? (
            <p className="py-1 text-xs text-muted-foreground">
              No chats yet. Click + to start one — Cortex will remember what you discuss here.
            </p>
          ) : (
            <div className="space-y-1">
              {groupConversationsByDate(convs).map((group) => (
                <Section
                  key={group.key}
                  title={group.title}
                  storageKey={`cortex.project.${project.id}.section.${group.key}`}
                  defaultOpen={group.key === "today"}
                  count={group.items.length}
                >
                  {group.items.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        navigate({ to: "/c/$id", params: { id: c.id } });
                        setActive(null);
                      }}
                      className="block w-full truncate rounded px-1 py-0.5 text-left text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                    >
                      {c.title ?? "Untitled chat"}
                    </button>
                  ))}
                </Section>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Data Sources ─────────────────────────────────────────────────────────────

const FILE_STATUS_STYLES: Record<string, string> = {
  ready: "text-green-600 bg-green-50 dark:bg-green-950/50",
  processing: "text-blue-600 bg-blue-50 dark:bg-blue-950/50",
  uploading: "text-blue-600 bg-blue-50 dark:bg-blue-950/50",
  error: "text-red-600 bg-red-50 dark:bg-red-950/50",
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function safeStorageRelativePath(path: string): string {
  return path
    .split("/")
    .map((part) => {
      const cleaned = Array.from(part.trim())
        .map((ch) => (ch.charCodeAt(0) < 32 || ["\\", "?", "#", "%"].includes(ch) ? "-" : ch))
        .join("")
        .replace(/^\.+$/, "-");
      return cleaned || "file";
    })
    .filter((part) => part !== "." && part !== "..")
    .join("/");
}

function formatDatasourceUploadError(error: { message?: string; statusCode?: string }): string {
  const msg = (error.message || "").toLowerCase();
  if (msg.includes("bucket") || msg.includes("not found")) {
    return "Data source storage is not ready yet. Please retry after the latest update finishes applying.";
  }
  if (msg.includes("row-level security") || msg.includes("violates row-level security policy")) {
    return "File uploads are blocked by storage permissions right now.";
  }
  if (msg.includes("size") || msg.includes("too large") || error.statusCode === "413") {
    return "That file exceeds the storage size limit.";
  }
  return error.message || "Upload failed.";
}

const CLOUD_STORAGE_SERVICES = [
  {
    service: "google_drive",
    name: "Google Drive",
    desc: "Sync Docs, Sheets, Slides and files",
    implemented: true,
  },
  {
    service: "google_docs",
    name: "Google Docs",
    desc: "Index your Google Docs documents",
    implemented: true,
  },
  {
    service: "google_sheets",
    name: "Google Sheets",
    desc: "Index your Google Sheets spreadsheets",
    implemented: true,
  },
  {
    service: "google_slides",
    name: "Google Slides",
    desc: "Index your Google Slides presentations",
    implemented: true,
  },
  {
    service: "onedrive",
    name: "OneDrive",
    desc: "Sync files from Microsoft OneDrive",
    implemented: true,
  },
  {
    service: "microsoft_word",
    name: "Microsoft Word",
    desc: "Index .docx files from OneDrive",
    implemented: true,
  },
  {
    service: "microsoft_excel",
    name: "Microsoft Excel",
    desc: "Index .xlsx files from OneDrive",
    implemented: true,
  },
  {
    service: "microsoft_powerpoint",
    name: "Microsoft PowerPoint",
    desc: "Index .pptx files from OneDrive",
    implemented: true,
  },
  {
    service: "microsoft_onenote",
    name: "Microsoft OneNote",
    desc: "Index OneNote notebooks and pages",
    implemented: true,
  },
];

function getFileIcon(name: string, status?: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const baseClass = cn(
    "h-4 w-4 shrink-0",
    status === "processing" || status === "uploading" ? "text-blue-500" : "",
  );
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext))
    return <FileImage className={cn(baseClass, "text-purple-500")} />;
  if (["xlsx", "xls", "csv", "tsv"].includes(ext))
    return <FileSpreadsheet className={cn(baseClass, "text-green-600")} />;
  if (
    [
      "py",
      "js",
      "ts",
      "tsx",
      "jsx",
      "java",
      "cpp",
      "c",
      "h",
      "hpp",
      "cs",
      "go",
      "rs",
      "rb",
      "php",
      "swift",
      "kt",
      "html",
      "htm",
      "css",
      "scss",
      "sh",
      "sql",
      "json",
      "xml",
      "yaml",
      "yml",
      "toml",
    ].includes(ext)
  )
    return <FileCode className={cn(baseClass, "text-amber-600")} />;
  if (["pdf", "doc", "docx", "txt", "md", "rtf", "ppt", "pptx"].includes(ext))
    return <FileText className={cn(baseClass, "text-blue-600")} />;
  return <File className={cn(baseClass, "text-muted-foreground")} />;
}

type FsNode =
  | { type: "folder"; name: string; path: string; children: FsNode[] }
  | { type: "file"; name: string; path: string; file: DatasourceFile };

function buildFileTree(files: DatasourceFile[]): FsNode {
  const root: FsNode = { type: "folder", name: "", path: "", children: [] };
  for (const f of files) {
    const parts = (f.name || "file").split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      const path = parts.slice(0, i + 1).join("/");
      let next = (cur.children as FsNode[]).find(
        (c): c is Extract<FsNode, { type: "folder" }> => c.type === "folder" && c.name === segment,
      );
      if (!next) {
        next = { type: "folder", name: segment, path, children: [] };
        (cur.children as FsNode[]).push(next);
      }
      cur = next;
    }
    const fileName = parts[parts.length - 1];
    (cur.children as FsNode[]).push({
      type: "file",
      name: fileName,
      path: parts.join("/"),
      file: f,
    });
  }
  // sort folders first, then files alphabetically
  const sortNode = (n: FsNode) => {
    if (n.type !== "folder") return;
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

function DatasourcesPanel() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<"files" | "cloud">("files");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const uploadCancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  const [currentPath, setCurrentPath] = useState<string>("");

  const { data, isLoading } = useQuery({
    queryKey: ["ds-files"],
    queryFn: () => listFiles({ data: {} }),
    refetchInterval: (query) => {
      const files =
        (query.state.data as Awaited<ReturnType<typeof listFiles>> | undefined)?.files ?? [];
      return files.some(
        (f: DatasourceFile) => f.status === "uploading" || f.status === "processing",
      )
        ? 2500
        : false;
    },
  });

  const { data: connData } = useQuery({
    queryKey: ["connectors", "list"],
    queryFn: () => listConnectors({ data: undefined as never }),
  });

  const { data: availData } = useQuery({
    queryKey: ["connector-availability"],
    queryFn: () => getConnectorAvailability({ data: undefined as never }),
    staleTime: 60_000,
  });

  const availability = availData ?? ({} as Record<string, boolean>);

  const files = data?.files ?? [];

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteDatasourceFile({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ds-files"] });
      toast.success("File removed.");
    },
    onError: () => toast.error("Couldn't remove file."),
  });

  const connectMut = useMutation({
    mutationFn: (service: string) =>
      initiateConnectorAuth({
        data: {
          service,
          redirect_uri: `${window.location.origin}/api/connectors/callback`,
        },
      }),
    onSuccess: (res) => {
      window.location.href = (res as { auth_url: string }).auth_url;
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't connect."),
  });

  const disconnectMut = useMutation({
    mutationFn: (id: string) => disconnectConnector({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connectors", "list"] });
      toast.success("Disconnected.");
    },
    onError: () => toast.error("Couldn't disconnect."),
  });

  const verifyMut = useMutation({
    mutationFn: (service: string) => verifyGoogleConnection({ data: { service } }),
    onSuccess: (res) => {
      const r = res as { ok: boolean; message: string; account?: { email?: string | null } };
      if (r.ok) {
        toast.success(r.account?.email ? `${r.message} (${r.account.email})` : r.message);
      } else {
        toast.error(r.message);
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Verification failed."),
  });

  const [pendingDeleteFileId, setPendingDeleteFileId] = useState<string | null>(null);
  const [pendingDisconnectId, setPendingDisconnectId] = useState<string | null>(null);

  async function uploadSingleFile(file: File): Promise<{ ok: boolean; error?: string }> {
    if (!user) return { ok: false, error: "Not signed in" };
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin";
      const relativePath =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const { file: record } = await createDatasourceFile({
        data: { name: relativePath, file_type: ext, file_size_bytes: file.size },
      });
      const fileId = record.id;
      const storagePath = `${user.id}/${fileId}/${safeStorageRelativePath(relativePath)}`;

      const { error: upErr } = await supabase.storage
        .from("datasource-files")
        .upload(storagePath, file, { upsert: false });

      if (upErr) {
        await deleteDatasourceFile({ data: { id: fileId } });
        return { ok: false, error: formatDatasourceUploadError(upErr) };
      }

      const { error: pathUpdateErr } = await supabase
        .from("datasource_files")
        .update({ storage_path: storagePath })
        .eq("id", fileId);
      if (pathUpdateErr) {
        await deleteDatasourceFile({ data: { id: fileId } });
        return { ok: false, error: "Failed to record file path" };
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        await deleteDatasourceFile({ data: { id: fileId } });
        return { ok: false, error: "Please sign in again and retry." };
      }

      const res = await fetch("/api/datasources/process", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          file_id: fileId,
          storage_path: storagePath,
          file_type: ext,
          file_name: relativePath,
        }),
      });
      if (!res.ok) {
        let errMsg = "Processing failed.";
        try {
          const body = await res.json();
          errMsg = body?.error ?? body?.message ?? errMsg;
        } catch {
          /* noop */
        }
        await deleteDatasourceFile({ data: { id: fileId } });
        return { ok: false, error: errMsg };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Upload failed" };
    }
  }

  async function handleFilesSelected(fileList: FileList | File[] | null) {
    if (!fileList || !user) return;
    const allFiles = Array.from(fileList).filter((f) => f.size > 0);
    if (allFiles.length === 0) return;

    const ALLOWED = new Set([
      "pdf",
      "docx",
      "doc",
      "txt",
      "md",
      "rtf",
      "xlsx",
      "xls",
      "csv",
      "tsv",
      "pptx",
      "ppt",
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "py",
      "js",
      "ts",
      "tsx",
      "jsx",
      "java",
      "cpp",
      "c",
      "h",
      "hpp",
      "cs",
      "go",
      "rs",
      "rb",
      "php",
      "swift",
      "kt",
      "html",
      "htm",
      "css",
      "scss",
      "sh",
      "sql",
      "json",
      "xml",
      "yaml",
      "yml",
      "toml",
    ]);
    const maxBytes = 50 * 1024 * 1024;

    const unsupported = allFiles.filter((f) => {
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      return !ALLOWED.has(ext);
    });
    const supported = allFiles.filter((f) => {
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      return ALLOWED.has(ext);
    });
    const tooLarge = supported.filter((f) => f.size > maxBytes);
    const valid = supported.filter((f) => f.size <= maxBytes);

    if (unsupported.length > 0) {
      toast.info(
        `${unsupported.length} unsupported file${unsupported.length === 1 ? "" : "s"} skipped.`,
      );
    }
    if (tooLarge.length > 0) {
      toast.error(
        `${tooLarge.length} file${tooLarge.length === 1 ? "" : "s"} exceed 50 MB and were skipped.`,
      );
    }
    if (valid.length === 0) {
      return;
    }

    uploadCancelRef.current = { cancelled: false };
    setUploading(true);
    setUploadProgress({ done: 0, total: valid.length });

    let succeeded = 0;
    let cancelled = 0;
    const failures: string[] = [];

    // Limit concurrency to 3 to avoid overwhelming the browser/server
    const CONCURRENCY = 3;
    let idx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, valid.length) }, async () => {
      while (idx < valid.length) {
        if (uploadCancelRef.current.cancelled) {
          cancelled = valid.length - idx;
          break;
        }
        const myIdx = idx++;
        const file = valid[myIdx];
        const result = await uploadSingleFile(file);
        if (result.ok) {
          succeeded++;
        } else {
          failures.push(`${file.name}: ${result.error ?? "failed"}`);
        }
        setUploadProgress((p) =>
          p ? { done: p.done + 1, total: p.total } : { done: 1, total: valid.length },
        );
        qc.invalidateQueries({ queryKey: ["ds-files"] });
      }
    });
    await Promise.all(workers);

    const wasCancelled = uploadCancelRef.current.cancelled;
    setUploading(false);
    setUploadProgress(null);
    qc.invalidateQueries({ queryKey: ["ds-files"] });

    if (wasCancelled) {
      toast.info(`Upload cancelled. ${succeeded} uploaded, ${cancelled} skipped.`);
    } else if (succeeded > 0 && failures.length === 0) {
      toast.success(succeeded === 1 ? "File is processing." : `${succeeded} files are processing.`);
    } else if (succeeded > 0 && failures.length > 0) {
      toast.warning(`${succeeded} uploaded, ${failures.length} failed. ${failures[0]}`);
    } else {
      toast.error(`Upload failed: ${failures[0] ?? "unknown error"}`);
    }
  }

  function cancelUpload() {
    uploadCancelRef.current.cancelled = true;
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = "";
    await handleFilesSelected(files);
  }

  const connectedStorage = (connData?.connected ?? []).filter((c) =>
    CLOUD_STORAGE_SERVICES.some((s) => s.service === c.service),
  );

  const tree = buildFileTree(files);

  // Navigate to a folder node by path
  const currentNode: FsNode = (() => {
    if (!currentPath) return tree;
    const parts = currentPath.split("/").filter(Boolean);
    let cur: FsNode = tree;
    for (const p of parts) {
      if (cur.type !== "folder") break;
      const next = cur.children.find((c) => c.type === "folder" && c.name === p);
      if (!next) return tree; // path no longer exists
      cur = next;
    }
    return cur;
  })();

  // Reset path if it became invalid
  useEffect(() => {
    if (currentPath && currentNode === tree && currentPath !== "") {
      setCurrentPath("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.length]);

  const breadcrumbs = currentPath ? currentPath.split("/").filter(Boolean) : [];

  const sortedChildren =
    currentNode.type === "folder"
      ? [...currentNode.children].sort((a, b) => {
          if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
          // file ordering: active first
          if (a.type === "file" && b.type === "file") {
            const ord: Record<string, number> = {
              uploading: 0,
              processing: 0,
              error: 1,
              ready: 2,
            };
            const oa = ord[a.file.status] ?? 3;
            const ob = ord[b.file.status] ?? 3;
            if (oa !== ob) return oa - ob;
          }
          return a.name.localeCompare(b.name);
        })
      : [];

  async function viewFile(f: DatasourceFile) {
    if (!f.storage_path) {
      toast.error("This file's original isn't available to preview. Try re-uploading.");
      return;
    }
    const { data: signed, error } = await supabase.storage
      .from("datasource-files")
      .createSignedUrl(f.storage_path, 60 * 10);
    if (error || !signed?.signedUrl) {
      toast.error("I ran into a problem opening that file.");
      return;
    }
    window.open(signed.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function downloadFile(f: DatasourceFile) {
    if (!f.storage_path) {
      toast.error("This file's original isn't available to download. Try re-uploading.");
      return;
    }
    const fileName = f.name.split("/").pop() || f.name;
    const { data: signed, error } = await supabase.storage
      .from("datasource-files")
      .createSignedUrl(f.storage_path, 60 * 10, { download: fileName });
    if (error || !signed?.signedUrl) {
      toast.error("I ran into a problem downloading that file.");
      return;
    }
    const a = window.document.createElement("a");
    a.href = signed.signedUrl;
    a.download = fileName;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.click();
  }

  const totalFileCount = files.length;

  return (
    <div className="flex h-full flex-col">
      {/* Tabs */}
      <div className="flex shrink-0 gap-0.5 border-b border-border px-4 pb-0 pt-1">
        {(["files", "cloud"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-3 py-2 text-xs font-medium capitalize transition-colors",
              tab === t
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "files" ? "Uploaded Files" : "Cloud Sources"}
          </button>
        ))}
      </div>

      {tab === "files" && (
        <>
          <div className="flex shrink-0 flex-col gap-1.5 px-4 py-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="sr-only"
              onChange={handleFileChange}
              accept=".pdf,.docx,.doc,.txt,.md,.rtf,.xlsx,.xls,.csv,.pptx,.ppt,.png,.jpg,.jpeg,.gif,.webp,.py,.js,.ts,.tsx,.jsx,.java,.cpp,.c,.rs,.go,.rb,.php,.swift,.kt,.html,.css,.json,.yaml,.sql"
            />
            <input
              ref={folderRef}
              type="file"
              multiple
              className="sr-only"
              onChange={handleFileChange}
              // @ts-expect-error - non-standard but widely supported
              webkitdirectory=""
              directory=""
            />
            <div className="flex items-center gap-2">
              <p className="flex-1 text-[11px] text-muted-foreground">
                PDFs, Docs, Code, Spreadsheets
              </p>
              <button
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1.5 text-xs text-primary hover:underline disabled:opacity-50"
              >
                {uploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {uploading ? "Uploading…" : "Upload files"}
              </button>
              <button
                disabled={uploading}
                onClick={() => folderRef.current?.click()}
                className="flex items-center gap-1.5 text-xs text-primary hover:underline disabled:opacity-50"
              >
                <FolderUp className="h-3.5 w-3.5" />
                Folder
              </button>
            </div>
            {uploadProgress && (
              <div className="flex items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${
                        uploadProgress.total > 0
                          ? (uploadProgress.done / uploadProgress.total) * 100
                          : 0
                      }%`,
                    }}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {uploadProgress.done}/{uploadProgress.total}
                </p>
                <button
                  onClick={cancelUpload}
                  className="text-[11px] text-destructive hover:underline"
                  title="Cancel upload"
                >
                  Cancel
                </button>
              </div>
            )}
            {/* Breadcrumbs */}
            {totalFileCount > 0 && (
              <div className="flex items-center gap-1 overflow-x-auto text-[11px] text-muted-foreground">
                {currentPath && (
                  <button
                    onClick={() => {
                      const parts = currentPath.split("/").filter(Boolean);
                      parts.pop();
                      setCurrentPath(parts.join("/"));
                    }}
                    className="flex h-5 w-5 items-center justify-center rounded hover:bg-accent hover:text-foreground"
                    title="Up"
                  >
                    <ArrowLeft className="h-3 w-3" />
                  </button>
                )}
                <button
                  onClick={() => setCurrentPath("")}
                  className={cn(
                    "rounded px-1 py-0.5 hover:bg-accent hover:text-foreground",
                    !currentPath && "font-medium text-foreground",
                  )}
                >
                  All files
                </button>
                {breadcrumbs.map((seg, i) => {
                  const path = breadcrumbs.slice(0, i + 1).join("/");
                  const isLast = i === breadcrumbs.length - 1;
                  return (
                    <span key={path} className="flex items-center gap-1">
                      <ChevronRight className="h-3 w-3" />
                      <button
                        onClick={() => setCurrentPath(path)}
                        className={cn(
                          "max-w-[120px] truncate rounded px-1 py-0.5 hover:bg-accent hover:text-foreground",
                          isLast && "font-medium text-foreground",
                        )}
                        title={seg}
                      >
                        {seg}
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <ScrollArea className="flex-1">
            {isLoading && (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">Loading…</p>
            )}
            {!isLoading && totalFileCount === 0 && (
              <div className="px-4 py-8 text-center">
                <Upload className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
                <p className="text-xs text-muted-foreground">No files yet.</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Upload PDFs, documents, spreadsheets, or code to use as context in any chat.
                </p>
              </div>
            )}
            {!isLoading && totalFileCount > 0 && sortedChildren.length === 0 && (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                This folder is empty.
              </p>
            )}
            <div className="space-y-0.5 px-2 pb-2">
              {sortedChildren.map((node) => {
                if (node.type === "folder") {
                  // Count files within this folder recursively
                  const countFiles = (n: FsNode): number =>
                    n.type === "file" ? 1 : n.children.reduce((acc, c) => acc + countFiles(c), 0);
                  const fileCount = countFiles(node);
                  return (
                    <button
                      key={`folder-${node.path}`}
                      onClick={() => setCurrentPath(node.path)}
                      className="group flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/40"
                    >
                      <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium">{node.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {fileCount} {fileCount === 1 ? "item" : "items"}
                        </p>
                      </div>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  );
                }
                const f = node.file;
                const isActive = f.status === "processing" || f.status === "uploading";
                const canOpen = f.status === "ready";
                return (
                  <div
                    key={f.id}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-2 hover:bg-accent/40"
                  >
                    {getFileIcon(f.name, f.status)}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium" title={f.name}>
                        {node.name}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {fmtBytes(f.file_size_bytes ?? 0)}
                      </p>
                    </div>
                    <div className="grid shrink-0 grid-flow-col auto-cols-[1.5rem] items-center justify-end gap-0.5">
                      {isActive && (
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] font-medium capitalize",
                            FILE_STATUS_STYLES[f.status] ?? "",
                          )}
                        >
                          <span className="flex items-center gap-1">
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            {f.status}
                          </span>
                        </span>
                      )}
                      {f.status === "error" && (
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] font-medium capitalize",
                            FILE_STATUS_STYLES.error,
                          )}
                        >
                          error
                        </span>
                      )}
                      {canOpen && (
                        <button
                          onClick={() => viewFile(f)}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                          title="View"
                          aria-label="View file"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {canOpen && (
                        <button
                          onClick={() => downloadFile(f)}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                          title="Download"
                          aria-label="Download file"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {(f.status === "ready" || f.status === "error") && (
                        <button
                          onClick={() => setPendingDeleteFileId(f.id)}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
                          title="Remove file"
                          aria-label="Remove file"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </>
      )}

      {tab === "cloud" && (
        <ScrollArea className="flex-1">
          <div className="space-y-3 px-4 py-3">
            {connectedStorage.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Connected
                </p>
                <div className="space-y-2">
                  {connectedStorage.map((c) => {
                    const svc = CLOUD_STORAGE_SERVICES.find((s) => s.service === c.service);
                    return (
                      <div key={c.id} className="rounded-lg border border-border bg-background p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium">{svc?.name ?? c.service}</p>
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[10px] font-medium",
                              c.status === "syncing"
                                ? "bg-blue-50 text-blue-600 dark:bg-blue-950/50"
                                : c.status === "paused"
                                  ? "bg-yellow-50 text-yellow-600 dark:bg-yellow-950/50"
                                  : "bg-green-50 text-green-600 dark:bg-green-950/50",
                            )}
                          >
                            {c.status === "syncing" ? (
                              <span className="flex items-center gap-1">
                                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                Syncing
                              </span>
                            ) : (
                              c.status
                            )}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {c.items_indexed != null ? `${c.items_indexed} items indexed` : ""}
                          {c.last_synced_at ? ` · synced ${relativeTime(c.last_synced_at)}` : ""}
                        </p>
                        <div className="mt-2 flex gap-1.5">
                          {c.service.startsWith("google") || c.service === "gmail" ? (
                            <button
                              onClick={() => verifyMut.mutate(c.service)}
                              disabled={verifyMut.isPending}
                              className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                            >
                              {verifyMut.isPending && verifyMut.variables === c.service ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : null}
                              Verify
                            </button>
                          ) : null}
                          <button
                            onClick={() => setPendingDisconnectId(c.id)}
                            disabled={disconnectMut.isPending}
                            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-destructive/50 hover:text-destructive disabled:opacity-50"
                          >
                            Disconnect
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {connectedStorage.length > 0 ? "Add more" : "Connect a cloud source"}
              </p>
              <div className="space-y-2">
                {CLOUD_STORAGE_SERVICES.filter(
                  (s) => !connectedStorage.some((c) => c.service === s.service),
                ).map((s) => {
                  const isConfigured = availability[s.service] ?? false;
                  const isPremiumOnly = s.service !== "google_drive";
                  const canConnect = s.implemented && isConfigured && !isPremiumOnly;
                  return (
                    <div
                      key={s.service}
                      className={cn(
                        "rounded-lg border border-border bg-background p-3",
                        !canConnect && "opacity-60",
                        isPremiumOnly && "grayscale",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{s.name}</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">{s.desc}</p>
                        </div>
                        {isPremiumOnly ? (
                          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            Premium
                          </span>
                        ) : canConnect ? (
                          <button
                            onClick={() => connectMut.mutate(s.service)}
                            disabled={connectMut.isPending}
                            className="flex shrink-0 items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                          >
                            {connectMut.isPending ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <ExternalLink className="h-3 w-3" />
                            )}
                            Connect
                          </button>
                        ) : s.implemented && !isConfigured ? (
                          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            Not configured
                          </span>
                        ) : (
                          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            Soon
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </ScrollArea>
      )}
      <AlertDialog
        open={!!pendingDeleteFileId}
        onOpenChange={(o) => {
          if (!o) setPendingDeleteFileId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this file?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the file and its indexed content.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDeleteFileId) {
                  deleteMut.mutate(pendingDeleteFileId);
                  setPendingDeleteFileId(null);
                }
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!pendingDisconnectId}
        onOpenChange={(o) => {
          if (!o) setPendingDisconnectId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this service?</AlertDialogTitle>
            <AlertDialogDescription>
              Indexed content from this service will be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDisconnectId) {
                  disconnectMut.mutate(pendingDisconnectId);
                  setPendingDisconnectId(null);
                }
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Connectors ───────────────────────────────────────────────────────────────

const CONNECTOR_STATUS_STYLES: Record<string, { badge: string; label: string }> = {
  connected: { badge: "text-green-600 bg-green-50 dark:bg-green-950/50", label: "Connected" },
  syncing: { badge: "text-blue-600 bg-blue-50 dark:bg-blue-950/50", label: "Syncing" },
  paused: { badge: "text-yellow-600 bg-yellow-50 dark:bg-yellow-950/50", label: "Paused" },
  error: { badge: "text-red-600 bg-red-50 dark:bg-red-950/50", label: "Error" },
};

// Services that appear in Connectors (not cloud storage)
const CONNECTOR_ONLY_SERVICES = new Set([
  "slack",
  "microsoft_teams",
  "gmail",
  "microsoft_outlook",
  "google_calendar",
]);

const CONNECTOR_GROUPS: { label: string; services: string[]; desc: string }[] = [
  { label: "Messaging", services: ["slack", "microsoft_teams"], desc: "" },
  { label: "Email", services: ["gmail", "microsoft_outlook"], desc: "" },
  { label: "Calendar", services: ["google_calendar"], desc: "" },
];

const CONNECTOR_META: Record<string, { name: string; desc: string; implemented: boolean }> = {
  slack: { name: "Slack", desc: "Index channel messages, threads and files", implemented: true },
  microsoft_teams: {
    name: "Microsoft Teams",
    desc: "Index Teams messages and channels",
    implemented: true,
  },
  gmail: { name: "Gmail", desc: "Index email threads and attachments", implemented: true },
  microsoft_outlook: {
    name: "Microsoft Outlook",
    desc: "Index Outlook email threads",
    implemented: true,
  },
  google_calendar: {
    name: "Google Calendar",
    desc: "Index events from your primary calendar",
    implemented: true,
  },
};

function ConnectorsPanel() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["connectors", "available"],
    queryFn: () => listConnectors({ data: undefined as never }),
  });

  const { data: availData } = useQuery({
    queryKey: ["connector-availability"],
    queryFn: () => getConnectorAvailability({ data: undefined as never }),
    staleTime: 60_000,
  });

  const availability = availData ?? ({} as Record<string, boolean>);

  const allConnected = data?.connected ?? [];
  const connected = allConnected.filter((c) => CONNECTOR_ONLY_SERVICES.has(c.service));

  const connectMut = useMutation({
    mutationFn: (service: string) =>
      initiateConnectorAuth({
        data: {
          service,
          redirect_uri: `${window.location.origin}/api/connectors/callback`,
        },
      }),
    onSuccess: (res) => {
      window.location.href = (res as { auth_url: string }).auth_url;
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't connect."),
  });

  const pauseMut = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) =>
      pauseConnector({ data: { id, paused } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connectors", "available"] }),
    onError: () => toast.error("Couldn't update connector."),
  });

  const disconnectMut = useMutation({
    mutationFn: (id: string) => disconnectConnector({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connectors", "available"] });
      toast.success("Connector disconnected.");
    },
    onError: () => toast.error("Couldn't disconnect."),
  });

  const [pendingDisconnectId, setPendingDisconnectId] = useState<string | null>(null);

  const connectedServices = new Set(connected.map((c) => c.service));

  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 px-4 py-3">
        <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-[12px] leading-relaxed text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-300">
          <p className="font-medium">Connectors are a premium feature</p>
          <p className="mt-0.5 text-amber-700 dark:text-amber-400/90">
            Upgrade to a premium plan to connect your apps and bring their data into Cortex.
          </p>
        </div>

        {isLoading && <p className="py-4 text-center text-xs text-muted-foreground">Loading…</p>}

        {connected.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Connected
            </p>
            <div className="space-y-2">
              {connected.map((c) => {
                const meta = CONNECTOR_META[c.service];
                const style =
                  CONNECTOR_STATUS_STYLES[c.status] ?? CONNECTOR_STATUS_STYLES.connected;
                const isPaused = c.status === "paused";
                return (
                  <div key={c.id} className="rounded-lg border border-border bg-background p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{meta?.name ?? c.service}</p>
                      <span
                        className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                          style.badge,
                        )}
                      >
                        {c.status === "syncing" ? (
                          <span className="flex items-center gap-1">
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            Syncing
                          </span>
                        ) : (
                          style.label
                        )}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {c.items_indexed != null ? `${c.items_indexed} items indexed` : ""}
                      {c.last_synced_at ? ` · synced ${relativeTime(c.last_synced_at)}` : ""}
                    </p>
                    {c.error_message && (
                      <p className="mt-1 text-[11px] text-red-500">{c.error_message}</p>
                    )}
                    <div className="mt-2 flex gap-1.5">
                      <button
                        onClick={() => pauseMut.mutate({ id: c.id, paused: !isPaused })}
                        disabled={pauseMut.isPending}
                        className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                      >
                        {isPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                        {isPaused ? "Resume" : "Pause"}
                      </button>
                      <button
                        onClick={() => setPendingDisconnectId(c.id)}
                        disabled={disconnectMut.isPending}
                        className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-destructive/50 hover:text-destructive disabled:opacity-50"
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {CONNECTOR_GROUPS.map((group) => {
          const ungrouped = group.services.filter((s) => !connectedServices.has(s));
          if (ungrouped.length === 0) return null;
          return (
            <div key={group.label}>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {group.label}
              </p>
              <div className="space-y-1.5">
                {ungrouped.map((service) => {
                  const meta = CONNECTOR_META[service];
                  if (!meta) return null;
                  const isConfigured = availability[service] ?? false;
                  // Premium-gated: connectors are disabled for all users.
                  const canConnect = false;
                  void isConfigured;
                  return (
                    <div
                      key={service}
                      className={cn(
                        "rounded-lg border border-border bg-background p-3 opacity-50 grayscale",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{meta.name}</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">{meta.desc}</p>
                        </div>
                        {canConnect ? null : (
                          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            Premium
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {!isLoading && connected.length === 0 && (
          <p className="py-2 text-center text-xs text-muted-foreground">
            Connect services to bring their data into your chats.
          </p>
        )}
      </div>
      <AlertDialog
        open={!!pendingDisconnectId}
        onOpenChange={(o) => {
          if (!o) setPendingDisconnectId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this service?</AlertDialogTitle>
            <AlertDialogDescription>
              Indexed content from this service will be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDisconnectId) {
                  disconnectMut.mutate(pendingDisconnectId);
                  setPendingDisconnectId(null);
                }
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  );
}

function groupByType(memories: MemoryEntry[]): Record<string, MemoryEntry[]> {
  const out: Record<string, MemoryEntry[]> = {};
  // Pinned memories surface first within each group
  const sorted = [...memories].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.confidence - a.confidence;
  });
  for (const m of sorted) {
    (out[m.type] ??= []).push(m);
  }
  return out;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function MemoryPanel() {
  const [tab, setTab] = useState<"memories" | "persona" | "insights">("memories");
  const qc = useQueryClient();

  const { data: memoriesData, isLoading: memoriesLoading } = useQuery({
    queryKey: ["memories"],
    queryFn: () => getMemories({ data: {} }),
  });

  const { data: ukmData, isLoading: ukmLoading } = useQuery({
    queryKey: ["ukm"],
    queryFn: () => getUkm({ data: {} }),
  });

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ["memory-stats"],
    queryFn: () => getMemoryStats({ data: {} }),
  });

  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) => toggleMemory({ data: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ukm"] }),
    onError: () => toast.error("Couldn't update memory setting."),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteMemory({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["memories"] });
      qc.invalidateQueries({ queryKey: ["memory-stats"] });
      toast.success("Memory deleted.");
    },
    onError: () => toast.error("Couldn't delete memory."),
  });

  const [pendingDeleteMemId, setPendingDeleteMemId] = useState<string | null>(null);

  const memoryEnabled = ukmData?.memoryEnabled ?? true;
  const memories = (memoriesData?.memories ?? []) as MemoryEntry[];
  const recentSignals = (ukmData?.recentSignals ?? []) as RecentPersonaSignal[];
  const grouped = groupByType(memories);

  const TABS = [
    { id: "memories" as const, label: "Memories" },
    { id: "persona" as const, label: "Persona" },
    { id: "insights" as const, label: "Insights" },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Master learning controls — govern both Memories and Persona */}
      <div className="shrink-0 space-y-3 border-b border-border px-3 py-3">
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
          <div className="flex items-start gap-2">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">Cortex learns as you chat</p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Mention things naturally — like <span className="italic">"I'm vegetarian"</span> or{" "}
                <span className="italic">"keep answers short"</span> — and Cortex remembers. Both
                your memories and persona below are built from these chats.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
          <div className="pr-3">
            <p className="text-sm font-medium">Learn from conversations</p>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Turn off to stop saving anything new. Existing entries stay until you delete them.
            </p>
          </div>
          <Switch
            checked={memoryEnabled}
            onCheckedChange={(v) => toggleMut.mutate(v)}
            aria-label={memoryEnabled ? "Disable learning" : "Enable learning"}
          />
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex shrink-0 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex-1 py-2 text-xs font-medium transition",
              tab === t.id
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ScrollArea className="flex-1">
        {!memoryEnabled && (
          <div className="mx-3 mt-3 rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
            Learning is paused. Cortex won't add to your memories or persona until you turn it back
            on. Existing entries are kept.
          </div>
        )}
        {tab === "memories" && (
          <MemoriesTab
            memories={memories}
            grouped={grouped}
            recentSignals={recentSignals}
            memoryEnabled={memoryEnabled}
            isLoading={memoriesLoading}
            onToggle={(v) => toggleMut.mutate(v)}
            onDelete={(id) => setPendingDeleteMemId(id)}
            onRefresh={() => {
              qc.invalidateQueries({ queryKey: ["memories"] });
              qc.invalidateQueries({ queryKey: ["memory-stats"] });
            }}
          />
        )}
        {tab === "persona" && (
          <PersonaTab
            ukm={ukmData?.ukm ?? null}
            recentSignals={recentSignals}
            isLoading={ukmLoading}
          />
        )}
        {tab === "insights" && (
          <InsightsTab
            memories={memories}
            ukm={ukmData?.ukm ?? null}
            stats={statsData ?? null}
            statsLoading={statsLoading}
          />
        )}
      </ScrollArea>
      <AlertDialog
        open={!!pendingDeleteMemId}
        onOpenChange={(o) => {
          if (!o) setPendingDeleteMemId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this memory?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDeleteMemId) {
                  deleteMut.mutate(pendingDeleteMemId);
                  setPendingDeleteMemId(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MemoriesTab({
  memories,
  grouped,
  recentSignals,
  memoryEnabled,
  isLoading,
  onToggle,
  onDelete,
  onRefresh,
}: {
  memories: MemoryEntry[];
  grouped: Record<string, MemoryEntry[]>;
  recentSignals: RecentPersonaSignal[];
  memoryEnabled: boolean;
  isLoading: boolean;
  onToggle: (v: boolean) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-4 px-3 py-3">
      {/* Granular memory preferences (only meaningful when learning is on) */}
      {memoryEnabled && <MemoryPreferencesSection />}

      {/* Memory list */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-md bg-muted/60" />
          ))}
        </div>
      ) : memories.length === 0 ? (
        <div className="space-y-3">
          {recentSignals.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-card/50 p-4 text-center">
              <Brain className="mx-auto mb-2 h-6 w-6 text-primary/40" />
              <p className="text-xs font-medium text-foreground">Nothing saved yet</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Start a conversation and share a preference or detail about yourself.
              </p>
            </div>
          ) : (
            <>
              <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Recent signals
              </p>
              {recentSignals.map((signal, index) => (
                <div
                  key={`${signal.createdAt}-${index}`}
                  className="rounded-md bg-accent/40 px-3 py-2"
                >
                  <p className="line-clamp-3 text-xs leading-relaxed text-foreground/85">
                    {signal.content}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {relativeTime(signal.createdAt)}
                  </p>
                </div>
              ))}
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {MEMORY_TYPE_META.filter((t) => (grouped[t.value]?.length ?? 0) > 0).map((typeInfo) => (
            <div key={typeInfo.value}>
              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <span>{typeInfo.emoji}</span>
                <span>{typeInfo.label}</span>
                <span className="ml-auto font-normal opacity-60">
                  {grouped[typeInfo.value].length}
                </span>
              </div>
              <div className="space-y-0.5">
                {grouped[typeInfo.value].map((m) => (
                  <MemoryItem key={m.id} memory={m} onDelete={onDelete} onSaved={onRefresh} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryItem({
  memory,
  onDelete,
  onSaved,
}: {
  memory: MemoryEntry;
  onDelete: (id: string) => void;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);

  const updateMut = useMutation({
    mutationFn: (content: string) => updateMemory({ data: { id: memory.id, content } }),
    onSuccess: () => {
      setEditing(false);
      onSaved();
      toast.success("Memory updated.");
    },
    onError: () => toast.error("Couldn't save."),
  });

  const pinMut = useMutation({
    mutationFn: (pinned: boolean) => pinMemory({ data: { id: memory.id, pinned } }),
    onSuccess: () => {
      onSaved();
      toast.success(memory.pinned ? "Unpinned." : "Pinned — will always surface first.");
    },
    onError: () => toast.error("Couldn't update pin."),
  });

  if (editing) {
    return (
      <div className="space-y-1.5 rounded-md border border-input bg-background/50 p-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={1000}
          rows={2}
          className="w-full resize-none bg-transparent text-xs outline-none"
          autoFocus
        />
        <div className="flex justify-end gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => {
              setEditing(false);
              setDraft(memory.content);
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => updateMut.mutate(draft.trim())}
            disabled={!draft.trim() || updateMut.isPending}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  const confidencePct = Math.round((memory.confidence ?? 0) * 100);

  return (
    <div className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition hover:bg-accent/40">
      {memory.pinned && <Pin className="mt-0.5 h-3 w-3 shrink-0 fill-primary text-primary" />}
      <div className="min-w-0 flex-1">
        <p className="text-xs leading-relaxed text-foreground/90">{memory.content}</p>
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground/50">
          <span title="Confidence score">{confidencePct}%</span>
          {memory.accessCount > 0 && (
            <span title="Times used in responses">×{memory.accessCount}</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
        <button
          onClick={() => pinMut.mutate(!memory.pinned)}
          aria-label={memory.pinned ? "Unpin memory" : "Pin memory"}
          title={memory.pinned ? "Unpin" : "Pin — always surface first"}
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded transition",
            memory.pinned
              ? "text-primary hover:text-primary/70"
              : "text-muted-foreground hover:text-foreground",
          )}
          disabled={pinMut.isPending}
        >
          <Pin className="h-3 w-3" />
        </button>
        <button
          onClick={() => setEditing(true)}
          aria-label="Edit memory"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          onClick={() => onDelete(memory.id)}
          aria-label="Delete memory"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function PersonaTab({
  ukm,
  recentSignals,
  isLoading,
}: {
  ukm: UserKnowledgeModel | null;
  recentSignals: RecentPersonaSignal[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-md bg-muted/60" />
        ))}
      </div>
    );
  }

  const hasIdentity = ukm && Object.values(ukm.identity).some(Boolean);
  const hasStyle = ukm && Object.values(ukm.communicationStyle).some(Boolean);
  const hasRelationships = (ukm?.relationships.length ?? 0) > 0;
  const hasPreferences =
    ukm &&
    (ukm.preferences.responseFormat ||
      (ukm.preferences.avoidTopics?.length ?? 0) > 0 ||
      (ukm.preferences.preferredSources?.length ?? 0) > 0);
  const hasContent =
    hasIdentity ||
    hasStyle ||
    hasRelationships ||
    hasPreferences ||
    (ukm?.expertise.length ?? 0) > 0 ||
    (ukm?.activeProjects.length ?? 0) > 0 ||
    (ukm?.antiPreferences.length ?? 0) > 0 ||
    (ukm?.corrections.length ?? 0) > 0 ||
    (ukm?.responseStyleDislikes.length ?? 0) > 0;

  if (!hasContent) {
    return (
      <div className="space-y-4 px-4 py-4">
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="text-sm font-medium text-foreground/80">Persona is still learning</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            I haven&apos;t found enough clear preferences to build a full profile yet, but your
            recent conversation signals are below.
          </p>
        </div>
        {recentSignals.length > 0 ? (
          <PersonaSection title="Recent signals">
            <div className="space-y-2">
              {recentSignals.map((signal, index) => (
                <div
                  key={`${signal.createdAt}-${index}`}
                  className="rounded-md bg-accent/40 px-3 py-2"
                >
                  <p className="line-clamp-3 text-xs leading-relaxed text-foreground/85">
                    {signal.content}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {relativeTime(signal.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          </PersonaSection>
        ) : (
          <div className="px-2 py-6 text-center">
            <Brain className="mx-auto mb-3 h-10 w-10 text-primary/20" />
            <p className="text-xs text-muted-foreground">
              Chat naturally and I&apos;ll learn your style, preferences, and expertise over time.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5 px-4 py-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          Built from your conversations — used to personalize every response.
        </p>
        {(ukm?.correctionCount ?? 0) > 0 && (
          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
            {ukm!.correctionCount} corrections
          </span>
        )}
      </div>

      {hasIdentity && (
        <PersonaSection title="Identity">
          {ukm!.identity.name && <PersonaRow label="Name" value={ukm!.identity.name} />}
          {ukm!.identity.role && <PersonaRow label="Role" value={ukm!.identity.role} />}
          {ukm!.identity.company && <PersonaRow label="Company" value={ukm!.identity.company} />}
          {ukm!.identity.team && <PersonaRow label="Team" value={ukm!.identity.team} />}
        </PersonaSection>
      )}

      {hasStyle && (
        <PersonaSection title="Communication style">
          {ukm!.communicationStyle.verbosity && (
            <PersonaRow label="Verbosity" value={ukm!.communicationStyle.verbosity} />
          )}
          {ukm!.communicationStyle.format && (
            <PersonaRow label="Format" value={ukm!.communicationStyle.format} />
          )}
          {ukm!.communicationStyle.tone && (
            <PersonaRow label="Tone" value={ukm!.communicationStyle.tone} />
          )}
        </PersonaSection>
      )}

      {hasPreferences && (
        <PersonaSection title="Preferences">
          {ukm!.preferences.responseFormat && (
            <PersonaRow label="Response format" value={ukm!.preferences.responseFormat} />
          )}
          {(ukm!.preferences.avoidTopics?.length ?? 0) > 0 && (
            <div className="mt-1">
              <p className="mb-1 text-[10px] text-muted-foreground">Avoid topics</p>
              <div className="flex flex-wrap gap-1">
                {ukm!.preferences.avoidTopics!.map((t, i) => (
                  <span
                    key={i}
                    className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive/80"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
          {(ukm!.preferences.preferredSources?.length ?? 0) > 0 && (
            <div className="mt-1">
              <p className="mb-1 text-[10px] text-muted-foreground">Preferred sources</p>
              <div className="flex flex-wrap gap-1">
                {ukm!.preferences.preferredSources!.map((s, i) => (
                  <span
                    key={i}
                    className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}
        </PersonaSection>
      )}

      {(ukm?.expertise.length ?? 0) > 0 && (
        <PersonaSection title="Expertise">
          <div className="flex flex-wrap gap-1.5">
            {ukm!.expertise.map((e, i) => (
              <span
                key={i}
                className="rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
              >
                {e}
              </span>
            ))}
          </div>
        </PersonaSection>
      )}

      {(ukm?.activeProjects.length ?? 0) > 0 && (
        <PersonaSection title="Active projects">
          <ul className="space-y-0.5">
            {ukm!.activeProjects.map((p, i) => (
              <li key={i} className="text-xs">
                · {p}
              </li>
            ))}
          </ul>
        </PersonaSection>
      )}

      {hasRelationships && (
        <PersonaSection title="People">
          <div className="space-y-1">
            {ukm!.relationships.map((r, i) => (
              <div key={i} className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{r.name}</span>
                <span className="text-[11px] text-muted-foreground">{r.role}</span>
              </div>
            ))}
          </div>
        </PersonaSection>
      )}

      {(ukm?.antiPreferences.length ?? 0) > 0 && (
        <PersonaSection title="Things to avoid">
          <ul className="space-y-0.5">
            {ukm!.antiPreferences.map((a, i) => (
              <li key={i} className="text-xs text-destructive/80">
                · {a}
              </li>
            ))}
          </ul>
        </PersonaSection>
      )}

      {(ukm?.responseStyleDislikes.length ?? 0) > 0 && (
        <PersonaSection title="Response style dislikes">
          <ul className="space-y-0.5">
            {ukm!.responseStyleDislikes.map((r, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                · {r}
              </li>
            ))}
          </ul>
        </PersonaSection>
      )}

      {(ukm?.corrections.length ?? 0) > 0 && (
        <PersonaSection title="Things I've corrected">
          <ul className="space-y-0.5">
            {ukm!.corrections.map((c, i) => (
              <li key={i} className="text-xs">
                · {c}
              </li>
            ))}
          </ul>
        </PersonaSection>
      )}

      <p className="pb-2 text-[10px] text-muted-foreground/60">
        Updated automatically after each conversation.
      </p>
    </div>
  );
}

function PersonaSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function PersonaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 py-0.5 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="capitalize">{value}</span>
    </div>
  );
}

// ---------- Insights Tab ----------

interface MemoryStatsResult {
  totalResponses: number;
  responsesWithMemory: number;
  totalMemoriesInjected: number;
  avgMemoriesPerResponse: number;
}

function InsightsTab({
  memories,
  ukm,
  stats,
  statsLoading,
}: {
  memories: MemoryEntry[];
  ukm: UserKnowledgeModel | null;
  stats: MemoryStatsResult | null;
  statsLoading: boolean;
}) {
  const grouped = groupByType(memories);

  const high = memories.filter((m) => m.confidence >= 0.8).length;
  const med = memories.filter((m) => m.confidence >= 0.6 && m.confidence < 0.8).length;
  const low = memories.filter((m) => m.confidence < 0.6).length;
  const unused = memories.filter((m) => m.accessCount === 0).length;

  const identityFilled = Object.values(ukm?.identity ?? {}).filter(Boolean).length;
  const styleFilled = Object.values(ukm?.communicationStyle ?? {}).filter(Boolean).length;
  const expertiseCount = ukm?.expertise?.length ?? 0;
  const projectsCount = ukm?.activeProjects?.length ?? 0;
  const avoidCount = ukm?.antiPreferences?.length ?? 0;
  const correctionsCount = ukm?.corrections?.length ?? 0;
  const totalFilled =
    identityFilled +
    styleFilled +
    (expertiseCount > 0 ? 1 : 0) +
    (projectsCount > 0 ? 1 : 0) +
    (avoidCount > 0 ? 1 : 0) +
    (correctionsCount > 0 ? 1 : 0);
  const completeness = Math.round((totalFilled / 10) * 100);

  const hitRate =
    (stats?.totalResponses ?? 0) > 0
      ? Math.round((stats!.responsesWithMemory / stats!.totalResponses) * 100)
      : 0;

  const topMemories = [...memories]
    .sort((a, b) => b.accessCount - a.accessCount)
    .slice(0, 5)
    .filter((m) => m.accessCount > 0);

  return (
    <div className="space-y-5 px-3 py-3">
      {/* Memory Library */}
      <InsightSection title="Memory Library">
        <div className="mb-3 flex items-end justify-between">
          <span className="text-3xl font-bold leading-none">{memories.length}</span>
          <span className="text-[11px] text-muted-foreground">memories stored</span>
        </div>
        {memories.length > 0 && (
          <div className="space-y-1.5">
            {MEMORY_TYPE_META.filter((t) => (grouped[t.value]?.length ?? 0) > 0).map((t) => {
              const count = grouped[t.value]?.length ?? 0;
              const pct = (count / memories.length) * 100;
              return (
                <div key={t.value} className="flex items-center gap-2">
                  <span className="w-4 text-center text-xs">{t.emoji}</span>
                  <div className="flex-1 overflow-hidden">
                    <div className="h-1.5 rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary/60 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                  <span className="w-5 text-right text-[11px] tabular-nums text-muted-foreground">
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {unused > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {unused} {unused === 1 ? "memory" : "memories"} not yet used in responses
          </p>
        )}
      </InsightSection>

      {/* Confidence quality */}
      {memories.length > 0 && (
        <InsightSection title="Extraction Quality">
          <div className="flex gap-2">
            <ConfidenceBadge label="High" count={high} variant="high" />
            <ConfidenceBadge label="Med" count={med} variant="med" />
            <ConfidenceBadge label="Low" count={low} variant="low" />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            High confidence → auto-saved · Med → suggested · Low → skipped
          </p>
        </InsightSection>
      )}

      {/* Response impact */}
      <InsightSection title="Response Impact">
        {statsLoading ? (
          <div className="space-y-2">
            <div className="h-6 animate-pulse rounded bg-muted/60" />
            <div className="h-14 animate-pulse rounded bg-muted/60" />
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Memory hit rate</span>
                <span className="font-semibold tabular-nums">{hitRate}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${hitRate}%` }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <StatBox
                label="Responses w/ memory"
                value={String(stats?.responsesWithMemory ?? 0)}
              />
              <StatBox label="Total responses" value={String(stats?.totalResponses ?? 0)} />
              <StatBox label="Total injections" value={String(stats?.totalMemoriesInjected ?? 0)} />
              <StatBox
                label="Avg per response"
                value={String(stats?.avgMemoriesPerResponse ?? 0)}
              />
            </div>
          </div>
        )}
      </InsightSection>

      {/* Persona completeness */}
      <InsightSection title="Persona Completeness">
        <div className="mb-2 flex items-end justify-between">
          <span className="text-3xl font-bold leading-none">{completeness}%</span>
          <span className="text-[11px] text-muted-foreground">profile built</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              completeness < 30
                ? "bg-destructive/60"
                : completeness < 70
                  ? "bg-yellow-500/70"
                  : "bg-green-500/70",
            )}
            style={{ width: `${completeness}%` }}
          />
        </div>
        <div className="mt-3 space-y-1.5">
          <CompletenessRow label="Identity" filled={identityFilled} total={4} />
          <CompletenessRow label="Comm. style" filled={styleFilled} total={3} />
          <CompletenessRow
            label="Expertise"
            filled={Math.min(expertiseCount, 1)}
            total={1}
            extra={
              expertiseCount > 0
                ? `${expertiseCount} area${expertiseCount !== 1 ? "s" : ""}`
                : undefined
            }
          />
          <CompletenessRow
            label="Projects"
            filled={Math.min(projectsCount, 1)}
            total={1}
            extra={projectsCount > 1 ? `${projectsCount}` : undefined}
          />
          <CompletenessRow
            label="Dislikes"
            filled={Math.min(avoidCount, 1)}
            total={1}
            extra={avoidCount > 1 ? `${avoidCount}` : undefined}
          />
          <CompletenessRow
            label="Corrections"
            filled={Math.min(correctionsCount, 1)}
            total={1}
            extra={correctionsCount > 1 ? `${correctionsCount}` : undefined}
          />
        </div>
        {completeness < 100 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Keep chatting — the persona fills automatically from conversations.
          </p>
        )}
      </InsightSection>

      {/* Top used memories */}
      {topMemories.length > 0 && (
        <InsightSection title="Most Used Memories">
          <div className="space-y-2">
            {topMemories.map((m) => (
              <div key={m.id} className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground">
                  ×{m.accessCount}
                </span>
                <span className="shrink-0">
                  {MEMORY_TYPE_META.find((t) => t.value === m.type)?.emoji ?? "💡"}
                </span>
                <p className="line-clamp-2 text-xs leading-relaxed text-foreground/80">
                  {m.content}
                </p>
              </div>
            ))}
          </div>
        </InsightSection>
      )}
    </div>
  );
}

function InsightSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function ConfidenceBadge({
  label,
  count,
  variant,
}: {
  label: string;
  count: number;
  variant: "high" | "med" | "low";
}) {
  const colors = {
    high: "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400",
    med: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-400",
    low: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400",
  };
  return (
    <div className={cn("flex-1 rounded-md px-2 py-1.5 text-center", colors[variant])}>
      <div className="text-lg font-bold tabular-nums leading-none">{count}</div>
      <div className="mt-0.5 text-[10px]">{label}</div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/50 px-2 py-1.5">
      <div className="text-base font-bold tabular-nums leading-none">{value}</div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

// Retired: ContextDebuggerPanel, ContextAssemblySection, and TaskPanel.
// Per-message context now renders inline via BehindAnswerChip in MessageList,
// and the active task surfaces as ActiveTaskBanner above the chat. The
// underlying server functions (getContextLog, getActiveTaskForConversation)
// remain available for future use.

function CompletenessRow({
  label,
  filled,
  total,
  extra,
}: {
  label: string;
  filled: number;
  total: number;
  extra?: string;
}) {
  const pct = total > 0 ? (filled / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex-1 overflow-hidden">
        <div className="h-1.5 rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary/70 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
        {extra ?? `${filled}/${total}`}
      </span>
    </div>
  );
}
