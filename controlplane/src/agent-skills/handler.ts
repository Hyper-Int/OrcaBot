// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Env, UserAgentSkill } from '../types';

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function formatAgentSkill(row: Record<string, unknown>): UserAgentSkill {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    command: (row.command as string) || '',
    args: safeParseJson<string[]>(row.args, []),
    source: (row.source as string) || 'custom',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function listAgentSkills(env: Env, userId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT * FROM user_agent_skills WHERE user_id = ? ORDER BY updated_at DESC`
  )
    .bind(userId)
    .all();

  return Response.json({
    skills: rows.results.map((row) => formatAgentSkill(row as Record<string, unknown>)),
  });
}

export async function createAgentSkill(
  env: Env,
  userId: string,
  data: Partial<UserAgentSkill>
): Promise<Response> {
  if (!data.name || !data.command) {
    return Response.json({ error: 'E79723: name and command are required' }, { status: 400 });
  }

  const id = data.id || crypto.randomUUID();
  const args = JSON.stringify(data.args || []);
  const description = data.description || '';
  const source = data.source || 'custom';

  await env.DB.prepare(
    `INSERT INTO user_agent_skills (id, user_id, name, description, command, args, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(id, userId, data.name, description, data.command, args, source)
    .run();

  const row = await env.DB.prepare(`SELECT * FROM user_agent_skills WHERE id = ?`)
    .bind(id)
    .first();

  return Response.json({ skill: formatAgentSkill(row as Record<string, unknown>) });
}

export async function deleteAgentSkill(env: Env, userId: string, id: string): Promise<Response> {
  const result = await env.DB.prepare(
    `DELETE FROM user_agent_skills WHERE id = ? AND user_id = ?`
  )
    .bind(id, userId)
    .run();

  if (result.meta.changes === 0) {
    return Response.json({ error: 'E79724: Agent skill not found' }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}
