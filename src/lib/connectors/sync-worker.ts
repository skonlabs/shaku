// Generic sync worker — dispatches to service-specific sync functions.
// In CF Workers, scheduled syncs run via Cloudflare Cron Triggers.
// Ad-hoc syncs (after connect, on-demand) run via waitUntil().
//
// Polling intervals:
//   Google Drive: 5 min
//   Slack: 5 min (+ real-time webhooks)
//   Dropbox/OneDrive: 30 min
//   Gmail/Calendar/Jira/GitHub: 15 min
//   Notion/Confluence: 30 min

import type { SupabaseClient } from "@supabase/supabase-js";

export const POLLING_INTERVALS: Record<string, number> = {
  google_drive: 5 * 60 * 1000,
  slack: 5 * 60 * 1000,
  dropbox: 30 * 60 * 1000,
  onedrive: 30 * 60 * 1000,
  gmail: 15 * 60 * 1000,
  google_calendar: 15 * 60 * 1000,
  jira: 15 * 60 * 1000,
  github: 15 * 60 * 1000,
  notion: 30 * 60 * 1000,
  confluence: 30 * 60 * 1000,
  teams: 15 * 60 * 1000,
};

export async function syncConnector(
  connectorId: string,
  userId: string,
  service: string,
  supabase: SupabaseClient,
): Promise<void> {
  // Mark as syncing
  await supabase
    .from("connectors")
    .update({ status: "syncing" })
    .eq("id", connectorId);

  try {
    let itemsProcessed = 0;
    let newCursor: string | null = null;

    if (service === "google_drive") {
      const { syncGoogleDrive } = await import("./google-drive");
      const result = await syncGoogleDrive(connectorId, userId, supabase);
      itemsProcessed = result.itemsProcessed;
      newCursor = result.newCursor;
    } else if (service === "slack") {
      const { syncSlack } = await import("./slack");
      const result = await syncSlack(connectorId, userId, supabase);
      itemsProcessed = result.itemsProcessed;
      newCursor = result.newCursor;
    } else {
      // Service not yet implemented in Phase 1
      await supabase
        .from("connectors")
        .update({ status: "connected", error_message: "Sync not yet implemented" })
        .eq("id", connectorId);
      return;
    }

    // Get current items_indexed count
    const { data: current } = await supabase
      .from("connectors")
      .select("items_indexed")
      .eq("id", connectorId)
      .single();

    await supabase.from("connectors").update({
      status: "connected",
      last_synced_at: new Date().toISOString(),
      items_indexed: (current?.items_indexed ?? 0) + itemsProcessed,
      sync_cursor: newCursor,
      error_message: null,
    }).eq("id", connectorId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Sync failed";
    await supabase.from("connectors").update({
      status: "error",
      error_message: msg,
    }).eq("id", connectorId);
    throw e;
  }
}

// Check which connectors are due for a sync and trigger them.
// Called by Cloudflare Cron Trigger (configure in wrangler.jsonc):
//   [triggers] crons = ["*/5 * * * *"]
export async function runDueConnectorSyncs(supabase: SupabaseClient): Promise<void> {
  const { data: connectors } = await supabase
    .from("connectors")
    .select("id, user_id, service, status, last_synced_at")
    .in("status", ["connected", "error"]);

  if (!connectors?.length) return;

  const now = Date.now();
  const due = connectors.filter((c) => {
    const interval = POLLING_INTERVALS[c.service] ?? 30 * 60 * 1000;
    const lastSync = c.last_synced_at ? new Date(c.last_synced_at).getTime() : 0;
    return now - lastSync >= interval;
  });

  // Run syncs sequentially to avoid overloading external APIs
  for (const connector of due) {
    try {
      await syncConnector(connector.id, connector.user_id, connector.service, supabase);
    } catch {
      // Individual sync failures are already logged in the DB; continue
    }
  }
}

// Hard delete chunks for a disconnected connector (within 24 hours per spec)
export async function cleanupDisconnectedConnector(
  connectorId: string,
  userId: string,
  supabase: SupabaseClient,
): Promise<void> {
  await supabase
    .from("chunks")
    .delete()
    .eq("user_id", userId)
    .eq("source_type", "connector")
    .eq("source_id", connectorId);

  await supabase
    .from("connectors")
    .update({ status: "disconnected", items_indexed: 0 })
    .eq("id", connectorId);
}
