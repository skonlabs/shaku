// Quick health check: confirms the configured Google OAuth credentials work AND
// that the user's stored tokens for a given Google service can fetch from Google's API.
// Auto-refreshes the access token on 401, mirroring the runtime sync behavior.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { decryptToken, encryptToken } from "@/lib/connectors/google-drive";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function getGoogleCreds() {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  return { clientId, clientSecret };
}

export const verifyGoogleConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      service: z.string().default("google_drive"),
    }),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;

    // 1. Credentials configured?
    const { clientId, clientSecret } = getGoogleCreds();
    if (!clientId || !clientSecret) {
      return {
        ok: false,
        stage: "credentials",
        message: "Google OAuth credentials are not configured on the server.",
      };
    }

    // 2. Connector row exists and is connected?
    const { data: connector } = await supabase
      .from("connectors")
      .select("id, status, oauth_token_encrypted, oauth_refresh_token_encrypted")
      .eq("user_id", userId)
      .eq("service", data.service)
      .maybeSingle();

    if (!connector) {
      return { ok: false, stage: "connector", message: `No ${data.service} connection found. Please connect first.` };
    }
    if (!connector.oauth_token_encrypted) {
      return { ok: false, stage: "tokens", message: "No access token stored. Please reconnect." };
    }

    // 3. Try Google userinfo with stored token; refresh on 401
    let accessToken: string;
    let refreshToken = "";
    try {
      accessToken = await decryptToken(connector.oauth_token_encrypted);
      if (connector.oauth_refresh_token_encrypted) {
        refreshToken = await decryptToken(connector.oauth_refresh_token_encrypted);
      }
    } catch {
      return { ok: false, stage: "decrypt", message: "Stored tokens couldn't be decrypted. Please reconnect." };
    }

    let userinfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    let refreshed = false;
    if (userinfoRes.status === 401 && refreshToken) {
      const refreshRes = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
        }),
      });
      if (!refreshRes.ok) {
        const body = await refreshRes.text().catch(() => "");
        return {
          ok: false,
          stage: "refresh",
          message: `Token refresh failed (${refreshRes.status}). Please reconnect.`,
          detail: body.slice(0, 200),
        };
      }
      const refreshJson = (await refreshRes.json()) as { access_token: string };
      accessToken = refreshJson.access_token;
      refreshed = true;
      // Persist new access token
      await supabase
        .from("connectors")
        .update({ oauth_token_encrypted: await encryptToken(accessToken) })
        .eq("id", connector.id);

      userinfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    }

    if (!userinfoRes.ok) {
      const body = await userinfoRes.text().catch(() => "");
      return {
        ok: false,
        stage: "userinfo",
        message: `Google rejected the access token (${userinfoRes.status}).`,
        detail: body.slice(0, 200),
      };
    }

    const userinfo = (await userinfoRes.json()) as { email?: string; name?: string; sub?: string };

    return {
      ok: true,
      stage: "verified",
      message: refreshed
        ? "Connection verified — access token was refreshed and works."
        : "Connection verified — stored access token works.",
      account: {
        email: userinfo.email ?? null,
        name: userinfo.name ?? null,
      },
      refreshed,
      status: connector.status,
    };
  });
