import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { getRateLimitStatus } from "@/lib/conversations.functions";
import { shouldWarnAboutLimit } from "@/lib/utils/rate-limit";
import { useAuth } from "@/lib/auth-context";

/**
 * Shows an inline warning when the user has used >=80% of their hourly limit.
 * The 100% disabled state is handled separately by ChatComposer's `disabled` prop.
 */
export function RateLimitBanner() {
  const { user, loading } = useAuth();

  const { data } = useQuery({
    queryKey: ["rate-limit"],
    queryFn: () => getRateLimitStatus({ data: undefined }),
    enabled: !loading && !!user,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (loading || !user || !data) return null;
  const { warn, remaining } = shouldWarnAboutLimit(data.used, data.limit);
  if (!warn || data.used >= data.limit) return null;
  return (
    <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>
        You have <strong>{remaining}</strong> message{remaining === 1 ? "" : "s"} left this hour.
      </span>
    </div>
  );
}
