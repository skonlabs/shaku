// Connector types and interfaces.

export type ConnectorService =
  | "google_drive"
  | "dropbox"
  | "onedrive"
  | "slack"
  | "teams"
  | "gmail"
  | "google_calendar"
  | "jira"
  | "github"
  | "notion"
  | "confluence";

export type ConnectorStatus = "connected" | "syncing" | "paused" | "error" | "disconnected";

export interface ConnectorConfig {
  service: ConnectorService;
  displayName: string;
  iconSlug: string;
  authType: "oauth2";
  pollingIntervalMs: number;
  supportsWebhook: boolean;
  scopes: string[];
  // Phase 1: Google Drive + Slack only. Others show UI but not implemented.
  implemented: boolean;
}

export const CONNECTOR_CONFIGS: ConnectorConfig[] = [
  {
    service: "google_drive",
    displayName: "Google Drive",
    iconSlug: "google-drive",
    authType: "oauth2",
    pollingIntervalMs: 5 * 60 * 1000,
    supportsWebhook: false,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    implemented: true,
  },
  {
    service: "slack",
    displayName: "Slack",
    iconSlug: "slack",
    authType: "oauth2",
    pollingIntervalMs: 5 * 60 * 1000,
    supportsWebhook: true,
    scopes: ["channels:read", "channels:history", "users:read", "files:read"],
    implemented: true,
  },
  {
    service: "dropbox",
    displayName: "Dropbox",
    iconSlug: "dropbox",
    authType: "oauth2",
    pollingIntervalMs: 30 * 60 * 1000,
    supportsWebhook: false,
    scopes: ["files.content.read", "files.metadata.read"],
    implemented: false, // Phase 2
  },
  {
    service: "onedrive",
    displayName: "OneDrive / SharePoint",
    iconSlug: "onedrive",
    authType: "oauth2",
    pollingIntervalMs: 30 * 60 * 1000,
    supportsWebhook: false,
    scopes: ["Files.Read"],
    implemented: false,
  },
  {
    service: "gmail",
    displayName: "Gmail",
    iconSlug: "gmail",
    authType: "oauth2",
    pollingIntervalMs: 15 * 60 * 1000,
    supportsWebhook: false,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    implemented: false,
  },
  {
    service: "google_calendar",
    displayName: "Google Calendar",
    iconSlug: "google-calendar",
    authType: "oauth2",
    pollingIntervalMs: 15 * 60 * 1000,
    supportsWebhook: false,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    implemented: false,
  },
  {
    service: "jira",
    displayName: "Jira",
    iconSlug: "jira",
    authType: "oauth2",
    pollingIntervalMs: 15 * 60 * 1000,
    supportsWebhook: false,
    scopes: ["read:jira-work"],
    implemented: false,
  },
  {
    service: "github",
    displayName: "GitHub",
    iconSlug: "github",
    authType: "oauth2",
    pollingIntervalMs: 15 * 60 * 1000,
    supportsWebhook: false,
    scopes: ["repo:status", "read:org"],
    implemented: false,
  },
  {
    service: "notion",
    displayName: "Notion",
    iconSlug: "notion",
    authType: "oauth2",
    pollingIntervalMs: 30 * 60 * 1000,
    supportsWebhook: false,
    scopes: [],
    implemented: false,
  },
  {
    service: "confluence",
    displayName: "Confluence",
    iconSlug: "confluence",
    authType: "oauth2",
    pollingIntervalMs: 30 * 60 * 1000,
    supportsWebhook: false,
    scopes: ["read:confluence-space.summary"],
    implemented: false,
  },
  {
    service: "teams",
    displayName: "Microsoft Teams",
    iconSlug: "teams",
    authType: "oauth2",
    pollingIntervalMs: 15 * 60 * 1000,
    supportsWebhook: false,
    scopes: ["ChannelMessage.Read.All"],
    implemented: false,
  },
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
