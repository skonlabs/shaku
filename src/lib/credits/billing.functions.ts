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
import Stripe from "stripe";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  // Pin to the SDK's default api version (no override) to avoid TS literal mismatch.
  return new Stripe(key);
}

function getOrigin(): string {
  return (
    process.env.PUBLIC_APP_ORIGIN ??
    process.env.APP_ORIGIN ??
    "https://20cb2f0c-2f09-469c-bb65-aa855f85b760.lovable.app"
  );
}

const CheckoutSchema = z.object({
  plan: z.literal("basic"),
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
      ui_mode: "embedded",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      return_url: `${origin}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
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
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${getOrigin()}/billing`,
    });
    return { ok: true as const, url: portal.url };
  });
