import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Leaf, ArrowRight, Sun, Mail, Lightbulb, ListChecks, BookOpen, MessageCircle } from "lucide-react";
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


type Suggestion = { icon: typeof Mail; label: string; prompt: string };

const SUGGESTIONS: Suggestion[] = [
  { icon: Mail, label: "Help me write an email", prompt: "Help me write a thoughtful email about…" },
  { icon: Lightbulb, label: "Brainstorm ideas with me", prompt: "Let's brainstorm ideas for…" },
  { icon: BookOpen, label: "Explain something simply", prompt: "Can you explain this in simple words: " },
  { icon: ListChecks, label: "Plan my day", prompt: "Help me plan my day around these priorities…" },
  { icon: MessageCircle, label: "Summarize a long article", prompt: "Please summarize the key points from this: " },
  { icon: Sun, label: "Just chat with me", prompt: "I'd love to just chat for a bit. Tell me something interesting." },
];

function pickThree(): Suggestion[] {
  const arr = [...SUGGESTIONS];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, 4);
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

  // Pre-create a draft conversation so the composer supports file uploads on "/".
  // The conversation is harmless if unused — it stays empty and disappears under
  // older entries.
  const [draftConvoId, setDraftConvoId] = useState<string | null>(null);
  const draftReqRef = useRef(false);
  useEffect(() => {
    if (loading || !user || draftConvoId || draftReqRef.current) return;
    draftReqRef.current = true;
    createConversation({ data: {} })
      .then(({ conversation }) => setDraftConvoId(conversation.id))
      .catch(() => {
        draftReqRef.current = false;
      });
  }, [loading, user, draftConvoId]);

  const startMut = useMutation({
    mutationFn: async ({ text, attachments }: { text: string; attachments: Attachment[] }) => {
      let id: string | null = draftConvoId;
      if (!id) {
        const { conversation } = await createConversation({ data: {} });
        id = conversation.id;
      }
      return { conversationId: id as string, text, attachments };
    },
    onSuccess: ({ conversationId, text, attachments }) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      try {
        sessionStorage.setItem(
          `cortex.pending.${conversationId}`,
          JSON.stringify({ text, attachments }),
        );
      } catch {
        /* noop */
      }
      void navigate({ to: "/c/$id", params: { id: conversationId } });
    },
    onError: () => toast.error("I ran into a problem starting the chat."),
  });

  const firstName = profile?.name ? profile.name.split(" ")[0] : null;
  const hour = new Date().getHours();
  const timeOfDay =
    hour < 5 ? "Hello" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const greeting = welcomeBack
    ? firstName
      ? `Welcome back, ${firstName}`
      : "Welcome back"
    : firstName
    ? `${timeOfDay}, ${firstName}`
    : timeOfDay;

  return (
    <div className="relative flex h-full flex-col">
      {/* Soft warm halo behind the greeting — adds atmosphere */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-[420px] bg-[radial-gradient(ellipse_at_top,oklch(0.88_0.04_130/0.55),transparent_70%)]"
      />
      <div className="relative flex-1 overflow-y-auto">
        <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-4 py-12 text-center">
          <div className="animate-fade-rise mb-7 flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-br from-[oklch(0.62_0.08_145)] to-[oklch(0.50_0.07_150)] text-primary-foreground shadow-[0_10px_30px_-10px_oklch(0.50_0.07_150/0.5)]">
            <Leaf className="h-8 w-8" />
          </div>
          <h1 className="font-display animate-fade-rise text-4xl font-semibold sm:text-5xl [animation-delay:60ms]">
            {greeting}
          </h1>

          {/* Differentiator tagline — what makes Cortex different from ChatGPT & co. */}
          <p className="animate-fade-rise mt-5 max-w-xl text-balance text-base leading-relaxed text-muted-foreground sm:text-[17px] [animation-delay:120ms]">
            The AI that{" "}
            <span className="font-medium text-foreground">remembers everything</span>{" "}
            and{" "}
            <span className="font-medium text-foreground">understands your work</span>.
          </p>

          {lastConvo && (
            <button
              onClick={() =>
                void navigate({ to: "/c/$id", params: { id: lastConvo.id } })
              }
              className="animate-fade-rise group mt-7 inline-flex items-center gap-2 rounded-full border border-border bg-card/70 px-5 py-2.5 text-sm text-muted-foreground shadow-sm backdrop-blur transition-all duration-200 hover:border-primary/40 hover:bg-card hover:text-foreground hover:shadow-md [animation-delay:180ms]"
            >
              Pick up where we left off
              {lastConvo.title ? (
                <span className="font-medium text-foreground">— {lastConvo.title}</span>
              ) : null}
              <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
            </button>
          )}

          <div className="mt-12 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
            {suggestions.map((s, i) => {
              const Icon = s.icon;
              return (
                <button
                  key={s.label}
                  onClick={() => startMut.mutate({ text: s.prompt, attachments: [] })}
                  disabled={startMut.isPending}
                  style={{ animationDelay: `${280 + i * 70}ms` }}
                  className="animate-fade-rise group flex items-center gap-3 rounded-2xl border border-border/70 bg-card/80 px-4 py-4 text-left text-sm text-foreground shadow-sm backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-card hover:shadow-md disabled:opacity-50"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/60 text-primary transition-colors duration-200 group-hover:bg-accent">
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <span className="font-medium">{s.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <RateLimitBanner />
      <ChatComposer
        conversationId={draftConvoId ?? undefined}
        onSend={(text, attachments) => startMut.mutate({ text, attachments })}
        isStreaming={startMut.isPending}
        draftKey="cortex.draft.new"
        autoFocus
        placeholder="Type a message, or just say hello…"
      />
    </div>
  );
}
