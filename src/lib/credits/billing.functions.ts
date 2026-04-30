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
  return new Stripe(key, { apiVersion: "2025-09-30.clover" });
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

export const createCheckoutSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => CheckoutSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId, claims } = context as {
      supabase: any;
      userId: string;
      claims: { email?: string };
    };
    const stripe = getStripe();

    const priceId = process.env.STRIPE_PRICE_BASIC;
    if (!priceId) {
      return {
        ok: false as const,
        error:
          "Stripe is not fully configured yet (missing STRIPE_PRICE_BASIC). Ask the admin to finish setup.",
      };
    }

    // Reuse stripe_customer_id if we already have one, otherwise create.
    const { data: walletRaw } = await supabase
      .from("user_credits")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();
    let customerId = (walletRaw?.stripe_customer_id as string | null) ?? null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: claims?.email,
        metadata: { supabase_user_id: userId },
      });
      customerId = customer.id;
      await supabase
        .from("user_credits")
        .update({ stripe_customer_id: customerId })
        .eq("user_id", userId);
    }

    const origin = getOrigin();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/billing?checkout=cancelled`,
      allow_promotion_codes: true,
      client_reference_id: userId,
      subscription_data: {
        metadata: { supabase_user_id: userId, plan: data.plan },
      },
      metadata: { supabase_user_id: userId, plan: data.plan },
    });

    return { ok: true as const, url: session.url ?? "", sessionId: session.id };
  });

export const createBillingPortalSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const stripe = getStripe();
    const { data: walletRaw } = await supabase
      .from("user_credits")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();
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
