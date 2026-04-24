import { createClient } from "@supabase/supabase-js";

/**
 * Admin Supabase client (service role). BYPASSES RLS.
 * Server-only — never import from client code.
 */
const SUPABASE_URL = process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string);
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

if (!SUPABASE_URL) throw new Error("SUPABASE_URL not configured");

export const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY ?? "", {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
