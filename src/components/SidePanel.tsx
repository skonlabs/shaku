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
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File,
  FileText,
  FolderPlus,
  Loader2,
  Pause,
  Play,
  Upload,
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
import { getUsageByConversation } from "@/lib/usage.functions";
import {
  getMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  toggleMemory,
  getUkm,
  getMemoryStats,
} from "@/lib/memory.functions";
import { listProjects, createProject, deleteProject, listProjectConversations } from "@/lib/projects.functions";
import { listFiles, createDatasourceFile, deleteDatasourceFile } from "@/lib/datasources.functions";
import { listConnectors, initiateConnectorAuth, pauseConnector, disconnectConnector, getConnectorAvailability } from "@/lib/connectors.functions";
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
      <TokenUsageSection />
    </div>
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
  const rows = [...byModel.entries()].sort((a, b) => b[1].in + b[1].out - (a[1].in + a[1].out));

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
          <div className="grid grid-cols-3 gap-2 rounded-lg border border-border bg-card/60 p-3 text-center">
            <UsageStat label="Input" value={formatTokens(totalIn)} tone="text-foreground" />
            <UsageStat label="Output" value={formatTokens(totalOut)} tone="text-primary" />
            <UsageStat label="Cost" value={`$${totalCost.toFixed(4)}`} tone="text-foreground" />
          </div>
          <div className="mt-3 space-y-1.5">
            {rows.map(([model, v]) => {
              const total = v.in + v.out || 1;
              const inPct = (v.in / total) * 100;
              return (
                <div
                  key={model}
                  className="rounded-md border border-border bg-card/60 px-2.5 py-2 text-[11px]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-foreground" title={model}>
                      {model}
                    </span>
                    <span className="text-muted-foreground">
                      {v.calls} call{v.calls === 1 ? "" : "s"} · ${v.cost.toFixed(4)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="bg-foreground/70"
                      style={{ width: `${inPct}%` }}
                      title={`Input: ${v.in.toLocaleString()}`}
                    />
                    <div
                      className="bg-primary"
                      style={{ width: `${100 - inPct}%` }}
                      title={`Output: ${v.out.toLocaleString()}`}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                    <span>↓ {formatTokens(v.in)} in</span>
                    <span>↑ {formatTokens(v.out)} out</span>
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
    !doc.mime ||
    doc.mime.startsWith("text/markdown") ||
    /\.(md|markdown)$/i.test(doc.title);

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
  | "project";

const MEMORY_TYPE_META: { value: MemoryType; label: string; emoji: string }[] = [
  { value: "preference", label: "Preferences", emoji: "💡" },
  { value: "anti_preference", label: "Dislikes", emoji: "🚫" },
  { value: "behavioral", label: "Behavioral", emoji: "🎯" },
  { value: "response_style", label: "Response style", emoji: "✍️" },
  { value: "correction", label: "Corrections", emoji: "✏️" },
  { value: "project", label: "Projects", emoji: "📁" },
  { value: "episodic", label: "Events", emoji: "📅" },
  { value: "semantic", label: "Facts", emoji: "🧠" },
];

interface MemoryEntry {
  id: string;
  type: string;
  content: string;
  confidence: number;
  importance: number;
  accessCount: number;
  lastAccessedAt: string | null;
}

// ─── Projects ────────────────────────────────────────────────────────────────

function ProjectsPanel() {
  const navigate = useNavigate();
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
    },
    onError: () => toast.error("Couldn't create project."),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteProject({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Project archived.");
    },
    onError: () => toast.error("Couldn't archive project."),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center px-4 py-2">
        <button
          onClick={() => { setCreating(true); setNewName(""); }}
          className="ml-auto flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <FolderPlus className="h-3.5 w-3.5" /> New project
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
            placeholder="Project name"
            maxLength={100}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ring/60"
          />
          <div className="flex gap-1">
            <Button size="sm" type="submit" disabled={!newName.trim() || createMut.isPending} className="h-7 flex-1 text-xs">
              {createMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Create"}
            </Button>
            <Button size="sm" variant="ghost" type="button" className="h-7 text-xs" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      <ScrollArea className="flex-1">
        {isLoading && <p className="px-4 py-6 text-center text-xs text-muted-foreground">Loading…</p>}
        {!isLoading && projects.length === 0 && !creating && (
          <div className="px-4 py-8 text-center">
            <FolderPlus className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">No projects yet.</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Create a project to organize related chats together.
            </p>
          </div>
        )}
        <div className="space-y-0.5 px-2 pb-2">
          {projects.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              isExpanded={expanded === p.id}
              onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
              onDelete={() => deleteMut.mutate(p.id)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function ProjectRow({
  project,
  isExpanded,
  onToggle,
  onDelete,
}: {
  project: { id: string; name: string; color: string };
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

  const convs = convData?.conversations ?? [];

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
          <span className="truncate text-sm">{project.name}</span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={(e) => { e.stopPropagation(); createMut.mutate(); }}
            title="New chat in project"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Archive project"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="mb-0.5 ml-5 border-l border-border pl-2">
          {convs.length === 0 ? (
            <p className="py-1 text-xs text-muted-foreground">No chats yet. Click + to create one.</p>
          ) : (
            convs.map((c) => (
              <button
                key={c.id}
                onClick={() => { navigate({ to: "/c/$id", params: { id: c.id } }); setActive(null); }}
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
      const files = (query.state.data as Awaited<ReturnType<typeof listFiles>> | undefined)?.files ?? [];
      return files.some((f: DatasourceFile) => f.status === "uploading" || f.status === "processing") ? 2500 : false;
    },
  });

  const { data: connData } = useQuery({
    queryKey: ["connectors"],
    queryFn: () => listConnectors({ data: undefined as never }),
  });

  const { data: availData } = useQuery({
    queryKey: ["connector-availability"],
    queryFn: () => getConnectorAvailability({ data: undefined as never }),
    staleTime: 60_000,
  });

  const availability = availData ?? {} as Record<string, boolean>;

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
    onSuccess: (res) => { window.location.href = (res as { auth_url: string }).auth_url; },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't connect."),
  });

  const disconnectMut = useMutation({
    mutationFn: (id: string) => disconnectConnector({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connectors"] });
      toast.success("Disconnected.");
    },
    onError: () => toast.error("Couldn't disconnect."),
  });

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

      await supabase.from("datasource_files").update({ storage_path: storagePath }).eq("id", fileId);

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (token) {
        await fetch("/api/datasources/process", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ file_id: fileId, storage_path: storagePath, file_type: ext, file_name: file.name }),
        });
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
    const ord: Record<string, number> = { processing: 0, uploading: 0, error: 1, ready: 2 };
    return (ord[a.status] ?? 2) - (ord[b.status] ?? 2);
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
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {uploading ? "Uploading…" : "Upload file"}
            </button>
          </div>
          <ScrollArea className="flex-1">
            {isLoading && <p className="px-4 py-6 text-center text-xs text-muted-foreground">Loading…</p>}
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
                          onClick={() => deleteMut.mutate(f.id)}
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
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Connected</p>
                <div className="space-y-2">
                  {connectedStorage.map((c) => {
                    const svc = CLOUD_STORAGE_SERVICES.find((s) => s.service === c.service);
                    const isPaused = c.status === "paused";
                    return (
                      <div key={c.id} className="rounded-lg border border-border bg-background p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium">{svc?.name ?? c.service}</p>
                          <span className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] font-medium",
                            c.status === "syncing" ? "bg-blue-50 text-blue-600 dark:bg-blue-950/50" :
                            c.status === "paused" ? "bg-yellow-50 text-yellow-600 dark:bg-yellow-950/50" :
                            "bg-green-50 text-green-600 dark:bg-green-950/50",
                          )}>
                            {c.status === "syncing" ? <span className="flex items-center gap-1"><Loader2 className="h-2.5 w-2.5 animate-spin" />Syncing</span> : c.status}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {c.items_indexed != null ? `${c.items_indexed} items indexed` : ""}
                          {c.last_synced_at ? ` · synced ${relativeTime(c.last_synced_at)}` : ""}
                        </p>
                        <div className="mt-2 flex gap-1.5">
                          <button
                            onClick={() => disconnectMut.mutate(c.id)}
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
                {CLOUD_STORAGE_SERVICES.filter((s) => !connectedStorage.some((c) => c.service === s.service)).map((s) => {
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
                            {connectMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
                            Connect
                          </button>
                        ) : s.implemented && !isConfigured ? (
                          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">Not configured</span>
                        ) : (
                          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">Soon</span>
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
const CONNECTOR_ONLY_SERVICES = new Set(["slack", "teams", "gmail", "google_calendar", "jira", "github", "notion", "confluence"]);

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
  google_calendar: { name: "Google Calendar", desc: "Access calendar events in chat context", implemented: false },
  jira: { name: "Jira (Atlassian)", desc: "Index issues, epics, sprints and comments", implemented: false },
  github: { name: "GitHub", desc: "Index issues, PRs, discussions and code", implemented: false },
  notion: { name: "Notion", desc: "Index pages, databases and wikis", implemented: false },
  confluence: { name: "Confluence (Atlassian)", desc: "Index spaces, pages and comments", implemented: false },
};

function ConnectorsPanel() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["connectors"],
    queryFn: () => listConnectors({ data: undefined as never }),
  });

  const { data: availData } = useQuery({
    queryKey: ["connector-availability"],
    queryFn: () => getConnectorAvailability({ data: undefined as never }),
    staleTime: 60_000,
  });

  const availability = availData ?? {} as Record<string, boolean>;

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connectors"] }),
    onError: () => toast.error("Couldn't update connector."),
  });

  const disconnectMut = useMutation({
    mutationFn: (id: string) => disconnectConnector({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connectors"] });
      toast.success("Connector disconnected.");
    },
    onError: () => toast.error("Couldn't disconnect."),
  });

  const connectedServices = new Set(connected.map((c) => c.service));

  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 px-4 py-3">
        {isLoading && <p className="py-4 text-center text-xs text-muted-foreground">Loading…</p>}

        {connected.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Connected</p>
            <div className="space-y-2">
              {connected.map((c) => {
                const meta = CONNECTOR_META[c.service];
                const style = CONNECTOR_STATUS_STYLES[c.status] ?? CONNECTOR_STATUS_STYLES.connected;
                const isPaused = c.status === "paused";
                return (
                  <div key={c.id} className="rounded-lg border border-border bg-background p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{meta?.name ?? c.service}</p>
                      <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", style.badge)}>
                        {c.status === "syncing" ? (
                          <span className="flex items-center gap-1"><Loader2 className="h-2.5 w-2.5 animate-spin" />Syncing</span>
                        ) : style.label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {c.items_indexed != null ? `${c.items_indexed} items indexed` : ""}
                      {c.last_synced_at ? ` · synced ${relativeTime(c.last_synced_at)}` : ""}
                    </p>
                    {c.error_message && <p className="mt-1 text-[11px] text-red-500">{c.error_message}</p>}
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
                        onClick={() => disconnectMut.mutate(c.id)}
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
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{group.label}</p>
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
                            {connectMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
                            Connect
                          </button>
                        ) : meta.implemented && !isConfigured ? (
                          <span className="shrink-0 rounded border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">Config needed</span>
                        ) : (
                          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">Soon</span>
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
          <p className="py-2 text-center text-xs text-muted-foreground">Connect services to bring their data into your chats.</p>
        )}
      </div>
    </ScrollArea>
  );
}

function groupByType(memories: MemoryEntry[]): Record<string, MemoryEntry[]> {
  const out: Record<string, MemoryEntry[]> = {};
  for (const m of memories) {
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

  const memoryEnabled = ukmData?.memoryEnabled ?? true;
  const memories = (memoriesData?.memories ?? []) as MemoryEntry[];
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
            memoryEnabled={memoryEnabled}
            isLoading={memoriesLoading}
            onToggle={(v) => toggleMut.mutate(v)}
            onDelete={(id) => deleteMut.mutate(id)}
            onRefresh={() => {
              qc.invalidateQueries({ queryKey: ["memories"] });
              qc.invalidateQueries({ queryKey: ["memory-stats"] });
            }}
          />
        )}
        {tab === "persona" && (
          <PersonaTab ukm={ukmData?.ukm ?? null} isLoading={ukmLoading} />
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
    </div>
  );
}

function MemoriesTab({
  memories,
  grouped,
  memoryEnabled,
  isLoading,
  onToggle,
  onDelete,
  onRefresh,
}: {
  memories: MemoryEntry[];
  grouped: Record<string, MemoryEntry[]>;
  memoryEnabled: boolean;
  isLoading: boolean;
  onToggle: (v: boolean) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState<MemoryType>("preference");
  const [newContent, setNewContent] = useState("");
  const qc = useQueryClient();

  const createMut = useMutation({
    mutationFn: ({ type, content }: { type: MemoryType; content: string }) =>
      createMemory({ data: { type, content } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["memories"] });
      setAdding(false);
      setNewContent("");
      toast.success("Memory saved.");
    },
    onError: () => toast.error("Couldn't save memory."),
  });

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

      {/* Add memory */}
      {adding ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as MemoryType)}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus:border-ring/60"
          >
            {MEMORY_TYPE_META.map((t) => (
              <option key={t.value} value={t.value}>
                {t.emoji} {t.label}
              </option>
            ))}
          </select>
          <textarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="Describe this memory…"
            maxLength={1000}
            rows={3}
            className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:border-ring/60"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => createMut.mutate({ type: newType, content: newContent.trim() })}
              disabled={!newContent.trim() || createMut.isPending}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3.5 w-3.5" /> Add memory
        </Button>
      )}

      {/* Memory list */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-md bg-muted/60" />
          ))}
        </div>
      ) : memories.length === 0 ? (
        <div className="py-8 text-center text-xs text-muted-foreground">
          <Brain className="mx-auto mb-2 h-8 w-8 opacity-20" />
          No memories yet. Start chatting and I&apos;ll learn your preferences!
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

  return (
    <div className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition hover:bg-accent/40">
      <p className="flex-1 text-xs leading-relaxed text-foreground/90">{memory.content}</p>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
        {memory.accessCount > 0 && (
          <span className="mr-1 text-[10px] text-muted-foreground/60" title="Times used in responses">
            ×{memory.accessCount}
          </span>
        )}
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

function PersonaTab({ ukm, isLoading }: { ukm: UserKnowledgeModel | null; isLoading: boolean }) {
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
  const hasPreferences = ukm && (
    ukm.preferences.responseFormat ||
    (ukm.preferences.avoidTopics?.length ?? 0) > 0 ||
    (ukm.preferences.preferredSources?.length ?? 0) > 0
  );
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
      <div className="px-4 py-10 text-center">
        <Brain className="mx-auto mb-3 h-10 w-10 text-primary/20" />
        <p className="text-sm font-medium text-foreground/70">Persona not built yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Chat naturally and I&apos;ll learn your style, preferences, and expertise over time.
        </p>
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
                  <span key={i} className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive/80">{t}</span>
                ))}
              </div>
            </div>
          )}
          {(ukm!.preferences.preferredSources?.length ?? 0) > 0 && (
            <div className="mt-1">
              <p className="mb-1 text-[10px] text-muted-foreground">Preferred sources</p>
              <div className="flex flex-wrap gap-1">
                {ukm!.preferences.preferredSources!.map((s, i) => (
                  <span key={i} className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{s}</span>
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
              <li key={i} className="text-xs">· {p}</li>
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
      ? Math.round(((stats!.responsesWithMemory) / stats!.totalResponses) * 100)
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
              <StatBox label="Responses w/ memory" value={String(stats?.responsesWithMemory ?? 0)} />
              <StatBox label="Total responses" value={String(stats?.totalResponses ?? 0)} />
              <StatBox label="Total injections" value={String(stats?.totalMemoriesInjected ?? 0)} />
              <StatBox label="Avg per response" value={String(stats?.avgMemoriesPerResponse ?? 0)} />
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
            extra={expertiseCount > 0 ? `${expertiseCount} area${expertiseCount !== 1 ? "s" : ""}` : undefined}
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
