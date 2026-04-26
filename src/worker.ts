// Custom Cloudflare Worker entry point.
// Re-exports the TanStack Start fetch handler and adds a scheduled handler
// so that Cloudflare Cron Triggers invoke the connector sync job.

import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import { runDueConnectorSyncs } from "@/lib/connectors/sync-worker";

const startFetch = createStartHandler(defaultStreamHandler);

// CF Workers execution context type (not in global types by default)
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    // Expose CF context so other handlers (callback, webhook) can call ctx.waitUntil()
    (globalThis as unknown as Record<string, unknown>).__cfContext = ctx;
    return startFetch(request, {});
  },

  async scheduled(_event: ScheduledEvent, _env: unknown, ctx: ExecutionContext): Promise<void> {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[scheduled] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — aborting sync");
      return;
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    ctx.waitUntil(runDueConnectorSyncs(supabase));
  },
};
