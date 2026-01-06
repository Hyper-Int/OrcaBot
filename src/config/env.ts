/**
 * Environment configuration
 */

// API URLs with defaults
export const CLOUDFLARE_API_URL =
  process.env.NEXT_PUBLIC_CLOUDFLARE_API_URL ||
  "https://hyper-cloudflare.robbomacrae.workers.dev";

export const SANDBOX_API_URL =
  process.env.NEXT_PUBLIC_SANDBOX_API_URL ||
  "https://hyper-sandbox.fly.dev";

export const DEV_MODE_ENABLED =
  process.env.NEXT_PUBLIC_DEV_MODE_ENABLED !== "false";

/**
 * Environment object for convenience
 */
export const env = {
  CLOUDFLARE_API_URL,
  SANDBOX_API_URL,
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
    ws: (dashboardId: string) =>
      `${CLOUDFLARE_API_URL.replace("https://", "wss://").replace("http://", "ws://")}/dashboards/${dashboardId}/ws`,
  },
  sandbox: {
    base: SANDBOX_API_URL,
    sessions: `${SANDBOX_API_URL}/sessions`,
    ws: (sessionId: string, ptyId: string) =>
      `${SANDBOX_API_URL.replace("https://", "wss://").replace("http://", "ws://")}/sessions/${sessionId}/ptys/${ptyId}/ws`,
    agentWs: (sessionId: string) =>
      `${SANDBOX_API_URL.replace("https://", "wss://").replace("http://", "ws://")}/sessions/${sessionId}/agent/ws`,
  },
};
