// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: desktop-env-v5-subscriptions
const MODULE_REVISION = "desktop-env-v5-subscriptions";
console.log(
  `[env] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

/**
 * Environment configuration
 */

// API URLs with defaults
export const CLOUDFLARE_API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  "https://orcabot-controlplane.orcabot.workers.dev";

export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || "https://orcabot.com";

export const DEV_MODE_ENABLED =
  process.env.NEXT_PUBLIC_DEV_MODE_ENABLED === "true";

export const TURNSTILE_SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";

// Desktop mode detection uses three layers (in order of reliability):
// 1. Cookie "orcabot-desktop=1" — set by middleware on every response in desktop mode
// 2. URL param "?desktop=1" — set by Tauri's dist/index.html redirect
// 3. localStorage "orcabot-desktop" — persisted from either of the above
// Server-side uses the env var directly.
function getDesktopMode(): boolean {
  const envDesktop = process.env.NEXT_PUBLIC_DESKTOP_MODE === "true";
  if (typeof window === "undefined") {
    return envDesktop;
  }
  const tauriWindow = window as unknown as { __TAURI__?: unknown; __TAURI_IPC__?: unknown };
  const isTauri = Boolean(tauriWindow.__TAURI__ || tauriWindow.__TAURI_IPC__);
  const hostname = window.location.hostname;
  const isLocalhost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";
  // Never allow URL/cookie/localStorage to enable desktop mode unless:
  // - The build explicitly opts in, OR
  // - We're running inside Tauri, OR
  // - We're on localhost (desktop dev / bundled workerd).
  if (!envDesktop && !isTauri && !isLocalhost) {
    return false;
  }
  try {
    // Tauri desktop always counts as desktop mode.
    if (isTauri) {
      return true;
    }
    // Check cookie (set by middleware via HTTP Set-Cookie header)
    if (document.cookie.includes("orcabot-desktop=1")) {
      localStorage.setItem("orcabot-desktop", "1");
      return true;
    }
    // Check URL param (set by Tauri's redirect page)
    const params = new URLSearchParams(window.location.search);
    if (params.get("desktop") === "1") {
      localStorage.setItem("orcabot-desktop", "1");
      const url = new URL(window.location.href);
      url.searchParams.delete("desktop");
      window.history.replaceState({}, "", url.toString());
      return true;
    }
    // Check localStorage (persisted from previous detection)
    if (localStorage.getItem("orcabot-desktop") === "1") {
      return true;
    }
    // If build opts in but no markers are set yet, still enable desktop mode.
    if (envDesktop) {
      return true;
    }
    return false;
  } catch {
    return envDesktop || isTauri || isLocalhost;
  }
}
export const DESKTOP_MODE = getDesktopMode();

/**
 * Environment object for convenience
 */
export const env = {
  CLOUDFLARE_API_URL,
  SITE_URL,
  DEV_MODE_ENABLED,
  DESKTOP_MODE,
};

/**
 * API endpoint helpers
 */
export const API = {
  cloudflare: {
    base: CLOUDFLARE_API_URL,
    dashboards: `${CLOUDFLARE_API_URL}/dashboards`,
    recipes: `${CLOUDFLARE_API_URL}/recipes`,
    schedules: `${CLOUDFLARE_API_URL}/schedules`,
    executions: `${CLOUDFLARE_API_URL}/executions`,
    // Dashboard-scoped endpoints (use dynamic functions below)
    dashboardTasks: (dashboardId: string) => `${CLOUDFLARE_API_URL}/dashboards/${dashboardId}/tasks`,
    dashboardMemory: (dashboardId: string) => `${CLOUDFLARE_API_URL}/dashboards/${dashboardId}/memory`,
    usersMe: `${CLOUDFLARE_API_URL}/users/me`,
    embedCheck: `${CLOUDFLARE_API_URL}/embed-check`,
    subagents: `${CLOUDFLARE_API_URL}/subagents`,
    templates: `${CLOUDFLARE_API_URL}/templates`,
    secrets: `${CLOUDFLARE_API_URL}/secrets`,
    pendingApprovals: `${CLOUDFLARE_API_URL}/pending-approvals`,
    asrKeys: `${CLOUDFLARE_API_URL}/asr/keys`,
    asrAssemblyAIToken: `${CLOUDFLARE_API_URL}/asr/assemblyai/token`,
    asrOpenAITranscribe: `${CLOUDFLARE_API_URL}/asr/openai/transcribe`,
    asrDeepgramToken: `${CLOUDFLARE_API_URL}/asr/deepgram/token`,
    asrDeepgramTranscribe: `${CLOUDFLARE_API_URL}/asr/deepgram/transcribe`,
    agentSkills: `${CLOUDFLARE_API_URL}/agent-skills`,
    mcpTools: `${CLOUDFLARE_API_URL}/mcp-tools`,
    googleDriveIntegration: `${CLOUDFLARE_API_URL}/integrations/google/drive`,
    googleDriveFolder: `${CLOUDFLARE_API_URL}/integrations/google/drive/folder`,
    googleDriveStatus: `${CLOUDFLARE_API_URL}/integrations/google/drive/status`,
    googleDriveManifest: `${CLOUDFLARE_API_URL}/integrations/google/drive/manifest`,
    googleDriveSync: `${CLOUDFLARE_API_URL}/integrations/google/drive/sync`,
    googleDriveSyncLarge: `${CLOUDFLARE_API_URL}/integrations/google/drive/sync/large`,
    googleDriveDisconnect: `${CLOUDFLARE_API_URL}/integrations/google/drive/disconnect`,
    githubIntegration: `${CLOUDFLARE_API_URL}/integrations/github`,
    githubRepos: `${CLOUDFLARE_API_URL}/integrations/github/repos`,
    githubRepo: `${CLOUDFLARE_API_URL}/integrations/github/repo`,
    githubHistory: `${CLOUDFLARE_API_URL}/integrations/github/history`,
    devClearWorkspace: `${CLOUDFLARE_API_URL}/dev/workspace/clear`,
    githubStatus: `${CLOUDFLARE_API_URL}/integrations/github/status`,
    githubManifest: `${CLOUDFLARE_API_URL}/integrations/github/manifest`,
    githubSync: `${CLOUDFLARE_API_URL}/integrations/github/sync`,
    githubSyncLarge: `${CLOUDFLARE_API_URL}/integrations/github/sync/large`,
    githubDisconnect: `${CLOUDFLARE_API_URL}/integrations/github/disconnect`,
    boxIntegration: `${CLOUDFLARE_API_URL}/integrations/box`,
    boxFolders: `${CLOUDFLARE_API_URL}/integrations/box/folders`,
    boxFolder: `${CLOUDFLARE_API_URL}/integrations/box/folder`,
    boxStatus: `${CLOUDFLARE_API_URL}/integrations/box/status`,
    boxManifest: `${CLOUDFLARE_API_URL}/integrations/box/manifest`,
    boxSync: `${CLOUDFLARE_API_URL}/integrations/box/sync`,
    boxSyncLarge: `${CLOUDFLARE_API_URL}/integrations/box/sync/large`,
    boxDisconnect: `${CLOUDFLARE_API_URL}/integrations/box/disconnect`,
    onedriveIntegration: `${CLOUDFLARE_API_URL}/integrations/onedrive`,
    onedriveFolders: `${CLOUDFLARE_API_URL}/integrations/onedrive/folders`,
    onedriveFolder: `${CLOUDFLARE_API_URL}/integrations/onedrive/folder`,
    onedriveStatus: `${CLOUDFLARE_API_URL}/integrations/onedrive/status`,
    onedriveManifest: `${CLOUDFLARE_API_URL}/integrations/onedrive/manifest`,
    onedriveSync: `${CLOUDFLARE_API_URL}/integrations/onedrive/sync`,
    onedriveSyncLarge: `${CLOUDFLARE_API_URL}/integrations/onedrive/sync/large`,
    onedriveDisconnect: `${CLOUDFLARE_API_URL}/integrations/onedrive/disconnect`,
    // Gmail
    gmailIntegration: `${CLOUDFLARE_API_URL}/integrations/google/gmail`,
    gmailSetup: `${CLOUDFLARE_API_URL}/integrations/google/gmail/setup`,
    gmailStatus: `${CLOUDFLARE_API_URL}/integrations/google/gmail/status`,
    gmailSync: `${CLOUDFLARE_API_URL}/integrations/google/gmail/sync`,
    gmailMessages: `${CLOUDFLARE_API_URL}/integrations/google/gmail/messages`,
    gmailMessage: `${CLOUDFLARE_API_URL}/integrations/google/gmail/message`,
    gmailAction: `${CLOUDFLARE_API_URL}/integrations/google/gmail/action`,
    gmailWatch: `${CLOUDFLARE_API_URL}/integrations/google/gmail/watch`,
    gmailStop: `${CLOUDFLARE_API_URL}/integrations/google/gmail/stop`,
    gmailDisconnect: `${CLOUDFLARE_API_URL}/integrations/google/gmail/disconnect`,
    // Google Calendar
    calendarIntegration: `${CLOUDFLARE_API_URL}/integrations/google/calendar`,
    calendarSetup: `${CLOUDFLARE_API_URL}/integrations/google/calendar/setup`,
    calendarStatus: `${CLOUDFLARE_API_URL}/integrations/google/calendar/status`,
    calendarSync: `${CLOUDFLARE_API_URL}/integrations/google/calendar/sync`,
    calendarEvents: `${CLOUDFLARE_API_URL}/integrations/google/calendar/events`,
    calendarEvent: `${CLOUDFLARE_API_URL}/integrations/google/calendar/event`,
    calendarDisconnect: `${CLOUDFLARE_API_URL}/integrations/google/calendar/disconnect`,
    // Google Contacts
    contactsIntegration: `${CLOUDFLARE_API_URL}/integrations/google/contacts`,
    contactsSetup: `${CLOUDFLARE_API_URL}/integrations/google/contacts/setup`,
    contactsStatus: `${CLOUDFLARE_API_URL}/integrations/google/contacts/status`,
    contactsSync: `${CLOUDFLARE_API_URL}/integrations/google/contacts/sync`,
    contactsList: `${CLOUDFLARE_API_URL}/integrations/google/contacts/list`,
    contactsDetail: `${CLOUDFLARE_API_URL}/integrations/google/contacts/detail`,
    contactsSearch: `${CLOUDFLARE_API_URL}/integrations/google/contacts/search`,
    contactsDisconnect: `${CLOUDFLARE_API_URL}/integrations/google/contacts/disconnect`,
    // Google Sheets
    sheetsIntegration: `${CLOUDFLARE_API_URL}/integrations/google/sheets`,
    sheetsSetup: `${CLOUDFLARE_API_URL}/integrations/google/sheets/setup`,
    sheetsList: `${CLOUDFLARE_API_URL}/integrations/google/sheets/list`,
    sheetsSpreadsheet: `${CLOUDFLARE_API_URL}/integrations/google/sheets/spreadsheet`,
    sheetsValues: `${CLOUDFLARE_API_URL}/integrations/google/sheets/values`,
    sheetsAppend: `${CLOUDFLARE_API_URL}/integrations/google/sheets/append`,
    sheetsLink: `${CLOUDFLARE_API_URL}/integrations/google/sheets/link`,
    sheetsDisconnect: `${CLOUDFLARE_API_URL}/integrations/google/sheets/disconnect`,
    // Google Forms
    formsIntegration: `${CLOUDFLARE_API_URL}/integrations/google/forms`,
    formsSetup: `${CLOUDFLARE_API_URL}/integrations/google/forms/setup`,
    formsList: `${CLOUDFLARE_API_URL}/integrations/google/forms/list`,
    formsForm: `${CLOUDFLARE_API_URL}/integrations/google/forms/form`,
    formsResponses: `${CLOUDFLARE_API_URL}/integrations/google/forms/responses`,
    formsLink: `${CLOUDFLARE_API_URL}/integrations/google/forms/link`,
    formsDisconnect: `${CLOUDFLARE_API_URL}/integrations/google/forms/disconnect`,
    // Subscriptions
    subscriptionCheckout: `${CLOUDFLARE_API_URL}/subscriptions/checkout`,
    subscriptionPortal: `${CLOUDFLARE_API_URL}/subscriptions/portal`,
    // Chat
    chat: `${CLOUDFLARE_API_URL}/chat`,
    chatMessage: `${CLOUDFLARE_API_URL}/chat/message`,
    chatHistory: `${CLOUDFLARE_API_URL}/chat/history`,
    ws: (dashboardId: string) =>
      `${CLOUDFLARE_API_URL.replace("https://", "wss://").replace("http://", "ws://")}/dashboards/${dashboardId}/ws`,
    terminalWs: (sessionId: string, ptyId: string) =>
      `${CLOUDFLARE_API_URL.replace("https://", "wss://").replace("http://", "ws://")}/sessions/${sessionId}/ptys/${ptyId}/ws`,
    sessionFile: (sessionId: string, path: string) =>
      `${CLOUDFLARE_API_URL}/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`,
  },
};
