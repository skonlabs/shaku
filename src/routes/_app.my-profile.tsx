import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Brain,
  Shield,
  Users,
  CheckCircle2,
  TrendingUp,
  MessageSquare,
  Award,
  Activity,
  BookOpen,
  Star,
  Target,
  Zap,
  Gift,
  Copy,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getUkm, getMemories, getMemoryStats } from "@/lib/memory.functions";
import { getMyReferralCodes } from "@/lib/referrals.functions";
import type { UserKnowledgeModel } from "@/lib/knowledge/ukm";
import { ScrollArea } from "@/components/ui/scroll-area";
import * as React from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/my-profile")({
  component: MyProfilePage,
});

// Mirrors MEMORY_TYPE_META in SidePanel.tsx — keep in sync
const MEMORY_TYPE_META = [
  { value: "preference",     label: "Preferences",    emoji: "💡", colorClass: "bg-yellow-500/60" },
  { value: "anti_preference",label: "Dislikes",       emoji: "🚫", colorClass: "bg-destructive/60" },
  { value: "behavioral",     label: "Behavioral",     emoji: "🎯", colorClass: "bg-blue-500/60" },
  { value: "response_style", label: "Response style", emoji: "✍️", colorClass: "bg-purple-500/60" },
  { value: "correction",     label: "Corrections",    emoji: "✏️", colorClass: "bg-orange-500/60" },
  { value: "project",        label: "Spaces",         emoji: "📁", colorClass: "bg-green-500/60" },
  { value: "episodic",       label: "Events",         emoji: "📅", colorClass: "bg-cyan-500/60" },
  { value: "semantic",       label: "Facts",          emoji: "🧠", colorClass: "bg-indigo-500/60" },
  { value: "long_term",      label: "Long-term",      emoji: "🔒", colorClass: "bg-primary/60" },
  { value: "short_term",     label: "Short-term",     emoji: "⏱️", colorClass: "bg-muted-foreground/40" },
  { value: "document",       label: "Documents",      emoji: "📄", colorClass: "bg-slate-500/60" },
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
}

function computeCompleteness(ukm: UserKnowledgeModel | null): number {
  if (!ukm) return 0;
  const scores = [
    Object.values(ukm.identity).filter(Boolean).length,          // 0–4
    Object.values(ukm.communicationStyle).filter(Boolean).length, // 0–3
    ukm.expertise.length > 0 ? 1 : 0,
    ukm.activeProjects.length > 0 ? 1 : 0,
    ukm.antiPreferences.length > 0 ? 1 : 0,
    ukm.corrections.length > 0 ? 1 : 0,
  ];
  return Math.round((scores.reduce((a, b) => a + b, 0) / 10) * 100);
}

export default function MyProfilePage() {
  const { data: ukmData, isLoading: ukmLoading } = useQuery({
    queryKey: ["ukm"],
    queryFn: () => getUkm({ data: {} }),
  });

  const { data: memoriesData, isLoading: memoriesLoading } = useQuery({
    queryKey: ["memories"],
    queryFn: () => getMemories({ data: {} }),
  });

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ["memory-stats"],
    queryFn: () => getMemoryStats({ data: {} }),
  });

  const ukm = ukmData?.ukm ?? null;
  const memories = (memoriesData?.memories ?? []) as MemoryEntry[];
  const stats = statsData ?? null;

  const completeness = computeCompleteness(ukm);
  const hitRate =
    stats && stats.totalResponses > 0
      ? Math.round((stats.responsesWithMemory / stats.totalResponses) * 100)
      : 0;

  const grouped: Record<string, MemoryEntry[]> = {};
  for (const m of memories) {
    (grouped[m.type] ??= []).push(m);
  }

  const high = memories.filter((m) => m.confidence >= 0.8).length;
  const med  = memories.filter((m) => m.confidence >= 0.6 && m.confidence < 0.8).length;
  const low  = memories.filter((m) => m.confidence < 0.6).length;

  const topMemories = [...memories]
    .sort((a, b) => b.accessCount - a.accessCount)
    .slice(0, 6)
    .filter((m) => m.accessCount > 0);

  const hasIdentity      = ukm && Object.values(ukm.identity).some(Boolean);
  const hasStyle         = ukm && Object.values(ukm.communicationStyle).some(Boolean);
  const hasPrefs         = ukm && (ukm.preferences.responseFormat ||
                             (ukm.preferences.avoidTopics?.length ?? 0) > 0 ||
                             (ukm.preferences.preferredSources?.length ?? 0) > 0);
  const hasConstraints   = (ukm?.antiPreferences.length ?? 0) > 0 ||
                           (ukm?.corrections.length ?? 0) > 0 ||
                           (ukm?.responseStyleDislikes.length ?? 0) > 0;
  const hasAnyProfile    = hasIdentity || hasStyle || hasPrefs ||
                           (ukm?.expertise.length ?? 0) > 0 ||
                           (ukm?.activeProjects.length ?? 0) > 0 ||
                           (ukm?.relationships.length ?? 0) > 0;

  if (ukmLoading || memoriesLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="space-y-3 text-center">
          <Brain className="mx-auto h-10 w-10 animate-pulse text-primary/40" />
          <p className="text-sm text-muted-foreground">Loading your profile…</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl space-y-5 p-4 pb-8 sm:space-y-6 sm:p-6 sm:pb-10">

        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary to-[oklch(0.50_0.16_245)] p-5 text-primary-foreground shadow-lg sm:p-6">
          {/* BG decoration */}
          <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-white/5" />
          <div className="pointer-events-none absolute -bottom-10 -left-10 h-40 w-40 rounded-full bg-white/5" />

          <div className="relative z-10 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/20 backdrop-blur-sm">
                  <Brain className="h-7 w-7" />
                </div>
                <div>
                  <h1 className="text-xl font-bold leading-tight">
                    {ukm?.identity?.name
                      ? `${ukm.identity.name}'s AI Profile`
                      : "Your AI Profile"}
                  </h1>
                  {(ukm?.identity?.role || ukm?.identity?.company) && (
                    <p className="mt-0.5 text-sm text-primary-foreground/80">
                      {[ukm!.identity.role, ukm!.identity.company].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </div>
              </div>
              <p className="max-w-md text-sm leading-relaxed text-primary-foreground/75">
                Unlike ChatGPT or Gemini, Ekonomical builds a persistent profile from your
                conversations — remembering your preferences, expertise, and corrections so every
                response feels personal.
              </p>

              {/* hero pills */}
              <div className="flex flex-wrap gap-2 pt-1">
                <HeroPill value={String(memories.length)} label="memories" />
                <HeroPill value={`${hitRate}%`} label="responses personalized" />
                {(ukm?.correctionCount ?? 0) > 0 && (
                  <HeroPill value={String(ukm!.correctionCount)} label="corrections learned" />
                )}
                {(ukm?.expertise.length ?? 0) > 0 && (
                  <HeroPill value={String(ukm!.expertise.length)} label="expertise areas" />
                )}
              </div>
            </div>

            {/* Completeness ring */}
            <div className="shrink-0 self-center text-center">
              <div className="relative mx-auto flex h-24 w-24 items-center justify-center">
                <svg className="absolute inset-0 h-24 w-24 -rotate-90" viewBox="0 0 96 96">
                  <circle cx="48" cy="48" r="40" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="8" />
                  <circle
                    cx="48" cy="48" r="40" fill="none"
                    stroke="rgba(255,255,255,0.85)" strokeWidth="8"
                    strokeDasharray={`${2 * Math.PI * 40}`}
                    strokeDashoffset={`${2 * Math.PI * 40 * (1 - completeness / 100)}`}
                    strokeLinecap="round"
                  />
                </svg>
                <div className="text-center">
                  <span className="text-2xl font-bold">{completeness}%</span>
                </div>
              </div>
              <p className="mt-1.5 text-xs text-primary-foreground/70">profile built</p>
            </div>
          </div>
        </div>

        {/* ── Quick stats row ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard icon={Brain}        label="Memories stored"    value={String(memories.length)} />
          <StatCard icon={TrendingUp}   label="Memory hit rate"    value={`${hitRate}%`} />
          <StatCard icon={CheckCircle2} label="Corrections applied" value={String(ukm?.correctionCount ?? 0)} />
          <StatCard icon={Award}        label="Expertise areas"    value={String(ukm?.expertise.length ?? 0)} />
        </div>

        {/* ── Referral codes ────────────────────────────────────────────────── */}
        <ReferralCodesCard />

        {/* ── Main content grid ─────────────────────────────────────────────── */}
        <div className="grid gap-5 lg:grid-cols-3">

          {/* ── Left: Persona (2/3 width) ─────────────────────────────────── */}
          <div className="space-y-4 lg:col-span-2">

            {hasIdentity && (
              <ProfileCard title="Identity" icon={Users}>
                <div className="grid gap-2 sm:grid-cols-2">
                  {ukm!.identity.name    && <FieldRow label="Name"    value={ukm!.identity.name} />}
                  {ukm!.identity.role    && <FieldRow label="Role"    value={ukm!.identity.role} />}
                  {ukm!.identity.company && <FieldRow label="Company" value={ukm!.identity.company} />}
                  {ukm!.identity.team    && <FieldRow label="Team"    value={ukm!.identity.team} />}
                </div>
              </ProfileCard>
            )}

            {hasStyle && (
              <ProfileCard title="Communication style" icon={MessageSquare}>
                <div className="flex flex-wrap gap-2.5">
                  {ukm!.communicationStyle.verbosity && (
                    <StyleChip label="Verbosity" value={ukm!.communicationStyle.verbosity} />
                  )}
                  {ukm!.communicationStyle.format && (
                    <StyleChip label="Format" value={ukm!.communicationStyle.format} />
                  )}
                  {ukm!.communicationStyle.tone && (
                    <StyleChip label="Tone" value={ukm!.communicationStyle.tone} />
                  )}
                </div>
              </ProfileCard>
            )}

            {(ukm?.expertise.length ?? 0) > 0 && (
              <ProfileCard title="Areas of expertise" icon={BookOpen}>
                <div className="flex flex-wrap gap-1.5">
                  {ukm!.expertise.map((e, i) => (
                    <span
                      key={i}
                      className="rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
                    >
                      {e}
                    </span>
                  ))}
                </div>
              </ProfileCard>
            )}

            {(ukm?.activeProjects.length ?? 0) > 0 && (
              <ProfileCard title="Active projects" icon={Target}>
                <ul className="space-y-1.5">
                  {ukm!.activeProjects.map((p, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
                      {p}
                    </li>
                  ))}
                </ul>
              </ProfileCard>
            )}

            {(ukm?.relationships.length ?? 0) > 0 && (
              <ProfileCard title="People you've mentioned" icon={Users}>
                <div className="space-y-1.5">
                  {ukm!.relationships.map((r, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-2 rounded-md bg-accent/40 px-3 py-2"
                    >
                      <span className="text-sm font-medium">{r.name}</span>
                      <span className="text-xs text-muted-foreground">{r.role}</span>
                    </div>
                  ))}
                </div>
              </ProfileCard>
            )}

            {hasPrefs && (
              <ProfileCard title="Preferences" icon={Star}>
                <div className="space-y-2">
                  {ukm!.preferences.responseFormat && (
                    <FieldRow label="Response format" value={ukm!.preferences.responseFormat} />
                  )}
                  {(ukm!.preferences.avoidTopics?.length ?? 0) > 0 && (
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Avoid topics
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {ukm!.preferences.avoidTopics!.map((t, i) => (
                          <span
                            key={i}
                            className="rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive/80"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {(ukm!.preferences.preferredSources?.length ?? 0) > 0 && (
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Preferred sources
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {ukm!.preferences.preferredSources!.map((s, i) => (
                          <span
                            key={i}
                            className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </ProfileCard>
            )}

            {!hasAnyProfile && (
              <div className="rounded-xl border border-dashed border-border bg-card/50 p-10 text-center">
                <Brain className="mx-auto mb-3 h-12 w-12 text-primary/20" />
                <p className="text-sm font-medium text-foreground/70">Profile is still learning</p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  Start chatting — mention your name, role, preferences, or what you&apos;re working on.
                  <br />Ekonomical will build your profile automatically.
                </p>
              </div>
            )}
          </div>

          {/* ── Right: Memory bank (1/3 width) ────────────────────────────── */}
          <div className="space-y-4">

            <ProfileCard title="Memory bank" icon={Brain}>
              <div className="mb-4 flex items-end justify-between">
                <span className="text-4xl font-bold tabular-nums leading-none">
                  {memories.length}
                </span>
                <span className="text-xs text-muted-foreground">total memories</span>
              </div>
              {memories.length > 0 ? (
                <div className="space-y-2.5">
                  {MEMORY_TYPE_META.filter((t) => (grouped[t.value]?.length ?? 0) > 0).map((t) => {
                    const count = grouped[t.value]?.length ?? 0;
                    const pct = (count / memories.length) * 100;
                    return (
                      <div key={t.value} className="flex items-center gap-2.5">
                        <span className="w-5 shrink-0 text-center text-sm">{t.emoji}</span>
                        <div className="min-w-0 flex-1">
                          <div className="mb-0.5 flex items-center justify-between">
                            <span className="text-[11px] text-muted-foreground">{t.label}</span>
                            <span className="text-[11px] font-medium tabular-nums">{count}</span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn("h-full rounded-full transition-all", t.colorClass)}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No memories yet — start chatting!</p>
              )}
            </ProfileCard>

            {memories.length > 0 && (
              <ProfileCard title="Memory quality" icon={Activity}>
                <div className="space-y-2.5">
                  <QualityBar label="High confidence" count={high} total={memories.length} colorClass="bg-green-500/70" />
                  <QualityBar label="Medium confidence" count={med} total={memories.length} colorClass="bg-yellow-500/70" />
                  <QualityBar label="Low confidence" count={low} total={memories.length} colorClass="bg-destructive/50" />
                </div>
                <p className="mt-2.5 text-[11px] text-muted-foreground">
                  High = auto-saved · Med = suggested · Low = skipped
                </p>
              </ProfileCard>
            )}

            <ProfileCard title="Response impact" icon={Zap}>
              {statsLoading ? (
                <div className="space-y-2">
                  <div className="h-5 animate-pulse rounded bg-muted/60" />
                  <div className="h-16 animate-pulse rounded bg-muted/60" />
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Memory hit rate</span>
                      <span className="font-semibold">{hitRate}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${hitRate}%` }}
                      />
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Fraction of responses where Ekonomical recalled a relevant memory
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <MiniStat label="Personalized" value={String(stats?.responsesWithMemory ?? 0)} />
                    <MiniStat label="Total responses" value={String(stats?.totalResponses ?? 0)} />
                    <MiniStat label="Memories injected" value={String(stats?.totalMemoriesInjected ?? 0)} />
                    <MiniStat label="Avg per response" value={String(stats?.avgMemoriesPerResponse ?? 0)} />
                  </div>
                </div>
              )}
            </ProfileCard>
          </div>
        </div>

        {/* ── Learned constraints (full width) ─────────────────────────────── */}
        {hasConstraints && (
          <div>
            <div className="mb-3 flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">
                What Ekonomical has learned not to do{" "}
                <span className="font-normal text-muted-foreground">
                  — applied as hard constraints in every response
                </span>
              </h2>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              {(ukm?.antiPreferences.length ?? 0) > 0 && (
                <ConstraintCard
                  title="Things to avoid"
                  colorVariant="destructive"
                  items={ukm!.antiPreferences}
                />
              )}
              {(ukm?.responseStyleDislikes.length ?? 0) > 0 && (
                <ConstraintCard
                  title="Response style to skip"
                  colorVariant="amber"
                  items={ukm!.responseStyleDislikes}
                />
              )}
              {(ukm?.corrections.length ?? 0) > 0 && (
                <ConstraintCard
                  title="Corrections applied"
                  colorVariant="blue"
                  items={ukm!.corrections}
                />
              )}
            </div>
          </div>
        )}

        {/* ── Top memories ─────────────────────────────────────────────────── */}
        {topMemories.length > 0 && (
          <ProfileCard title="Most-used memories" icon={Star}>
            <p className="mb-3 text-xs text-muted-foreground">
              These memories have influenced Ekonomical's responses most often.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {topMemories.map((m) => {
                const typeMeta = MEMORY_TYPE_META.find((t) => t.value === m.type);
                return (
                  <div
                    key={m.id}
                    className="flex items-start gap-3 rounded-lg border border-border bg-card/50 px-3 py-2.5"
                  >
                    <span className="mt-0.5 shrink-0 text-sm">{typeMeta?.emoji ?? "💡"}</span>
                    <p className="flex-1 text-xs leading-relaxed text-foreground/90">{m.content}</p>
                    <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary tabular-nums">
                      ×{m.accessCount}
                    </span>
                  </div>
                );
              })}
            </div>
          </ProfileCard>
        )}

        <p className="text-center text-[11px] text-muted-foreground/40">
          Profile updates automatically after every conversation.
        </p>
      </div>
    </ScrollArea>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function HeroPill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 backdrop-blur-sm">
      <span className="text-sm font-bold tabular-nums">{value}</span>
      <span className="text-xs text-primary-foreground/70">{label}</span>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Brain;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-xs">{label}</span>
      </div>
      <p className="mt-1.5 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function ProfileCard({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Brain;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-accent/30 px-3 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

function StyleChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 rounded-lg border border-border bg-accent/30 px-3 py-1.5 text-center">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-xs capitalize">{value}</span>
    </div>
  );
}

function QualityBar({
  label,
  count,
  total,
  colorClass,
}: {
  label: string;
  count: number;
  total: number;
  colorClass: string;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{count}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", colorClass)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-accent/30 p-2.5">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-base font-bold tabular-nums">{value}</p>
    </div>
  );
}

function ConstraintCard({
  title,
  colorVariant,
  items,
}: {
  title: string;
  colorVariant: "destructive" | "amber" | "blue";
  items: string[];
}) {
  const styles = {
    destructive: {
      wrap:  "bg-destructive/5 border-destructive/20",
      label: "text-destructive/80",
      dot:   "bg-destructive/60",
      text:  "text-foreground/80",
    },
    amber: {
      wrap:  "bg-amber-500/5 border-amber-500/20",
      label: "text-amber-600 dark:text-amber-400",
      dot:   "bg-amber-500/60",
      text:  "text-foreground/80",
    },
    blue: {
      wrap:  "bg-blue-500/5 border-blue-500/20",
      label: "text-blue-600 dark:text-blue-400",
      dot:   "bg-blue-500/60",
      text:  "text-foreground/80",
    },
  }[colorVariant];

  return (
    <div className={cn("rounded-xl border p-4", styles.wrap)}>
      <p className={cn("mb-2.5 text-[11px] font-semibold uppercase tracking-wider", styles.label)}>
        {title}
      </p>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", styles.dot)} />
            <span className={cn("text-xs leading-relaxed", styles.text)}>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReferralCodesCard() {
  const { data, isLoading } = useQuery({
    queryKey: ["referral-codes"],
    queryFn: () => getMyReferralCodes(),
  });
  const [copied, setCopied] = React.useState<string | null>(null);
  const codes = data?.codes ?? [];

  const onCopy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      toast.success("Code copied!");
      setTimeout(() => setCopied(null), 1800);
    } catch {
      toast.error("Couldn't copy — try selecting manually.");
    }
  };

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Gift className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h2 className="font-display text-lg font-semibold">Your invites</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            You get 2 invite codes each month. Each code works once.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {isLoading ? (
          <>
            <div className="h-20 animate-pulse rounded-xl bg-muted/40" />
            <div className="h-20 animate-pulse rounded-xl bg-muted/40" />
          </>
        ) : (
          codes.map((c) => {
            const used = c.status === "used";
            return (
              <div
                key={c.code}
                className={cn(
                  "rounded-xl border p-3.5 transition-all",
                  used
                    ? "border-border/50 bg-muted/30 opacity-70"
                    : "border-primary/30 bg-primary/5",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "font-mono text-base font-semibold tracking-[0.2em]",
                      used && "line-through text-muted-foreground",
                    )}
                  >
                    {c.code}
                  </span>
                  {used ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Used
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onCopy(c.code)}
                      className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                    >
                      {copied === c.code ? (
                        <>
                          <Check className="h-3.5 w-3.5" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" /> Copy
                        </>
                      )}
                    </button>
                  )}
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {used && c.used_at
                    ? `Used ${new Date(c.used_at).toLocaleDateString()}`
                    : "Available — share with a friend"}
                </p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
