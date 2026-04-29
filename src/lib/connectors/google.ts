// Unified Google connector: single OAuth client serves Drive, Docs, Sheets, Slides,
// Gmail, and Calendar. Per-service sync functions extract text and feed the indexer.
// Reuses encryptToken/decryptToken from google-drive.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncResult } from "./types";
import { decryptToken, encryptToken } from "./google-drive";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

// Per-service scopes. We use one shared OAuth client (GOOGLE_CLIENT_ID) when set,
// falling back to GOOGLE_DRIVE_CLIENT_ID for backwards compatibility.
const SERVICE_SCOPES: Record<string, string> = {
  google_docs: "https://www.googleapis.com/auth/documents.readonly https://www.googleapis.com/auth/drive.readonly",
  google_sheets: "https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly",
  google_slides: "https://www.googleapis.com/auth/presentations.readonly https://www.googleapis.com/auth/drive.readonly",
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  google_calendar: "https://www.googleapis.com/auth/calendar.readonly",
};

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth not configured");
  return { clientId, clientSecret };
}

export function buildGoogleAuthUrl(service: string, redirectUri: string, oauthState: string): string {
  const { clientId } = getCredentials();
  const scope = SERVICE_SCOPES[service];
  if (!scope) throw new Error(`Unknown Google service: ${service}`);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent",
    state: oauthState,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const { clientId, clientSecret } = getCredentials();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? "", expiresAt: Date.now() + j.expires_in * 1000 };
}

async function refreshGoogleToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = getCredentials();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("Google token refresh failed");
  const j = (await res.json()) as { access_token: string };
  return j.access_token;
}

// Returns an authed-fetch helper that auto-refreshes on 401.
async function makeAuthedFetch(connectorId: string, supabase: SupabaseClient) {
  const { data: c } = await supabase
    .from("connectors")
    .select("oauth_token_encrypted, oauth_refresh_token_encrypted")
    .eq("id", connectorId)
    .single();
  if (!c) throw new Error("Connector not found");

  let accessToken = await decryptToken(c.oauth_token_encrypted);
  const refreshToken = await decryptToken(c.oauth_refresh_token_encrypted);

  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    let res = await fetch(url, { ...init, headers });
    if (res.status === 401 && refreshToken) {
      accessToken = await refreshGoogleToken(refreshToken);
      const enc = await encryptToken(accessToken);
      await supabase.from("connectors").update({ oauth_token_encrypted: enc }).eq("id", connectorId);
      headers.set("Authorization", `Bearer ${accessToken}`);
      res = await fetch(url, { ...init, headers });
    }
    return res;
  };
}

// ---------------- Google Docs ----------------
export async function syncGoogleDocs(connectorId: string, userId: string, supabase: SupabaseClient): Promise<SyncResult> {
  return syncDriveFiltered(connectorId, userId, supabase, "application/vnd.google-apps.document", "Google Docs");
}

// ---------------- Google Sheets ----------------
export async function syncGoogleSheets(connectorId: string, userId: string, supabase: SupabaseClient): Promise<SyncResult> {
  return syncDriveFiltered(connectorId, userId, supabase, "application/vnd.google-apps.spreadsheet", "Google Sheets", "text/csv");
}

// ---------------- Google Slides ----------------
export async function syncGoogleSlides(connectorId: string, userId: string, supabase: SupabaseClient): Promise<SyncResult> {
  return syncDriveFiltered(connectorId, userId, supabase, "application/vnd.google-apps.presentation", "Google Slides");
}

// Shared helper: list files of a given Google MIME type via Drive, export as text/plain (or CSV for sheets).
async function syncDriveFiltered(
  connectorId: string,
  userId: string,
  supabase: SupabaseClient,
  mimeType: string,
  sourceName: string,
  exportMime = "text/plain",
): Promise<SyncResult> {
  const authedFetch = await makeAuthedFetch(connectorId, supabase);
  const { processFile } = await import("@/lib/datasources/processor");
  const errors: string[] = [];
  let itemsProcessed = 0;
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      pageSize: "50",
      fields: "files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken",
      q: `trashed=false and mimeType='${mimeType}'`,
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await authedFetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
    const json = (await res.json()) as {
      files: { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string }[];
      nextPageToken?: string;
    };

    for (const file of json.files ?? []) {
      try {
        const exportRes = await authedFetch(
          `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(exportMime)}`,
        );
        if (!exportRes.ok) continue;
        const text = await exportRes.text();
        if (!text.trim()) continue;

        await processFile(
          userId,
          new TextEncoder().encode(text),
          file.name,
          exportMime === "text/csv" ? "csv" : "txt",
          {
            sourceType: "connector",
            sourceId: connectorId,
            sourceItemId: file.id,
            metadata: {
              title: file.name,
              url: file.webViewLink,
              source_name: sourceName,
              modified_at: file.modifiedTime,
              permissions: { canAccess: true },
            },
          },
          supabase,
        );
        itemsProcessed++;
      } catch (e) {
        errors.push(`${file.name}: ${e instanceof Error ? e.message : "err"}`);
      }
    }
    pageToken = json.nextPageToken;
  } while (pageToken);

  return { itemsProcessed, newCursor: null, errors };
}

// ---------------- Gmail ----------------
export async function syncGmail(connectorId: string, userId: string, supabase: SupabaseClient): Promise<SyncResult> {
  const authedFetch = await makeAuthedFetch(connectorId, supabase);
  const { processFile } = await import("@/lib/datasources/processor");
  const errors: string[] = [];
  let itemsProcessed = 0;

  // Fetch the 100 most recent messages from inbox
  const listRes = await authedFetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=in:inbox",
  );
  if (!listRes.ok) throw new Error(`Gmail list failed: ${listRes.status}`);
  const listJson = (await listRes.json()) as { messages?: { id: string }[] };

  for (const m of listJson.messages ?? []) {
    try {
      const msgRes = await authedFetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
      );
      if (!msgRes.ok) continue;
      const msg = (await msgRes.json()) as {
        id: string;
        snippet?: string;
        internalDate?: string;
        payload?: {
          headers?: { name: string; value: string }[];
          parts?: { mimeType: string; body?: { data?: string } }[];
          body?: { data?: string };
        };
      };

      const headers = msg.payload?.headers ?? [];
      const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "(no subject)";
      const from = headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
      const body = extractGmailBody(msg.payload) || msg.snippet || "";
      if (!body.trim()) continue;

      const text = `From: ${from}\nSubject: ${subject}\n\n${body}`;
      await processFile(
        userId,
        new TextEncoder().encode(text),
        `${subject}.txt`,
        "txt",
        {
          sourceType: "connector",
          sourceId: connectorId,
          sourceItemId: msg.id,
          metadata: {
            title: subject,
            url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
            source_name: "Gmail",
            modified_at: msg.internalDate ? new Date(parseInt(msg.internalDate)).toISOString() : new Date().toISOString(),
            permissions: { canAccess: true },
          },
        },
        supabase,
      );
      itemsProcessed++;
    } catch (e) {
      errors.push(`msg ${m.id}: ${e instanceof Error ? e.message : "err"}`);
    }
  }
  return { itemsProcessed, newCursor: null, errors };
}

function extractGmailBody(payload: any): string {
  if (!payload) return "";
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  }
  for (const part of payload.parts ?? []) {
    const nested = extractGmailBody(part);
    if (nested) return nested;
  }
  return "";
}

function decodeBase64Url(s: string): string {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

// ---------------- Google Calendar ----------------
export async function syncGoogleCalendar(connectorId: string, userId: string, supabase: SupabaseClient): Promise<SyncResult> {
  const authedFetch = await makeAuthedFetch(connectorId, supabase);
  const { processFile } = await import("@/lib/datasources/processor");
  const errors: string[] = [];
  let itemsProcessed = 0;

  // Pull events from past 30 days through next 90 days
  const timeMin = new Date(Date.now() - 30 * 86400000).toISOString();
  const timeMax = new Date(Date.now() + 90 * 86400000).toISOString();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults: "250",
    singleEvents: "true",
    orderBy: "startTime",
  });
  const res = await authedFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
  if (!res.ok) throw new Error(`Calendar list failed: ${res.status}`);
  const json = (await res.json()) as {
    items?: {
      id: string;
      summary?: string;
      description?: string;
      location?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      htmlLink?: string;
      attendees?: { email: string }[];
    }[];
  };

  for (const ev of json.items ?? []) {
    try {
      const start = ev.start?.dateTime ?? ev.start?.date ?? "";
      const end = ev.end?.dateTime ?? ev.end?.date ?? "";
      const title = ev.summary || "(untitled event)";
      const attendees = (ev.attendees ?? []).map((a) => a.email).join(", ");
      const text = [
        `Event: ${title}`,
        `When: ${start} - ${end}`,
        ev.location ? `Where: ${ev.location}` : "",
        attendees ? `Attendees: ${attendees}` : "",
        ev.description ? `\n${ev.description}` : "",
      ].filter(Boolean).join("\n");

      await processFile(
        userId,
        new TextEncoder().encode(text),
        `${title}.txt`,
        "txt",
        {
          sourceType: "connector",
          sourceId: connectorId,
          sourceItemId: ev.id,
          metadata: {
            title,
            url: ev.htmlLink,
            source_name: "Google Calendar",
            modified_at: start || new Date().toISOString(),
            permissions: { canAccess: true },
          },
        },
        supabase,
      );
      itemsProcessed++;
    } catch (e) {
      errors.push(`event ${ev.id}: ${e instanceof Error ? e.message : "err"}`);
    }
  }

  return { itemsProcessed, newCursor: null, errors };
}
