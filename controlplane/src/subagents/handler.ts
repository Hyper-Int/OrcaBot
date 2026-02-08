// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Env, UserSubagent } from '../types';

/**
 * Safely parse JSON with a fallback value.
 * Prevents crashes from corrupted database entries.
 */
function safеJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    console.error('Failed to parse JSON:', error, 'Input:', json?.substring(0, 100));
    return fallback;
  }
}

function formatSubagent(row: Record<string, unknown>): UserSubagent {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    prompt: (row.prompt as string) || '',
    tools: safеJsonParse<string[]>((row.tools as string) || '[]', []),
    source: (row.source as string) || 'custom',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function listSubagents(env: Env, userId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT * FROM user_subagents WHERE user_id = ? ORDER BY updated_at DESC`
  )
    .bind(userId)
    .all();

  return Response.json({
    subagents: rows.results.map((row) => formatSubagent(row as Record<string, unknown>)),
  });
}

export async function createSubagent(
  env: Env,
  userId: string,
  data: Partial<UserSubagent>
): Promise<Response> {
  if (!data.name || !data.prompt) {
    return Response.json({ error: 'E79721: name and prompt are required' }, { status: 400 });
  }

  const id = data.id || crypto.randomUUID();
  const tools = JSON.stringify(data.tools || []);
  const description = data.description || '';
  const source = data.source || 'custom';

  await env.DB.prepare(
    `INSERT INTO user_subagents (id, user_id, name, description, prompt, tools, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(id, userId, data.name, description, data.prompt, tools, source)
    .run();

  const row = await env.DB.prepare(`SELECT * FROM user_subagents WHERE id = ?`)
    .bind(id)
    .first();

  return Response.json({ subagent: formatSubagent(row as Record<string, unknown>) });
}

export async function deleteSubagent(env: Env, userId: string, id: string): Promise<Response> {
  const result = await env.DB.prepare(
    `DELETE FROM user_subagents WHERE id = ? AND user_id = ?`
  )
    .bind(id, userId)
    .run();

  if (result.meta.changes === 0) {
    return Response.json({ error: 'E79722: Subagent not found' }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}
