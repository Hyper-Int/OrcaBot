// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Env, UserMcpTool } from '../types';

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function fоrmatMcpTооl(row: Record<string, unknown>): UserMcpTool {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    serverUrl: (row.server_url as string) || '',
    transport: (row.transport as 'stdio' | 'sse' | 'streamable-http') || 'stdio',
    config: safeParseJson<Record<string, unknown>>(row.config, {}),
    source: (row.source as string) || 'custom',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function listMcpTооls(env: Env, userId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT * FROM user_mcp_tools WHERE user_id = ? ORDER BY updated_at DESC`
  )
    .bind(userId)
    .all();

  return Response.json({
    tools: rows.results.map((row) => fоrmatMcpTооl(row as Record<string, unknown>)),
  });
}

export async function createMcpTооl(
  env: Env,
  userId: string,
  data: Partial<UserMcpTool>
): Promise<Response> {
  if (!data.name || !data.serverUrl) {
    return Response.json({ error: 'E79101: name and serverUrl are required' }, { status: 400 });
  }

  const validTransports = ['stdio', 'sse', 'streamable-http'] as const;
  const transport = data.transport || 'stdio';
  if (!validTransports.includes(transport)) {
    return Response.json(
      { error: `transport must be one of: ${validTransports.join(', ')}` },
      { status: 400 }
    );
  }

  const id = data.id || crypto.randomUUID();
  const config = JSON.stringify(data.config || {});
  const description = data.description || '';
  const source = data.source || 'custom';

  await env.DB.prepare(
    `INSERT INTO user_mcp_tools (id, user_id, name, description, server_url, transport, config, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(id, userId, data.name, description, data.serverUrl, transport, config, source)
    .run();

  const row = await env.DB.prepare(`SELECT * FROM user_mcp_tools WHERE id = ?`)
    .bind(id)
    .first();

  return Response.json({ tool: fоrmatMcpTооl(row as Record<string, unknown>) });
}

export async function deleteMcpTооl(env: Env, userId: string, id: string): Promise<Response> {
  const result = await env.DB.prepare(
    `DELETE FROM user_mcp_tools WHERE id = ? AND user_id = ?`
  )
    .bind(id, userId)
    .run();

  if (result.meta.changes === 0) {
    return Response.json({ error: 'E79102: MCP tool not found' }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}

// Get MCP tools for a dashboard (used by sandbox to configure agent MCP servers)
export async function getMcpToolsForDashboard(env: Env, dashboardId: string): Promise<Response> {
  // Get dashboard owner
  const dashboard = await env.DB.prepare(
    `SELECT dm.user_id FROM dashboard_members dm WHERE dm.dashboard_id = ? AND dm.role = 'owner'`
  )
    .bind(dashboardId)
    .first<{ user_id: string }>();

  if (!dashboard) {
    return Response.json({ error: 'E79103: Dashboard not found' }, { status: 404 });
  }

  // Get owner's MCP tools
  const rows = await env.DB.prepare(
    `SELECT * FROM user_mcp_tools WHERE user_id = ? ORDER BY updated_at DESC`
  )
    .bind(dashboard.user_id)
    .all();

  return Response.json({
    tools: rows.results.map((row) => fоrmatMcpTооl(row as Record<string, unknown>)),
  });
}
