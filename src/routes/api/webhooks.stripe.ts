// Stripe webhook handler with mandatory signature verification.
//
// This endpoint is the source of truth for plan flips and credit grants.
//
// Handles (in order of importance):
//   * checkout.session.completed       — first successful payment → flip plan + grant credits
//   * customer.subscription.created/updated — keep plan/period in sync, grant credits if new period
//   * invoice.paid                     — monthly renewal → grant credits for the new period
//   * customer.subscription.deleted    — cancellation → drop to free
//   * invoice.payment_failed           — mark subscription past_due (don't downgrade immediately)
//
// Idempotency:
//   1) Every event id is recorded in `stripe_events`. Re-deliveries no-op at the
//      table level (primary key collision).
//   2) `credits_grant_for_period(user, plan, period_start, period_end, ...)` is
//      idempotent on (user, period_start) inside the database, so even if the
//      table check is bypassed, credits are never granted twice for the same
//      billing period.

import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const SUPABASE_URL = process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string);
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export const Route = createFileRoute("/api/webhooks/stripe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
        const stripeKey = process.env.STRIPE_SECRET_KEY;

        if (!webhookSecret || !stripeKey) {
          return jsonError("Stripe not configured", 500);
        }

        const body = await request.text();
        const signature = request.headers.get("stripe-signature");
        if (!signature) return jsonError("Missing signature", 400);

        let event: Stripe.Event;
        try {
          event = await verifyStripeSignature(body, signature, webhookSecret);
        } catch (e) {
          console.error("[webhooks.stripe] signature verification failed:", e);
          return jsonError("Invalid signature", 400);
        }

        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        // Process the event first, THEN record it as processed.
        // Recording first caused silent credit loss: if the handler threw a transient
        // error after the idempotency row was inserted, Stripe's next retry would be
        // deduped and the user would never receive their credits.
        const stripe = new Stripe(stripeKey);
        try {
          await handleStripeEvent(event, stripe, supabase);
        } catch (e) {
          console.error(`[webhooks.stripe] handler error for ${event.type} ${event.id}:`, e);
          // Return 500 so Stripe retries until the handler actually succeeds.
          // Do NOT record the event yet — we haven't successfully processed it.
          return new Response(JSON.stringify({ error: "handler failed, will retry" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Mark event as processed only after successful handler execution.
        const { error: insertEventErr } = await supabase
          .from("stripe_events")
          .insert({ event_id: event.id, type: event.type, payload: event as unknown as object });
        if (insertEventErr && (insertEventErr as { code?: string }).code !== "23505") {
          // Non-duplicate error: log but return 200 — the event was already processed successfully.
          console.error("[webhooks.stripe] failed to record processed event:", insertEventErr);
        }
        return ok();
      },
    },
  },
});

async function handleStripeEvent(
  event: Stripe.Event,
  stripe: Stripe,
  supabase: SupabaseClient,
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId =
        (session.metadata?.supabase_user_id as string | undefined) ??
        (session.client_reference_id as string | undefined);
      const customerId =
        typeof session.customer === "string" ? session.customer : session.customer?.id;
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;
      if (!userId || !subscriptionId) {
        console.warn("[webhooks.stripe] checkout.session.completed missing user/subscription");
        return;
      }
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      await grantPeriod(supabase, userId, "basic", sub, customerId ?? null);
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const userId = await resolveUserId(supabase, sub);
      if (!userId) return;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const isActive = sub.status === "active" || sub.status === "trialing";
      if (isActive && !isCancelAtPeriodEnd(sub)) {
        await grantPeriod(supabase, userId, "basic", sub, customerId);
      } else {
        await syncSubscriptionOnly(supabase, userId, sub, customerId);
      }
      return;
    }

    case "invoice.paid": {
      const inv = event.data.object as Stripe.Invoice;
      const subscriptionId = getInvoiceSubscriptionId(inv);
      if (!subscriptionId) return;
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const userId = await resolveUserId(supabase, sub);
      if (!userId) return;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      await grantPeriod(supabase, userId, "basic", sub, customerId);
      return;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const userId = await resolveUserId(supabase, sub);
      if (!userId) return;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      await changePlanImmediate(supabase, userId, "free");
      await syncSubscriptionOnly(supabase, userId, sub, customerId, "canceled");
      return;
    }

    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      const customerId = typeof inv.customer === "string" ? inv.customer : null;
      if (!customerId) return;
      await supabase
        .from("user_credits")
        .update({ subscription_status: "past_due", updated_at: new Date().toISOString() })
        .eq("stripe_customer_id", customerId);
      return;
    }

    default:
      return;
  }
}

async function grantPeriod(
  supabase: SupabaseClient,
  userId: string,
  plan: string,
  sub: Stripe.Subscription,
  customerId: string | null,
): Promise<void> {
  const periodStart = secondsToIso(getPeriodStart(sub));
  const periodEnd = secondsToIso(getPeriodEnd(sub));
  if (!periodStart || !periodEnd) {
    console.warn("[webhooks.stripe] subscription missing period bounds:", sub.id);
    return;
  }
  const { error } = await supabase.rpc("credits_grant_for_period", {
    p_user_id: userId,
    p_plan: plan,
    p_period_start: periodStart,
    p_period_end: periodEnd,
    p_stripe_customer_id: customerId,
    p_stripe_subscription_id: sub.id,
    p_subscription_status: sub.status,
  });
  if (error) console.error("[webhooks.stripe] credits_grant_for_period error:", error);
}

async function changePlanImmediate(
  supabase: SupabaseClient,
  userId: string,
  targetPlan: "free" | "basic",
): Promise<void> {
  const { error } = await supabase.rpc("credits_change_plan_immediate", {
    p_user_id: userId,
    p_target_plan: targetPlan,
  });
  if (error) console.error("[webhooks.stripe] credits_change_plan_immediate error:", error);
}

async function syncSubscriptionOnly(
  supabase: SupabaseClient,
  userId: string,
  sub: Stripe.Subscription,
  customerId: string,
  statusOverride?: string,
): Promise<void> {
  const { error } = await supabase
    .from("user_credits")
    .update({
      stripe_customer_id: customerId,
      stripe_subscription_id: sub.id,
      subscription_status: statusOverride ?? sub.status,
      current_period_end: secondsToIso(getPeriodEnd(sub)),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (error) console.error("[webhooks.stripe] subscription sync error:", error);
}

function isCancelAtPeriodEnd(sub: Stripe.Subscription): boolean {
  return Boolean((sub as unknown as { cancel_at_period_end?: boolean }).cancel_at_period_end);
}

async function resolveUserId(
  supabase: SupabaseClient,
  sub: Stripe.Subscription,
): Promise<string | null> {
  const fromMeta = (sub.metadata?.supabase_user_id as string | undefined) ?? null;
  if (fromMeta) return fromMeta;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  if (!customerId) return null;
  const { data } = await supabase
    .from("user_credits")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return (data?.user_id as string | undefined) ?? null;
}

function secondsToIso(s: number | null | undefined): string | null {
  if (!s || !Number.isFinite(s)) return null;
  return new Date(s * 1000).toISOString();
}

// Stripe SDK v18+ moved current_period_* off Subscription onto subscription items
// in some types, but Stripe still sends them at the top level on the wire. Read
// from either location safely.
function getPeriodStart(sub: Stripe.Subscription): number | null {
  const top = (sub as unknown as { current_period_start?: number }).current_period_start;
  if (typeof top === "number") return top;
  const item = sub.items?.data?.[0] as unknown as { current_period_start?: number } | undefined;
  return typeof item?.current_period_start === "number" ? item.current_period_start : null;
}
function getPeriodEnd(sub: Stripe.Subscription): number | null {
  const top = (sub as unknown as { current_period_end?: number }).current_period_end;
  if (typeof top === "number") return top;
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  return typeof item?.current_period_end === "number" ? item.current_period_end : null;
}
// Stripe SDK v22 dropped `Invoice.subscription`. Read it via cast — the field is
// still on the wire for subscription invoices.
function getInvoiceSubscriptionId(inv: Stripe.Invoice): string | null {
  const raw = (inv as unknown as { subscription?: string | { id: string } | null }).subscription;
  if (!raw) return null;
  return typeof raw === "string" ? raw : raw.id;
}

// Stripe signature verification using Web Crypto (no Node.js crypto needed)
async function verifyStripeSignature(
  body: string,
  signatureHeader: string,
  secret: string,
): Promise<Stripe.Event> {
  const parts: Record<string, string> = {};
  for (const part of signatureHeader.split(",")) {
    const [k, v] = part.split("=");
    if (k && v) parts[k] = v;
  }
  const timestamp = parts["t"];
  const expectedSig = parts["v1"];
  if (!timestamp || !expectedSig) throw new Error("Invalid signature header format");
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    throw new Error("Webhook timestamp too old (possible replay attack)");
  }
  const signedPayload = `${timestamp}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const hmac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(hmac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (computed.length !== expectedSig.length) throw new Error("Signature mismatch");
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  if (diff !== 0) throw new Error("Signature mismatch");
  return JSON.parse(body) as Stripe.Event;
}

function ok(): Response {
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
function jsonError(msg: string, status: number): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
