/**
 * Server functions for the credit & billing system.
 *
 *   getCreditState        — current plan + balance + features ("/credits/check")
 *   estimateRequestCredits — pre-flight estimate ("/credits/estimate")
 *   deductCredits          — atomic deduct via RPC ("/credits/deduct")
 *   getCreditLedger        — paginated history ("/credits/ledger")
 *   getCreditSummary       — 30-day breakdown by reason
 *   listPlans              — pricing-page data
 *   requestPlanAccess      — Pro/Team/Enterprise wait-list
 *
 * These wrap SECURITY DEFINER RPCs; the heavy lifting is in 0010_credits_billing.sql.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  estimateCredits,
  planAllowsModel,
  planAllowsFeature,
  pickFallbackModel,
  type PlanFeatures,
  type ReasonCode,
} from "./engine";

function isCreditsSchemaMissing(error: unknown): boolean {
  const message =
    typeof (error as { message?: unknown } | null)?.message === "string"
      ? ((error as { message: string }).message)
      : String(error ?? "");

  return (
    message.includes("schema cache") &&
    ["credits_ledger", "credits_summary", "credits_get_state", "plans", "user_credits"].some((name) =>
      message.includes(name),
    )
  );
}

const fallbackFeatures: PlanFeatures = {
  models: ["gpt-4o-mini", "claude-haiku-4-5-20251001"],
  memory: false,
  documents: false,
  max_context_tokens: 10_000,
  advanced_routing: false,
};

const fallbackPlans = [
  {
    id: "free",
    display_name: "Free",
    monthly_price_usd: 0,
    monthly_credits: 500,
    features: fallbackFeatures,
    is_purchasable: false,
    sort_order: 10,
  },
  {
    id: "basic",
    display_name: "Basic",
    monthly_price_usd: 20,
    monthly_credits: 5000,
    features: {
      models: ["gpt-4o-mini", "claude-haiku-4-5-20251001", "gpt-4o", "claude-sonnet-4-6", "gemini-2.0-flash"],
      memory: true,
      documents: true,
      max_context_tokens: 50_000,
      advanced_routing: true,
    } satisfies PlanFeatures,
    is_purchasable: true,
    sort_order: 20,
  },
];

// ---------------------------------------------------------------------------
// /credits/check
// ---------------------------------------------------------------------------
export const getCreditState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: raw, error } = await supabase
      .rpc("credits_get_state", { p_user_id: userId })
      .maybeSingle();
    const data = raw as
      | {
          plan: string;
          balance: number;
          monthly_quota: number;
          last_reset_at: string;
          features: PlanFeatures;
          current_period_end: string | null;
          subscription_status: string | null;
        }
      | null;

    if (error || !data) {
      // Wallet not provisioned yet — fall back to free defaults rather than crash.
      return {
        setupRequired: isCreditsSchemaMissing(error),
        plan: "free",
        balance: 500,
        monthlyQuota: 500,
        lastResetAt: new Date().toISOString(),
        currentPeriodEnd: null as string | null,
        subscriptionStatus: null as string | null,
        features: fallbackFeatures,
      };
    }

    return {
      setupRequired: false,
      plan: data.plan as string,
      balance: data.balance as number,
      monthlyQuota: data.monthly_quota as number,
      lastResetAt: data.last_reset_at as string,
      currentPeriodEnd: (data.current_period_end as string | null) ?? null,
      subscriptionStatus: (data.subscription_status as string | null) ?? null,
      features: data.features as PlanFeatures,
    };
  });

// ---------------------------------------------------------------------------
// /credits/estimate
// ---------------------------------------------------------------------------
const EstimateSchema = z.object({
  modelId: z.string().min(1).max(120),
  estInputTokens: z.number().int().min(0).max(500_000),
  estOutputTokens: z.number().int().min(0).max(64_000),
  memoryRead: z.boolean().optional(),
  documentRead: z.boolean().optional(),
});

export const estimateRequestCredits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => EstimateSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const breakdown = estimateCredits(data.modelId, data.estInputTokens, data.estOutputTokens, {
      memoryRead: data.memoryRead,
      documentRead: data.documentRead,
    });

    // Check if user can afford it.
    const { data: stateRaw } = await supabase
      .rpc("credits_get_state", { p_user_id: userId })
      .maybeSingle();
    const state = stateRaw as { balance: number; features: PlanFeatures } | null;
    const balance: number = state?.balance ?? 0;
    const features: PlanFeatures = state?.features ?? {
      models: [],
      memory: false,
      documents: false,
      max_context_tokens: 0,
      advanced_routing: false,
    };

    return {
      estimate: breakdown,
      balance,
      affordable: balance >= breakdown.total,
      modelAllowed: planAllowsModel(features, data.modelId),
      memoryAllowed: planAllowsFeature(features, "memory"),
      documentsAllowed: planAllowsFeature(features, "documents"),
      fallbackModelId: pickFallbackModel(features),
    };
  });

// ---------------------------------------------------------------------------
// /credits/deduct
// ---------------------------------------------------------------------------
const DeductSchema = z.object({
  amount: z.number().int().min(1).max(10_000),
  reason: z.enum([
    "chat",
    "memory_write",
    "memory_retrieval",
    "document_retrieval",
    "embedding",
    "admin_adjust",
  ]),
  requestId: z.string().min(1).max(120).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const deductCredits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => DeductSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: rawRow, error } = await supabase
      .rpc("credits_deduct", {
        p_user_id: userId,
        p_amount: data.amount,
        p_reason: data.reason as ReasonCode,
        p_request_id: data.requestId ?? null,
        p_metadata: data.metadata ?? {},
      })
      .maybeSingle();
    const row = rawRow as
      | { ledger_id: string; balance_after: number; charged: number }
      | null;

    if (error) {
      if (error.message?.includes("insufficient_credits")) {
        return { ok: false as const, error: "insufficient_credits" as const };
      }
      throw error;
    }
    return {
      ok: true as const,
      ledgerId: row?.ledger_id ?? "",
      balanceAfter: row?.balance_after ?? 0,
      charged: row?.charged ?? data.amount,
    };
  });

// ---------------------------------------------------------------------------
// /credits/ledger
// ---------------------------------------------------------------------------
const LedgerSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().datetime().optional(),
});

export const getCreditLedger = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => LedgerSchema.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    let q = supabase
      .from("credits_ledger")
      .select("id, delta, reason, balance_after, request_id, metadata, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.cursor) q = q.lt("created_at", data.cursor);

    const { data: rows, error } = await q;
    if (isCreditsSchemaMissing(error)) {
      return { entries: [], nextCursor: null, setupRequired: true };
    }
    if (error) throw error;

    type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
    type LedgerRow = {
      id: string;
      delta: number;
      reason: string;
      balance_after: number;
      request_id: string | null;
      metadata: JsonValue;
      created_at: string;
    };
    const list = (rows ?? []) as unknown as LedgerRow[];
    return {
      entries: list,
      nextCursor: list.length === data.limit ? list[list.length - 1].created_at : null,
      setupRequired: false,
    };
  });

// ---------------------------------------------------------------------------
// 30-day breakdown
// ---------------------------------------------------------------------------
export const getCreditSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase.rpc("credits_summary", { p_user_id: userId });
    if (isCreditsSchemaMissing(error)) {
      return { breakdown: [], setupRequired: true };
    }
    if (error) throw error;
    return {
      breakdown: (data ?? []) as Array<{ reason: string; total_spent: number; request_count: number }>,
      setupRequired: false,
    };
  });

// ---------------------------------------------------------------------------
// listPlans
// ---------------------------------------------------------------------------
export const listPlans = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("plans")
      .select("id, display_name, monthly_price_usd, monthly_credits, features, is_purchasable, sort_order")
      .order("sort_order", { ascending: true });
    if (isCreditsSchemaMissing(error)) {
      return { plans: fallbackPlans, setupRequired: true };
    }
    if (error) throw error;
    return { plans: data ?? [], setupRequired: false };
  });

// ---------------------------------------------------------------------------
// requestPlanAccess (Pro/Team/Enterprise)
// ---------------------------------------------------------------------------
const RequestPlanSchema = z.object({
  plan: z.enum(["pro", "team", "enterprise"]),
  message: z.string().trim().max(1_000).optional(),
});

export const requestPlanAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => RequestPlanSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("plan_access_requests")
      .insert({ user_id: userId, plan: data.plan, message: data.message ?? null });
    if (error) throw error;
    return { ok: true };
  });
