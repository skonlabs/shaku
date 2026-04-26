import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// TODO: wire to UI — currently unused
export const getUsageSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    // Messages today (count from messages table — usage_events added in Sprint 7)
    const { count: messagesToday } = await supabase
      .from("messages")
      .select("id, conversations!inner(user_id)", { count: "exact", head: true })
      .eq("role", "user")
      .eq("conversations.user_id", userId)
      .gte("created_at", todayIso);

    // Memories used today
    const { count: memoriesUsed } = await supabase
      .from("memories")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("last_accessed_at", todayIso);

    // Usage events for token breakdown (Sprint 7+ data)
    const { data: usageEvents } = await supabase
      .from("usage_events")
      .select("model_used, tokens_in, tokens_out, cost_usd, created_at")
      .eq("user_id", userId)
      .gte("created_at", thirtyDaysAgo)
      .order("created_at", { ascending: true });

    const events = usageEvents ?? [];
    const totalTokensIn = events.reduce((s, e) => s + (e.tokens_in ?? 0), 0);
    const totalTokensOut = events.reduce((s, e) => s + (e.tokens_out ?? 0), 0);
    const totalCost = events.reduce((s, e) => s + Number(e.cost_usd ?? 0), 0);

    // Daily breakdown for trend chart
    const dailyMap = new Map<string, { tokensIn: number; tokensOut: number }>();
    for (const e of events) {
      const day = e.created_at.slice(0, 10);
      const existing = dailyMap.get(day) ?? { tokensIn: 0, tokensOut: 0 };
      dailyMap.set(day, {
        tokensIn: existing.tokensIn + (e.tokens_in ?? 0),
        tokensOut: existing.tokensOut + (e.tokens_out ?? 0),
      });
    }

    const dailyTrend = [...dailyMap.entries()].map(([date, v]) => ({
      date,
      tokensIn: v.tokensIn,
      tokensOut: v.tokensOut,
    }));

    return {
      messagesToday: messagesToday ?? 0,
      memoriesUsed: memoriesUsed ?? 0,
      totalTokensIn,
      totalTokensOut,
      totalCostUsd: totalCost,
      dailyTrend,
    };
  });

export const getUsageByConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data } = await supabase
      .from("usage_events")
      .select("model_used, tokens_in, tokens_out, cost_usd, latency_ms, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(200);

    return { events: data ?? [] };
  });
