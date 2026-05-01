import { createFileRoute, Link, useSearch, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { z } from "zod";
import {
  Sparkles,
  Check,
  Receipt,
  ArrowRight,
  CreditCard,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  getCreditState,
  getCreditLedger,
  getCreditSummary,
  listPlans,
} from "@/lib/credits/credits.functions";
import {
  createCheckoutSession,
  createBillingPortalSession,
} from "@/lib/credits/billing.functions";

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

function BillingPage() {
  const search = useSearch({ from: "/_app/billing" });
  const router = useRouter();
  const [billingError, setBillingError] = useState<string | null>(null);

  const stateQ = useQuery({
    queryKey: ["credit-state"],
    queryFn: () => getCreditState(),
    refetchOnWindowFocus: true,
  });
  const ledgerQ = useQuery({
    queryKey: ["credit-ledger"],
    queryFn: () => getCreditLedger({ data: { limit: 25 } }),
  });
  const summaryQ = useQuery({
    queryKey: ["credit-summary"],
    queryFn: () => getCreditSummary(),
  });
  const plansQ = useQuery({
    queryKey: ["plans"],
    queryFn: () => listPlans(),
  });

  const checkoutMut = useMutation({
    mutationFn: () => createCheckoutSession({ data: { plan: "basic" } }),
    onSuccess: (res) => {
      if (res.ok && res.url) {
        window.open(res.url, "_blank", "noopener,noreferrer");
      } else {
        const message = res.ok ? "Couldn't start checkout." : res.error;
        setBillingError(message);
        toast.error(message);
      }
    },
    onError: (e: Error) => {
      const message = e.message ?? "Couldn't start checkout.";
      setBillingError(message);
      toast.error(message);
    },
  });
  const portalMut = useMutation({
    mutationFn: () => createBillingPortalSession(),
    onSuccess: (res) => {
      if (res.ok) window.location.href = res.url;
      else toast.error(res.error);
    },
    onError: (e: Error) => toast.error(e.message ?? "Couldn't open billing portal."),
  });

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
    state?.setupRequired || ledgerQ.data?.setupRequired || summaryQ.data?.setupRequired || plansQ.data?.setupRequired,
  );

  const startCheckout = () => {
    setBillingError(null);
    checkoutMut.mutate();
  };

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
        <Link
          to="/"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
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
                Run `supabase/sql/0010_credits_billing.sql` and `supabase/sql/0011_billing_extensions.sql` in Supabase, then reload the schema cache.
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

      {/* Plan + balance card */}
      <Card className="overflow-hidden border-primary/15 bg-gradient-to-br from-card to-card/60 p-6 shadow-[0_10px_40px_-20px_oklch(0.50_0.07_150/0.35)]">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <Badge
                variant="secondary"
                className="rounded-full bg-primary/10 text-primary"
              >
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
            {isFree ? (
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
            ) : (
              <Button
                variant="outline"
                onClick={() => portalMut.mutate()}
                disabled={portalMut.isPending || setupRequired}
                className="rounded-full"
              >
                {portalMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CreditCard className="mr-2 h-4 w-4" />
                )}
                Manage subscription
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
            (summaryQ.data?.breakdown ?? []).map((row) => (
              <div
                key={row.reason}
                className="flex items-center justify-between px-5 py-3 text-sm"
              >
                <div>
                  <div className="font-medium">{REASON_LABELS[row.reason] ?? row.reason}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.request_count.toLocaleString()} request
                    {row.request_count === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="font-mono text-sm tabular-nums">
                  −{row.total_spent.toLocaleString()}
                </div>
              </div>
            ))
          )}
        </Card>
      </section>

      {/* Ledger */}
      <section className="mt-10">
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">Recent activity</h3>
        <Card>
          {ledgerQ.isLoading ? (
            <div className="px-5 py-6 text-sm text-muted-foreground">Loading…</div>
          ) : (ledgerQ.data?.entries ?? []).length === 0 ? (
            <div className="px-5 py-6 text-sm text-muted-foreground">No activity yet.</div>
          ) : (
            <ul className="divide-y divide-border/60">
              {ledgerQ.data!.entries.map((e) => {
                const meta =
                  typeof e.metadata === "object" && e.metadata !== null
                    ? (e.metadata as Record<string, unknown>)
                    : {};
                const model = typeof meta.model === "string" ? meta.model : null;
                return (
                  <li
                    key={e.id}
                    className="flex items-center justify-between gap-4 px-5 py-3 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="font-medium">
                        {REASON_LABELS[e.reason] ?? e.reason}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {new Date(e.created_at).toLocaleString()}
                        {model ? ` · ${model}` : ""}
                      </div>
                    </div>
                    <div className="text-right">
                      <div
                        className={
                          "font-mono text-sm tabular-nums " +
                          (e.delta < 0 ? "text-foreground" : "text-primary")
                        }
                      >
                        {e.delta < 0 ? "−" : "+"}
                        {Math.abs(e.delta).toLocaleString()}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        bal {e.balance_after.toLocaleString()}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>

      {/* Plans */}
      <section className="mt-10 mb-12">
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">Available plans</h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {(plansQ.data?.plans ?? [])
            .filter((p: any) => p.id === "free" || p.id === "basic")
            .map((p: any) => {
              const isCurrent = state?.plan === p.id;
              const features = (p.features ?? {}) as {
                models?: string[];
                memory?: boolean;
                documents?: boolean;
                advanced_routing?: boolean;
                max_context_tokens?: number;
              };
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
                  {isCurrent ? (
                    <Button variant="outline" disabled className="w-full rounded-full">
                      Current plan
                    </Button>
                  ) : p.id === "basic" ? (
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
                  ) : (
                    <Button variant="outline" disabled className="w-full rounded-full">
                      Free
                    </Button>
                  )}
                </Card>
              );
            })}
        </div>
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <AlertCircle className="h-3.5 w-3.5" />
          Pro &amp; Team plans are coming soon. Need higher limits?{" "}
          <a className="underline" href="mailto:hello@cortex.app">
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
        "flex items-start gap-2 " + (ok ? "text-foreground" : "text-muted-foreground/60 line-through")
      }
    >
      <Check
        className={
          "mt-0.5 h-4 w-4 shrink-0 " + (ok ? "text-primary" : "text-muted-foreground/40")
        }
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
