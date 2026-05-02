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

    // Apply any pending plan change if eligible (balance == 0 OR effective
    // date passed). Best-effort; log the result so we can debug.
    try {
      const { data: applied, error: applyErr } = await supabase.rpc("apply_pending_plan", {
        p_user_id: userId,
      });
      if (applyErr) {
        console.warn("[getCreditState] apply_pending_plan rpc error:", applyErr.message);
      } else if (applied) {
        console.log("[getCreditState] apply_pending_plan result:", JSON.stringify(applied));
      }
    } catch (err) {
      console.warn("[getCreditState] apply_pending_plan threw:", err);
    }

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

    let pendingPlan: string | null = null;
    let pendingPlanEffectiveAt: string | null = null;
    try {
      const { data: pend, error: pendErr } = await supabase
        .from("user_credits")
        .select("pending_plan, pending_plan_effective_at")
        .eq("user_id", userId)
        .maybeSingle();
      if (pendErr) {
        console.warn("[getCreditState] pending_plan read error:", pendErr.message);
      }
      pendingPlan = (pend?.pending_plan as string | null) ?? null;
      pendingPlanEffectiveAt = (pend?.pending_plan_effective_at as string | null) ?? null;
    } catch (err) {
      console.warn("[getCreditState] pending_plan read threw:", err);
    }

    if (error || !data) {
      return {
        setupRequired: isCreditsSchemaMissing(error),
        plan: "free",
        balance: 500,
        monthlyQuota: 500,
        lastResetAt: new Date().toISOString(),
        currentPeriodEnd: null as string | null,
        subscriptionStatus: null as string | null,
        features: fallbackFeatures,
        pendingPlan,
        pendingPlanEffectiveAt,
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
      pendingPlan,
      pendingPlanEffectiveAt,
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

// ---------------------------------------------------------------------------
// Per-conversation credit usage (groups chat-reason ledger entries by conversation)
// ---------------------------------------------------------------------------
const ConvoUsageSchema = z.object({
  days: z.number().int().min(1).max(365).default(30),
  limit: z.number().int().min(1).max(100).default(50),
});

export const getCreditByConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => ConvoUsageSchema.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const since = new Date(Date.now() - data.days * 24 * 60 * 60 * 1000).toISOString();

    const { data: rows, error } = await supabase
      .from("credits_ledger")
      .select("id, delta, request_id, metadata, created_at")
      .eq("user_id", userId)
      .eq("reason", "chat")
      .lt("delta", 0)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(2000);

    if (isCreditsSchemaMissing(error)) {
      return { conversations: [], setupRequired: true };
    }
    if (error) throw error;

    type Agg = {
      conversation_id: string;
      total_spent: number;
      message_count: number;
      last_at: string;
      first_at: string;
    };

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    type LedgerRow = {
      id: string;
      delta: number;
      request_id: string | null;
      metadata: unknown;
      created_at: string;
    };
    const ledgerRows = (rows ?? []) as unknown as LedgerRow[];

    // Resolve conversation_id from metadata, or fall back to messages.id lookup via request_id.
    const orphanRequestIds = new Set<string>();
    for (const r of ledgerRows) {
      const meta = r.metadata;
      const hasConv =
        typeof meta === "object" &&
        meta !== null &&
        typeof (meta as Record<string, unknown>).conversation_id === "string";
      if (!hasConv && r.request_id && UUID_RE.test(r.request_id)) {
        orphanRequestIds.add(r.request_id);
      }
    }

    let messageIdToConvo = new Map<string, string>();
    if (orphanRequestIds.size > 0) {
      const ids = Array.from(orphanRequestIds);
      // Chunk to avoid URL-length / IN-list limits
      const CHUNK = 200;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const { data: msgs } = await supabase
          .from("messages")
          .select("id, conversation_id")
          .in("id", slice);
        for (const m of (msgs ?? []) as Array<{ id: string; conversation_id: string }>) {
          messageIdToConvo.set(m.id, m.conversation_id);
        }
      }
    }

    const map = new Map<string, Agg>();
    for (const r of ledgerRows) {
      const meta = r.metadata;
      let convId: string | null = null;
      if (
        typeof meta === "object" &&
        meta !== null &&
        typeof (meta as Record<string, unknown>).conversation_id === "string"
      ) {
        convId = (meta as Record<string, string>).conversation_id;
      } else if (r.request_id && messageIdToConvo.has(r.request_id)) {
        convId = messageIdToConvo.get(r.request_id) ?? null;
      }
      if (!convId) continue;

      const entry = map.get(convId);
      const spent = Math.abs(r.delta);
      const created = r.created_at;
      if (entry) {
        entry.total_spent += spent;
        entry.message_count += 1;
        if (created > entry.last_at) entry.last_at = created;
        if (created < entry.first_at) entry.first_at = created;
      } else {
        map.set(convId, {
          conversation_id: convId,
          total_spent: spent,
          message_count: 1,
          last_at: created,
          first_at: created,
        });
      }
    }

    const aggregated = Array.from(map.values()).sort((a, b) => b.total_spent - a.total_spent);
    const ids = aggregated.slice(0, data.limit).map((a) => a.conversation_id);

    let titleMap = new Map<string, string | null>();
    if (ids.length > 0) {
      const { data: convos } = await supabase
        .from("conversations")
        .select("id, title")
        .eq("user_id", userId)
        .in("id", ids);
      titleMap = new Map((convos ?? []).map((c: { id: string; title: string | null }) => [c.id, c.title]));
    }

    return {
      conversations: aggregated.slice(0, data.limit).map((a) => ({
        ...a,
        title: titleMap.get(a.conversation_id) ?? null,
      })),
      setupRequired: false,
    };
  });

// ---------------------------------------------------------------------------
// Detail view: every ledger entry for a single conversation
// ---------------------------------------------------------------------------
const ConvoDetailSchema = z.object({
  conversation_id: z.string().uuid(),
  days: z.number().int().min(1).max(365).default(90),
});

export const getCreditEntriesForConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => ConvoDetailSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const since = new Date(Date.now() - data.days * 24 * 60 * 60 * 1000).toISOString();

    const { data: rows, error } = await supabase
      .from("credits_ledger")
      .select("id, delta, reason, balance_after, request_id, metadata, created_at")
      .eq("user_id", userId)
      .eq("reason", "chat")
      .lt("delta", 0)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);

    type JsonV = string | number | boolean | null | JsonV[] | { [k: string]: JsonV };
    type EntryShape = {
      id: string;
      delta: number;
      reason: string;
      balance_after: number;
      request_id: string | null;
      metadata: JsonV;
      created_at: string;
    };
    if (isCreditsSchemaMissing(error)) {
      return { entries: [] as EntryShape[], setupRequired: true };
    }
    if (error) throw error;

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    type Row = EntryShape;
    const list = (rows ?? []) as unknown as Row[];

    // Look up message → conversation for entries that don't have conversation_id in metadata
    const orphanReqIds = list
      .filter((r) => {
        const m = r.metadata;
        const has =
          typeof m === "object" &&
          m !== null &&
          typeof (m as Record<string, unknown>).conversation_id === "string";
        return !has && r.request_id && UUID_RE.test(r.request_id);
      })
      .map((r) => r.request_id as string);

    const messageIdToConvo = new Map<string, string>();
    if (orphanReqIds.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < orphanReqIds.length; i += CHUNK) {
        const slice = orphanReqIds.slice(i, i + CHUNK);
        const { data: msgs } = await supabase
          .from("messages")
          .select("id, conversation_id")
          .in("id", slice);
        for (const m of (msgs ?? []) as Array<{ id: string; conversation_id: string }>) {
          messageIdToConvo.set(m.id, m.conversation_id);
        }
      }
    }

    const filtered = list.filter((r) => {
      const meta = r.metadata;
      const fromMeta =
        typeof meta === "object" &&
        meta !== null &&
        (meta as Record<string, unknown>).conversation_id === data.conversation_id;
      if (fromMeta) return true;
      if (r.request_id && messageIdToConvo.get(r.request_id) === data.conversation_id) return true;
      return false;
    });

    return { entries: filtered, setupRequired: false };
  });
