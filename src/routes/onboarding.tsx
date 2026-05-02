import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Leaf, Heart, Lock, ArrowRight } from "lucide-react";
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

  useEffect(() => {
    if (loading) return;
    if (!user) void navigate({ to: "/login" });
    else if (profile?.has_completed_onboarding) void navigate({ to: "/app" });
    else if (profile?.name && !name) setName(profile.name);
  }, [loading, user, profile, navigate, name]);

  const finish = async () => {
    setSaving(true);
    try {
      await completeOnboarding({ data: { name: name.trim() || undefined } });
      await refreshProfile();
      void navigate({ to: "/app" });
    } catch {
      toast.error("Hmm, that didn't save. Mind trying again?");
    } finally {
      setSaving(false);
    }
  };

  if (loading || !user) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">One moment…</p>
      </div>
    );
  }

  const steps = [
    {
      icon: Leaf,
      title: "Welcome to Ekonomical",
      body: "I'm a friendly AI here to help — whether you want to draft a message, think something through, or just chat. No tech skills needed.",
    },
    {
      icon: Heart,
      title: "I get to know you over time",
      body: "The more we talk, the better I understand what you like and what you're working on — so my answers feel personal to you.",
    },
    {
      icon: Lock,
      title: "You're always in control",
      body: "Everything you share stays private. You can review what I remember, or clear it all, whenever you want.",
    },
  ];

  const isLast = step === steps.length - 1;
  const Step = steps[step];
  const Icon = Step.icon;

  return (
    <div className="relative flex min-h-svh items-center justify-center bg-background px-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,oklch(0.88_0.04_130/0.55),transparent_65%)]"
      />
      <div className="relative w-full max-w-md rounded-3xl border border-border/70 bg-card/90 p-8 shadow-[var(--shadow-float)] backdrop-blur">
        <div className="flex justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-br from-[oklch(0.62_0.08_145)] to-[oklch(0.50_0.07_150)] text-primary-foreground shadow-[0_10px_30px_-10px_oklch(0.50_0.07_150/0.5)]">
            <Icon className="h-8 w-8" />
          </div>
        </div>

        <h1 className="font-display mt-6 text-center text-2xl font-semibold">{Step.title}</h1>
        <p className="mt-3 text-center text-[15px] leading-relaxed text-muted-foreground">
          {Step.body}
        </p>

        {isLast && (
          <div className="mt-7 space-y-2">
            <Label htmlFor="onboarding-name">What should I call you?</Label>
            <Input
              id="onboarding-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your first name"
              className="h-11 rounded-xl"
              autoFocus
              maxLength={100}
            />
          </div>
        )}

        <div className="mt-8 flex items-center justify-between">
          <div className="flex gap-1.5">
            {steps.map((_, i) => (
              <span
                key={i}
                className={
                  "h-1.5 rounded-full transition-all duration-300 " +
                  (i === step ? "w-8 bg-primary" : "w-2 bg-muted")
                }
              />
            ))}
          </div>
          <Button
            onClick={() => (isLast ? void finish() : setStep(step + 1))}
            disabled={saving}
            className="h-11 rounded-xl px-5 text-sm font-medium"
          >
            {isLast ? (saving ? "Just a sec…" : "I'm ready") : "Next"}
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
