/**
 * End-to-end-ish tests for the credit deduction pipeline.
 *
 * The DB-side `credits_deduct` RPC is the source of truth for atomicity and
 * idempotency. We can't run real Postgres in the unit suite, so we model the
 * exact contract here in TypeScript and assert that:
 *
 *   1. A successful deduction shrinks the balance by EXACTLY the engine's
 *      computed credit total.
 *   2. Replaying the same `request_id` is a no-op (returns the original
 *      ledger row, balance unchanged) — this is what protects us from
 *      double-charging when chat.stream.ts retries network failures.
 *   3. Different `request_id`s on the same user create separate ledger rows.
 *   4. Insufficient balance raises and never partially debits.
 *   5. The pricing engine is deterministic for identical inputs (so retries
 *      compute the same amount).
 *
 * The mock mirrors the SQL in supabase/sql/0010_credits_billing.sql line-for-line
 * for the `credits_deduct` function.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { calculateCredits } from "../engine";

interface LedgerRow {
  id: string;
  user_id: string;
  delta: number;
  reason: string;
  balance_after: number;
  request_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

class CreditsRpcMock {
  private wallets = new Map<string, number>();
  private ledger: LedgerRow[] = [];
  private rowSeq = 0;

  setBalance(user: string, amount: number) {
    this.wallets.set(user, amount);
  }
  getBalance(user: string): number {
    return this.wallets.get(user) ?? 0;
  }
  getLedger(user: string): LedgerRow[] {
    return this.ledger.filter((r) => r.user_id === user);
  }

  /** Mirrors public.credits_deduct exactly. */
  deduct(args: {
    user_id: string;
    amount: number;
    reason: string;
    request_id?: string | null;
    metadata?: Record<string, unknown>;
  }): { ledger_id: string; balance_after: number; charged: number } {
    if (args.amount <= 0) throw new Error("invalid_amount");

    // Idempotency check (matches the unique index on (user_id, request_id))
    if (args.request_id) {
      const existing = this.ledger.find(
        (r) => r.user_id === args.user_id && r.request_id === args.request_id,
      );
      if (existing) {
        return {
          ledger_id: existing.id,
          balance_after: existing.balance_after,
          charged: -existing.delta, // delta is negative for deductions
        };
      }
    }

    const current = this.wallets.get(args.user_id) ?? 0;
    if (current < args.amount) throw new Error("insufficient_credits");

    const next = current - args.amount;
    this.wallets.set(args.user_id, next);
    const row: LedgerRow = {
      id: `ledger-${++this.rowSeq}`,
      user_id: args.user_id,
      delta: -args.amount,
      reason: args.reason,
      balance_after: next,
      request_id: args.request_id ?? null,
      metadata: args.metadata ?? {},
      created_at: new Date().toISOString(),
    };
    this.ledger.push(row);
    return { ledger_id: row.id, balance_after: next, charged: args.amount };
  }
}

describe("post-stream credit deduction (chat pipeline contract)", () => {
  let rpc: CreditsRpcMock;
  const USER = "user-test-1";

  beforeEach(() => {
    rpc = new CreditsRpcMock();
    rpc.setBalance(USER, 5_000);
  });

  it("deducts exactly the engine-computed amount after a streamed chat completes", () => {
    const breakdown = calculateCredits({
      modelId: "gpt-4o",
      inputTokens: 2_000,
      outputTokens: 800,
    });
    expect(breakdown.total).toBe(12);

    const result = rpc.deduct({
      user_id: USER,
      amount: breakdown.total,
      reason: "chat",
      request_id: "asst-msg-001",
      metadata: { tokens_in: 2000, tokens_out: 800 },
    });

    expect(result.charged).toBe(12);
    expect(result.balance_after).toBe(4_988);
    expect(rpc.getBalance(USER)).toBe(4_988);
    expect(rpc.getLedger(USER)).toHaveLength(1);
    expect(rpc.getLedger(USER)[0].delta).toBe(-12);
  });

  it("never double-charges on a retried deduction with the same request_id", () => {
    const amount = calculateCredits({
      modelId: "gpt-4o",
      inputTokens: 2_000,
      outputTokens: 800,
    }).total;

    // First call — debit
    const a = rpc.deduct({
      user_id: USER,
      amount,
      reason: "chat",
      request_id: "asst-msg-retry",
    });
    // Network blip → chat.stream.ts retries the same RPC with the same assistantId
    const b = rpc.deduct({
      user_id: USER,
      amount,
      reason: "chat",
      request_id: "asst-msg-retry",
    });
    // And a third time, just to be sure
    const c = rpc.deduct({
      user_id: USER,
      amount,
      reason: "chat",
      request_id: "asst-msg-retry",
    });

    expect(a.ledger_id).toBe(b.ledger_id);
    expect(b.ledger_id).toBe(c.ledger_id);
    expect(rpc.getBalance(USER)).toBe(5_000 - amount);
    expect(rpc.getLedger(USER)).toHaveLength(1);
  });

  it("creates separate ledger rows for distinct request_ids on the same user", () => {
    rpc.deduct({ user_id: USER, amount: 10, reason: "chat", request_id: "msg-A" });
    rpc.deduct({ user_id: USER, amount: 5, reason: "chat", request_id: "msg-B" });
    expect(rpc.getLedger(USER)).toHaveLength(2);
    expect(rpc.getBalance(USER)).toBe(5_000 - 15);
  });

  it("rejects deduction when balance is insufficient and never partially debits", () => {
    rpc.setBalance(USER, 5);
    expect(() =>
      rpc.deduct({ user_id: USER, amount: 100, reason: "chat", request_id: "msg-x" }),
    ).toThrow("insufficient_credits");
    expect(rpc.getBalance(USER)).toBe(5); // unchanged
    expect(rpc.getLedger(USER)).toHaveLength(0);
  });

  it("pricing engine is deterministic for identical token usage (so retries match)", () => {
    const a = calculateCredits({
      modelId: "claude-sonnet-4-6",
      inputTokens: 1234,
      outputTokens: 567,
      memoryRead: true,
    });
    const b = calculateCredits({
      modelId: "claude-sonnet-4-6",
      inputTokens: 1234,
      outputTokens: 567,
      memoryRead: true,
    });
    expect(a.total).toBe(b.total);
  });

  it("rejects amount=0 and negative amounts", () => {
    expect(() => rpc.deduct({ user_id: USER, amount: 0, reason: "chat" })).toThrow("invalid_amount");
    expect(() => rpc.deduct({ user_id: USER, amount: -3, reason: "chat" })).toThrow("invalid_amount");
    expect(rpc.getBalance(USER)).toBe(5_000);
  });

  it("simulates the chat.stream.ts retry loop: one charge, even with three concurrent retries", async () => {
    const amount = calculateCredits({
      modelId: "gpt-4o-mini",
      inputTokens: 800,
      outputTokens: 400,
    }).total;
    const reqId = "asst-concurrent-1";

    // Three "concurrent" attempts (sequential here — JS is single-threaded; the
    // real DB serializes via the unique index either way).
    const results = await Promise.all([
      Promise.resolve(rpc.deduct({ user_id: USER, amount, reason: "chat", request_id: reqId })),
      Promise.resolve(rpc.deduct({ user_id: USER, amount, reason: "chat", request_id: reqId })),
      Promise.resolve(rpc.deduct({ user_id: USER, amount, reason: "chat", request_id: reqId })),
    ]);

    expect(new Set(results.map((r) => r.ledger_id)).size).toBe(1);
    expect(rpc.getLedger(USER)).toHaveLength(1);
    expect(rpc.getBalance(USER)).toBe(5_000 - amount);
  });
});
