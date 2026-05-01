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
 * Reset the current user back to the free plan.
 * Cancels any active Stripe subscription and resets the user_credits row.
 */
export const resetMyPlanToFree = createServerFn({ method: "POST" })
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
      .select("stripe_subscription_id")
      .eq("user_id", userId)
      .maybeSingle();

    const subId = wallet?.stripe_subscription_id as string | null;
    if (subId) {
      try {
        const stripe = getStripe();
        await stripe.subscriptions.cancel(subId);
      } catch (err) {
        console.warn("[resetMyPlanToFree] cancel subscription failed (continuing):", err);
      }
    }

    let freeCredits = 100;
    const { data: freePlan } = await writeSupabase
      .from("billing_plans")
      .select("monthly_credits")
      .eq("id", "free")
      .maybeSingle();
    if (freePlan?.monthly_credits) freeCredits = Number(freePlan.monthly_credits);

    const nowIso = new Date().toISOString();
    const { error: upErr } = await writeSupabase
      .from("user_credits")
      .update({
        plan: "free",
        balance: freeCredits,
        monthly_quota: freeCredits,
        stripe_subscription_id: null,
        subscription_status: null,
        current_period_end: null,
        last_reset_at: nowIso,
      })
      .eq("user_id", userId);
    if (upErr) {
      console.error("[resetMyPlanToFree] update failed:", upErr);
      return { ok: false as const, error: upErr.message };
    }

    try {
      await writeSupabase.from("credit_ledger").insert({
        user_id: userId,
        delta: 0,
        balance_after: freeCredits,
        reason: "plan_change",
        metadata: { to_plan: "free", source: "user_self_service_reset" },
      });
    } catch (err) {
      console.warn("[resetMyPlanToFree] ledger insert skipped:", err);
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
