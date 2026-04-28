import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Target,
  ChevronDown,
  ChevronRight,
  Check,
  CircleDashed,
  HelpCircle,
  Sparkles,
} from "lucide-react";
import { getActiveTaskForConversation } from "@/lib/context.functions";
import { cn } from "@/lib/utils";

/**
 * Slim, ambient banner above the chat that surfaces the conversation's
 * active task. Collapsed by default; click to expand for full structure.
 *
 * Renders nothing when there's no active task — keeps the chat header clean.
 */
export function ActiveTaskBanner({ conversationId }: { conversationId: string }) {
  const [expanded, setExpanded] = useState(false);
  const { data: task } = useQuery({
    queryKey: ["active-task", conversationId],
    queryFn: () => getActiveTaskForConversation({ data: { conversation_id: conversationId } }),
    enabled: Boolean(conversationId),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  if (!task) return null;

  const completed = task.completedSteps.length;
  const next = task.nextActions.length;
  const total = completed + next + (task.currentStep ? 1 : 0);
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const headline = task.goal || task.title || "Working on something";

  return (
    <div className="border-b border-border/60 bg-gradient-to-r from-primary/[0.04] via-background to-background">
      <button
        type="button"
        onClick={() => setExpanded((s) => !s)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-primary/[0.03]"
        aria-expanded={expanded}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Target className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Working on
            </span>
            {total > 0 && (
              <span className="text-[10px] tabular-nums text-muted-foreground/80">
                {completed}/{total} done
              </span>
            )}
          </div>
          <p className="truncate text-sm font-medium text-foreground">{headline}</p>
        </div>
        {total > 0 && (
          <div className="hidden w-24 sm:block">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-border/40 bg-background/40 px-4 py-3 animate-fade-in">
          {task.currentStep && (
            <Section icon={<CircleDashed className="h-3.5 w-3.5 text-primary" />} label="Right now">
              <p className="text-sm text-foreground">{task.currentStep}</p>
            </Section>
          )}

          {task.nextActions.length > 0 && (
            <Section
              icon={<ChevronRight className="h-3.5 w-3.5 text-primary" />}
              label="Coming up"
            >
              <ul className="space-y-1.5">
                {task.nextActions.map((a, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                    <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-primary/60" />
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {task.completedSteps.length > 0 && (
            <Section
              icon={<Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />}
              label={`Done (${task.completedSteps.length})`}
            >
              <ul className="space-y-1.5">
                {task.completedSteps.map((s, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-sm text-muted-foreground line-through decoration-muted-foreground/40"
                  >
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500/70" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {task.openQuestions.length > 0 && (
            <Section
              icon={<HelpCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />}
              label="Still figuring out"
            >
              <ul className="space-y-1.5">
                {task.openQuestions.map((q, i) => (
                  <li key={i} className="text-sm text-foreground/90">
                    {q}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {task.decisions.length > 0 && (
            <Section
              icon={<Sparkles className="h-3.5 w-3.5 text-primary" />}
              label="Decisions made"
            >
              <ul className="space-y-1.5">
                {task.decisions.map((d, i) => (
                  <li key={i} className="text-sm text-foreground/90">
                    {d}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="pl-5">{children}</div>
    </div>
  );
}
