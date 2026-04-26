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
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
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

  // Save the sync start time BEFORE fetching so we don't miss messages that
  // arrive during the sync window. Subtract a 60-second buffer to handle
  // clock skew and ensure overlap between sync windows.
  const newCursor = Math.floor(Date.now() / 1000 - 60).toString();

  // Get all public channels via cursor-based pagination
  const channels: { id: string; name: string; is_member: boolean }[] = [];
  let channelCursor: string | undefined;

  do {
    const params = new URLSearchParams({ types: "public_channel", limit: "200" });
    if (channelCursor) params.set("cursor", channelCursor);

    const channelsRes = await fetch(`${SLACK_API}/conversations.list?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const channelsJson = (await channelsRes.json()) as {
      ok: boolean;
      channels?: { id: string; name: string; is_member: boolean }[];
      response_metadata?: { next_cursor?: string };
    };

    if (!channelsJson.ok) break;
    channels.push(...(channelsJson.channels ?? []));
    channelCursor = channelsJson.response_metadata?.next_cursor || undefined;
  } while (channelCursor);

  const memberChannels = channels.filter((c) => c.is_member);

  const { processFile } = await import("@/lib/datasources/processor");

  for (const channel of memberChannels) {
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
        messages?: { text?: string; ts?: string; user?: string; thread_ts?: string }[];
      };

      if (!histJson.ok || !histJson.messages?.length) continue;

      const messages = histJson.messages.filter((m) => m.text?.trim());
      if (!messages.length) continue;

      // Chunk messages by day so each day becomes an independent, replaceable document.
      // Using channel:day as source_item_id means re-syncing the same day replaces
      // the old content rather than creating duplicates.
      const byDay = new Map<string, typeof messages>();
      for (const msg of messages) {
        const day = new Date(parseFloat(msg.ts ?? "0") * 1000).toISOString().slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day)!.push(msg);
      }

      for (const [day, dayMsgs] of byDay) {
        const content = dayMsgs
          .map((m) => `[${m.user ?? "unknown"}]: ${m.text ?? ""}`)
          .join("\n");

        if (!content.trim()) continue;

        const sourceItemId = `${channel.id}:${day}`;
        const bytes = new TextEncoder().encode(content);

        await processFile(userId, bytes, `#${channel.name}-${day}`, "txt", {
          sourceType: "connector",
          sourceId: connectorId,
          sourceItemId,
          metadata: {
            title: `#${channel.name} — ${day}`,
            source_name: "Slack",
            channel_id: channel.id,
            permissions: { canAccess: true },
          },
        }, supabase);

        itemsProcessed++;
      }
    } catch (e) {
      errors.push(`#${channel.name}: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  return { itemsProcessed, newCursor, errors };
}
