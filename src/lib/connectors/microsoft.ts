// Unified Microsoft connector: single Azure AD app serves OneDrive, Word, Excel,
// PowerPoint, OneNote, Outlook, and Teams via the Microsoft Graph API.
// Per-user OAuth (authorization code flow with PKCE-less confidential client).
// Reuses encryptToken/decryptToken from google-drive.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncResult } from "./types";
import { decryptToken, encryptToken } from "./google-drive";

const MS_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";

// Microsoft requires `offline_access` to receive a refresh token.
// We request the union of scopes for the chosen service plus `User.Read` for profile.
const SERVICE_SCOPES: Record<string, string> = {
  onedrive: "Files.Read offline_access",
  microsoft_word: "Files.Read offline_access",
  microsoft_excel: "Files.Read offline_access",
  microsoft_powerpoint: "Files.Read offline_access",
  microsoft_onenote: "Notes.Read offline_access",
  microsoft_outlook: "Mail.Read offline_access",
  microsoft_teams: "Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All offline_access",
};

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Microsoft OAuth not configured");
  return { clientId, clientSecret };
}

export function buildMicrosoftAuthUrl(service: string, redirectUri: string, oauthState: string): string {
  const { clientId } = getCredentials();
  const scope = SERVICE_SCOPES[service];
  if (!scope) throw new Error(`Unknown Microsoft service: ${service}`);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    scope,
    state: oauthState,
    prompt: "select_account",
  });
  return `${MS_AUTH_URL}?${params}`;
}

export async function exchangeMicrosoftCode(
  service: string,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const { clientId, clientSecret } = getCredentials();
  const scope = SERVICE_SCOPES[service];
  const res = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope,
    }),
  });
  if (!res.ok) throw new Error(`MS token exchange failed: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? "", expiresAt: Date.now() + j.expires_in * 1000 };
}

async function refreshMicrosoftToken(service: string, refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = getCredentials();
  const scope = SERVICE_SCOPES[service];
  const res = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope,
    }),
  });
  if (!res.ok) throw new Error("MS token refresh failed");
  const j = (await res.json()) as { access_token: string };
  return j.access_token;
}

async function makeAuthedFetch(connectorId: string, service: string, supabase: SupabaseClient) {
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
      accessToken = await refreshMicrosoftToken(service, refreshToken);
      const enc = await encryptToken(accessToken);
      await supabase.from("connectors").update({ oauth_token_encrypted: enc }).eq("id", connectorId);
      headers.set("Authorization", `Bearer ${accessToken}`);
      res = await fetch(url, { ...init, headers });
    }
    return res;
  };
}

// ---------------- OneDrive (and Word/Excel/PowerPoint via Drive items) ----------------
const OFFICE_MIME_FILTER: Record<string, string[]> = {
  onedrive: [], // all files
  microsoft_word: [".docx", ".doc"],
  microsoft_excel: [".xlsx", ".xls"],
  microsoft_powerpoint: [".pptx", ".ppt"],
};

export async function syncMicrosoftDrive(
  connectorId: string,
  userId: string,
  service: string,
  supabase: SupabaseClient,
  sourceName: string,
): Promise<SyncResult> {
  const authedFetch = await makeAuthedFetch(connectorId, service, supabase);
  const { processFile } = await import("@/lib/datasources/processor");
  const errors: string[] = [];
  let itemsProcessed = 0;
  const allowedExt = OFFICE_MIME_FILTER[service] ?? [];

  // Recursively walk the drive starting at root.
  async function walk(folderId: string): Promise<void> {
    let nextLink: string | null = `${GRAPH}/me/drive/items/${folderId}/children?$top=50&$select=id,name,file,folder,webUrl,lastModifiedDateTime`;
    while (nextLink) {
      const res = await authedFetch(nextLink);
      if (!res.ok) throw new Error(`OneDrive list failed: ${res.status}`);
      const json = (await res.json()) as {
        value: { id: string; name: string; file?: { mimeType: string }; folder?: unknown; webUrl?: string; lastModifiedDateTime?: string }[];
        "@odata.nextLink"?: string;
      };

      for (const item of json.value ?? []) {
        if (item.folder) {
          await walk(item.id);
          continue;
        }
        if (!item.file) continue;
        const lowerName = item.name.toLowerCase();
        if (allowedExt.length && !allowedExt.some((e) => lowerName.endsWith(e))) continue;

        try {
          const dl = await authedFetch(`${GRAPH}/me/drive/items/${item.id}/content`);
          if (!dl.ok) continue;
          const buf = new Uint8Array(await dl.arrayBuffer());
          const ext = lowerName.split(".").pop() ?? "bin";
          await processFile(
            userId,
            buf,
            item.name,
            ext,
            {
              sourceType: "connector",
              sourceId: connectorId,
              sourceItemId: item.id,
              metadata: {
                title: item.name,
                url: item.webUrl,
                source_name: sourceName,
                modified_at: item.lastModifiedDateTime ?? new Date().toISOString(),
                permissions: { canAccess: true },
              },
            },
            supabase,
          );
          itemsProcessed++;
        } catch (e) {
          errors.push(`${item.name}: ${e instanceof Error ? e.message : "err"}`);
        }
      }

      nextLink = json["@odata.nextLink"] ?? null;
    }
  }

  await walk("root");
  return { itemsProcessed, newCursor: null, errors };
}

// ---------------- OneNote ----------------
export async function syncMicrosoftOneNote(
  connectorId: string,
  userId: string,
  supabase: SupabaseClient,
): Promise<SyncResult> {
  const authedFetch = await makeAuthedFetch(connectorId, "microsoft_onenote", supabase);
  const { processFile } = await import("@/lib/datasources/processor");
  const errors: string[] = [];
  let itemsProcessed = 0;

  const pagesRes = await authedFetch(`${GRAPH}/me/onenote/pages?$top=100&$select=id,title,contentUrl,lastModifiedDateTime,links`);
  if (!pagesRes.ok) throw new Error(`OneNote list failed: ${pagesRes.status}`);
  const pages = (await pagesRes.json()) as {
    value: { id: string; title: string; contentUrl?: string; lastModifiedDateTime?: string; links?: { oneNoteWebUrl?: { href: string } } }[];
  };

  for (const page of pages.value ?? []) {
    try {
      if (!page.contentUrl) continue;
      const cRes = await authedFetch(page.contentUrl);
      if (!cRes.ok) continue;
      const html = await cRes.text();
      const text = stripHtml(html);
      if (!text.trim()) continue;

      await processFile(
        userId,
        new TextEncoder().encode(text),
        `${page.title || "page"}.html`,
        "html",
        {
          sourceType: "connector",
          sourceId: connectorId,
          sourceItemId: page.id,
          metadata: {
            title: page.title,
            url: page.links?.oneNoteWebUrl?.href,
            source_name: "OneNote",
            modified_at: page.lastModifiedDateTime ?? new Date().toISOString(),
            permissions: { canAccess: true },
          },
        },
        supabase,
      );
      itemsProcessed++;
    } catch (e) {
      errors.push(`${page.title}: ${e instanceof Error ? e.message : "err"}`);
    }
  }
  return { itemsProcessed, newCursor: null, errors };
}

// ---------------- Outlook ----------------
export async function syncMicrosoftOutlook(
  connectorId: string,
  userId: string,
  supabase: SupabaseClient,
): Promise<SyncResult> {
  const authedFetch = await makeAuthedFetch(connectorId, "microsoft_outlook", supabase);
  const { processFile } = await import("@/lib/datasources/processor");
  const errors: string[] = [];
  let itemsProcessed = 0;

  const res = await authedFetch(
    `${GRAPH}/me/messages?$top=100&$select=id,subject,bodyPreview,from,receivedDateTime,webLink,body`,
  );
  if (!res.ok) throw new Error(`Outlook list failed: ${res.status}`);
  const json = (await res.json()) as {
    value: {
      id: string;
      subject?: string;
      bodyPreview?: string;
      from?: { emailAddress?: { address: string } };
      receivedDateTime?: string;
      webLink?: string;
      body?: { content?: string; contentType?: string };
    }[];
  };

  for (const m of json.value ?? []) {
    try {
      const subject = m.subject || "(no subject)";
      const from = m.from?.emailAddress?.address ?? "";
      const bodyText = m.body?.contentType === "html" ? stripHtml(m.body.content ?? "") : (m.body?.content ?? m.bodyPreview ?? "");
      if (!bodyText.trim()) continue;

      const text = `From: ${from}\nSubject: ${subject}\n\n${bodyText}`;
      await processFile(
        userId,
        new TextEncoder().encode(text),
        `${subject}.txt`,
        "txt",
        {
          sourceType: "connector",
          sourceId: connectorId,
          sourceItemId: m.id,
          metadata: {
            title: subject,
            url: m.webLink,
            source_name: "Outlook",
            modified_at: m.receivedDateTime ?? new Date().toISOString(),
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

// ---------------- Teams ----------------
export async function syncMicrosoftTeams(
  connectorId: string,
  userId: string,
  supabase: SupabaseClient,
): Promise<SyncResult> {
  const authedFetch = await makeAuthedFetch(connectorId, "microsoft_teams", supabase);
  const { processFile } = await import("@/lib/datasources/processor");
  const errors: string[] = [];
  let itemsProcessed = 0;

  const teamsRes = await authedFetch(`${GRAPH}/me/joinedTeams?$select=id,displayName`);
  if (!teamsRes.ok) throw new Error(`Teams list failed: ${teamsRes.status}`);
  const teams = (await teamsRes.json()) as { value: { id: string; displayName: string }[] };

  for (const team of teams.value ?? []) {
    const chRes = await authedFetch(`${GRAPH}/teams/${team.id}/channels?$select=id,displayName`);
    if (!chRes.ok) continue;
    const channels = (await chRes.json()) as { value: { id: string; displayName: string }[] };

    for (const ch of channels.value ?? []) {
      try {
        const msgRes = await authedFetch(`${GRAPH}/teams/${team.id}/channels/${ch.id}/messages?$top=50`);
        if (!msgRes.ok) continue;
        const msgs = (await msgRes.json()) as {
          value: { id: string; body?: { content?: string; contentType?: string }; from?: { user?: { displayName?: string } }; createdDateTime?: string; webUrl?: string }[];
        };

        for (const m of msgs.value ?? []) {
          const raw = m.body?.content ?? "";
          if (!raw.trim()) continue;
          const bodyText = m.body?.contentType === "html" ? stripHtml(raw) : raw;
          const author = m.from?.user?.displayName ?? "unknown";
          const text = `Team: ${team.displayName} / Channel: ${ch.displayName}\nFrom: ${author}\n\n${bodyText}`;

          await processFile(
            userId,
            new TextEncoder().encode(text),
            `${team.displayName}-${ch.displayName}-${m.id}.txt`,
            "txt",
            {
              sourceType: "connector",
              sourceId: connectorId,
              sourceItemId: m.id,
              metadata: {
                title: `${ch.displayName} message`,
                url: m.webUrl,
                source_name: "Microsoft Teams",
                modified_at: m.createdDateTime ?? new Date().toISOString(),
                permissions: { canAccess: true },
              },
            },
            supabase,
          );
          itemsProcessed++;
        }
      } catch (e) {
        errors.push(`${team.displayName}/${ch.displayName}: ${e instanceof Error ? e.message : "err"}`);
      }
    }
  }
  return { itemsProcessed, newCursor: null, errors };
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
