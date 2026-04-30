/**
 * Stripe webhook idempotency contract tests.
 *
 * The webhook (src/routes/api/webhooks.stripe.ts) protects against duplicate
 * Stripe deliveries with TWO layers of defense:
 *
 *   Layer 1 — `stripe_events` table primary-key on event.id.
 *             Re-delivery hits the unique-violation and we early-return.
 *
 *   Layer 2 — `credits_grant_for_period(user, plan, period_start, period_end, …)`
 *             checks the ledger for an existing 'plan_grant' row whose
 *             metadata.period_start matches and no-ops if found.
 *
 * Both must hold even under adversarial conditions:
 *   * Stripe replays the same event id              → only one grant
 *   * Stripe sends a second event for the SAME period (e.g. subscription.updated
 *     after invoice.paid) with a NEW event id        → still only one grant
 *   * A new billing period arrives                   → exactly one new grant
 *
 * We model both layers in TS and assert each scenario.
 */
import { describe, it, expect, beforeEach } from "vitest";

interface LedgerRow {
  id: string;
  user_id: string;
  delta: number;
  reason: string;
  balance_after: number;
  request_id: string | null;
  metadata: Record<string, unknown>;
}

class WebhookSim {
  private events = new Set<string>(); // stripe_events.event_id PK
  private wallets = new Map<string, { plan: string; balance: number; quota: number }>();
  private ledger: LedgerRow[] = [];
  private rowSeq = 0;
  private planQuotas: Record<string, number> = { free: 500, basic: 5_000 };

  setWallet(user: string, plan: string, balance: number) {
    this.wallets.set(user, {
      plan,
      balance,
      quota: this.planQuotas[plan] ?? 0,
    });
  }
  getWallet(user: string) {
    return this.wallets.get(user)!;
  }
  getLedger(user: string): LedgerRow[] {
    return this.ledger.filter((r) => r.user_id === user);
  }

  /** Returns false if event was already processed (Layer 1). */
  recordEvent(eventId: string): boolean {
    if (this.events.has(eventId)) return false;
    this.events.add(eventId);
    return true;
  }

  /** Mirrors public.credits_grant_for_period (Layer 2). */
  grantForPeriod(args: {
    user_id: string;
    plan: string;
    period_start: string;
    period_end: string;
  }): { granted: number; balance_after: number; already_granted: boolean } {
    const wallet = this.wallets.get(args.user_id) ?? {
      plan: "free",
      balance: 0,
      quota: 0,
    };

    // Idempotency on (user, period_start) via ledger metadata
    const already = this.ledger.find(
      (r) =>
        r.user_id === args.user_id &&
        r.reason === "plan_grant" &&
        (r.metadata as { period_start?: string }).period_start === args.period_start,
    );
    if (already) {
      return { granted: 0, balance_after: wallet.balance, already_granted: true };
    }

    const quota = this.planQuotas[args.plan] ?? 0;
    this.wallets.set(args.user_id, { plan: args.plan, balance: quota, quota });
    const row: LedgerRow = {
      id: `ledger-${++this.rowSeq}`,
      user_id: args.user_id,
      delta: quota,
      reason: "plan_grant",
      balance_after: quota,
      request_id: `stripe::${args.period_start}`,
      metadata: { plan: args.plan, period_start: args.period_start, period_end: args.period_end },
    };
    this.ledger.push(row);
    return { granted: quota, balance_after: quota, already_granted: false };
  }

  /** End-to-end: simulate the webhook handler for a Stripe event. */
  handleEvent(evt: {
    id: string;
    type: string;
    user_id: string;
    period_start: string;
    period_end: string;
  }): "skipped_duplicate" | "granted" | "noop_already_granted" {
    if (!this.recordEvent(evt.id)) return "skipped_duplicate";
    if (evt.type === "checkout.session.completed" || evt.type === "invoice.paid") {
      const r = this.grantForPeriod({
        user_id: evt.user_id,
        plan: "basic",
        period_start: evt.period_start,
        period_end: evt.period_end,
      });
      return r.already_granted ? "noop_already_granted" : "granted";
    }
    return "noop_already_granted";
  }
}

describe("Stripe webhook idempotency", () => {
  let sim: WebhookSim;
  const USER = "user-1";
  const P1_START = "2026-04-01T00:00:00Z";
  const P1_END = "2026-05-01T00:00:00Z";
  const P2_START = "2026-05-01T00:00:00Z";
  const P2_END = "2026-06-01T00:00:00Z";

  beforeEach(() => {
    sim = new WebhookSim();
    sim.setWallet(USER, "free", 500);
  });

  it("first checkout.session.completed grants the period once, balance becomes quota", () => {
    const r = sim.handleEvent({
      id: "evt_001",
      type: "checkout.session.completed",
      user_id: USER,
      period_start: P1_START,
      period_end: P1_END,
    });
    expect(r).toBe("granted");
    expect(sim.getWallet(USER).plan).toBe("basic");
    expect(sim.getWallet(USER).balance).toBe(5_000);
    expect(sim.getLedger(USER)).toHaveLength(1);
  });

  it("Layer 1: replaying the SAME event id is a no-op", () => {
    sim.handleEvent({
      id: "evt_001",
      type: "checkout.session.completed",
      user_id: USER,
      period_start: P1_START,
      period_end: P1_END,
    });
    const dup = sim.handleEvent({
      id: "evt_001",
      type: "checkout.session.completed",
      user_id: USER,
      period_start: P1_START,
      period_end: P1_END,
    });
    expect(dup).toBe("skipped_duplicate");
    expect(sim.getLedger(USER)).toHaveLength(1);
    expect(sim.getWallet(USER).balance).toBe(5_000);
  });

  it("Layer 2: a different event id for the SAME period still grants only once", () => {
    sim.handleEvent({
      id: "evt_001",
      type: "checkout.session.completed",
      user_id: USER,
      period_start: P1_START,
      period_end: P1_END,
    });
    // Stripe also sends customer.subscription.updated for the same period —
    // different event id, so Layer 1 lets it through; Layer 2 must catch it.
    const second = sim.handleEvent({
      id: "evt_002",
      type: "invoice.paid",
      user_id: USER,
      period_start: P1_START,
      period_end: P1_END,
    });
    expect(second).toBe("noop_already_granted");
    expect(sim.getLedger(USER)).toHaveLength(1);
    expect(sim.getWallet(USER).balance).toBe(5_000);
  });

  it("a NEW billing period grants exactly one new period", () => {
    sim.handleEvent({
      id: "evt_001",
      type: "checkout.session.completed",
      user_id: USER,
      period_start: P1_START,
      period_end: P1_END,
    });
    // Spend some credits in between
    sim.setWallet(USER, "basic", 250);

    const renewal = sim.handleEvent({
      id: "evt_renewal",
      type: "invoice.paid",
      user_id: USER,
      period_start: P2_START,
      period_end: P2_END,
    });
    expect(renewal).toBe("granted");
    expect(sim.getWallet(USER).balance).toBe(5_000); // refilled (not stacked)
    expect(sim.getLedger(USER)).toHaveLength(2);
  });

  it("storm of replays for the same period results in exactly one ledger row", () => {
    for (let i = 0; i < 10; i++) {
      sim.handleEvent({
        id: `evt_${i}`,
        type: i % 2 === 0 ? "invoice.paid" : "checkout.session.completed",
        user_id: USER,
        period_start: P1_START,
        period_end: P1_END,
      });
    }
    expect(sim.getLedger(USER)).toHaveLength(1);
    expect(sim.getWallet(USER).balance).toBe(5_000);
  });
});
