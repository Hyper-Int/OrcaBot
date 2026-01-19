// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Env, UserSecret } from '../types';

function formatSecret(row: Record<string, unknown>): UserSecret {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    dashboardId: row.dashboard_id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

async function ensureDashboardAccess(
  env: Env,
  dashboardId: string,
  userId: string
): Promise<{ role: string } | null> {
  const access = await env.DB.prepare(
    `SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?`
  )
    .bind(dashboardId, userId)
    .first<{ role: string }>();
  return access ?? null;
}

export async function listSecrets(
  env: Env,
  userId: string,
  dashboardId: string | null
): Promise<Response> {
  if (!dashboardId) {
    return Response.json({ error: 'E79733: dashboard_id is required' }, { status: 400 });
  }

  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: 'E79734: Not found or no access' }, { status: 404 });
  }

  const rows = await env.DB.prepare(
    `SELECT id, user_id, dashboard_id, name, description, created_at, updated_at
     FROM user_secrets
     WHERE user_id = ? AND dashboard_id = ?
     ORDER BY updated_at DESC`
  )
    .bind(userId, dashboardId)
    .all();

  return Response.json({
    secrets: rows.results.map((row) => formatSecret(row as Record<string, unknown>)),
  });
}

export async function createSecret(
  env: Env,
  userId: string,
  data: Partial<UserSecret> & { value?: string }
): Promise<Response> {
  if (!data.dashboardId || !data.name || !data.value) {
    return Response.json({ error: 'E79731: dashboard_id, name, and value are required' }, { status: 400 });
  }

  const access = await ensureDashboardAccess(env, data.dashboardId, userId);
  if (!access || (access.role !== 'owner' && access.role !== 'editor')) {
    return Response.json({ error: 'E79735: Not found or no edit access' }, { status: 404 });
  }

  const id = crypto.randomUUID();
  const description = data.description || '';

  await env.DB.prepare(
    `INSERT INTO user_secrets (id, user_id, dashboard_id, name, value, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(id, userId, data.dashboardId, data.name, data.value, description)
    .run();

  const row = await env.DB.prepare(
    `SELECT id, user_id, dashboard_id, name, description, created_at, updated_at
     FROM user_secrets WHERE id = ?`
  )
    .bind(id)
    .first();

  return Response.json({ secret: formatSecret(row as Record<string, unknown>) });
}

export async function deleteSecret(
  env: Env,
  userId: string,
  id: string,
  dashboardId: string | null
): Promise<Response> {
  if (!dashboardId) {
    return Response.json({ error: 'E79736: dashboard_id is required' }, { status: 400 });
  }

  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access || (access.role !== 'owner' && access.role !== 'editor')) {
    return Response.json({ error: 'E79737: Not found or no edit access' }, { status: 404 });
  }

  const result = await env.DB.prepare(
    `DELETE FROM user_secrets WHERE id = ? AND user_id = ? AND dashboard_id = ?`
  )
    .bind(id, userId, dashboardId)
    .run();

  if (result.meta.changes === 0) {
    return Response.json({ error: 'E79732: Secret not found' }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}
