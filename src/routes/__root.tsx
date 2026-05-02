import {
  Outlet,
  Link,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/lib/auth-context";
import { ThemeProvider } from "@/lib/theme-context";
import { KbHelpProvider, PanelProvider } from "@/lib/ui-context";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { KeyboardShortcutsDialog } from "@/components/KeyboardShortcutsDialog";
import { SiteGate } from "@/components/SiteGate";

import appCss from "../styles.css?url";

interface RouterCtx {
  queryClient: QueryClient;
}

function NotFoundComponent() {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,oklch(0.88_0.04_130/0.55),transparent_65%)]"
      />
      <div className="relative max-w-md text-center">
        <p className="font-display text-7xl font-semibold text-foreground/90">404</p>
        <h2 className="font-display mt-4 text-2xl font-semibold text-foreground">
          Hmm, we couldn't find that page
        </h2>
        <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
          It might have been moved, or maybe the link was a bit off. Let's get you back home.
        </p>
        <div className="mt-7">
          <Link
            to="/"
            className="inline-flex h-11 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground shadow-[0_8px_22px_-8px_oklch(0.50_0.07_150/0.6)] transition-all hover:opacity-90"
          >
            Take me home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterCtx>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Ekonomical — Your personal AI" },
      {
        name: "description",
        content:
          "Ekonomical is your personal AI assistant that remembers, learns, and helps you get things done.",
      },
      { property: "og:title", content: "Ekonomical — Your personal AI" },
      {
        property: "og:description",
        content:
          "Ekonomical is your personal AI assistant that remembers, learns, and helps you get things done.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var t = localStorage.getItem('ekonomical.theme') || 'system';
                var d = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
                if (d) document.documentElement.classList.add('dark');
              } catch(e) {}
            `,
          }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <SiteGate>
          <AuthProvider>
            <PanelProvider>
              <KbHelpProvider>
                <KeyboardShortcuts />
                <KeyboardShortcutsDialog />
                <Outlet />
                <Toaster richColors closeButton position="top-right" />
              </KbHelpProvider>
            </PanelProvider>
          </AuthProvider>
        </SiteGate>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
