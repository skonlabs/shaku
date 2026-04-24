// Slack connector: OAuth2 + message indexing + webhook signature validation.
// Webhook signing secret validation is mandatory — never skip it.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncResult } from "./types";
import { encryptToken, decryptToken } from "./google-drive";

const SLACK_API = "https://slack.com/api";

// ---- OAuth Flow ----

export function buildSlackAuthUrl(redirectUri: string, oauthState: string): string {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) throw new Error("SLACK_CLIENT_ID not configured");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "channels:read,channels:history,users:read,files:read",
    state: oauthState,
  });

  return `https://slack.com/oauth/v2/authorize?${params}`;
}

export async function exchangeSlackCode(
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; teamId: string; teamName: string }> {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Slack not configured");

  const res = await fetch(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }),
  });

  const json = (await res.json()) as {
    ok: boolean;
    access_token?: string;
    team?: { id: string; name: string };
    error?: string;
  };

  if (!json.ok) throw new Error(`Slack OAuth failed: ${json.error}`);
  return {
    accessToken: json.access_token!,
    teamId: json.team?.id ?? "",
    teamName: json.team?.name ?? "",
  };
}

// ---- Webhook Signature Validation ----
// Must be called for ALL incoming Slack webhooks. Never bypass.

export async function validateSlackSignature(
  body: string,
  timestamp: string,
  signature: string,
): Promise<boolean> {
  const signingSecret = process.env.SLACK_CLIENT_SECRET;
  if (!signingSecret) return false;

  // Reject replays older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const hmac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(baseString));
  const expected = "v0=" + Array.from(new Uint8Array(hmac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

// ---- Sync ----

export async function syncSlack(
  connectorId: string,
  userId: string,
  supabase: SupabaseClient,
): Promise<SyncResult> {
  const { data: connector } = await supabase
    .from("connectors")
    .select("oauth_token_encrypted, sync_cursor")
    .eq("id", connectorId)
    .single();

  if (!connector) throw new Error("Connector not found");

  const accessToken = await decryptToken(connector.oauth_token_encrypted);
  const errors: string[] = [];
  let itemsProcessed = 0;

  // Get public channels
  const channelsRes = await fetch(`${SLACK_API}/conversations.list?types=public_channel&limit=50`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const channelsJson = (await channelsRes.json()) as {
    ok: boolean;
    channels?: { id: string; name: string; is_member: boolean }[];
  };

  const channels = (channelsJson.channels ?? []).filter((c) => c.is_member);

  const { processFile } = await import("@/lib/datasources/processor");

  for (const channel of channels.slice(0, 20)) {
    try {
      // Get recent messages
      const historyParams = new URLSearchParams({
        channel: channel.id,
        limit: "100",
      });
      if (connector.sync_cursor) historyParams.set("oldest", connector.sync_cursor);

      const histRes = await fetch(`${SLACK_API}/conversations.history?${historyParams}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const histJson = (await histRes.json()) as {
        ok: boolean;
        messages?: { text: string; ts: string; user?: string; thread_ts?: string }[];
      };

      if (!histJson.ok || !histJson.messages?.length) continue;

      // Combine messages into a document
      const content = histJson.messages
        .filter((m) => m.text?.trim())
        .map((m) => m.text)
        .join("\n---\n");

      if (!content.trim()) continue;

      const bytes = new TextEncoder().encode(content);
      await processFile(userId, bytes, `#${channel.name}`, "txt", {
        sourceType: "connector",
        sourceId: connectorId,
        sourceItemId: channel.id,
        metadata: {
          title: `#${channel.name}`,
          source_name: "Slack",
          channel_id: channel.id,
          permissions: { canAccess: true },
        },
      }, supabase);

      itemsProcessed++;
    } catch (e) {
      errors.push(`#${channel.name}: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  // Update sync cursor to now (Unix timestamp)
  const newCursor = Math.floor(Date.now() / 1000).toString();

  return { itemsProcessed, newCursor, errors };
}
