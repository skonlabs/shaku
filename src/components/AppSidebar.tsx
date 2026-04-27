import { Link, useLocation } from "@tanstack/react-router";
import {
  MessageSquare,
  FolderKanban,
  Database,
  Plug,
  Settings,
  User,
  Brain,
  Plus,
  Bug,
  ListTodo,
} from "lucide-react";
import { usePanel, type PanelId } from "@/lib/ui-context";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const items: { id: PanelId; icon: typeof MessageSquare; label: string }[] = [
  { id: "chats", icon: MessageSquare, label: "Chats" },
  { id: "projects", icon: FolderKanban, label: "Projects" },
  { id: "datasources", icon: Database, label: "Data sources" },
  { id: "connectors", icon: Plug, label: "Connectors" },
  { id: "memory", icon: Brain, label: "Memory & Persona" },
  { id: "task", icon: ListTodo, label: "Active Task" },
  { id: "context", icon: Bug, label: "Context Debugger" },
];

export function AppSidebar() {
  const { active, toggle, setActive } = usePanel();
  const location = useLocation();

  return (
    <TooltipProvider delayDuration={250}>
      <aside className="z-30 flex h-svh w-16 shrink-0 flex-col items-center justify-between border-r border-sidebar-border bg-sidebar py-4">
        <div className="flex flex-col items-center gap-1.5">
          {/* Brand */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to="/"
                onClick={() => setActive(null)}
                className={cn(
                  "group/brand flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-[oklch(0.55_0.18_255)] text-primary-foreground shadow-[0_4px_12px_-4px_oklch(0.6_0.16_245/0.5)] transition-all duration-200 hover:shadow-[0_6px_18px_-4px_oklch(0.6_0.16_245/0.6)]",
                  location.pathname === "/" &&
                    "ring-2 ring-ring/30 ring-offset-2 ring-offset-sidebar",
                )}
                aria-label="New chat"
              >
                <span className="text-[15px] font-bold tracking-tight">C</span>
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">New chat</TooltipContent>
          </Tooltip>

          {/* Quick new-chat */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to="/"
                onClick={() => setActive(null)}
                aria-label="New chat"
                className="mt-1 flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-sidebar-border text-sidebar-foreground/60 transition-all duration-200 hover:border-primary/50 hover:bg-sidebar-accent hover:text-primary"
              >
                <Plus className="h-[18px] w-[18px]" />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">Start new chat</TooltipContent>
          </Tooltip>

          <div className="my-1.5 h-px w-7 bg-sidebar-border" />

          {items.map((it) => {
            const Icon = it.icon;
            const isActive = active === it.id;
            return (
              <Tooltip key={it.id}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => toggle(it.id)}
                    aria-label={it.label}
                    aria-pressed={isActive}
                    className={cn(
                      "group/btn relative flex h-10 w-10 items-center justify-center rounded-xl text-sidebar-foreground/65 transition-all duration-200",
                      "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                      isActive && "bg-sidebar-accent text-primary",
                    )}
                  >
                    {isActive && (
                      <span className="absolute -left-[14px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
                    )}
                    <Icon className="h-[18px] w-[18px] transition-transform duration-200 group-hover/btn:scale-110" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{it.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => toggle("settings")}
                aria-label="Settings"
                aria-pressed={active === "settings"}
                className={cn(
                  "group/btn relative flex h-10 w-10 items-center justify-center rounded-xl text-sidebar-foreground/65 transition-all duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  active === "settings" && "bg-sidebar-accent text-primary",
                )}
              >
                {active === "settings" && (
                  <span className="absolute -left-[14px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
                )}
                <Settings className="h-[18px] w-[18px] transition-transform duration-200 group-hover/btn:rotate-45" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Settings</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => toggle("account")}
                aria-label="Account"
                aria-pressed={active === "account"}
                className={cn(
                  "relative flex h-10 w-10 items-center justify-center rounded-xl text-sidebar-foreground/65 transition-all duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  active === "account" && "bg-sidebar-accent text-primary",
                )}
              >
                {active === "account" && (
                  <span className="absolute -left-[14px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
                )}
                <User className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Account</TooltipContent>
          </Tooltip>
        </div>
      </aside>
    </TooltipProvider>
  );
}
