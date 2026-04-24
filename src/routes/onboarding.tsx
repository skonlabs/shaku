import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Sparkles, Brain, Lock, ArrowRight } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { completeOnboarding } from "@/lib/conversations.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
});

function OnboardingPage() {
  const { user, profile, loading, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  // Redirect non-authed users to login; finished users to home
  useEffect(() => {
    if (loading) return;
    if (!user) void navigate({ to: "/login" });
    else if (profile?.has_completed_onboarding) void navigate({ to: "/" });
    else if (profile?.name && !name) setName(profile.name);
  }, [loading, user, profile, navigate, name]);

  const finish = async () => {
    setSaving(true);
    try {
      await completeOnboarding({ data: { name: name.trim() || undefined } });
      await refreshProfile();
      void navigate({ to: "/" });
    } catch {
      toast.error("Couldn't save. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  if (loading || !user) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const steps = [
    {
      icon: Sparkles,
      title: "Welcome to Cortex",
      body: "Your personal AI that remembers, learns, and helps you get things done — across every conversation.",
    },
    {
      icon: Brain,
      title: "It learns as you chat",
      body: "Cortex builds a private memory of your preferences and projects so each answer gets better than the last.",
    },
    {
      icon: Lock,
      title: "Your data, your control",
      body: "Everything is private by default. Memory can be paused or cleared any time in Settings.",
    },
  ];

  const isLast = step === steps.length - 1;
  const Step = steps[step];
  const Icon = Step.icon;

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-sm">
        <div className="flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Icon className="h-7 w-7" />
          </div>
        </div>

        <h1 className="mt-5 text-center text-2xl font-semibold tracking-tight">{Step.title}</h1>
        <p className="mt-3 text-center text-sm leading-relaxed text-muted-foreground">
          {Step.body}
        </p>

        {isLast && (
          <div className="mt-6 space-y-2">
            <Label htmlFor="onboarding-name">What should we call you?</Label>
            <Input
              id="onboarding-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your first name"
              autoFocus
              maxLength={100}
            />
          </div>
        )}

        <div className="mt-7 flex items-center justify-between">
          <div className="flex gap-1.5">
            {steps.map((_, i) => (
              <span
                key={i}
                className={
                  "h-1.5 w-6 rounded-full transition " +
                  (i === step ? "bg-primary" : "bg-muted")
                }
              />
            ))}
          </div>
          <Button
            onClick={() => (isLast ? void finish() : setStep(step + 1))}
            disabled={saving}
          >
            {isLast ? (saving ? "Setting up…" : "Get started") : "Next"}
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
