import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CONNECTOR_CONFIGS } from "@/lib/connectors/types";
import { buildAuthUrl, encryptToken, exchangeCodeForTokens } from "@/lib/connectors/google-drive";
import { buildSlackAuthUrl, exchangeSlackCode } from "@/lib/connectors/slack";
import { cleanupDisconnectedConnector } from "@/lib/connectors/sync-worker";

// Generate OAuth URL with CSRF state, stored in DB before redirect
export const initiateConnectorAuth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      service: z.string(),
      redirect_uri: z.string().url(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;

    const config = CONNECTOR_CONFIGS.find((c) => c.service === data.service);
    if (!config) throw new Error("Unknown connector service.");
    if (!config.implemented) throw new Error(`${config.displayName} is coming soon.`);

    // Generate CSRF state token
    const oauthState = crypto.randomUUID();

    // Insert if new connector; if one already exists (possibly connected), only update oauth_state
    // to avoid resetting a connected/syncing connector's status back to "disconnected".
    const { data: existing } = await supabase
      .from("connectors")
      .select("id")
      .eq("user_id", userId)
      .eq("service", data.service)
      .maybeSingle();

    let error: { message: string } | null;
    if (existing) {
      ({ error } = await supabase
        .from("connectors")
        .update({ oauth_state: oauthState })
        .eq("id", existing.id));
    } else {
      ({ error } = await supabase.from("connectors").insert({
        user_id: userId,
        service: data.service,
        status: "disconnected",
        oauth_state: oauthState,
      }));
    }
    if (error) throw new Error("Couldn't initiate connection.");

    // Build provider-specific auth URL
    let authUrl: string;
    if (data.service === "google_drive") {
      authUrl = buildAuthUrl(data.redirect_uri, oauthState);
    } else if (data.service === "slack") {
      authUrl = buildSlackAuthUrl(data.redirect_uri, oauthState);
    } else {
      throw new Error("Auth not implemented for this service.");
    }

    return { auth_url: authUrl, state: oauthState };
  });

export const listConnectors = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data } = await supabase
      .from("connectors")
      .select("id, service, status, last_synced_at, items_indexed, error_message")
      .eq("user_id", userId)
      .neq("status", "disconnected");

    const connected = data ?? [];
    const connectedServices = new Set(connected.map((c) => c.service));

    const available = CONNECTOR_CONFIGS.filter(
      (c) => !connectedServices.has(c.service),
    ).map((c) => ({
      service: c.service,
      displayName: c.displayName,
      implemented: c.implemented,
    }));

    return { connected, available };
  });

export const pauseConnector = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid(), paused: z.boolean() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("connectors")
      .update({ status: data.paused ? "paused" : "connected" })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error("Couldn't update connector.");
    return { success: true };
  });

export const disconnectConnector = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    // Immediately mark as disconnected; cleanup runs async
    await cleanupDisconnectedConnector(data.id, userId, supabase);
    return { success: true };
  });

export const completeConnectorAuth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      service: z.string(),
      code: z.string(),
      state: z.string(),
      redirect_uri: z.string().url(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;

    // Validate CSRF state
    const { data: connector } = await supabase
      .from("connectors")
      .select("id, oauth_state")
      .eq("user_id", userId)
      .eq("service", data.service)
      .single();

    if (!connector || connector.oauth_state !== data.state) {
      throw new Error("Invalid OAuth state. Please try connecting again.");
    }

    let encryptedToken: string;
    let encryptedRefresh: string;

    if (data.service === "google_drive") {
      const tokens = await exchangeCodeForTokens(data.code, data.redirect_uri);
      encryptedToken = await encryptToken(tokens.accessToken);
      encryptedRefresh = await encryptToken(tokens.refreshToken);
    } else if (data.service === "slack") {
      const result = await exchangeSlackCode(data.code, data.redirect_uri);
      encryptedToken = await encryptToken(result.accessToken);
      encryptedRefresh = await encryptToken(""); // Slack uses long-lived tokens
    } else {
      throw new Error("Unknown service");
    }

    // Save tokens, clear CSRF state
    await supabase.from("connectors").update({
      status: "connected",
      oauth_token_encrypted: encryptedToken,
      oauth_refresh_token_encrypted: encryptedRefresh,
      oauth_state: null, // clear state after successful use
    }).eq("id", connector.id);

    return { success: true, connector_id: connector.id };
  });

// Returns which services have OAuth credentials configured server-side.
// Used by the UI to show "Connect" vs "Not configured" without leaking secrets.
export const getConnectorAvailability = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    return {
      google_drive: !!(process.env.GOOGLE_DRIVE_CLIENT_ID && process.env.GOOGLE_DRIVE_CLIENT_SECRET),
      slack: !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET),
      onedrive: false,
      dropbox: false,
      teams: false,
      gmail: false,
      google_calendar: false,
      jira: false,
      github: false,
      notion: false,
      confluence: false,
    } as Record<string, boolean>;
  });
