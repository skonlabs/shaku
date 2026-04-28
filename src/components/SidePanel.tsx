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
  FolderPlus,
  Loader2,
  Pause,
  Play,
  Upload,
  Sparkles,
} from "lucide-react";
import { usePanel } from "@/lib/ui-context";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import { HARD_UPLOAD_MAX_MB, useUploadMaxMb } from "@/lib/upload-settings";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
      if (location.pathname === `/c/${id}`) navigate({ to: "/" });
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
                    onDelete={(id) => setPendingDeleteId(id)}
                    onRename={(id, title) => renameMut.mutate({ id, title })}
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
                  onDelete={(id) => setPendingDeleteId(id)}
                  onRename={(id, title) => renameMut.mutate({ id, title })}
                  onNavigate={() => setActive(null)}
                />
              ))}
            </Section>
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
          {/* Auto-extract */}
          <div>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-1.5 font-medium">
                Remember things automatically
                <HelpTip>
                  <p className="mb-1 font-medium">What this changes</p>
                  <p className="mb-2 text-muted-foreground">
                    Cortex watches each chat for useful facts and saves them quietly.
                  </p>
                  <p className="mb-1 font-medium">Example</p>
                  <p className="text-muted-foreground">
                    You say <em>"I'm vegetarian"</em> → next time you ask for dinner ideas,
                    Cortex skips meat dishes without you reminding it.
                  </p>
                </HelpTip>
              </span>
              <Switch
                checked={prefs.autoExtract}
                onCheckedChange={(v) => updateMut.mutate({ auto_extract: v })}
              />
            </label>
            <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
              When on, Cortex quietly saves useful facts from your chats (your name, preferences,
              ongoing projects) so it doesn't ask twice.
            </p>
          </div>

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
                    <b className="text-foreground">Eager —</b> "I think I'd like to learn
                    French someday" gets saved. You'll see more reminders, some off-base.
                  </li>
                  <li>
                    <b className="text-foreground">Balanced —</b> "I'm learning French" gets
                    saved. Casual asides usually don't.
                  </li>
                  <li>
                    <b className="text-foreground">Cautious —</b> only clear statements like
                    "My name is Sam" or "I live in Berlin" stick.
                  </li>
                </ul>
              </HelpTip>
            </p>
            <p className="mb-2 text-[12px] leading-snug text-muted-foreground">
              Higher means fewer, more reliable memories. Lower means more memories but some may
              be wrong.
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
                  onClick={() =>
                    updateMut.mutate({ min_confidence_threshold: confValue[opt.v] })
                  }
                  className={cn(
                    "rounded-md border border-border px-2 py-2 text-center text-xs transition",
                    confPreset === opt.v
                      ? "border-primary bg-accent"
                      : "hover:bg-accent/60",
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
                      <b className="text-foreground">5–8 (Recommended) —</b> also saves
                      "traveling with partner," "wants museums and food," "budget €1500."
                    </li>
                    <li>
                      <b className="text-foreground">15–20 (Capture everything) —</b> adds
                      smaller details like preferred neighborhoods and dietary notes.
                    </li>
                  </ul>
                </HelpTip>
              </p>
              <span className="text-xs tabular-nums text-muted-foreground">
                up to {prefs.maxMemoriesPerCall}
              </span>
            </div>
            <p className="mb-2 text-[12px] leading-snug text-muted-foreground">
              Most chats produce 1–3 useful facts. A higher limit lets Cortex capture more from
              long conversations.
            </p>
            <Slider
              min={1}
              max={20}
              step={1}
              value={[Math.min(prefs.maxMemoriesPerCall, 20)]}
              onValueChange={(vals) =>
                updateMut.mutate({ max_memories_per_call: vals[0] })
              }
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
              A space groups chats and memories around a topic — like a job search,
              a trip, or a long project. Cortex remembers context across every chat
              inside it.
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
              Try one for something you'll keep coming back to — Cortex will get
              smarter every time.
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
              <span className="font-medium text-foreground">{chatCount}</span> chat{chatCount === 1 ? "" : "s"}
            </span>
            <span aria-hidden className="opacity-30">·</span>
            <span title="Memories saved from chats in this space" className="flex items-center gap-1">
              <span className="font-medium text-foreground">{memCount}</span> memor{memCount === 1 ? "y" : "ies"}
            </span>
          </div>

          {convs.length === 0 ? (
            <p className="py-1 text-xs text-muted-foreground">
              No chats yet. Click + to start one — Cortex will remember what you discuss here.
            </p>
          ) : (
            convs.map((c) => (
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
            ))
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

const CLOUD_STORAGE_SERVICES = [
  {
    service: "google_drive",
    name: "Google Drive",
    desc: "Sync Docs, Sheets, Slides and files",
    implemented: true,
  },
  {
    service: "onedrive",
    name: "OneDrive / SharePoint",
    desc: "Sync files from Microsoft OneDrive",
    implemented: false,
  },
  {
    service: "dropbox",
    name: "Dropbox",
    desc: "Sync documents and files from Dropbox",
    implemented: false,
  },
  {
    service: "shared_folder",
    name: "Shared / Network Folder",
    desc: "Mount a local or network shared folder",
    implemented: false,
  },
];

function DatasourcesPanel() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<"files" | "cloud">("files");
  const [uploading, setUploading] = useState(false);

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
          redirect_uri: `${window.location.origin}/api/connectors/callback?service=${service}`,
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

  const [pendingDeleteFileId, setPendingDeleteFileId] = useState<string | null>(null);
  const [pendingDisconnectId, setPendingDisconnectId] = useState<string | null>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    e.target.value = "";
    setUploading(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin";
      const { file: record } = await createDatasourceFile({
        data: { name: file.name, file_type: ext, file_size_bytes: file.size },
      });
      const fileId = record.id;
      const storagePath = `${user.id}/${fileId}/${file.name}`;

      const { error: upErr } = await supabase.storage
        .from("datasource-files")
        .upload(storagePath, file, { upsert: false });

      if (upErr) {
        await deleteDatasourceFile({ data: { id: fileId } });
        throw new Error(upErr.message);
      }

      const { error: pathUpdateErr } = await supabase
        .from("datasource_files")
        .update({ storage_path: storagePath })
        .eq("id", fileId);
      if (pathUpdateErr) {
        // Surface error to user rather than proceeding to process with missing path
        toast.error("Failed to record file path. Please try again.");
        await deleteDatasourceFile({ data: { id: fileId } });
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (token) {
        const res = await fetch("/api/datasources/process", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            file_id: fileId,
            storage_path: storagePath,
            file_type: ext,
            file_name: file.name,
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
          toast.error(errMsg);
        }
      }

      qc.invalidateQueries({ queryKey: ["ds-files"] });
      toast.success(`"${file.name}" is processing.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  const connectedStorage = (connData?.connected ?? []).filter((c) =>
    CLOUD_STORAGE_SERVICES.some((s) => s.service === c.service),
  );

  const sorted = [...files].sort((a, b) => {
    const ord: Record<string, number> = { uploading: 0, processing: 0, error: 1, ready: 2 };
    // Unknown statuses go to the end
    const getOrd = (status: string) => ord[status] ?? 3;
    return getOrd(a.status) - getOrd(b.status);
  });

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
          <div className="flex shrink-0 items-center px-4 py-2">
            <input
              ref={fileRef}
              type="file"
              className="sr-only"
              onChange={handleFileChange}
              accept=".pdf,.docx,.doc,.txt,.md,.rtf,.xlsx,.xls,.csv,.pptx,.ppt,.png,.jpg,.jpeg,.gif,.webp,.py,.js,.ts,.tsx,.jsx,.java,.cpp,.c,.rs,.go,.rb,.php,.swift,.kt,.html,.css,.json,.yaml,.sql"
            />
            <p className="text-[11px] text-muted-foreground">PDFs, Docs, Code, Spreadsheets</p>
            <button
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              className="ml-auto flex items-center gap-1.5 text-xs text-primary hover:underline disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {uploading ? "Uploading…" : "Upload file"}
            </button>
          </div>
          <ScrollArea className="flex-1">
            {isLoading && (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">Loading…</p>
            )}
            {!isLoading && sorted.length === 0 && (
              <div className="px-4 py-8 text-center">
                <Upload className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
                <p className="text-xs text-muted-foreground">No files yet.</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Upload PDFs, documents, spreadsheets, or code to use as context in any chat.
                </p>
              </div>
            )}
            <div className="space-y-0.5 px-2 pb-2">
              {sorted.map((f) => {
                const isActive = f.status === "processing" || f.status === "uploading";
                return (
                  <div
                    key={f.id}
                    className="group flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent/40"
                  >
                    <File
                      className={cn(
                        "h-4 w-4 shrink-0",
                        isActive ? "text-blue-500" : "text-muted-foreground",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{f.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {fmtBytes(f.file_size_bytes ?? 0)}
                        {f.chunk_count ? ` · ${f.chunk_count} chunks` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium capitalize",
                          FILE_STATUS_STYLES[f.status] ?? "",
                        )}
                      >
                        {isActive ? (
                          <span className="flex items-center gap-1">
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            {f.status}
                          </span>
                        ) : (
                          f.status
                        )}
                      </span>
                      {(f.status === "ready" || f.status === "error") && (
                        <button
                          onClick={() => setPendingDeleteFileId(f.id)}
                          className="hidden h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-destructive group-hover:flex"
                          title="Remove file"
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
                  const canConnect = s.implemented && isConfigured;
                  return (
                    <div
                      key={s.service}
                      className={cn(
                        "rounded-lg border border-border bg-background p-3",
                        !canConnect && "opacity-60",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{s.name}</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">{s.desc}</p>
                        </div>
                        {canConnect ? (
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
  "teams",
  "gmail",
  "google_calendar",
  "jira",
  "github",
  "notion",
  "confluence",
]);

const CONNECTOR_GROUPS: { label: string; services: string[]; desc: string }[] = [
  { label: "Communication", services: ["slack", "teams", "gmail"], desc: "" },
  { label: "Knowledge", services: ["notion", "confluence"], desc: "" },
  { label: "Dev & Code", services: ["github"], desc: "" },
  { label: "Productivity", services: ["jira", "google_calendar"], desc: "" },
];

const CONNECTOR_META: Record<string, { name: string; desc: string; implemented: boolean }> = {
  slack: { name: "Slack", desc: "Index channel messages, threads and files", implemented: true },
  teams: { name: "Microsoft Teams", desc: "Index Teams messages and channels", implemented: false },
  gmail: { name: "Gmail", desc: "Index email threads and attachments", implemented: false },
  google_calendar: {
    name: "Google Calendar",
    desc: "Access calendar events in chat context",
    implemented: false,
  },
  jira: {
    name: "Jira (Atlassian)",
    desc: "Index issues, epics, sprints and comments",
    implemented: false,
  },
  github: { name: "GitHub", desc: "Index issues, PRs, discussions and code", implemented: false },
  notion: { name: "Notion", desc: "Index pages, databases and wikis", implemented: false },
  confluence: {
    name: "Confluence (Atlassian)",
    desc: "Index spaces, pages and comments",
    implemented: false,
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
          redirect_uri: `${window.location.origin}/api/connectors/callback?service=${service}`,
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
                  const canConnect = meta.implemented && isConfigured;
                  return (
                    <div
                      key={service}
                      className={cn(
                        "rounded-lg border border-border bg-background p-3",
                        !canConnect && "opacity-60",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{meta.name}</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">{meta.desc}</p>
                        </div>
                        {canConnect ? (
                          <button
                            onClick={() => connectMut.mutate(service)}
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
                        ) : meta.implemented && !isConfigured ? (
                          <span className="shrink-0 rounded border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
                            Config needed
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
          <PersonaTab ukm={ukmData?.ukm ?? null} recentSignals={recentSignals} isLoading={ukmLoading} />
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
      {/* Memory toggle */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
        <div>
          <p className="text-sm font-medium">Learn from conversations</p>
          <p className="text-[11px] text-muted-foreground">Build your persona over time</p>
        </div>
        <button
          onClick={() => onToggle(!memoryEnabled)}
          aria-label={memoryEnabled ? "Disable memory" : "Enable memory"}
          className={cn(
            "relative h-5 w-9 rounded-full transition-colors",
            memoryEnabled ? "bg-primary" : "bg-muted-foreground/30",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
              memoryEnabled ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      {/* Granular memory preferences (only meaningful when memory is on) */}
      {memoryEnabled && <MemoryPreferencesSection />}

      {/* How it works — always visible, teaches the mental model */}
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">Cortex learns as you chat</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Just mention things naturally — like <span className="italic">"I'm vegetarian"</span> or{" "}
              <span className="italic">"keep answers short"</span> — and Cortex will remember.
              You can delete anything here anytime.
            </p>
          </div>
        </div>
      </div>

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
                <div key={`${signal.createdAt}-${index}`} className="rounded-md bg-accent/40 px-3 py-2">
                  <p className="line-clamp-3 text-xs leading-relaxed text-foreground/85">{signal.content}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">{relativeTime(signal.createdAt)}</p>
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
            I haven&apos;t found enough clear preferences to build a full profile yet, but your recent
            conversation signals are below.
          </p>
        </div>
        {recentSignals.length > 0 ? (
          <PersonaSection title="Recent signals">
            <div className="space-y-2">
              {recentSignals.map((signal, index) => (
                <div key={`${signal.createdAt}-${index}`} className="rounded-md bg-accent/40 px-3 py-2">
                  <p className="line-clamp-3 text-xs leading-relaxed text-foreground/85">{signal.content}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">{relativeTime(signal.createdAt)}</p>
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
