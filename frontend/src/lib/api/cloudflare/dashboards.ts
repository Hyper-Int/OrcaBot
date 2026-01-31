// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { API } from "@/config/env";
import { apiGet, apiPost, apiPut, apiDelete } from "../client";
import type {
  Dashboard,
  DashboardItem,
  Session,
  DashboardRole,
  DashboardEdge,
} from "@/types/dashboard";

// ===== Response Types =====

interface DashboardsListResponse {
  dashboards: Dashboard[];
}

interface DashboardResponse {
  dashboard: Dashboard;
  items?: DashboardItem[];
  sessions?: Session[];
  edges?: DashboardEdge[];
  role?: DashboardRole;
}

interface DashboardCreateRequest {
  name: string;
  templateId?: string;
}

interface DashboardUpdateRequest {
  name?: string;
}

interface ItemResponse {
  item: DashboardItem;
}

interface EdgeResponse {
  edge: DashboardEdge;
}

interface EdgeCreateRequest {
  sourceItemId: string;
  targetItemId: string;
  sourceHandle?: string;
  targetHandle?: string;
}

interface ItemCreateRequest {
  type: DashboardItem["type"];
  content: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  metadata?: Record<string, unknown>;
}

interface ItemUpdateRequest {
  content?: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  metadata?: Record<string, unknown>;
}

interface SessionResponse {
  session: Session;
}

// ===== Dashboard API =====

/**
 * List all dashboards for the current user
 */
export async function listDashboards(): Promise<Dashboard[]> {
  const response = await apiGet<DashboardsListResponse>(API.cloudflare.dashboards);
  return response.dashboards;
}

/**
 * Get a dashboard by ID with items and sessions
 */
export async function getDashboard(id: string): Promise<{
  dashboard: Dashboard;
  items: DashboardItem[];
  sessions: Session[];
  edges: DashboardEdge[];
  role: DashboardRole;
}> {
  const response = await apiGet<DashboardResponse>(
    `${API.cloudflare.dashboards}/${id}`
  );
  return {
    dashboard: response.dashboard,
    items: response.items || [],
    sessions: response.sessions || [],
    edges: response.edges || [],
    role: response.role || "viewer",
  };
}

/**
 * Create a new dashboard
 */
export async function createDashboard(
  name: string,
  templateId?: string
): Promise<Dashboard> {
  const response = await apiPost<DashboardResponse>(API.cloudflare.dashboards, {
    name,
    templateId,
  } as DashboardCreateRequest);
  return response.dashboard;
}

/**
 * Update a dashboard
 */
export async function updateDashboard(
  id: string,
  data: DashboardUpdateRequest
): Promise<Dashboard> {
  const response = await apiPut<DashboardResponse>(
    `${API.cloudflare.dashboards}/${id}`,
    data
  );
  return response.dashboard;
}

/**
 * Delete a dashboard
 */
export async function deleteDashboard(id: string): Promise<void> {
  await apiDelete<void>(`${API.cloudflare.dashboards}/${id}`);
}

// ===== Dashboard Items API =====

/**
 * Create a dashboard item
 */
export async function createItem(
  dashboardId: string,
  data: ItemCreateRequest
): Promise<DashboardItem> {
  const response = await apiPost<ItemResponse>(
    `${API.cloudflare.dashboards}/${dashboardId}/items`,
    data
  );
  return response.item;
}

/**
 * Create a dashboard edge
 */
export async function createEdge(
  dashboardId: string,
  data: EdgeCreateRequest
): Promise<DashboardEdge> {
  const response = await apiPost<EdgeResponse>(
    `${API.cloudflare.dashboards}/${dashboardId}/edges`,
    data
  );
  return response.edge;
}

/**
 * Delete a dashboard edge
 */
export async function deleteEdge(
  dashboardId: string,
  edgeId: string
): Promise<void> {
  await apiDelete<void>(`${API.cloudflare.dashboards}/${dashboardId}/edges/${edgeId}`);
}

/**
 * Update a dashboard item
 */
export async function updateItem(
  dashboardId: string,
  itemId: string,
  data: ItemUpdateRequest
): Promise<DashboardItem> {
  const response = await apiPut<ItemResponse>(
    `${API.cloudflare.dashboards}/${dashboardId}/items/${itemId}`,
    data
  );
  return response.item;
}

/**
 * Delete a dashboard item
 */
export async function deleteItem(
  dashboardId: string,
  itemId: string
): Promise<void> {
  await apiDelete<void>(
    `${API.cloudflare.dashboards}/${dashboardId}/items/${itemId}`
  );
}

// ===== Session API =====

/**
 * Create a terminal session for a dashboard item
 */
export async function createSession(
  dashboardId: string,
  itemId: string
): Promise<Session> {
  const response = await apiPost<SessionResponse>(
    `${API.cloudflare.dashboards}/${dashboardId}/items/${itemId}/session`
  );
  return response.session;
}

/**
 * Stop a session
 */
export async function stopSession(sessionId: string): Promise<void> {
  await apiDelete<void>(`${API.cloudflare.base}/sessions/${sessionId}`);
}

/**
 * Apply stored secrets to session (with broker protection).
 * This fetches secrets from the DB and applies them with proper broker flags.
 */
export async function applySessionSecrets(sessionId: string): Promise<{ applied: number }> {
  return apiPost<{ applied: number }>(`${API.cloudflare.base}/sessions/${sessionId}/apply-secrets`);
}

/**
 * Update session environment variables (plain env vars only, no broker protection)
 */
export async function updateSessionEnv(
  sessionId: string,
  payload: { set?: Record<string, string>; unset?: string[]; applyNow?: boolean }
): Promise<void> {
  const base = API.cloudflare.base.replace(/^http/, "ws");
  const wsUrl = `${base}/sessions/${sessionId}/control`;
  const applyNow = Boolean(payload.applyNow);
  const message = {
    type: "env",
    set: payload.set,
    unset: payload.unset,
    apply_now: applyNow,
  };

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = window.setTimeout(() => {
      ws.close();
      reject(new Error("E79751: Control channel timeout"));
    }, 8000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };

    const onError = () => {
      cleanup();
      reject(new Error("E79752: Control channel error"));
    };

    const onClose = () => {
      cleanup();
      reject(new Error("E79753: Control channel closed"));
    };

    const onMessage = (event: MessageEvent) => {
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data?.type === "env_result" && data?.status === "ok") {
          cleanup();
          ws.close();
          resolve();
          return;
        }
        if (data?.type === "error") {
          cleanup();
          ws.close();
          reject(new Error(data.error || "E79754: Control channel error"));
        }
      } catch {
        cleanup();
        ws.close();
        reject(new Error("E79755: Invalid control response"));
      }
    };

    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(message));
    });
  });
}

export type SandboxMetrics = {
  heapBytes: number;
  sysBytes: number;
  heapObjects: number;
  goroutines: number;
  gcRuns: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  uptimeMs: number;
  sessionCount: number;
  heapMB: number;
  sysMB: number;
};

export async function getSessionMetrics(sessionId: string): Promise<SandboxMetrics> {
  const raw = await apiGet<Record<string, number>>(
    `${API.cloudflare.base}/sessions/${sessionId}/metrics`
  );
  return {
    heapBytes: raw.heap_bytes ?? raw.heapBytes ?? 0,
    sysBytes: raw.sys_bytes ?? raw.sysBytes ?? 0,
    heapObjects: raw.heap_objects ?? raw.heapObjects ?? 0,
    goroutines: raw.goroutines ?? 0,
    gcRuns: raw.gc_runs ?? raw.gcRuns ?? 0,
    cpuUserMs: raw.cpu_user_ms ?? raw.cpuUserMs ?? 0,
    cpuSystemMs: raw.cpu_system_ms ?? raw.cpuSystemMs ?? 0,
    uptimeMs: raw.uptime_ms ?? raw.uptimeMs ?? 0,
    sessionCount: raw.session_count ?? raw.sessionCount ?? 0,
    heapMB: raw.heap_mb ?? raw.heapMB ?? 0,
    sysMB: raw.sys_mb ?? raw.sysMB ?? 0,
  };
}

export async function getDashboardMetrics(dashboardId: string): Promise<SandboxMetrics> {
  const raw = await apiGet<Record<string, number>>(
    `${API.cloudflare.dashboards}/${dashboardId}/metrics`
  );
  return {
    heapBytes: raw.heap_bytes ?? raw.heapBytes ?? 0,
    sysBytes: raw.sys_bytes ?? raw.sysBytes ?? 0,
    heapObjects: raw.heap_objects ?? raw.heapObjects ?? 0,
    goroutines: raw.goroutines ?? 0,
    gcRuns: raw.gc_runs ?? raw.gcRuns ?? 0,
    cpuUserMs: raw.cpu_user_ms ?? raw.cpuUserMs ?? 0,
    cpuSystemMs: raw.cpu_system_ms ?? raw.cpuSystemMs ?? 0,
    uptimeMs: raw.uptime_ms ?? raw.uptimeMs ?? 0,
    sessionCount: raw.session_count ?? raw.sessionCount ?? 0,
    heapMB: raw.heap_mb ?? raw.heapMB ?? 0,
    sysMB: raw.sys_mb ?? raw.sysMB ?? 0,
  };
}

export async function startDashboardBrowser(dashboardId: string): Promise<void> {
  await apiPost(`${API.cloudflare.dashboards}/${dashboardId}/browser/start`);
}

export async function stopDashboardBrowser(dashboardId: string): Promise<void> {
  await apiPost(`${API.cloudflare.dashboards}/${dashboardId}/browser/stop`);
}

export async function getDashboardBrowserStatus(
  dashboardId: string
): Promise<{ running: boolean; ready?: boolean }> {
  return apiGet(`${API.cloudflare.dashboards}/${dashboardId}/browser/status`);
}

export async function openDashboardBrowser(dashboardId: string, url: string): Promise<void> {
  await apiPost(`${API.cloudflare.dashboards}/${dashboardId}/browser/open`, { url });
}

// ===== Browser Automation API =====

/**
 * Capture a screenshot of the browser
 * @returns The path to the saved screenshot file
 */
export async function browserScreenshot(
  dashboardId: string,
  filename?: string
): Promise<{ path: string }> {
  return apiPost(`${API.cloudflare.dashboards}/${dashboardId}/browser/screenshot`, {
    path: filename,
  });
}

/**
 * Click an element by CSS selector
 */
export async function browserClick(dashboardId: string, selector: string): Promise<void> {
  await apiPost(`${API.cloudflare.dashboards}/${dashboardId}/browser/click`, { selector });
}

/**
 * Type text into an element by CSS selector
 */
export async function browserType(
  dashboardId: string,
  selector: string,
  text: string
): Promise<void> {
  await apiPost(`${API.cloudflare.dashboards}/${dashboardId}/browser/type`, { selector, text });
}

/**
 * Execute JavaScript in the browser and return result
 */
export async function browserEvaluate(
  dashboardId: string,
  script: string
): Promise<{ result: string }> {
  return apiPost(`${API.cloudflare.dashboards}/${dashboardId}/browser/evaluate`, { script });
}

/**
 * Get visible text content from the page
 */
export async function browserGetContent(dashboardId: string): Promise<{ content: string }> {
  return apiGet(`${API.cloudflare.dashboards}/${dashboardId}/browser/content`);
}

/**
 * Get full HTML of the page
 */
export async function browserGetHTML(dashboardId: string): Promise<{ html: string }> {
  return apiGet(`${API.cloudflare.dashboards}/${dashboardId}/browser/html`);
}

/**
 * Get current URL
 */
export async function browserGetURL(dashboardId: string): Promise<{ url: string }> {
  return apiGet(`${API.cloudflare.dashboards}/${dashboardId}/browser/url`);
}

/**
 * Get page title
 */
export async function browserGetTitle(dashboardId: string): Promise<{ title: string }> {
  return apiGet(`${API.cloudflare.dashboards}/${dashboardId}/browser/title`);
}

/**
 * Wait for an element to appear
 */
export async function browserWait(
  dashboardId: string,
  selector: string,
  timeout?: number
): Promise<void> {
  await apiPost(`${API.cloudflare.dashboards}/${dashboardId}/browser/wait`, {
    selector,
    timeout: timeout ?? 30,
  });
}

/**
 * Navigate to a URL
 */
export async function browserNavigate(dashboardId: string, url: string): Promise<void> {
  await apiPost(`${API.cloudflare.dashboards}/${dashboardId}/browser/navigate`, { url });
}

/**
 * Scroll the page
 */
export async function browserScroll(dashboardId: string, x: number, y: number): Promise<void> {
  await apiPost(`${API.cloudflare.dashboards}/${dashboardId}/browser/scroll`, { x, y });
}

/**
 * Get the WebSocket URL for dashboard collaboration
 */
export function getCollaborationWsUrl(
  dashboardId: string,
  userId: string,
  userName: string
): string {
  const baseWsUrl = API.cloudflare.ws(dashboardId);
  let url = `${baseWsUrl}?user_id=${encodeURIComponent(userId)}&user_name=${encodeURIComponent(userName)}`;
  return url;
}

/**
 * Send UI command result back to the DashboardDO for broadcast
 */
export async function sendUICommandResult(
  dashboardId: string,
  result: {
    command_id: string;
    success: boolean;
    error?: string;
    created_item_id?: string;
  }
): Promise<void> {
  await apiPost<void>(
    `${API.cloudflare.dashboards}/${dashboardId}/ui-command-result`,
    result
  );
}
