// Connector types and interfaces.

export type ConnectorService =
  | "google_drive"
  | "google_docs"
  | "google_sheets"
  | "google_slides"
  | "gmail"
  | "google_calendar"
  | "onedrive"
  | "microsoft_word"
  | "microsoft_excel"
  | "microsoft_powerpoint"
  | "microsoft_onenote"
  | "microsoft_outlook"
  | "microsoft_teams"
  | "slack";

export type ConnectorStatus = "connected" | "syncing" | "paused" | "error" | "disconnected";

export interface ConnectorConfig {
  service: ConnectorService;
  displayName: string;
  iconSlug: string;
  authType: "oauth2";
  pollingIntervalMs: number;
  supportsWebhook: boolean;
  scopes: string[];
  implemented: boolean;
  // Which OAuth credential family this connector belongs to. Used by the UI to
  // tell users which secrets must be configured (one set per provider, not per service).
  provider: "google" | "microsoft" | "slack";
}

export const CONNECTOR_CONFIGS: ConnectorConfig[] = [
  // ----- Google -----
  { service: "google_drive", displayName: "Google Drive", iconSlug: "google-drive", authType: "oauth2", pollingIntervalMs: 5 * 60 * 1000, supportsWebhook: false, scopes: ["drive.readonly"], implemented: true, provider: "google" },
  { service: "google_docs", displayName: "Google Docs", iconSlug: "google-docs", authType: "oauth2", pollingIntervalMs: 15 * 60 * 1000, supportsWebhook: false, scopes: ["documents.readonly"], implemented: true, provider: "google" },
  { service: "google_sheets", displayName: "Google Sheets", iconSlug: "google-sheets", authType: "oauth2", pollingIntervalMs: 15 * 60 * 1000, supportsWebhook: false, scopes: ["spreadsheets.readonly"], implemented: true, provider: "google" },
  { service: "google_slides", displayName: "Google Slides", iconSlug: "google-slides", authType: "oauth2", pollingIntervalMs: 15 * 60 * 1000, supportsWebhook: false, scopes: ["presentations.readonly"], implemented: true, provider: "google" },
  { service: "gmail", displayName: "Gmail", iconSlug: "gmail", authType: "oauth2", pollingIntervalMs: 15 * 60 * 1000, supportsWebhook: false, scopes: ["gmail.readonly"], implemented: true, provider: "google" },
  { service: "google_calendar", displayName: "Google Calendar", iconSlug: "google-calendar", authType: "oauth2", pollingIntervalMs: 15 * 60 * 1000, supportsWebhook: false, scopes: ["calendar.readonly"], implemented: true, provider: "google" },

  // ----- Microsoft -----
  { service: "onedrive", displayName: "OneDrive", iconSlug: "onedrive", authType: "oauth2", pollingIntervalMs: 30 * 60 * 1000, supportsWebhook: false, scopes: ["Files.Read"], implemented: true, provider: "microsoft" },
  { service: "microsoft_word", displayName: "Microsoft Word", iconSlug: "word", authType: "oauth2", pollingIntervalMs: 30 * 60 * 1000, supportsWebhook: false, scopes: ["Files.Read"], implemented: true, provider: "microsoft" },
  { service: "microsoft_excel", displayName: "Microsoft Excel", iconSlug: "excel", authType: "oauth2", pollingIntervalMs: 30 * 60 * 1000, supportsWebhook: false, scopes: ["Files.Read"], implemented: true, provider: "microsoft" },
  { service: "microsoft_powerpoint", displayName: "Microsoft PowerPoint", iconSlug: "powerpoint", authType: "oauth2", pollingIntervalMs: 30 * 60 * 1000, supportsWebhook: false, scopes: ["Files.Read"], implemented: true, provider: "microsoft" },
  { service: "microsoft_onenote", displayName: "Microsoft OneNote", iconSlug: "onenote", authType: "oauth2", pollingIntervalMs: 30 * 60 * 1000, supportsWebhook: false, scopes: ["Notes.Read"], implemented: true, provider: "microsoft" },
  { service: "microsoft_outlook", displayName: "Microsoft Outlook", iconSlug: "outlook", authType: "oauth2", pollingIntervalMs: 15 * 60 * 1000, supportsWebhook: false, scopes: ["Mail.Read"], implemented: true, provider: "microsoft" },
  { service: "microsoft_teams", displayName: "Microsoft Teams", iconSlug: "teams", authType: "oauth2", pollingIntervalMs: 15 * 60 * 1000, supportsWebhook: false, scopes: ["ChannelMessage.Read.All"], implemented: true, provider: "microsoft" },

  // ----- Slack -----
  { service: "slack", displayName: "Slack", iconSlug: "slack", authType: "oauth2", pollingIntervalMs: 5 * 60 * 1000, supportsWebhook: true, scopes: ["channels:read", "channels:history", "users:read", "files:read"], implemented: true, provider: "slack" },
];

export interface ConnectedItem {
  id: string;
  title: string;
  url?: string;
  content: string;
  permissions: { canAccess: boolean; userId?: string };
  updatedAt: string;
  cursor?: string;
}

export interface SyncResult {
  itemsProcessed: number;
  newCursor: string | null;
  errors: string[];
}
