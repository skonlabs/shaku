/**
 * Billing server functions:
 *
 *   createCheckoutSession  — Stripe Checkout for the Basic plan ($20/mo)
 *   createBillingPortalSession — manage payment method / cancel
 *
 * The webhook (src/routes/api/webhooks.stripe.ts) is the source of truth for
 * plan flips and credit grants. These endpoints just initiate the flow.
 */

import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getStripePublishableKey = createServerFn({ method: "GET" }).handler(async () => {
  return { publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "" };
});

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  // Pin to the SDK's default api version (no override) to avoid TS literal mismatch.
  return new Stripe(key);
}

function getOrigin(): string {
  return (
    getRequestHeader("origin") ??
    safeOriginFromUrl(getRequestHeader("referer")) ??
    process.env.PUBLIC_APP_ORIGIN ??
    process.env.APP_ORIGIN ??
    "https://20cb2f0c-2f09-469c-bb65-aa855f85b760.lovable.app"
  );
}

function safeOriginFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const CheckoutSchema = z.object({
  plan: z.literal("basic"),
});

const SyncCheckoutSchema = z.object({
  sessionId: z.string().min(8).max(255),
});

function isCreditsSchemaMissing(error: unknown): boolean {
  const message =
    typeof (error as { message?: unknown } | null)?.message === "string"
      ? (error as { message: string }).message
      : String(error ?? "");

  return message.includes("schema cache") && ["user_credits", "plans", "credits_ledger"].some((name) => message.includes(name));
}

export const createCheckoutSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => CheckoutSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const stripe = getStripe();
    // Best-effort fetch user email for Stripe customer creation.
    let userEmail: string | undefined;
    try {
      const { data: u } = await supabase.auth.getUser();
      userEmail = u.user?.email ?? undefined;
    } catch {
      /* ignore */
    }

    const priceId = process.env.STRIPE_PRICE_BASIC;
    if (!priceId) {
      return {
        ok: false as const,
        error:
          "Stripe is not fully configured yet (missing STRIPE_PRICE_BASIC). Ask the admin to finish setup.",
      };
    }

    // Reuse stripe_customer_id if we already have one, otherwise create.
    const { data: walletRaw, error: walletErr } = await supabase
      .from("user_credits")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (isCreditsSchemaMissing(walletErr)) {
      return {
        ok: false as const,
        error: "Billing is still being set up. Please apply the credits billing SQL migration, then try again.",
      };
    }
    if (walletErr) throw walletErr;
    let customerId = (walletRaw?.stripe_customer_id as string | null) ?? null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: { supabase_user_id: userId },
      });
      customerId = customer.id;
      await supabase
        .from("user_credits")
        .update({ stripe_customer_id: customerId })
        .eq("user_id", userId);
    }

    const origin = getOrigin();
    const params = {
      mode: "subscription",
      ui_mode: "embedded_page",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      return_url: `${origin}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      redirect_on_completion: "if_required",
      allow_promotion_codes: true,
      client_reference_id: userId,
      subscription_data: {
        metadata: { supabase_user_id: userId, plan: data.plan },
      },
      metadata: { supabase_user_id: userId, plan: data.plan },
    } as unknown as Stripe.Checkout.SessionCreateParams;
    const session = await stripe.checkout.sessions.create(params);

    return {
      ok: true as const,
      clientSecret: session.client_secret ?? "",
      sessionId: session.id,
    };
  });

export const createBillingPortalSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const stripe = getStripe();
    const { data: walletRaw, error: walletErr } = await supabase
      .from("user_credits")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (isCreditsSchemaMissing(walletErr)) {
      return {
        ok: false as const,
        error: "Billing is still being set up. Please apply the credits billing SQL migration, then try again.",
      };
    }
    if (walletErr) throw walletErr;
    const customerId = walletRaw?.stripe_customer_id as string | null;
    if (!customerId) {
      return {
        ok: false as const,
        error: "No Stripe customer on file yet — upgrade first.",
      };
    }
    try {
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${getOrigin()}/billing`,
      });
      return { ok: true as const, url: portal.url };
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string; raw?: { message?: string } };
      const message = e?.raw?.message || e?.message || "Couldn't open billing portal.";
      console.error("[billingPortal] Stripe error:", message);
      // Common case: test-mode default configuration not yet created in Stripe Dashboard.
      if (/configuration/i.test(message)) {
        return {
          ok: false as const,
          error:
            "Stripe Customer Portal isn't configured yet. Open your Stripe Dashboard → Settings → Billing → Customer portal, save the default configuration, then try again.",
        };
      }
      return { ok: false as const, error: message };
    }
  });

export const syncCheckoutSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => SyncCheckoutSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(data.sessionId);
    const sessionUserId = session.metadata?.supabase_user_id ?? session.client_reference_id;
    if (sessionUserId !== userId) {
      return { ok: false as const, plan: null, pending: true, error: "Billing sync is still pending." };
    }

    const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    if (!subscriptionId || session.status !== "complete") {
      return { ok: true as const, plan: null, pending: true };
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const periodStart = secondsToIso(getSubscriptionPeriodStart(subscription));
    const periodEnd = secondsToIso(getSubscriptionPeriodEnd(subscription));
    if (!periodStart || !periodEnd) {
      return { ok: true as const, plan: null, pending: true };
    }

    const writeSupabase = serviceRoleKey && supabaseUrl
      ? createClient(supabaseUrl, serviceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : supabase;
    const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
    const { error } = await writeSupabase.rpc("credits_grant_for_period", {
      p_user_id: userId,
      p_plan: "basic",
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_stripe_customer_id: customerId,
      p_stripe_subscription_id: subscription.id,
      p_subscription_status: subscription.status,
    });
    if (error) throw error;

    return { ok: true as const, plan: "basic", pending: false };
  });

/**
 * Schedule a plan change (upgrade or downgrade).
 *
 * Rules (no refunds, no balance wipes):
 *   - The change is recorded as `pending_plan` with `pending_plan_effective_at`
 *     set to the user's current billing period end (or last_reset + 30d for
 *     free users with no Stripe period).
 *   - The change applies automatically once the user's credit balance hits 0
 *     OR the effective date passes — whichever comes first.
 *   - For paid → free, we set Stripe's `cancel_at_period_end = true` so no
 *     further charges happen, but the user keeps their balance and access
 *     until the period ends.
 *   - For free → basic, the user must complete checkout first (handled by
 *     `createCheckoutSession`); we don't expose this function for that path.
 */
const SchedulePlanSchema = z.object({
  targetPlan: z.enum(["free", "basic"]),
});

export const schedulePlanChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => SchedulePlanSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const writeSupabase = serviceRoleKey && supabaseUrl
      ? createClient(supabaseUrl, serviceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : supabase;

    const { data: wallet, error: walletErr } = await writeSupabase
      .from("user_credits")
      .select("plan, stripe_subscription_id, current_period_end, last_reset_at, balance")
      .eq("user_id", userId)
      .maybeSingle();
    if (walletErr) {
      console.error("[schedulePlanChange] read failed:", JSON.stringify(walletErr));
      return { ok: false as const, error: "Couldn't load your plan." };
    }
    if (!wallet) return { ok: false as const, error: "No wallet found." };

    if (wallet.plan === data.targetPlan) {
      return { ok: false as const, error: `You're already on the ${data.targetPlan} plan.` };
    }

    // Determine the effective date — when the change will actually apply.
    let effectiveAt: string | null = wallet.current_period_end ?? null;
    if (!effectiveAt && wallet.last_reset_at) {
      const d = new Date(wallet.last_reset_at);
      d.setDate(d.getDate() + 30);
      effectiveAt = d.toISOString();
    }

    // Downgrade path (basic → free): tell Stripe to stop billing at period end,
    // but DO NOT cancel immediately — we want the user to keep using their
    // balance until then.
    if (data.targetPlan === "free" && wallet.stripe_subscription_id) {
      try {
        const stripe = getStripe();
        await stripe.subscriptions.update(wallet.stripe_subscription_id, {
          cancel_at_period_end: true,
        });
      } catch (err) {
        console.warn("[schedulePlanChange] cancel_at_period_end failed (continuing):", err);
      }
    }

    const { error: upErr } = await writeSupabase
      .from("user_credits")
      .update({
        pending_plan: data.targetPlan,
        pending_plan_effective_at: effectiveAt,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (upErr) {
      const msg = upErr.message ?? "";
      if (/schema cache|column .* does not exist/i.test(msg) && /pending_plan/i.test(msg)) {
        return {
          ok: false as const,
          error:
            "Plan scheduling isn't set up yet. Run supabase/sql/0013_pending_plan.sql in your Supabase SQL Editor, then try again.",
        };
      }
      console.error("[schedulePlanChange] update failed:", JSON.stringify(upErr));
      return { ok: false as const, error: msg || "Couldn't schedule plan change." };
    }

    try {
      await writeSupabase.from("credit_ledger").insert({
        user_id: userId,
        delta: 0,
        balance_after: wallet.balance,
        reason: "plan_change",
        metadata: {
          scheduled: true,
          from_plan: wallet.plan,
          to_plan: data.targetPlan,
          effective_at: effectiveAt,
        },
      });
    } catch (err) {
      console.warn("[schedulePlanChange] ledger insert skipped:", err);
    }

    // Try to apply immediately if conditions are already met (e.g. balance
    // already 0, or effective date is in the past, or there's no active
    // subscription to wait on). The function is a no-op otherwise.
    let appliedNow = false;
    let appliedToPlan: string | null = null;
    try {
      const { data: applyRes } = await writeSupabase.rpc("apply_pending_plan", {
        p_user_id: userId,
      });
      const row = Array.isArray(applyRes) ? applyRes[0] : applyRes;
      appliedNow = !!row?.applied;
      appliedToPlan = (row?.plan as string | null) ?? null;
    } catch (err) {
      console.warn("[schedulePlanChange] apply_pending_plan failed:", err);
    }

    return {
      ok: true as const,
      pendingPlan: appliedNow ? null : data.targetPlan,
      effectiveAt: appliedNow ? null : effectiveAt,
      appliedNow,
      appliedToPlan,
    };
  });

/**
 * Cancel a previously scheduled plan change.
 */
export const cancelPendingPlanChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const writeSupabase = serviceRoleKey && supabaseUrl
      ? createClient(supabaseUrl, serviceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : supabase;

    const { data: wallet } = await writeSupabase
      .from("user_credits")
      .select("stripe_subscription_id, pending_plan")
      .eq("user_id", userId)
      .maybeSingle();

    if (!wallet?.pending_plan) {
      return { ok: false as const, error: "No pending plan change." };
    }

    // If we previously scheduled a paid cancellation, undo it.
    if (wallet.stripe_subscription_id) {
      try {
        const stripe = getStripe();
        await stripe.subscriptions.update(wallet.stripe_subscription_id, {
          cancel_at_period_end: false,
        });
      } catch (err) {
        console.warn("[cancelPendingPlanChange] reactivate failed:", err);
      }
    }

    const { error: upErr } = await writeSupabase
      .from("user_credits")
      .update({
        pending_plan: null,
        pending_plan_effective_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (upErr) {
      console.error("[cancelPendingPlanChange] update failed:", JSON.stringify(upErr));
      return { ok: false as const, error: upErr.message ?? "Couldn't cancel." };
    }
    return { ok: true as const };
  });

function secondsToIso(s: number | null | undefined): string | null {
  if (!s || !Number.isFinite(s)) return null;
  return new Date(s * 1000).toISOString();
}

function getSubscriptionPeriodStart(sub: Stripe.Subscription): number | null {
  const top = (sub as unknown as { current_period_start?: number }).current_period_start;
  if (typeof top === "number") return top;
  const item = sub.items?.data?.[0] as unknown as { current_period_start?: number } | undefined;
  return typeof item?.current_period_start === "number" ? item.current_period_start : null;
}

function getSubscriptionPeriodEnd(sub: Stripe.Subscription): number | null {
  const top = (sub as unknown as { current_period_end?: number }).current_period_end;
  if (typeof top === "number") return top;
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  return typeof item?.current_period_end === "number" ? item.current_period_end : null;
}
