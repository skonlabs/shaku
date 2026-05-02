import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Leaf, Loader2 } from "lucide-react";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { user, signInWithPassword, signUpWithPassword, signInWithGoogle } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = React.useState<"signin" | "signup">("signin");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [name, setName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (user) void navigate({ to: "/app" });
  }, [user, navigate]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (mode === "signin") {
        const { error } = await signInWithPassword(email, password);
        if (error) toast.error(error);
        else toast.success("Welcome back!");
      } else {
        const { error, needsConfirmation } = await signUpWithPassword(email, password, name);
        if (error) toast.error(error);
        else if (needsConfirmation)
          toast.info("Check your email — we sent a quick confirmation link.");
        else toast.success("Welcome to Cortex!");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onGoogle = async () => {
    setSubmitting(true);
    const { error } = await signInWithGoogle();
    if (error) {
      toast.error(error);
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-6">
      {/* Soft sage halo */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,oklch(0.88_0.04_130/0.6),transparent_60%)]"
      />
      <div className="relative w-full max-w-sm">
        <Link to="/login" className="mb-10 flex flex-col items-center justify-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-3xl bg-gradient-to-br from-[oklch(0.62_0.08_145)] to-[oklch(0.50_0.07_150)] text-primary-foreground shadow-[0_10px_30px_-10px_oklch(0.50_0.07_150/0.55)]">
            <Leaf className="h-7 w-7" />
          </div>
          <span className="font-display text-2xl font-semibold">Cortex</span>
        </Link>

        <div className="rounded-3xl border border-border/70 bg-card/90 p-8 shadow-[var(--shadow-float)] backdrop-blur">
          <h1 className="font-display text-2xl font-semibold">
            {mode === "signin" ? "Welcome back" : "Let's get you set up"}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {mode === "signin"
              ? "Sign in to pick up where you left off."
              : "Just a few details and you're in. Promise."}
          </p>

          <Button
            type="button"
            variant="outline"
            className="mt-6 h-11 w-full rounded-xl text-sm font-medium"
            onClick={onGoogle}
            disabled={submitting}
          >
            Continue with Google
          </Button>

          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or use email</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            {mode === "signup" && (
              <div className="space-y-2">
                <Label htmlFor="name">What should I call you?</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your first name"
                  className="h-11 rounded-xl"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="h-11 rounded-xl"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="h-11 rounded-xl"
                minLength={6}
                required
              />
            </div>
            <Button type="submit" className="h-11 w-full rounded-xl text-sm font-medium" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {mode === "signin" ? "Sign in" : "Create my account"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {mode === "signin" ? "First time here?" : "Already have an account?"}{" "}
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            >
              {mode === "signin" ? "Create an account" : "Sign in instead"}
            </button>
          </p>
        </div>

        <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">
          Your conversations stay private. You can review or clear what Cortex remembers anytime.
        </p>
      </div>
    </div>
  );
}
