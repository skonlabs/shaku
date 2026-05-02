import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { AppSidebar } from "@/components/AppSidebar";
import { SidePanel } from "@/components/SidePanel";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const { user, profile, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  if (profile && !profile.has_completed_onboarding) {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <div className="flex h-svh w-full overflow-hidden bg-background">
      <AppSidebar />
      <SidePanel side="left" />
      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
      <SidePanel side="right" />
    </div>
  );
}

