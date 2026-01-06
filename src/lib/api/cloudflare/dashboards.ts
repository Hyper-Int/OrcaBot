import { API } from "@/config/env";
import { apiGet, apiPost, apiPut, apiDelete } from "../client";
import type {
  Dashboard,
  DashboardItem,
  Session,
  DashboardRole,
} from "@/types/dashboard";

// ===== Response Types =====

interface DashboardsListResponse {
  dashboards: Dashboard[];
}

interface DashboardResponse {
  dashboard: Dashboard;
  items?: DashboardItem[];
  sessions?: Session[];
  role?: DashboardRole;
}

interface DashboardCreateRequest {
  name: string;
}

interface DashboardUpdateRequest {
  name?: string;
}

interface ItemResponse {
  item: DashboardItem;
}

interface ItemCreateRequest {
  type: DashboardItem["type"];
  content: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

interface ItemUpdateRequest {
  content?: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
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
  role: DashboardRole;
}> {
  const response = await apiGet<DashboardResponse>(
    `${API.cloudflare.dashboards}/${id}`
  );
  return {
    dashboard: response.dashboard,
    items: response.items || [],
    sessions: response.sessions || [],
    role: response.role || "viewer",
  };
}

/**
 * Create a new dashboard
 */
export async function createDashboard(name: string): Promise<Dashboard> {
  const response = await apiPost<DashboardResponse>(API.cloudflare.dashboards, {
    name,
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
 * Get the WebSocket URL for dashboard collaboration
 */
export function getCollaborationWsUrl(
  dashboardId: string,
  userId: string,
  userName: string,
  userEmail?: string
): string {
  const baseWsUrl = API.cloudflare.ws(dashboardId);
  let url = `${baseWsUrl}?user_id=${encodeURIComponent(userId)}&user_name=${encodeURIComponent(userName)}`;
  if (userEmail) {
    url += `&user_email=${encodeURIComponent(userEmail)}`;
  }
  return url;
}
