import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import { AppSidebar } from "@/components/AppSidebar";
import { SidePanel } from "@/components/SidePanel";
import { recordSeen } from "@/lib/conversations.functions";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const { user, profile, loading } = useAuth();
  const navigate = useNavigate();
  const seenRef = useRef(false);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      void navigate({ to: "/login" });
      return;
    }
    // First-time users → onboarding
    if (profile && !profile.has_completed_onboarding) {
      void navigate({ to: "/onboarding" });
      return;
    }
    // Stamp last_seen_at once per session (after greeting decision in index)
    if (!seenRef.current && profile) {
      seenRef.current = true;
      // Small delay so the index page can read the previous value first
      setTimeout(() => {
        void recordSeen({ data: undefined }).catch(() => {});
      }, 1500);
    }
  }, [loading, user, profile, navigate]);

  if (loading || !user || (profile && !profile.has_completed_onboarding)) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  return (
    <div className="flex h-svh w-full overflow-hidden bg-background">
      <AppSidebar />
      <SidePanel />
      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

