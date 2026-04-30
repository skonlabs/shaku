// Google Drive connector: OAuth2 + file sync.
// CSRF protection: generates a state parameter for OAuth initiation,
// stores it in connectors.oauth_state, validates on callback.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConnectedItem, SyncResult } from "./types";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";

// ---- OAuth Flow ----

export function buildAuthUrl(
  redirectUri: string,
  oauthState: string,
): string {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_DRIVE_CLIENT_ID;
  if (!clientId) throw new Error("Google OAuth not configured");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    access_type: "offline",
    prompt: "consent",
    state: oauthState, // CSRF token stored in DB before redirect
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google Drive not configured");

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

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: ${err.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? "",
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google Drive not configured");

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

  if (!res.ok) throw new Error("Token refresh failed");
  const json = (await res.json()) as { access_token: string; expires_in: number };
  return { accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
}

// ---- Token Encryption ----
// Simple AES-GCM encryption using CF Workers Web Crypto API.
// Key derived from CONNECTOR_ENCRYPTION_KEY (preferred) or SUPABASE_SERVICE_ROLE_KEY (fallback).

async function deriveEncryptionKey(): Promise<CryptoKey> {
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!encryptionKey) throw new Error("CONNECTOR_ENCRYPTION_KEY env var is required for OAuth token encryption");
  const encoded = new TextEncoder().encode(encryptionKey);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptToken(token: string): Promise<string> {
  const key = await deriveEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(token),
  );
  // Store as iv:ciphertext in base64
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(encrypted)));
  return `${ivB64}:${ctB64}`;
}

export async function decryptToken(stored: string): Promise<string> {
  if (!stored) return ""; // Slack uses empty refresh tokens; guard against decrypt crash
  const key = await deriveEncryptionKey();
  const [ivB64, ctB64] = stored.split(":");
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(decrypted);
}

// ---- Sync ----

export async function syncGoogleDrive(
  connectorId: string,
  userId: string,
  supabase: SupabaseClient,
): Promise<SyncResult> {
  const { data: connector } = await supabase
    .from("connectors")
    .select("oauth_token_encrypted, oauth_refresh_token_encrypted, sync_cursor")
    .eq("id", connectorId)
    .single();

  if (!connector) throw new Error("Connector not found");

  let accessToken = await decryptToken(connector.oauth_token_encrypted);
  const refreshToken = await decryptToken(connector.oauth_refresh_token_encrypted);

  // Retry once after token refresh
  const fetchWithAuth = async (url: string): Promise<Response> => {
    let res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 401) {
      const refreshed = await refreshAccessToken(refreshToken);
      accessToken = refreshed.accessToken;
      const encryptedNew = await encryptToken(accessToken);
      await supabase.from("connectors").update({
        oauth_token_encrypted: encryptedNew,
        oauth_state: null, // clear stale CSRF token after refresh
      }).eq("id", connectorId);
      res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    }
    return res;
  };

  const { processFile } = await import("@/lib/datasources/processor");
  const errors: string[] = [];
  let itemsProcessed = 0;
  let newCursor: string | null = null;

  if (!connector.sync_cursor) {
    // ---- Initial sync: list all existing files via files.list (paginated) ----
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        pageSize: "100",
        fields: "files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken",
        q: "trashed=false and mimeType!='application/vnd.google-apps.folder'",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const res = await fetchWithAuth(`${GOOGLE_DRIVE_API}/files?${params}`);
      if (!res.ok) throw new Error(`Drive API error: ${res.status}`);

      const json = (await res.json()) as {
        files: { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string }[];
        nextPageToken?: string;
      };

      for (const file of json.files ?? []) {
        try {
          const content = await downloadFileContent(file.id, file.mimeType, accessToken);
          if (!content) continue;
          await processFile(
            userId,
            new TextEncoder().encode(content),
            file.name,
            mimeToExtension(file.mimeType),
            {
              sourceType: "connector",
              sourceId: connectorId,
              sourceItemId: file.id,
              metadata: {
                title: file.name,
                url: file.webViewLink,
                source_name: "Google Drive",
                modified_at: file.modifiedTime,
                permissions: { canAccess: true },
              },
            },
            supabase,
          );
          itemsProcessed++;
        } catch (e) {
          errors.push(`${file.name}: ${e instanceof Error ? e.message : "unknown"}`);
        }
      }

      pageToken = json.nextPageToken;
    } while (pageToken);

    // Fetch a Changes API startPageToken so the next sync uses incremental changes
    const startRes = await fetchWithAuth(`${GOOGLE_DRIVE_API}/changes/startPageToken`);
    if (startRes.ok) {
      const startJson = (await startRes.json()) as { startPageToken: string };
      newCursor = startJson.startPageToken;
    }
  } else {
    // ---- Incremental sync: list changes since last Changes API token ----
    // sync_cursor holds a Drive Changes startPageToken (durable across invocations),
    // not a files.list nextPageToken (which expires in minutes).
    const params = new URLSearchParams({
      pageToken: connector.sync_cursor,
      pageSize: "50",
      fields:
        "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,webViewLink))",
    });
    const res = await fetchWithAuth(`${GOOGLE_DRIVE_API}/changes?${params}`);
    if (!res.ok) throw new Error(`Drive API error: ${res.status}`);

    const json = (await res.json()) as {
      changes: {
        fileId: string;
        removed: boolean;
        file?: { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string };
      }[];
      nextPageToken?: string;
      newStartPageToken?: string;
    };

    for (const change of json.changes ?? []) {
      if (change.removed || !change.file) continue;
      const file = change.file;
      if (file.mimeType === "application/vnd.google-apps.folder") continue;
      try {
        const content = await downloadFileContent(file.id, file.mimeType, accessToken);
        if (!content) continue;
        await processFile(
          userId,
          new TextEncoder().encode(content),
          file.name,
          mimeToExtension(file.mimeType),
          {
            sourceType: "connector",
            sourceId: connectorId,
            sourceItemId: file.id,
            metadata: {
              title: file.name,
              url: file.webViewLink,
              source_name: "Google Drive",
              modified_at: file.modifiedTime,
              permissions: { canAccess: true },
            },
          },
          supabase,
        );
        itemsProcessed++;
      } catch (e) {
        errors.push(`${file.name}: ${e instanceof Error ? e.message : "unknown"}`);
      }
    }

    // newStartPageToken (durable) is only on the last page; nextPageToken means more pages remain.
    // Storing nextPageToken lets the next cron pick up where this page left off.
    newCursor = json.newStartPageToken ?? json.nextPageToken ?? connector.sync_cursor;
  }

  return { itemsProcessed, newCursor, errors };
}

async function downloadFileContent(
  fileId: string,
  mimeType: string,
  accessToken: string,
): Promise<string | null> {
  // Google Workspace files must be exported
  const exportMimes: Record<string, string> = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "text/plain",
  };

  const exportMime = exportMimes[mimeType];
  let url: string;

  if (exportMime) {
    url = `${GOOGLE_DRIVE_API}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`;
  } else if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/pdf"
  ) {
    url = `${GOOGLE_DRIVE_API}/files/${fileId}?alt=media`;
  } else {
    return null; // Binary files not supported via text download
  }

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  return res.text();
}

function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "application/vnd.google-apps.document": "txt",
    "application/vnd.google-apps.spreadsheet": "csv",
    "application/vnd.google-apps.presentation": "txt",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/csv": "csv",
    "application/json": "json",
  };
  return map[mimeType] ?? "txt";
}
