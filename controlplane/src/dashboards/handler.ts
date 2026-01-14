/**
 * Dashboard API Handlers
 */

import type { Env, Dashboard, DashboardItem } from '../types';

function generateId(): string {
  return crypto.randomUUID();
}

// Format a raw DB dashboard row to camelCase
function formatDashboard(row: Record<string, unknown>): Dashboard {
  return {
    id: row.id as string,
    name: row.name as string,
    ownerId: row.owner_id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// Format a raw DB item row to camelCase
function formatItem(row: Record<string, unknown>): DashboardItem {
  return {
    id: row.id as string,
    dashboardId: row.dashboard_id as string,
    type: row.type as DashboardItem['type'],
    content: row.content as string,
    position: {
      x: row.position_x as number,
      y: row.position_y as number,
    },
    size: {
      width: row.width as number,
      height: row.height as number,
    },
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// Format a raw DB session row to camelCase
function formatSession(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    dashboardId: row.dashboard_id as string,
    itemId: row.item_id as string,
    ownerUserId: row.owner_user_id as string,
    ownerName: row.owner_name as string,
    sandboxSessionId: row.sandbox_session_id as string,
    ptyId: row.pty_id as string,
    status: row.status as string,
    region: row.region as string,
    createdAt: row.created_at as string,
    stoppedAt: row.stopped_at as string | null,
  };
}

// List dashboards for a user
export async function listDashboards(
  env: Env,
  userId: string
): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT d.* FROM dashboards d
    JOIN dashboard_members dm ON d.id = dm.dashboard_id
    WHERE dm.user_id = ?
    ORDER BY d.updated_at DESC
  `).bind(userId).all();

  const dashboards = result.results.map(formatDashboard);
  return Response.json({ dashboards });
}

// Get a single dashboard
export async function getDashboard(
  env: Env,
  dashboardId: string,
  userId: string
): Promise<Response> {
  // Check access
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'Not found or no access' }, { status: 404 });
  }

  // Get dashboard
  const dashboardRow = await env.DB.prepare(`
    SELECT * FROM dashboards WHERE id = ?
  `).bind(dashboardId).first();

  if (!dashboardRow) {
    return Response.json({ error: 'Dashboard not found' }, { status: 404 });
  }

  // Get items
  const itemRows = await env.DB.prepare(`
    SELECT * FROM dashboard_items WHERE dashboard_id = ?
  `).bind(dashboardId).all();

  // Get sessions
  const sessionRows = await env.DB.prepare(`
    SELECT * FROM sessions WHERE dashboard_id = ? AND status != 'stopped'
  `).bind(dashboardId).all();

  return Response.json({
    dashboard: formatDashboard(dashboardRow),
    items: itemRows.results.map(formatItem),
    sessions: sessionRows.results.map(formatSession),
    role: access.role,
  });
}

// Create a new dashboard
export async function createDashboard(
  env: Env,
  userId: string,
  data: { name: string }
): Promise<Response> {
  const id = generateId();
  const now = new Date().toISOString();

  // Create dashboard
  await env.DB.prepare(`
    INSERT INTO dashboards (id, name, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, data.name, userId, now, now).run();

  // Add owner as member
  await env.DB.prepare(`
    INSERT INTO dashboard_members (dashboard_id, user_id, role, added_at)
    VALUES (?, ?, 'owner', ?)
  `).bind(id, userId, now).run();

  const dashboard: Dashboard = {
    id,
    name: data.name,
    ownerId: userId,
    createdAt: now,
    updatedAt: now,
  };

  return Response.json({ dashboard }, { status: 201 });
}

// Update a dashboard
export async function updateDashboard(
  env: Env,
  dashboardId: string,
  userId: string,
  data: { name?: string }
): Promise<Response> {
  // Check edit access
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'Not found or no edit access' }, { status: 404 });
  }

  const now = new Date().toISOString();

  if (data.name) {
    await env.DB.prepare(`
      UPDATE dashboards SET name = ?, updated_at = ? WHERE id = ?
    `).bind(data.name, now, dashboardId).run();
  }

  const dashboardRow = await env.DB.prepare(`
    SELECT * FROM dashboards WHERE id = ?
  `).bind(dashboardId).first();

  return Response.json({ dashboard: formatDashboard(dashboardRow!) });
}

// Delete a dashboard
export async function deleteDashboard(
  env: Env,
  dashboardId: string,
  userId: string
): Promise<Response> {
  // Check owner access
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role = 'owner'
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'Not found or not owner' }, { status: 404 });
  }

  await env.DB.prepare(`DELETE FROM dashboards WHERE id = ?`).bind(dashboardId).run();

  return new Response(null, { status: 204 });
}

// Add/update dashboard item
export async function upsertItem(
  env: Env,
  dashboardId: string,
  userId: string,
  item: Partial<DashboardItem> & { id?: string }
): Promise<Response> {
  // Check edit access
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'Not found or no edit access' }, { status: 404 });
  }

  const now = new Date().toISOString();
  const id = item.id || generateId();

  // Check if exists
  const existing = await env.DB.prepare(`
    SELECT id FROM dashboard_items WHERE id = ? AND dashboard_id = ?
  `).bind(id, dashboardId).first();

  if (existing) {
    // Update - use undefined check to allow clearing to empty string
    await env.DB.prepare(`
      UPDATE dashboard_items SET
        content = COALESCE(?, content),
        position_x = COALESCE(?, position_x),
        position_y = COALESCE(?, position_y),
        width = COALESCE(?, width),
        height = COALESCE(?, height),
        updated_at = ?
      WHERE id = ?
    `).bind(
      item.content !== undefined ? item.content : null,
      item.position?.x ?? null,
      item.position?.y ?? null,
      item.size?.width ?? null,
      item.size?.height ?? null,
      now,
      id
    ).run();
  } else {
    // Insert
    await env.DB.prepare(`
      INSERT INTO dashboard_items (id, dashboard_id, type, content, position_x, position_y, width, height, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      dashboardId,
      item.type || 'note',
      item.content || '',
      item.position?.x ?? 0,
      item.position?.y ?? 0,
      item.size?.width ?? 200,
      item.size?.height ?? 150,
      now,
      now
    ).run();
  }

  // Update dashboard timestamp
  await env.DB.prepare(`
    UPDATE dashboards SET updated_at = ? WHERE id = ?
  `).bind(now, dashboardId).run();

  // Notify Durable Object
  const doId = env.DASHBOARD.idFromName(dashboardId);
  const stub = env.DASHBOARD.get(doId);

  const savedItem = await env.DB.prepare(`
    SELECT * FROM dashboard_items WHERE id = ?
  `).bind(id).first();

  const formattedItem = formatItem(savedItem!);

  await stub.fetch(new Request('http://do/item', {
    method: existing ? 'PUT' : 'POST',
    body: JSON.stringify(formattedItem),
  }));

  return Response.json({ item: formattedItem }, { status: existing ? 200 : 201 });
}

// Delete dashboard item
export async function deleteItem(
  env: Env,
  dashboardId: string,
  itemId: string,
  userId: string
): Promise<Response> {
  // Check edit access
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'Not found or no edit access' }, { status: 404 });
  }

  await env.DB.prepare(`
    DELETE FROM dashboard_items WHERE id = ? AND dashboard_id = ?
  `).bind(itemId, dashboardId).run();

  // Notify Durable Object
  const doId = env.DASHBOARD.idFromName(dashboardId);
  const stub = env.DASHBOARD.get(doId);
  await stub.fetch(new Request('http://do/item', {
    method: 'DELETE',
    body: JSON.stringify({ itemId }),
  }));

  return new Response(null, { status: 204 });
}

// WebSocket connection for real-time collaboration
export async function connectWebSocket(
  env: Env,
  dashboardId: string,
  userId: string,
  userName: string,
  request: Request
): Promise<Response> {
  // Check access
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'Not found or no access' }, { status: 404 });
  }

  // Forward to Durable Object
  const doId = env.DASHBOARD.idFromName(dashboardId);
  const stub = env.DASHBOARD.get(doId);

  const wsUrl = new URL(request.url);
  wsUrl.pathname = '/ws';
  wsUrl.searchParams.set('user_id', userId);
  wsUrl.searchParams.set('user_name', userName);

  // Pass original request to preserve WebSocket upgrade semantics
  // The second argument copies method, headers, body, and upgrade intent from the original
  return stub.fetch(new Request(wsUrl.toString(), request));
}
