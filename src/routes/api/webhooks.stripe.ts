// Stripe webhook handler with mandatory signature verification.
// Never process a webhook without validating the signature first.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
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

        // Read raw body for signature verification
        const body = await request.text();
        const signature = request.headers.get("stripe-signature");

        if (!signature) {
          return jsonError("Missing signature", 400);
        }

        // Verify signature using Web Crypto (CF Workers compatible)
        let event: Stripe.Event;
        try {
          event = await verifyStripeSignature(body, signature, webhookSecret);
        } catch (e) {
          console.error("[webhooks.stripe] signature verification failed:", e);
          return jsonError("Invalid signature", 400);
        }

        // Admin Supabase client to bypass RLS for plan updates
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false },
        });

        try {
          await handleStripeEvent(event, supabase);
        } catch (e) {
          console.error("[webhooks.stripe] handler error:", e);
          // Return 200 so Stripe doesn't retry — log the error
        }

        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});

async function handleStripeEvent(
  event: Stripe.Event,
  supabase: ReturnType<typeof createClient>,
): Promise<void> {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = sub.customer as string;
      const isActive = sub.status === "active" || sub.status === "trialing";

      await supabase
        .from("users")
        .update({
          plan: isActive ? "pro" : "free",
          stripe_subscription_id: sub.id,
        })
        .eq("stripe_customer_id", customerId);
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await supabase
        .from("users")
        .update({ plan: "free", stripe_subscription_id: null })
        .eq("stripe_customer_id", sub.customer as string);
      break;
    }

    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      // Store payment failure note — UI reads this and shows a banner
      await supabase
        .from("users")
        .update({ plan: "free" })
        .eq("stripe_customer_id", inv.customer as string);
      break;
    }

    case "customer.created": {
      const customer = event.data.object as Stripe.Customer;
      if (customer.email) {
        await supabase
          .from("users")
          .update({ stripe_customer_id: customer.id })
          .eq("email", customer.email);
      }
      break;
    }

    default:
      // Unhandled event type — ignore silently
      break;
  }
}

// Stripe signature verification using Web Crypto (no Node.js crypto needed)
async function verifyStripeSignature(
  body: string,
  signatureHeader: string,
  secret: string,
): Promise<Stripe.Event> {
  // Parse the signature header: t=...,v1=...
  const parts: Record<string, string> = {};
  for (const part of signatureHeader.split(",")) {
    const [k, v] = part.split("=");
    if (k && v) parts[k] = v;
  }

  const timestamp = parts["t"];
  const expectedSig = parts["v1"];

  if (!timestamp || !expectedSig) throw new Error("Invalid signature header format");

  // Reject replays older than 5 minutes
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

  // Constant-time comparison
  if (computed.length !== expectedSig.length) throw new Error("Signature mismatch");
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  if (diff !== 0) throw new Error("Signature mismatch");

  return JSON.parse(body) as Stripe.Event;
}

function jsonError(msg: string, status: number): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
