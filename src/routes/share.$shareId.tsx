import { createFileRoute, notFound, Link } from "@tanstack/react-router";
import { getSharedResponse } from "@/lib/share.functions";
import { MessageContent } from "@/components/MessageContent";

export const Route = createFileRoute("/share/$shareId")({
  loader: async ({ params }) => {
    try {
      const result = await getSharedResponse({ data: { share_id: params.shareId } });
      return result;
    } catch {
      throw notFound();
    }
  },
  component: SharedResponsePage,
  notFoundComponent: () => (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center">
      <p className="text-lg font-semibold">Shared response not found</p>
      <p className="text-sm text-muted-foreground">This link may have expired or been removed.</p>
      <Link to="/" className="text-sm text-primary underline underline-offset-2">Go to Cortex</Link>
    </div>
  ),
});

function SharedResponsePage() {
  const { response } = Route.useLoaderData();
  const createdAt = new Date(response.created_at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-sidebar/60 backdrop-blur-sm">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-sm font-semibold tracking-tight text-foreground hover:text-primary">
            Cortex
          </Link>
          <span className="text-xs text-muted-foreground">{createdAt}</span>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-6 px-4 py-8">
        {response.user_message_content && (
          <div className="rounded-xl bg-accent/60 px-4 py-3">
            <p className="text-sm text-foreground">{response.user_message_content}</p>
          </div>
        )}

        <div className="rounded-xl border border-border bg-card px-5 py-4">
          <MessageContent content={response.assistant_message_content as string} />
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Shared via{" "}
          <Link to="/" className="text-primary underline underline-offset-2">
            Cortex
          </Link>
          {" · "}
          {response.view_count ?? 0} view{response.view_count !== 1 ? "s" : ""}
        </p>
      </main>
    </div>
  );
}
