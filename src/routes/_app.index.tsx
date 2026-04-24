import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { ChatComposer } from "@/components/ChatComposer";
import { createConversation } from "@/lib/conversations.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/")({
  component: NewChatPage,
});

function NewChatPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const startMut = useMutation({
    mutationFn: async (text: string) => {
      const { conversation } = await createConversation({ data: {} });
      return { conversation, text };
    },
    onSuccess: ({ conversation, text }) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      // Stash the first message so the chat page sends it on mount
      try {
        sessionStorage.setItem(`cortex.pending.${conversation.id}`, text);
      } catch {
        /* noop */
      }
      void navigate({ to: "/c/$id", params: { id: conversation.id } });
    },
    onError: () => toast.error("I ran into a problem starting the chat."),
  });

  const greeting = profile?.name ? `Hello, ${profile.name.split(" ")[0]}` : "Hello";

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-4 py-10 text-center">
          <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Sparkles className="h-6 w-6" />
          </div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{greeting}</h1>
          <p className="mt-2 max-w-md text-muted-foreground">
            What can I help you with today?
          </p>
        </div>
      </div>
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
