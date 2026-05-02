import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, FolderOpen, FolderPlus, Check } from "lucide-react";
import { listProjects, createProject } from "@/lib/projects.functions";
import { setConversationProject } from "@/lib/conversations.functions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { useState } from "react";

/**
 * Compact pill above the chat that tells the user *where* they are:
 *   "📁 In Job search" → click to change/move
 *   "Not in a space"   → click to add to / create one
 *
 * Helps users understand context scope (passive memory + future RAG) for the
 * current chat without digging into the side panel.
 */
export function ChatContextHeader({
  conversationId,
  projectId,
  isEmpty,
}: {
  conversationId: string;
  projectId: string | null;
  isEmpty: boolean;
}) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const { data } = useQuery({
    queryKey: ["projects"],
    queryFn: () => listProjects({ data: undefined as never }),
  });
  const projects = data?.projects ?? [];
  const current = projects.find((p) => p.id === projectId) ?? null;

  const moveMut = useMutation({
    mutationFn: (next: string | null) =>
      setConversationProject({ data: { id: conversationId, project_id: next } }),
    onSuccess: (_, next) => {
      qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success(next ? "Moved to space." : "Removed from space.");
    },
    onError: () => toast.error("Couldn't move this chat."),
  });

  const createMut = useMutation({
    mutationFn: (name: string) => createProject({ data: { name } }),
    onSuccess: async ({ project }) => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      moveMut.mutate(project.id);
      setCreating(false);
      setNewName("");
    },
    onError: () => toast.error("Couldn't create space."),
  });

  return (
    <div className="flex items-center justify-center gap-2 px-4 pt-3 pb-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="group inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/80 px-3 py-1 text-[11px] text-muted-foreground transition hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
            aria-label="Change space for this chat"
          >
            {current ? (
              <>
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: current.color }}
                />
                <span className="font-medium text-foreground">{current.name}</span>
                <span className="opacity-60">· chat in this space</span>
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3 text-primary/70" />
                <span>
                  Not in a space ·{" "}
                  <span className="font-medium text-primary group-hover:underline">
                    add to one
                  </span>
                </span>
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-64">
          <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Move this chat to…
          </DropdownMenuLabel>

          {projects.length === 0 && !creating && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No spaces yet. Create one to group related chats and let Ekonomical
              remember context across them.
            </p>
          )}

          {projects.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onSelect={(e) => {
                e.preventDefault();
                if (p.id !== projectId) moveMut.mutate(p.id);
              }}
              className="flex items-center gap-2"
            >
              <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
              <span className="flex-1 truncate">{p.name}</span>
              {p.id === projectId && <Check className="h-3.5 w-3.5 text-primary" />}
            </DropdownMenuItem>
          ))}

          {projectId && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  moveMut.mutate(null);
                }}
                className="text-muted-foreground"
              >
                <FolderOpen className="mr-2 h-3.5 w-3.5" />
                Remove from space
              </DropdownMenuItem>
            </>
          )}

          <DropdownMenuSeparator />
          {creating ? (
            <form
              className="space-y-1.5 px-2 py-1.5"
              onClick={(e) => e.stopPropagation()}
              onSubmit={(e) => {
                e.preventDefault();
                if (newName.trim()) createMut.mutate(newName.trim());
              }}
            >
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Job search"
                maxLength={100}
                className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring/60"
              />
              <div className="flex gap-1">
                <button
                  type="submit"
                  disabled={!newName.trim() || createMut.isPending}
                  className="h-6 flex-1 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
                >
                  Create &amp; move
                </button>
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className="h-6 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-accent"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setCreating(true);
              }}
            >
              <FolderPlus className="mr-2 h-3.5 w-3.5" />
              New space…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Helper text only on empty chats so it's not noisy mid-conversation */}
      {isEmpty && current && (
        <span className="text-[11px] text-muted-foreground">
          Ekonomical remembers what you discuss here across all chats in this space.
        </span>
      )}
    </div>
  );
}
