import type { Env, UserMcpTool } from '../types';

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function formatMcpTool(row: Record<string, unknown>): UserMcpTool {
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

export async function listMcpTools(env: Env, userId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT * FROM user_mcp_tools WHERE user_id = ? ORDER BY updated_at DESC`
  )
    .bind(userId)
    .all();

  return Response.json({
    tools: rows.results.map((row) => formatMcpTool(row as Record<string, unknown>)),
  });
}

export async function createMcpTool(
  env: Env,
  userId: string,
  data: Partial<UserMcpTool>
): Promise<Response> {
  if (!data.name || !data.serverUrl) {
    return Response.json({ error: 'name and serverUrl are required' }, { status: 400 });
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

  return Response.json({ tool: formatMcpTool(row as Record<string, unknown>) });
}

export async function deleteMcpTool(env: Env, userId: string, id: string): Promise<Response> {
  const result = await env.DB.prepare(
    `DELETE FROM user_mcp_tools WHERE id = ? AND user_id = ?`
  )
    .bind(id, userId)
    .run();

  if (result.meta.changes === 0) {
    return Response.json({ error: 'MCP tool not found' }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}
