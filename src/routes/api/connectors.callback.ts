// OAuth callback handler for all connectors.
// Validates CSRF state, exchanges code, saves encrypted tokens, triggers initial sync.
// Uses service-role Supabase client to avoid cookie-based auth issues with OAuth redirects.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string);

export const Route = createFileRoute("/api/connectors/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const service = url.searchParams.get("service");

        // OAuth provider returned an error
        if (error) {
          return redirect(`/?connector_error=${encodeURIComponent(error)}`);
        }

        if (!code || !state) {
          return redirect("/?connector_error=missing_params");
        }

        // Validate service param presence — it must be in the query string
        if (!service) {
          console.warn("[connectors.callback] Missing service param in callback URL");
          return redirect("/?error=oauth_missing_service");
        }

        // Use service-role client for the callback: the oauth_state UUID acts as the CSRF
        // token, so we don't need cookie-based user auth. This avoids issues where OAuth
        // providers strip cookies or the session isn't available in the redirect context.
        const serviceSupabase = createClient(
          SUPABASE_URL,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } },
        );

        try {
          // Validate CSRF state: look up connector with this state (no user_id filter needed
          // since the state UUID is unguessable and acts as the auth token)
          const { data: connector } = await serviceSupabase
            .from("connectors")
            .select("id, service, user_id, oauth_state")
            .eq("oauth_state", state)
            .maybeSingle();

          if (!connector) {
            return redirect("/?connector_error=invalid_state");
          }

          // Validate that the service in the URL matches the service stored in the DB
          if (connector.service !== service) {
            console.warn(`[connectors.callback] service mismatch: URL="${service}" DB="${connector.service}"`);
            return redirect("/?error=oauth_state_mismatch");
          }

          const userId = connector.user_id;
          const redirectUri = `${url.origin}/api/connectors/callback?service=${connector.service}`;

          if (connector.service === "google_drive") {
            const { exchangeCodeForTokens, encryptToken } = await import("@/lib/connectors/google-drive");
            const tokens = await exchangeCodeForTokens(code, redirectUri);
            const encryptedAccess = await encryptToken(tokens.accessToken);
            const encryptedRefresh = await encryptToken(tokens.refreshToken);
            await serviceSupabase.from("connectors").update({
              status: "connected",
              oauth_token_encrypted: encryptedAccess,
              oauth_refresh_token_encrypted: encryptedRefresh,
              oauth_state: null,
            }).eq("id", connector.id);
          } else if (
            connector.service === "google_docs" ||
            connector.service === "google_sheets" ||
            connector.service === "google_slides" ||
            connector.service === "gmail" ||
            connector.service === "google_calendar"
          ) {
            const { exchangeGoogleCode } = await import("@/lib/connectors/google");
            const { encryptToken } = await import("@/lib/connectors/google-drive");
            const tokens = await exchangeGoogleCode(code, redirectUri);
            await serviceSupabase.from("connectors").update({
              status: "connected",
              oauth_token_encrypted: await encryptToken(tokens.accessToken),
              oauth_refresh_token_encrypted: await encryptToken(tokens.refreshToken),
              oauth_state: null,
            }).eq("id", connector.id);
          } else if (
            connector.service === "onedrive" ||
            connector.service === "microsoft_word" ||
            connector.service === "microsoft_excel" ||
            connector.service === "microsoft_powerpoint" ||
            connector.service === "microsoft_onenote" ||
            connector.service === "microsoft_outlook" ||
            connector.service === "microsoft_teams"
          ) {
            const { exchangeMicrosoftCode } = await import("@/lib/connectors/microsoft");
            const { encryptToken } = await import("@/lib/connectors/google-drive");
            const tokens = await exchangeMicrosoftCode(connector.service, code, redirectUri);
            await serviceSupabase.from("connectors").update({
              status: "connected",
              oauth_token_encrypted: await encryptToken(tokens.accessToken),
              oauth_refresh_token_encrypted: await encryptToken(tokens.refreshToken),
              oauth_state: null,
            }).eq("id", connector.id);
          } else if (connector.service === "slack") {
            const { exchangeSlackCode } = await import("@/lib/connectors/slack");
            const { encryptToken } = await import("@/lib/connectors/google-drive");
            const result = await exchangeSlackCode(code, redirectUri);
            const encryptedAccess = await encryptToken(result.accessToken);

            await serviceSupabase.from("connectors").update({
              status: "connected",
              oauth_token_encrypted: encryptedAccess,
              oauth_refresh_token_encrypted: await encryptToken(""),
              oauth_state: null,
              metadata: { team_id: result.teamId, team_name: result.teamName },
            }).eq("id", connector.id);
          }

          // Trigger initial sync (fire-and-forget via waitUntil if available)
          // The sync will run in the background
          const syncPromise = (async () => {
            const { syncConnector } = await import("@/lib/connectors/sync-worker");
            try {
              await syncConnector(connector.id, userId, connector.service, serviceSupabase);
            } catch {
              // Sync errors are recorded in the DB; don't block redirect
            }
          })();

          // CF Workers: use waitUntil; fall back to await in dev mode
          const ctx = (globalThis as unknown as { __cfContext?: ExecutionContext }).__cfContext;
          if (ctx?.waitUntil) {
            ctx.waitUntil(syncPromise);
          } else {
            await syncPromise;
          }

          return redirect("/?connector_connected=true");
        } catch (e) {
          const msg = e instanceof Error ? e.message : "unknown";
          console.error("[connectors.callback]", msg);
          return redirect(`/?connector_error=${encodeURIComponent("Connection failed")}`);
        }
      },
    },
  },
});

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

// CF Workers execution context type
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
