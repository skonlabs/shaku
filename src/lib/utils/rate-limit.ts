// Rate limiting for free and Pro tiers.
//
// Free:  20 messages/hour
// Pro:   30 messages/minute (sustained)
//
// Counts user messages from the messages table join conversations.
// Usage events table (Sprint 7) will supplement this.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: string;
  windowMs: number;
}

export async function checkRateLimit(
  userId: string,
  plan: string,
  supabase: SupabaseClient,
): Promise<RateLimitResult> {
  const isPro = plan === "pro";
  const limit = isPro ? 30 : 20;
  const windowMs = isPro ? 60 * 1000 : 60 * 60 * 1000; // 1 min for pro, 1 hr for free

  const windowStart = new Date(Date.now() - windowMs).toISOString();

  const { count } = await supabase
    .from("messages")
    .select("id, conversations!inner(user_id)", { count: "exact", head: true })
    .eq("role", "user")
    .eq("conversations.user_id", userId)
    .gte("created_at", windowStart);

  const used = count ?? 0;
  const allowed = used < limit;
  const remaining = Math.max(0, limit - used);

  // Estimate reset time: find the oldest message in the window
  let resetAt = new Date(Date.now() + windowMs).toISOString();
  if (!allowed) {
    const { data: oldest } = await supabase
      .from("messages")
      .select("created_at, conversations!inner(user_id)")
      .eq("role", "user")
      .eq("conversations.user_id", userId)
      .gte("created_at", windowStart)
      .order("created_at", { ascending: true })
      .limit(1);

    if (oldest?.[0]?.created_at) {
      resetAt = new Date(
        new Date(oldest[0].created_at).getTime() + windowMs,
      ).toISOString();
    }
  }

  return { allowed, remaining, limit, resetAt, windowMs };
}

// Warning threshold: emit a banner at 80% usage
// TODO: wire to UI — currently unused
export function shouldWarnAboutLimit(
  used: number,
  limit: number,
): { warn: boolean; remaining: number } {
  const remaining = Math.max(0, limit - used);
  return { warn: used / limit >= 0.8 && remaining > 0, remaining };
}
