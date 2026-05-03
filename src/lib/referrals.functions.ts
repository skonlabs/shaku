import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? (import.meta.env.VITE_SUPABASE_URL as string);
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string);

function anonClient() {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export type ReferralCode = {
  code: string;
  status: "unused" | "used";
  period_start: string;
  used_at: string | null;
};

/** List the current user's codes for the current calendar month. */
export const getMyReferralCodes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    // Ensure codes exist for current month (idempotent).
    await supabase.rpc("issue_monthly_referral_codes", { p_user_id: userId });

    const periodStart = new Date();
    periodStart.setUTCDate(1);
    periodStart.setUTCHours(0, 0, 0, 0);
    const iso = periodStart.toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from("referral_codes")
      .select("code, status, period_start, used_at")
      .eq("owner_id", userId)
      .eq("period_start", iso)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[referrals] list error", error);
      return { codes: [] as ReferralCode[] };
    }
    return { codes: (data ?? []) as ReferralCode[] };
  });

/** Public: does the app currently require a referral code to sign up? */
export const signupRequiresReferral = createServerFn({ method: "GET" }).handler(
  async () => {
    const supabase = anonClient();
    const { data, error } = await supabase.rpc("signup_requires_referral");
    if (error) {
      console.error("[referrals] requires error", error);
      return { required: true };
    }
    return { required: Boolean(data) };
  },
);

/** Public: is the supplied code currently valid (exists & unused)? */
export const validateReferralCode = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({ code: z.string().trim().min(4).max(16) }),
  )
  .handler(async ({ data }) => {
    const supabase = anonClient();
    const { data: ok, error } = await supabase.rpc("is_referral_code_valid", {
      p_code: data.code.toUpperCase(),
    });
    if (error) {
      console.error("[referrals] validate error", error);
      return { valid: false };
    }
    return { valid: Boolean(ok) };
  });
