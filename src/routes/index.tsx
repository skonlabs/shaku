import { createFileRoute, Link } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const { user, profile, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  // Authenticated: show empty chat shell placeholder
  if (user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Sparkles className="h-7 w-7" />
        </div>
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Hello, {profile?.name ?? "there"}
          </h1>
          <p className="max-w-md text-muted-foreground">
            Ask me anything. I can search your connected sources, remember your preferences, and
            help you get things done.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          Chat UI coming next — Sprint 1 foundation is in place.
        </p>
      </div>
    );
  }

  // Unauthenticated: marketing/landing
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
        <Sparkles className="h-8 w-8" />
      </div>
      <div className="max-w-xl space-y-3">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Cortex is your personal AI
        </h1>
        <p className="text-lg text-muted-foreground">
          An assistant that remembers, learns, and helps you get things done.
        </p>
      </div>
      <Button asChild size="lg" className="rounded-full px-8">
        <Link to="/login">Get started</Link>
      </Button>
    </div>
  );
}
