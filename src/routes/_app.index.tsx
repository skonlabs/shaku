import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, ArrowRight } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { ChatComposer, type Attachment } from "@/components/ChatComposer";
import { RateLimitBanner } from "@/components/RateLimitBanner";
import {
  createConversation,
  listConversations,
  recordSeen,
} from "@/lib/conversations.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/")({
  component: NewChatPage,
});

export const Route = createFileRoute("/_app/")({
  component: NewChatPage,
});

const SUGGESTIONS = [
  "Help me draft a thoughtful reply to this email…",
  "Brainstorm 5 angles for a blog post about…",
  "Explain a tricky concept in simple terms",
  "Plan my day around these 4 priorities…",
  "Summarize the key ideas from a long article",
  "Write a short, friendly intro message",
];



function pickThree(): string[] {
  const arr = [...SUGGESTIONS];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, 3);
}

function NewChatPage() {
  const { profile, user, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const suggestions = useMemo(pickThree, []);
  const [welcomeBack, setWelcomeBack] = useState(false);

  // Welcome-back: derive from profile.last_seen_at (DB source of truth),
  // then stamp the new last_seen_at server-side.
  useEffect(() => {
    if (loading || !user || !profile) return;
    if (profile.last_seen_at) {
      const hours = (Date.now() - new Date(profile.last_seen_at).getTime()) / 36e5;
      if (hours > 24) setWelcomeBack(true);
    }
    void recordSeen({ data: undefined as never });
  }, [loading, user, profile]);

  // Last conversation (offered, not auto-redirected, to respect explicit "/" navigation)
  const { data: convoList } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => listConversations({ data: undefined }),
    enabled: !loading && !!user,
    staleTime: 30_000,
  });
  const lastConvo = welcomeBack ? convoList?.conversations?.[0] : undefined;

  const startMut = useMutation({
    mutationFn: async (text: string) => {
      const { conversation } = await createConversation({ data: {} });
      return { conversation, text };
    },
    onSuccess: ({ conversation, text }) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      try {
        sessionStorage.setItem(`cortex.pending.${conversation.id}`, text);
      } catch {
        /* noop */
      }
      void navigate({ to: "/c/$id", params: { id: conversation.id } });
    },
    onError: () => toast.error("I ran into a problem starting the chat."),
  });

  const firstName = profile?.name ? profile.name.split(" ")[0] : null;
  const greeting = welcomeBack
    ? firstName
      ? `Welcome back, ${firstName}`
      : "Welcome back"
    : firstName
    ? `Hello, ${firstName}`
    : "Hello";

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-4 py-12 text-center">
          <div className="animate-fade-rise mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5 text-primary ring-1 ring-primary/10">
            <Sparkles className="h-7 w-7" />
          </div>
          <h1 className="animate-fade-rise text-4xl font-semibold tracking-tight sm:text-5xl [animation-delay:60ms]">
            {greeting}
          </h1>
          <p className="animate-fade-rise mt-3 max-w-md text-base text-muted-foreground [animation-delay:120ms]">
            What can I help you with today?
          </p>

          {lastConvo && (
            <button
              onClick={() =>
                void navigate({ to: "/c/$id", params: { id: lastConvo.id } })
              }
              className="animate-fade-rise group mt-6 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-4 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur transition-all duration-200 hover:border-primary/40 hover:bg-card hover:text-foreground hover:shadow-md [animation-delay:180ms]"
            >
              Continue last chat
              {lastConvo.title ? (
                <span className="font-medium text-foreground">— {lastConvo.title}</span>
              ) : null}
              <ArrowRight className="h-3 w-3 transition-transform duration-200 group-hover:translate-x-0.5" />
            </button>
          )}

          <div className="mt-10 grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-3">
            {suggestions.map((s, i) => (
              <button
                key={s}
                onClick={() => startMut.mutate(s)}
                disabled={startMut.isPending}
                style={{ animationDelay: `${280 + i * 60}ms` }}
                className="animate-fade-rise group rounded-xl border border-border/70 bg-card/80 px-4 py-3.5 text-left text-sm text-muted-foreground shadow-sm backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-card hover:text-foreground hover:shadow-md disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
      <RateLimitBanner />
      <ChatComposer
        onSend={(text) => startMut.mutate(text)}
        isStreaming={startMut.isPending}
        draftKey="cortex.draft.new"
        autoFocus
        placeholder="Ask me anything…"
      />
    </div>
  );
}
