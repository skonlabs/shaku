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
  google_docs: 15 * 60 * 1000,
  google_sheets: 15 * 60 * 1000,
  google_slides: 15 * 60 * 1000,
  gmail: 15 * 60 * 1000,
  google_calendar: 15 * 60 * 1000,
  onedrive: 30 * 60 * 1000,
  microsoft_word: 30 * 60 * 1000,
  microsoft_excel: 30 * 60 * 1000,
  microsoft_powerpoint: 30 * 60 * 1000,
  microsoft_onenote: 30 * 60 * 1000,
  microsoft_outlook: 15 * 60 * 1000,
  microsoft_teams: 15 * 60 * 1000,
  slack: 5 * 60 * 1000,
};

export async function syncConnector(
  connectorId: string,
  userId: string,
  service: string,
  supabase: SupabaseClient,
): Promise<void> {
  await supabase
    .from("connectors")
    .update({ status: "syncing" })
    .eq("id", connectorId);

  try {
    let itemsProcessed = 0;
    let newCursor: string | null = null;

    if (service === "google_drive") {
      const { syncGoogleDrive } = await import("./google-drive");
      const r = await syncGoogleDrive(connectorId, userId, supabase);
      itemsProcessed = r.itemsProcessed; newCursor = r.newCursor;
    } else if (service === "google_docs") {
      const { syncGoogleDocs } = await import("./google");
      const r = await syncGoogleDocs(connectorId, userId, supabase);
      itemsProcessed = r.itemsProcessed; newCursor = r.newCursor;
    } else if (service === "google_sheets") {
      const { syncGoogleSheets } = await import("./google");
      const r = await syncGoogleSheets(connectorId, userId, supabase);
      itemsProcessed = r.itemsProcessed; newCursor = r.newCursor;
    } else if (service === "google_slides") {
      const { syncGoogleSlides } = await import("./google");
      const r = await syncGoogleSlides(connectorId, userId, supabase);
      itemsProcessed = r.itemsProcessed; newCursor = r.newCursor;
    } else if (service === "gmail") {
      const { syncGmail } = await import("./google");
      const r = await syncGmail(connectorId, userId, supabase);
      itemsProcessed = r.itemsProcessed; newCursor = r.newCursor;
    } else if (service === "google_calendar") {
      const { syncGoogleCalendar } = await import("./google");
      const r = await syncGoogleCalendar(connectorId, userId, supabase);
      itemsProcessed = r.itemsProcessed; newCursor = r.newCursor;
    } else if (
      service === "onedrive" ||
      service === "microsoft_word" ||
      service === "microsoft_excel" ||
      service === "microsoft_powerpoint"
    ) {
      const { syncMicrosoftDrive } = await import("./microsoft");
      const sourceName =
        service === "onedrive" ? "OneDrive" :
        service === "microsoft_word" ? "Microsoft Word" :
        service === "microsoft_excel" ? "Microsoft Excel" :
        "Microsoft PowerPoint";
      const r = await syncMicrosoftDrive(connectorId, userId, service, supabase, sourceName);
      itemsProcessed = r.itemsProcessed; newCursor = r.newCursor;
    } else if (service === "microsoft_onenote") {
      const { syncMicrosoftOneNote } = await import("./microsoft");
      const r = await syncMicrosoftOneNote(connectorId, userId, supabase);
      itemsProcessed = r.itemsProcessed; newCursor = r.newCursor;
    } else if (service === "microsoft_outlook") {
      const { syncMicrosoftOutlook } = await import("./microsoft");
      const r = await syncMicrosoftOutlook(connectorId, userId, supabase);
      itemsProcessed = r.itemsProcessed; newCursor = r.newCursor;
    } else if (service === "microsoft_teams") {
      const { syncMicrosoftTeams } = await import("./microsoft");
      const r = await syncMicrosoftTeams(connectorId, userId, supabase);
      itemsProcessed = r.itemsProcessed; newCursor = r.newCursor;
    } else if (service === "slack") {
      const { syncSlack } = await import("./slack");
      const r = await syncSlack(connectorId, userId, supabase);
      itemsProcessed = r.itemsProcessed; newCursor = r.newCursor;
    } else {
      await supabase
        .from("connectors")
        .update({ status: "error", error_message: "Sync not implemented for this service" })
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
  const startTime = now;
  const due = connectors.filter((c) => {
    const interval = POLLING_INTERVALS[c.service] ?? 30 * 60 * 1000;
    const lastSync = c.last_synced_at ? new Date(c.last_synced_at).getTime() : 0;
    return now - lastSync >= interval;
  });

  // Run syncs sequentially to avoid overloading external APIs.
  // Stop before 25 s to stay well within CF Workers' 30 s CPU limit.
  for (const connector of due) {
    if (Date.now() - startTime >= 25_000) {
      console.warn("[runDueConnectorSyncs] Time budget reached; deferring remaining connectors to next cron run");
      break;
    }
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
