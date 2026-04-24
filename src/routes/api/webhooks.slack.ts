// Slack Events API webhook handler.
// Validates every request with HMAC-SHA256 signature before processing.
// Slack sends: url_verification challenges, message events, file events.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { validateSlackSignature } from "@/lib/connectors/slack";

const SUPABASE_URL = process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string);
const SUPABASE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string);

export const Route = createFileRoute("/api/webhooks/slack")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.text();
        const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
        const signature = request.headers.get("x-slack-signature") ?? "";

        // MANDATORY: validate signature before processing anything
        const valid = await validateSlackSignature(body, timestamp, signature);
        if (!valid) {
          return new Response("Invalid signature", { status: 401 });
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(body);
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        // Slack URL verification challenge (sent when first registering webhook)
        if (payload.type === "url_verification") {
          return new Response(JSON.stringify({ challenge: payload.challenge }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Slack Events API — process asynchronously
        if (payload.type === "event_callback") {
          const event = payload.event as Record<string, unknown>;
          const teamId = payload.team_id as string;

          // Find the connector for this workspace
          const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
          const { data: connectors } = await supabase
            .from("connectors")
            .select("id, user_id")
            .eq("service", "slack")
            .eq("status", "connected");

          // Process new messages
          if (event.type === "message" && event.text && !event.bot_id) {
            for (const connector of connectors ?? []) {
              // Queue a sync for this connector (simplified: trigger full sync)
              const syncPromise = (async () => {
                try {
                  const { syncSlack } = await import("@/lib/connectors/slack");
                  await syncSlack(connector.id, connector.user_id, supabase);
                } catch (e) {
                  console.error("[webhooks.slack] sync error:", e);
                }
              })();

              const ctx = (globalThis as unknown as { __cfContext?: { waitUntil: (p: Promise<unknown>) => void } }).__cfContext;
              ctx?.waitUntil(syncPromise);
            }
          }
        }

        return new Response("OK", { status: 200 });
      },
    },
  },
});
