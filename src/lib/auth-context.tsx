import * as React from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase, type Profile } from "@/integrations/supabase/client";

const AUTH_READY_TIMEOUT_MS = 8_000;

export interface AuthContextValue {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  signInWithPassword: (email: string, password: string) => Promise<{ error: string | null }>;
  signUpWithPassword: (
    email: string,
    password: string,
    name?: string,
    referralCode?: string,
  ) => Promise<{ error: string | null; needsConfirmation: boolean }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [user, setUser] = React.useState<User | null>(null);
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [loading, setLoading] = React.useState(true);

  const loadProfile = React.useCallback(async (uid: string) => {
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", uid)
      .maybeSingle();
    if (error) {
      console.error("[auth] profile load error", error);
      return;
    }
    setProfile(data as Profile | null);
  }, []);

  React.useEffect(() => {
    let mounted = true;
    const readyFallback = window.setTimeout(() => {
      if (mounted) setLoading(false);
    }, AUTH_READY_TIMEOUT_MS);

    const finishLoading = () => {
      if (!mounted) return;
      window.clearTimeout(readyFallback);
      setLoading(false);
    };

    // 1. Subscribe FIRST (per Supabase auth best practices)
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!mounted) return;
      setSession(newSession);
      setUser(newSession?.user ?? null);
      if (newSession?.user) {
        // Defer profile fetch to avoid deadlocks inside the auth callback
        setTimeout(() => {
          if (mounted) void loadProfile(newSession.user.id).finally(finishLoading);
        }, 0);
      } else {
        setProfile(null);
        finishLoading();
      }
    });

    // 2. Then check existing session
    void supabase.auth.getSession().then(({ data: { session: initial } }) => {
      if (!mounted) return;
      setSession(initial);
      setUser(initial?.user ?? null);
      if (initial?.user) {
        void loadProfile(initial.user.id).finally(finishLoading);
      } else {
        finishLoading();
      }
    }).catch((error) => {
      console.error("[auth] session load error", error);
      if (!mounted) return;
      setSession(null);
      setUser(null);
      setProfile(null);
      finishLoading();
    });

    return () => {
      mounted = false;
      window.clearTimeout(readyFallback);
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      session,
      user,
      profile,
      loading,
      signInWithPassword: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error: error?.message ?? null };
      },
      signUpWithPassword: async (email, password, name) => {
        const redirectTo =
          typeof window !== "undefined" ? `${window.location.origin}/` : undefined;
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: redirectTo,
            data: name ? { name } : undefined,
          },
        });
        return {
          error: error?.message ?? null,
          needsConfirmation: !!data.user && !data.session,
        };
      },
      signInWithGoogle: async () => {
        const redirectTo =
          typeof window !== "undefined" ? `${window.location.origin}/` : undefined;
        const { error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo },
        });
        return { error: error?.message ?? null };
      },
      signOut: async () => {
        await supabase.auth.signOut();
      },
      refreshProfile: async () => {
        if (user) await loadProfile(user.id);
      },
    }),
    [session, user, profile, loading, loadProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
