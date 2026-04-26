// Slack Events API webhook handler.
// Validates every request with HMAC-SHA256 signature before processing.
// Slack sends: url_verification challenges, message events, file events.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { validateSlackSignature } from "@/lib/connectors/slack";

const SUPABASE_URL = process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string);

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
          // Extract team_id so we only sync the workspace that sent this event
          const teamId = (payload.team_id ?? (payload.team as Record<string, unknown> | undefined)?.id) as string | undefined;

          // Use service-role client: the webhook has no user auth context, and
          // RLS would block reads with the publishable key.
          const adminSupabase = createClient(
            SUPABASE_URL,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { persistSession: false } },
          );

          // Process new messages
          if (event.type === "message" && event.text && !event.bot_id) {
            // Fetch all connected Slack connectors; filter to the matching workspace
            const { data: connectors } = await adminSupabase
              .from("connectors")
              .select("id, user_id, metadata")
              .eq("service", "slack")
              .eq("status", "connected");

            // Only trigger syncs for connectors belonging to the workspace that sent this event.
            // Connector metadata should store team_id (set during OAuth exchange).
            // If team_id isn't stored yet, fall back to syncing only the first connector to
            // avoid hammering all workspaces on every message.
            const matching = teamId
              ? (connectors ?? []).filter(
                  (c) => (c.metadata as Record<string, unknown> | null)?.team_id === teamId,
                )
              : (connectors ?? []).slice(0, 1);

            for (const connector of matching) {
              const syncPromise = (async () => {
                try {
                  const { syncSlack } = await import("@/lib/connectors/slack");
                  await syncSlack(connector.id, connector.user_id, adminSupabase);
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
