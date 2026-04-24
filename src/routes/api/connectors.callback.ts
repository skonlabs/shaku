// OAuth callback handler for all connectors.
// Validates CSRF state, exchanges code, saves encrypted tokens, triggers initial sync.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string);
const SUPABASE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string);

export const Route = createFileRoute("/api/connectors/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const service = url.searchParams.get("service") ?? inferServiceFromState(state ?? "");

        // OAuth provider returned an error
        if (error) {
          return redirect(`/chat?connector_error=${encodeURIComponent(error)}`);
        }

        if (!code || !state) {
          return redirect("/chat?connector_error=missing_params");
        }

        // Auth required via cookie session
        const authHeader = request.headers.get("cookie") ?? "";
        const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
          auth: { persistSession: false, detectSessionInUrl: false },
          global: { headers: { Cookie: authHeader } },
        });

        const { data: userData } = await supabase.auth.getUser();
        if (!userData.user) {
          return redirect("/login?redirect=/chat");
        }

        const userId = userData.user.id;

        try {
          // Validate CSRF state: look up connector with this state
          const { data: connector } = await supabase
            .from("connectors")
            .select("id, service, oauth_state")
            .eq("user_id", userId)
            .eq("oauth_state", state)
            .maybeSingle();

          if (!connector) {
            return redirect("/chat?connector_error=invalid_state");
          }

          const redirectUri = `${url.origin}/api/connectors/callback?service=${connector.service}`;

          if (connector.service === "google_drive") {
            const { exchangeCodeForTokens, encryptToken } = await import("@/lib/connectors/google-drive");
            const tokens = await exchangeCodeForTokens(code, redirectUri);
            const encryptedAccess = await encryptToken(tokens.accessToken);
            const encryptedRefresh = await encryptToken(tokens.refreshToken);

            await supabase.from("connectors").update({
              status: "connected",
              oauth_token_encrypted: encryptedAccess,
              oauth_refresh_token_encrypted: encryptedRefresh,
              oauth_state: null,
            }).eq("id", connector.id);
          } else if (connector.service === "slack") {
            const { exchangeSlackCode } = await import("@/lib/connectors/slack");
            const { encryptToken } = await import("@/lib/connectors/google-drive");
            const result = await exchangeSlackCode(code, redirectUri);
            const encryptedAccess = await encryptToken(result.accessToken);

            await supabase.from("connectors").update({
              status: "connected",
              oauth_token_encrypted: encryptedAccess,
              oauth_refresh_token_encrypted: await encryptToken(""),
              oauth_state: null,
            }).eq("id", connector.id);
          }

          // Trigger initial sync (fire-and-forget via waitUntil if available)
          // The sync will run in the background
          const syncPromise = (async () => {
            const { syncConnector } = await import("@/lib/connectors/sync-worker");
            try {
              await syncConnector(connector.id, userId, connector.service, supabase);
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

          return redirect("/chat?connector_connected=true");
        } catch (e) {
          const msg = e instanceof Error ? e.message : "unknown";
          console.error("[connectors.callback]", msg);
          return redirect(`/chat?connector_error=${encodeURIComponent("Connection failed")}`);
        }
      },
    },
  },
});

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function inferServiceFromState(state: string): string {
  // State is a UUID — service is embedded in the query param
  return "";
}

// CF Workers execution context type
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
