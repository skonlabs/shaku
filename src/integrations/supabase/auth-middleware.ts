import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string);
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string);

/**
 * Middleware: extracts the user's bearer token from the Authorization header,
 * verifies it with Supabase, and exposes an authenticated supabase client +
 * userId to the handler context. Throws 401 if the token is missing/invalid.
 */
export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const authHeader = getRequestHeader("authorization") ?? getRequestHeader("Authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      throw new Error("Unauthorized: missing bearer token");
    }
    const token = authHeader.slice(7).trim();

    const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      throw new Error("Unauthorized: invalid token");
    }

    return next({ context: { supabase, userId: data.user.id, accessToken: token } });
  },
);
