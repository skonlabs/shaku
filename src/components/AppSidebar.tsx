import { Link, useLocation } from "@tanstack/react-router";
import { MessageSquare, FolderKanban, Database, Plug, Settings, User, Brain } from "lucide-react";
import { usePanel, type PanelId } from "@/lib/ui-context";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const items: { id: PanelId; icon: typeof MessageSquare; label: string }[] = [
  { id: "chats", icon: MessageSquare, label: "Chats" },
  { id: "projects", icon: FolderKanban, label: "Projects" },
  { id: "datasources", icon: Database, label: "Data sources" },
  { id: "connectors", icon: Plug, label: "Connectors" },
  { id: "memory", icon: Brain, label: "Memory & Persona" },
];

export function AppSidebar() {
  const { active, toggle, setActive } = usePanel();
  const location = useLocation();

  return (
    <TooltipProvider delayDuration={300}>
      <aside className="z-30 flex h-svh w-14 shrink-0 flex-col items-center justify-between border-r border-sidebar-border bg-sidebar py-3">
        {/* Logo / new chat */}
        <div className="flex flex-col items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to="/"
                onClick={() => setActive(null)}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition hover:opacity-90",
                  location.pathname === "/" && "ring-2 ring-ring/40",
                )}
                aria-label="New chat"
              >
                <span className="text-sm font-bold">C</span>
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">New chat</TooltipContent>
          </Tooltip>

          <div className="my-1 h-px w-6 bg-sidebar-border" />

          {items.map((it) => {
            const Icon = it.icon;
            const isActive = active === it.id;
            return (
              <Tooltip key={it.id}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => toggle(it.id)}
                    aria-label={it.label}
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-lg text-sidebar-foreground/70 transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                      isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
                    )}
                  >
                    <Icon className="h-[18px] w-[18px]" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{it.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        {/* Bottom: settings + account */}
        <div className="flex flex-col items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => toggle("settings")}
                aria-label="Settings"
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-lg text-sidebar-foreground/70 transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  active === "settings" && "bg-sidebar-accent text-sidebar-accent-foreground",
                )}
              >
                <Settings className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Settings</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => toggle("account")}
                aria-label="Account"
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-lg text-sidebar-foreground/70 transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  active === "account" && "bg-sidebar-accent text-sidebar-accent-foreground",
                )}
              >
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
