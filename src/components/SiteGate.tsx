import { useEffect, useState, type FormEvent } from "react";
import { Leaf, Lock } from "lucide-react";

/**
 * Soft site-wide access gate. Useful for keeping the app private during
 * staging / pre-launch. NOT a security boundary — credentials live in the
 * client bundle. Real authentication is handled by Supabase under /_app/*.
 */
const STORAGE_KEY = "ekonomical.site-gate.v1";
const EXPECTED_USER = "admin";
const EXPECTED_PASS = "ek@123";

export function SiteGate({ children }: { children: React.ReactNode }) {
  // Default to "locked" until we've checked localStorage to avoid a flash of
  // unprotected content during hydration.
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      setUnlocked(localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      setUnlocked(false);
    }
  }, []);

  if (unlocked === null) {
    // SSR / first paint — render nothing to avoid leaking content.
    return null;
  }

  if (unlocked) return <>{children}</>;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (user.trim() === EXPECTED_USER && pass === EXPECTED_PASS) {
      try {
        localStorage.setItem(STORAGE_KEY, "1");
      } catch {
        /* ignore */
      }
      setUnlocked(true);
      setError(null);
    } else {
      setError("That username or password didn't match.");
    }
  };

  return (
    <div className="relative flex min-h-svh items-center justify-center bg-background px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,oklch(0.88_0.04_130/0.55),transparent_65%)]"
      />
      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-3xl bg-gradient-to-br from-[oklch(0.62_0.08_145)] to-[oklch(0.50_0.07_150)] text-primary-foreground shadow-[0_10px_30px_-10px_oklch(0.50_0.07_150/0.55)]">
            <Leaf className="h-7 w-7" />
          </div>
          <div>
            <h1 className="font-display text-2xl font-semibold text-foreground">
              Ekonomical
            </h1>
            <p className="mt-1 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Lock className="h-3.5 w-3.5" />
              Private preview — sign in to continue
            </p>
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-3xl border border-border/70 bg-card/90 p-6 shadow-[var(--shadow-float)] backdrop-blur"
        >
          <label className="block text-[13px] font-medium text-foreground">
            Username
            <input
              type="text"
              autoComplete="username"
              autoFocus
              value={user}
              onChange={(e) => setUser(e.target.value)}
              className="mt-1.5 h-11 w-full rounded-xl border border-input bg-background px-3.5 text-[15px] outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </label>
          <label className="mt-4 block text-[13px] font-medium text-foreground">
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              className="mt-1.5 h-11 w-full rounded-xl border border-input bg-background px-3.5 text-[15px] outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </label>

          {error && (
            <p className="mt-3 text-[13px] text-destructive" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="mt-5 flex h-11 w-full items-center justify-center rounded-xl bg-primary text-[15px] font-medium text-primary-foreground shadow-[0_8px_22px_-8px_oklch(0.50_0.07_150/0.6)] transition-all hover:opacity-95 active:scale-[0.99]"
          >
            Continue
          </button>
        </form>

        <p className="mt-5 text-center text-[12px] text-muted-foreground/80">
          This page keeps Ekonomical hidden from web crawlers and casual visitors.
        </p>
      </div>
    </div>
  );
}
