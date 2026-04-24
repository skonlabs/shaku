import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { AppSidebar } from "@/components/AppSidebar";
import { SidePanel } from "@/components/SidePanel";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const { user, profile, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      void navigate({ to: "/login" });
      return;
    }
    if (profile && !profile.has_completed_onboarding) {
      void navigate({ to: "/onboarding" });
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

