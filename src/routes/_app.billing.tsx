import { createFileRoute, Link, useSearch, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  Sparkles,
  Check,
  Receipt,
  ArrowRight,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  getCreditState,
  getCreditLedger,
  getCreditSummary,
  getCreditByConversation,
  getCreditEntriesForConversation,
  listPlans,
} from "@/lib/credits/credits.functions";
import {
  createCheckoutSession,
  syncCheckoutSession,
  schedulePlanChange,
} from "@/lib/credits/billing.functions";
import { EmbeddedCheckoutDialog } from "@/components/EmbeddedCheckoutDialog";

const SearchSchema = z.object({
  checkout: z.enum(["success", "cancelled"]).optional(),
  session_id: z.string().optional(),
});

export const Route = createFileRoute("/_app/billing")({
  validateSearch: SearchSchema,
  component: BillingPage,
});

const REASON_LABELS: Record<string, string> = {
  chat: "Conversations",
  memory_write: "Memory updates",
  memory_retrieval: "Memory recall",
  document_retrieval: "Document Q&A",
  embedding: "Indexing",
  monthly_reset: "Monthly reset",
  plan_grant: "Plan credits",
  plan_change: "Plan change",
  refund: "Refund",
  admin_adjust: "Adjustment",
};

type BillingPlan = {
  id: string;
  display_name: string;
  monthly_price_usd: number;
  monthly_credits: number;
  features?: {
    models?: string[];
    memory?: boolean;
    documents?: boolean;
    advanced_routing?: boolean;
    max_context_tokens?: number;
  };
};

function BillingPage() {
  const search = useSearch({ from: "/_app/billing" });
  const router = useRouter();
  const queryClient = useQueryClient();
  const [billingError, setBillingError] = useState<string | null>(null);
  const [checkoutClientSecret, setCheckoutClientSecret] = useState<string | null>(null);
  const [checkoutSessionId, setCheckoutSessionId] = useState<string | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [conversationsExpanded, setConversationsExpanded] = useState(false);
  const [expandedConvoId, setExpandedConvoId] = useState<string | null>(null);
  const [allActivityOpen, setAllActivityOpen] = useState(false);
  const [allActivityCursor, setAllActivityCursor] = useState<string | null>(null);
  const [allActivityEntries, setAllActivityEntries] = useState<
    Array<{
      id: string;
      delta: number;
      reason: string;
      balance_after: number;
      metadata: unknown;
      created_at: string;
    }>
  >([]);
  const [loadingMoreActivity, setLoadingMoreActivity] = useState(false);
  const [filterMonth, setFilterMonth] = useState<string>("all"); // "all" | "0".."11"
  const [filterYear, setFilterYear] = useState<string>("all"); // "all" | "2024" etc.

  const stateQ = useQuery({
    queryKey: ["credit-state"],
    queryFn: () => getCreditState(),
    refetchOnWindowFocus: true,
  });
  const ledgerQ = useQuery({
    queryKey: ["credit-ledger", "recent"],
    queryFn: () => getCreditLedger({ data: { limit: 5 } }),
  });
  const summaryQ = useQuery({
    queryKey: ["credit-summary"],
    queryFn: () => getCreditSummary(),
  });
  const convoUsageQ = useQuery({
    queryKey: ["credit-by-conversation"],
    queryFn: () => getCreditByConversation({ data: { days: 30, limit: 50 } }),
    enabled: conversationsExpanded,
  });
  const convoDetailQ = useQuery({
    queryKey: ["credit-convo-detail", expandedConvoId],
    queryFn: () =>
      getCreditEntriesForConversation({
        data: { conversation_id: expandedConvoId!, days: 90 },
      }),
    enabled: !!expandedConvoId,
  });
  const plansQ = useQuery({
    queryKey: ["plans"],
    queryFn: () => listPlans(),
  });

  const checkoutMut = useMutation({
    mutationFn: () => createCheckoutSession({ data: { plan: "basic" } }),
  });
  const scheduleMut = useMutation({
    mutationFn: (targetPlan: "free" | "basic") =>
      schedulePlanChange({ data: { targetPlan } }),
    onSuccess: async (res) => {
      if (res.ok) {
        toast.success(
          res.appliedToPlan === "free"
            ? "You're now on the Free plan. Your remaining credits stay until they run out."
            : "You're now on the Basic plan. Your existing credits are preserved.",
        );
        await queryClient.invalidateQueries({ queryKey: ["credit-state"] });
        await queryClient.invalidateQueries({ queryKey: ["credit-ledger"] });
        await queryClient.invalidateQueries({ queryKey: ["credit-summary"] });
        await stateQ.refetch();
      } else {
        toast.error(res.error ?? "Couldn't change plan.");
      }
    },
    onError: (e: Error) => toast.error(e.message ?? "Couldn't schedule plan change."),
  });

  const loadAllActivity = useCallback(
    async (cursor: string | null) => {
      setLoadingMoreActivity(true);
      try {
        const res = await getCreditLedger({
          data: { limit: 50, cursor: cursor ?? undefined },
        });
        setAllActivityEntries((prev) => {
          if (!cursor) return res.entries;
          const seen = new Set(prev.map((e) => e.id));
          return [...prev, ...res.entries.filter((e) => !seen.has(e.id))];
        });
        setAllActivityCursor(res.nextCursor ?? null);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't load activity.");
      } finally {
        setLoadingMoreActivity(false);
      }
    },
    [],
  );

  // Toast on return from Stripe
  const [poll, setPoll] = useState(false);
  useEffect(() => {
    if (search.checkout === "success") {
      toast.success("Welcome to Basic! Your credits are being added…");
      setPoll(true);
    } else if (search.checkout === "cancelled") {
      toast.info("Checkout cancelled. You can upgrade anytime.");
    }
  }, [search.checkout]);

  // Poll for plan flip after checkout success (webhook is async).
  useEffect(() => {
    if (!poll) return;
    let n = 0;
    const t = setInterval(() => {
      n++;
      void stateQ.refetch();
      void ledgerQ.refetch();
      if (stateQ.data?.plan === "basic" || n >= 10) {
        clearInterval(t);
        setPoll(false);
        // Clean URL
        void router.navigate({ to: "/billing", search: {} });
      }
    }, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll, stateQ.data?.plan]);

  const state = stateQ.data;
  const balance = state?.balance ?? 0;
  const quota = state?.monthlyQuota ?? 0;
  const used = Math.max(0, quota - balance);
  const usedPct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const isFree = (state?.plan ?? "free") === "free";
  const setupRequired = Boolean(
    state?.setupRequired ||
    ledgerQ.data?.setupRequired ||
    summaryQ.data?.setupRequired ||
    plansQ.data?.setupRequired,
  );

  const startCheckout = async () => {
    if (checkoutMut.isPending) return;
    setBillingError(null);

    try {
      const res = await checkoutMut.mutateAsync();
      if (res.ok && res.clientSecret) {
        setCheckoutClientSecret(res.clientSecret);
        setCheckoutSessionId(res.sessionId);
        setCheckoutOpen(true);
      } else {
        const message = res.ok ? "Couldn't start checkout." : res.error;
        setBillingError(message);
        toast.error(message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't start checkout.";
      setBillingError(message);
      toast.error(message);
    }
  };

  const handleCheckoutComplete = useCallback(async () => {
    setCheckoutOpen(false);
    setCheckoutClientSecret(null);
    toast.success("Payment received! Updating your plan…");
    if (checkoutSessionId) {
      try {
        const sync = await syncCheckoutSession({ data: { sessionId: checkoutSessionId } });
        if (!sync.ok || sync.pending) setPoll(true);
      } catch {
        setPoll(true);
      }
    } else {
      setPoll(true);
    }
    void queryClient.invalidateQueries({ queryKey: ["credit-state"] });
    void queryClient.invalidateQueries({ queryKey: ["credit-ledger"] });
    void queryClient.invalidateQueries({ queryKey: ["credit-summary"] });
  }, [checkoutSessionId, queryClient]);

  return (
    <div className="mx-auto w-full max-w-5xl overflow-y-auto px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-card/80 px-3 py-1 text-xs text-muted-foreground">
            <Receipt className="h-3.5 w-3.5" /> Billing &amp; usage
          </div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            Your plan &amp; credits
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Track your monthly credits, see where they go, and upgrade when you need more.
          </p>
        </div>
        <Link to="/app" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to chat
        </Link>
      </header>

      {setupRequired && (
        <Card className="mb-6 border-destructive/20 bg-destructive/5 p-4">
          <div className="flex gap-3 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-foreground">Billing database setup is not complete.</p>
              <p className="mt-1 text-muted-foreground">
                Run `supabase/sql/0010_credits_billing.sql` and
                `supabase/sql/0011_billing_extensions.sql` in Supabase, then reload the schema
                cache.
              </p>
            </div>
          </div>
        </Card>
      )}

      {billingError && !setupRequired && (
        <Card className="mb-6 border-destructive/20 bg-destructive/5 p-4">
          <div className="flex gap-3 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-foreground">Checkout couldn't open.</p>
              <p className="mt-1 text-muted-foreground">{billingError}</p>
            </div>
          </div>
        </Card>
      )}

      <EmbeddedCheckoutDialog
        open={checkoutOpen}
        onOpenChange={(o) => {
          setCheckoutOpen(o);
          if (!o) {
            setCheckoutClientSecret(null);
            setCheckoutSessionId(null);
          }
        }}
        clientSecret={checkoutClientSecret}
        onComplete={handleCheckoutComplete}
      />

      {/* Plan + balance card */}
      <Card className="overflow-hidden border-primary/15 bg-gradient-to-br from-card to-card/60 p-6 shadow-[0_10px_40px_-20px_oklch(0.50_0.07_150/0.35)]">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <Badge variant="secondary" className="rounded-full bg-primary/10 text-primary">
                {(state?.plan ?? "—").toUpperCase()} plan
              </Badge>
              {state?.subscriptionStatus && state.subscriptionStatus !== "active" && (
                <Badge variant="outline" className="rounded-full">
                  {state.subscriptionStatus}
                </Badge>
              )}
            </div>
            <h2 className="font-display text-2xl font-semibold">
              {balance.toLocaleString()}{" "}
              <span className="text-base font-normal text-muted-foreground">
                of {quota.toLocaleString()} credits left
              </span>
            </h2>
            {state?.lastResetAt && (
              <p className="mt-1 text-xs text-muted-foreground">
                Resets {formatRelativeMonthly(state.lastResetAt)}
                {state.currentPeriodEnd
                  ? ` · next billing ${new Date(state.currentPeriodEnd).toLocaleDateString()}`
                  : ""}
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {isFree && (
              <Button
                size="lg"
                onClick={startCheckout}
                disabled={checkoutMut.isPending || setupRequired}
                className="rounded-full"
              >
                {checkoutMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-4 w-4" />
                )}
                Upgrade to Basic — $20/mo
              </Button>
            )}
          </div>
        </div>

        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>{used.toLocaleString()} used this month</span>
            <span>{balance.toLocaleString()} remaining</span>
          </div>
          <Progress value={usedPct} className="h-2" />
        </div>
      </Card>

      {/* This month breakdown */}
      <section className="mt-10">
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">
          Where your credits go (last 30 days)
        </h3>
        <Card className="divide-y divide-border/60">
          {summaryQ.isLoading ? (
            <div className="px-5 py-6 text-sm text-muted-foreground">Loading…</div>
          ) : (summaryQ.data?.breakdown ?? []).length === 0 ? (
            <div className="px-5 py-6 text-sm text-muted-foreground">
              No spend yet — start a chat to see usage here.
            </div>
          ) : (
            (summaryQ.data?.breakdown ?? []).map((row) => {
              const isChat = row.reason === "chat";
              const isOpen = isChat && conversationsExpanded;
              return (
                <div key={row.reason}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!isChat) return;
                      setConversationsExpanded((v) => !v);
                      setExpandedConvoId(null);
                    }}
                    className={
                      "flex w-full items-center justify-between gap-3 px-5 py-3 text-left text-sm " +
                      (isChat ? "cursor-pointer hover:bg-accent/30" : "cursor-default")
                    }
                    disabled={!isChat}
                    aria-expanded={isOpen}
                  >
                    <div className="flex items-center gap-2">
                      {isChat &&
                        (isOpen ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        ))}
                      <div>
                        <div className="font-medium">
                          {REASON_LABELS[row.reason] ?? row.reason}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {row.request_count.toLocaleString()} request
                          {row.request_count === 1 ? "" : "s"}
                          {isChat && !isOpen ? " · click to break down by conversation" : ""}
                        </div>
                      </div>
                    </div>
                    <div className="font-mono text-sm tabular-nums">
                      −{row.total_spent.toLocaleString()}
                    </div>
                  </button>

                  {isOpen && (
                    <div className="border-t border-border/60 bg-muted/20">
                      {convoUsageQ.isLoading ? (
                        <div className="px-5 py-4 text-xs text-muted-foreground">
                          Loading conversations…
                        </div>
                      ) : (convoUsageQ.data?.conversations ?? []).length === 0 ? (
                        <div className="px-5 py-4 text-xs text-muted-foreground">
                          No conversation-level data yet. New chats will appear here as they
                          consume credits.
                        </div>
                      ) : (
                        <ul className="divide-y divide-border/40">
                          {convoUsageQ.data!.conversations.map((c) => {
                            const isThisOpen = expandedConvoId === c.conversation_id;
                            return (
                              <li key={c.conversation_id}>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedConvoId((id) =>
                                      id === c.conversation_id ? null : c.conversation_id,
                                    )
                                  }
                                  className="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left text-sm hover:bg-accent/40"
                                  aria-expanded={isThisOpen}
                                >
                                  <div className="flex min-w-0 items-center gap-2">
                                    {isThisOpen ? (
                                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                    ) : (
                                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                    )}
                                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0">
                                      <div className="truncate font-medium">
                                        {c.title ?? "Untitled conversation"}
                                      </div>
                                      <div className="text-xs text-muted-foreground">
                                        {c.message_count} message
                                        {c.message_count === 1 ? "" : "s"} ·{" "}
                                        {new Date(c.last_at).toLocaleDateString()}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-3 shrink-0">
                                    <div className="font-mono text-sm tabular-nums">
                                      −{c.total_spent.toLocaleString()}
                                    </div>
                                    <Link
                                      to="/c/$id"
                                      params={{ id: c.conversation_id }}
                                      onClick={(e) => e.stopPropagation()}
                                      className="text-xs text-primary hover:underline"
                                    >
                                      Open
                                    </Link>
                                  </div>
                                </button>

                                {isThisOpen && (
                                  <div className="border-t border-border/40 bg-background/60 px-5 py-3">
                                    {convoDetailQ.isLoading ? (
                                      <div className="text-xs text-muted-foreground">
                                        Loading events…
                                      </div>
                                    ) : (convoDetailQ.data?.entries ?? []).length === 0 ? (
                                      <div className="text-xs text-muted-foreground">
                                        No event details available.
                                      </div>
                                    ) : (
                                      <ul className="space-y-1.5">
                                        {convoDetailQ.data!.entries.map((ev) => {
                                          const m =
                                            typeof ev.metadata === "object" &&
                                            ev.metadata !== null
                                              ? (ev.metadata as Record<string, unknown>)
                                              : {};
                                          const model =
                                            typeof m.model === "string" ? m.model : null;
                                          const tIn =
                                            typeof m.tokens_in === "number" ? m.tokens_in : null;
                                          const tOut =
                                            typeof m.tokens_out === "number"
                                              ? m.tokens_out
                                              : null;
                                          return (
                                            <li
                                              key={ev.id}
                                              className="flex items-center justify-between gap-3 text-xs"
                                            >
                                              <div className="min-w-0">
                                                <div className="text-muted-foreground">
                                                  {new Date(ev.created_at).toLocaleString()}
                                                </div>
                                                <div className="truncate text-muted-foreground/80">
                                                  {model ? `${model}` : "—"}
                                                  {tIn !== null && tOut !== null
                                                    ? ` · ${tIn.toLocaleString()} in / ${tOut.toLocaleString()} out tokens`
                                                    : ""}
                                                </div>
                                              </div>
                                              <div className="font-mono tabular-nums">
                                                −{Math.abs(ev.delta).toLocaleString()}
                                              </div>
                                            </li>
                                          );
                                        })}
                                      </ul>
                                    )}
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </Card>
      </section>

      {/* Ledger */}
      <section className="mt-10">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-muted-foreground">Recent activity</h3>
          <button
            type="button"
            onClick={() => {
              setAllActivityOpen(true);
              if (allActivityEntries.length === 0) {
                void loadAllActivity(null);
              }
            }}
            className="text-xs text-primary hover:underline"
          >
            View all activity
          </button>
        </div>
        <Card>
          {ledgerQ.isLoading ? (
            <div className="px-5 py-6 text-sm text-muted-foreground">Loading…</div>
          ) : (ledgerQ.data?.entries ?? []).length === 0 ? (
            <div className="px-5 py-6 text-sm text-muted-foreground">No activity yet.</div>
          ) : (
            <>
              <ul className="divide-y divide-border/60">
                {ledgerQ.data!.entries.slice(0, 5).map((e) => (
                  <LedgerRow key={e.id} entry={e} />
                ))}
              </ul>
              <div className="border-t border-border/60 px-5 py-3">
                <button
                  type="button"
                  onClick={() => {
                    setAllActivityOpen(true);
                    if (allActivityEntries.length === 0) {
                      void loadAllActivity(null);
                    }
                  }}
                  className="flex w-full items-center justify-center gap-1.5 text-sm font-medium text-primary hover:underline"
                >
                  See full credit history <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </>
          )}
        </Card>
      </section>

      {/* Full activity dialog */}
      <Dialog open={allActivityOpen} onOpenChange={setAllActivityOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>All credit activity</DialogTitle>
            <DialogDescription>
              Every credit transaction on your account, newest first.
            </DialogDescription>
          </DialogHeader>
          {(() => {
            const isFiltering = filterMonth !== "all" || filterYear !== "all";
            const filtered = isFiltering
              ? allActivityEntries.filter((e) => {
                  const d = new Date(e.created_at);
                  if (filterYear !== "all" && String(d.getFullYear()) !== filterYear) return false;
                  if (filterMonth !== "all" && String(d.getMonth()) !== filterMonth) return false;
                  return true;
                })
              : allActivityEntries;
            const years = Array.from(
              new Set(allActivityEntries.map((e) => new Date(e.created_at).getFullYear())),
            ).sort((a, b) => b - a);
            const monthNames = [
              "January", "February", "March", "April", "May", "June",
              "July", "August", "September", "October", "November", "December",
            ];
            return (
              <>
                <div className="flex flex-wrap items-center gap-2 pb-2">
                  <span className="text-xs text-muted-foreground">Filter:</span>
                  <Select value={filterMonth} onValueChange={setFilterMonth}>
                    <SelectTrigger className="h-8 w-[140px]">
                      <SelectValue placeholder="Month" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All months</SelectItem>
                      {monthNames.map((m, i) => (
                        <SelectItem key={i} value={String(i)}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={filterYear} onValueChange={setFilterYear}>
                    <SelectTrigger className="h-8 w-[110px]">
                      <SelectValue placeholder="Year" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All years</SelectItem>
                      {years.map((y) => (
                        <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {isFiltering && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8"
                        onClick={() => {
                          setFilterMonth("all");
                          setFilterYear("all");
                        }}
                      >
                        Clear
                      </Button>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {filtered.length} of {allActivityEntries.length} loaded
                      </span>
                    </>
                  )}
                </div>
                <div className="max-h-[55vh] overflow-y-auto">
                  {filtered.length === 0 && !loadingMoreActivity ? (
                    <div className="px-2 py-6 text-sm text-muted-foreground">
                      {isFiltering
                        ? "No activity in the selected period. Try loading more or adjusting the filter."
                        : "No activity yet."}
                    </div>
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {filtered.map((e) => (
                        <LedgerRow key={e.id} entry={e} />
                      ))}
                    </ul>
                  )}
                  {loadingMoreActivity && (
                    <div className="py-3 text-center text-xs text-muted-foreground">
                      <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Loading…
                    </div>
                  )}
                </div>
                {allActivityCursor && (
                  <div className="flex justify-center pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => loadAllActivity(allActivityCursor)}
                      disabled={loadingMoreActivity}
                    >
                      Load more
                    </Button>
                  </div>
                )}
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Plans */}
      <section className="mt-10 mb-12">
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">Available plans</h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {((plansQ.data?.plans ?? []) as BillingPlan[])
            .filter((p) => p.id === "free" || p.id === "basic")
            .map((p) => {
              const isCurrent = state?.plan === p.id;
              const features = p.features ?? {};
              return (
                <Card
                  key={p.id}
                  className={
                    "p-6 " +
                    (isCurrent
                      ? "border-primary/40 shadow-[0_4px_22px_-12px_oklch(0.50_0.07_150/0.45)]"
                      : "")
                  }
                >
                  <div className="mb-3 flex items-center justify-between">
                    <h4 className="font-display text-xl font-semibold">{p.display_name}</h4>
                    <div className="text-right">
                      <div className="text-2xl font-semibold">
                        ${Number(p.monthly_price_usd).toFixed(0)}
                      </div>
                      <div className="text-xs text-muted-foreground">/ month</div>
                    </div>
                  </div>
                  <div className="mb-4 text-sm text-muted-foreground">
                    {p.monthly_credits.toLocaleString()} credits / month
                  </div>
                  <ul className="mb-5 space-y-1.5 text-sm">
                    <Feat ok={(features.models ?? []).length > 0}>
                      {features.models?.includes("*")
                        ? "All models including premium"
                        : `${(features.models ?? []).length} models`}
                    </Feat>
                    <Feat ok={!!features.memory}>Long-term memory</Feat>
                    <Feat ok={!!features.documents}>Document Q&amp;A</Feat>
                    <Feat ok={!!features.advanced_routing}>Smart model routing</Feat>
                    <Feat ok={(features.max_context_tokens ?? 0) >= 50_000}>
                      Long-context conversations
                    </Feat>
                  </ul>
                  {(() => {
                    if (isCurrent) {
                      return (
                        <Button variant="outline" disabled className="w-full rounded-full">
                          Current plan
                        </Button>
                      );
                    }
                    if (p.id === "basic") {
                      // Free → Basic: requires payment, go through checkout immediately.
                      return (
                        <Button
                          onClick={startCheckout}
                          disabled={checkoutMut.isPending || setupRequired}
                          className="w-full rounded-full"
                        >
                          {checkoutMut.isPending ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : null}
                          Upgrade <ArrowRight className="ml-1.5 h-4 w-4" />
                        </Button>
                      );
                    }
                    // Basic → Free: immediate downgrade. Existing credits and expiry are preserved.
                    return (
                      <Button
                        variant="outline"
                        onClick={() => {
                          if (
                            confirm(
                              "Downgrade to Free? You'll keep your current credits and expiry — no refund, but billing stops at the end of your current period.",
                            )
                          ) {
                            scheduleMut.mutate("free");
                          }
                        }}
                        disabled={scheduleMut.isPending || setupRequired}
                        className="w-full rounded-full"
                      >
                        {scheduleMut.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : null}
                        Downgrade to Free
                      </Button>
                    );
                  })()}
                </Card>
              );
            })}
        </div>
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <AlertCircle className="h-3.5 w-3.5" />
          Pro &amp; Team plans are coming soon. Need higher limits?{" "}
          <a className="underline" href="mailto:hello@ekonomical.app">
            Get in touch
          </a>
          .
        </p>
      </section>
    </div>
  );
}

function Feat({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li
      className={
        "flex items-start gap-2 " +
        (ok ? "text-foreground" : "text-muted-foreground/60 line-through")
      }
    >
      <Check
        className={"mt-0.5 h-4 w-4 shrink-0 " + (ok ? "text-primary" : "text-muted-foreground/40")}
      />
      <span>{children}</span>
    </li>
  );
}

function formatRelativeMonthly(iso: string): string {
  const last = new Date(iso);
  const next = new Date(last);
  next.setMonth(next.getMonth() + 1);
  return `on ${next.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function LedgerRow({
  entry,
}: {
  entry: {
    id: string;
    delta: number;
    reason: string;
    balance_after: number;
    metadata: unknown;
    created_at: string;
  };
}) {
  const meta =
    typeof entry.metadata === "object" && entry.metadata !== null
      ? (entry.metadata as Record<string, unknown>)
      : {};
  const model = typeof meta.model === "string" ? meta.model : null;
  return (
    <li className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
      <div className="min-w-0">
        <div className="font-medium">{REASON_LABELS[entry.reason] ?? entry.reason}</div>
        <div className="truncate text-xs text-muted-foreground">
          {new Date(entry.created_at).toLocaleString()}
          {model ? ` · ${model}` : ""}
        </div>
      </div>
      <div className="text-right">
        <div
          className={
            "font-mono text-sm tabular-nums " +
            (entry.delta < 0 ? "text-foreground" : "text-primary")
          }
        >
          {entry.delta < 0 ? "−" : "+"}
          {Math.abs(entry.delta).toLocaleString()}
        </div>
        <div className="text-xs text-muted-foreground">
          bal {entry.balance_after.toLocaleString()}
        </div>
      </div>
    </li>
  );
}
