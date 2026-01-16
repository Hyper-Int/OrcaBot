// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Environment configuration
 */

// API URLs with defaults
export const CLOUDFLARE_API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  "https://orcabot-controlplane.orcabot.workers.dev";

export const DEV_MODE_ENABLED =
  process.env.NEXT_PUBLIC_DEV_MODE_ENABLED === "true";

/**
 * Environment object for convenience
 */
export const env = {
  CLOUDFLARE_API_URL,
  DEV_MODE_ENABLED,
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
    usersMe: `${CLOUDFLARE_API_URL}/users/me`,
    embedCheck: `${CLOUDFLARE_API_URL}/embed-check`,
    subagents: `${CLOUDFLARE_API_URL}/subagents`,
    secrets: `${CLOUDFLARE_API_URL}/secrets`,
    agentSkills: `${CLOUDFLARE_API_URL}/agent-skills`,
    mcpTools: `${CLOUDFLARE_API_URL}/mcp-tools`,
    ws: (dashboardId: string) =>
      `${CLOUDFLARE_API_URL.replace("https://", "wss://").replace("http://", "ws://")}/dashboards/${dashboardId}/ws`,
    terminalWs: (sessionId: string, ptyId: string) =>
      `${CLOUDFLARE_API_URL.replace("https://", "wss://").replace("http://", "ws://")}/sessions/${sessionId}/ptys/${ptyId}/ws`,
  },
};
