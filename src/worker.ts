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

function hydrateProcessEnv(env: unknown): void {
  if (!env || typeof env !== "object") return;
  // In Cloudflare Workers, secrets/vars are bound to `env`, NOT `process.env`.
  // Copy string-valued bindings into process.env so library code that reads
  // process.env.* (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY) works correctly.
  const target = process.env as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === "string" && target[key] === undefined) {
      target[key] = value;
    }
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    hydrateProcessEnv(env);
    // Expose CF context so other handlers (callback, webhook) can call ctx.waitUntil()
    (globalThis as unknown as Record<string, unknown>).__cfContext = ctx;
    return startFetch(request, {});
  },

  async scheduled(_event: ScheduledEvent, env: unknown, ctx: ExecutionContext): Promise<void> {
    hydrateProcessEnv(env);
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
