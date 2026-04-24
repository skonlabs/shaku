import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Admin Supabase client (service role). BYPASSES RLS.
 * Server-only — never import from client code.
 *
 * Lazily constructed so that importing this module doesn't crash when
 * SUPABASE_SERVICE_ROLE_KEY isn't configured (only features that actually
 * need admin access — e.g. file uploads — will fail).
 */
const SUPABASE_URL = process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string);

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL) throw new Error("SUPABASE_URL not configured");
  if (!SERVICE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY not configured — admin operations are unavailable.",
    );
  }
  _client = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return _client;
}

export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_t, prop) {
    const c = getClient();
    // @ts-expect-error dynamic forward
    const v = c[prop];
    return typeof v === "function" ? v.bind(c) : v;
  },
});
