import { Link, useLocation } from "@tanstack/react-router";
import {
  MessageSquare,
  FolderHeart,
  BookOpen,
  Plug,
  Settings,
  User,
  Brain,
  Plus,
  Leaf,
  Receipt,
} from "lucide-react";
import { usePanel, type PanelId } from "@/lib/ui-context";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// Friendly labels — keep the original term in parentheses so power users
// can still find Memory, Persona, and other features.
//
// Note: "Active task" and "Context debugger" used to live here. They were
// retired because per-message context belongs inline with each message
// (see BehindAnswerChip in MessageList) and the active task now appears
// as an ambient banner above the chat (see ActiveTaskBanner).
// Each item is either a panel (toggles the slide-out drawer) or a route link.
// "AI Profile" used to be a panel called "What I remember" — it's now a route
// so memories, persona, and identity all live on one canonical page.
type SidebarItem =
  | { kind: "panel"; id: PanelId; icon: typeof MessageSquare; label: string }
  | { kind: "link"; to: "/my-profile"; icon: typeof MessageSquare; label: string; matchPath: string };

const items: SidebarItem[] = [
  { kind: "panel", id: "chats", icon: MessageSquare, label: "My chats" },
  { kind: "panel", id: "projects", icon: FolderHeart, label: "Spaces" },
  { kind: "panel", id: "datasources", icon: BookOpen, label: "My library (data sources)" },
  { kind: "panel", id: "connectors", icon: Plug, label: "Connections" },
  { kind: "link", to: "/my-profile", icon: Brain, label: "AI Profile (memories & persona)", matchPath: "/my-profile" },
];

export function AppSidebar() {
  const { active, toggle, setActive } = usePanel();
  const location = useLocation();

  return (
    <TooltipProvider delayDuration={250}>
      <aside className="z-30 flex h-svh w-[56px] shrink-0 flex-col items-center justify-between border-r border-sidebar-border bg-sidebar py-4 md:w-[68px] md:py-5">
        <div className="flex flex-col items-center gap-1.5">
          {/* Brand — soft sage gradient with a leaf, warm and welcoming */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to="/app"
                onClick={() => setActive(null)}
                className={cn(
                  "group/brand flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-[oklch(0.62_0.08_145)] to-[oklch(0.50_0.07_150)] text-primary-foreground shadow-[0_6px_18px_-6px_oklch(0.50_0.07_150/0.55)] transition-all duration-300 hover:scale-[1.04] hover:shadow-[0_8px_22px_-6px_oklch(0.50_0.07_150/0.65)]",
                   location.pathname === "/app" &&
                    "ring-2 ring-primary/30 ring-offset-2 ring-offset-sidebar",
                )}
                aria-label="Start a new chat"
              >
                <Leaf className="h-[19px] w-[19px] transition-transform duration-500 group-hover/brand:rotate-[-8deg]" />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">Home</TooltipContent>
          </Tooltip>

          {/* Quick new-chat */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to="/app"
                onClick={() => setActive(null)}
                aria-label="Start a new chat"
                className="mt-1 flex h-11 w-11 items-center justify-center rounded-2xl border border-dashed border-sidebar-border/80 text-sidebar-foreground/60 transition-all duration-200 hover:border-primary/50 hover:bg-sidebar-accent hover:text-primary"
              >
                <Plus className="h-[19px] w-[19px]" />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">Start a new chat</TooltipContent>
          </Tooltip>

          <div className="my-2 h-px w-7 bg-sidebar-border" />

          {items.map((it) => {
            const Icon = it.icon;
            const isActive =
              it.kind === "panel"
                ? active === it.id
                : location.pathname === it.matchPath;
            const className = cn(
              "group/btn relative flex h-11 w-11 items-center justify-center rounded-2xl text-sidebar-foreground/65 transition-all duration-200",
              "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              isActive && "bg-sidebar-accent text-primary",
            );
            const indicator = isActive ? (
              <span className="absolute -left-[14px] top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
            ) : null;
            const iconEl = (
              <Icon className="h-[19px] w-[19px] transition-transform duration-200 group-hover/btn:scale-110" />
            );
            return (
              <Tooltip key={it.kind === "panel" ? it.id : it.to}>
                <TooltipTrigger asChild>
                  {it.kind === "panel" ? (
                    <button
                      onClick={() => toggle(it.id)}
                      aria-label={it.label}
                      aria-pressed={isActive}
                      className={className}
                    >
                      {indicator}
                      {iconEl}
                    </button>
                  ) : (
                    <Link
                      to={it.to}
                      onClick={() => setActive(null)}
                      aria-label={it.label}
                      aria-current={isActive ? "page" : undefined}
                      className={className}
                    >
                      {indicator}
                      {iconEl}
                    </Link>
                  )}
                </TooltipTrigger>
                <TooltipContent side="right">{it.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        <div className="flex flex-col items-center gap-1.5">
          {/* AI Profile lives in the top item list now (Sparkles icon). */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to="/billing"
                aria-label="Billing & credits"
                className={cn(
                  "relative flex h-11 w-11 items-center justify-center rounded-2xl text-sidebar-foreground/65 transition-all duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  location.pathname === "/billing" && "bg-sidebar-accent text-primary",
                )}
              >
                {location.pathname === "/billing" && (
                  <span className="absolute -left-[14px] top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
                )}
                <Receipt className="h-[19px] w-[19px]" />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">Billing &amp; credits</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => toggle("settings")}
                aria-label="Settings"
                aria-pressed={active === "settings"}
                className={cn(
                  "group/btn relative flex h-11 w-11 items-center justify-center rounded-2xl text-sidebar-foreground/65 transition-all duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  active === "settings" && "bg-sidebar-accent text-primary",
                )}
              >
                {active === "settings" && (
                  <span className="absolute -left-[14px] top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
                )}
                <Settings className="h-[19px] w-[19px] transition-transform duration-300 group-hover/btn:rotate-45" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Settings &amp; token usage</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => toggle("account")}
                aria-label="My account"
                aria-pressed={active === "account"}
                className={cn(
                  "relative flex h-11 w-11 items-center justify-center rounded-2xl text-sidebar-foreground/65 transition-all duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  active === "account" && "bg-sidebar-accent text-primary",
                )}
              >
                {active === "account" && (
                  <span className="absolute -left-[14px] top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
                )}
                <User className="h-[19px] w-[19px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">My account</TooltipContent>
          </Tooltip>
        </div>
      </aside>
    </TooltipProvider>
  );
}
