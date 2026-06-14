// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// CRUD for per-user custom model endpoints (Ollama / vLLM / self-hosted / cloud BYO).
// See PLAN-custom-endpoints.md. The API key, if any, lives in user_secrets and is
// referenced by secret_name — never stored here.

import type { Env, UserModelProvider } from '../types';

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    console.error('[model-providers] bad JSON:', error, json?.substring(0, 100));
    return fallback;
  }
}

function formatProvider(row: Record<string, unknown>): UserModelProvider {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    label: row.label as string,
    baseUrl: row.base_url as string,
    format: ((row.format as string) || 'openai') as 'openai' | 'anthropic',
    modelId: row.model_id as string,
    secretName: (row.secret_name as string) || undefined,
    contextWindow: row.context_window == null ? undefined : Number(row.context_window),
    maxOutputTokens: row.max_output_tokens == null ? undefined : Number(row.max_output_tokens),
    compatibleHarnesses: safeJsonParse<string[]>((row.compatible_harnesses as string) || '[]', []),
    isLocal: Number(row.is_local) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Validate the base URL: http/https only, parseable. Returns the parsed URL or null. */
function validateBaseUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

export async function listModelProviders(env: Env, userId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT * FROM user_model_providers WHERE user_id = ? ORDER BY updated_at DESC`
  )
    .bind(userId)
    .all();

  return Response.json({
    providers: rows.results.map((row) => formatProvider(row as Record<string, unknown>)),
  });
}

export async function createModelProvider(
  env: Env,
  userId: string,
  data: Partial<UserModelProvider>
): Promise<Response> {
  if (!data.label || !data.baseUrl || !data.modelId) {
    return Response.json(
      { error: 'E79901: label, baseUrl, and modelId are required' },
      { status: 400 }
    );
  }
  if (!validateBaseUrl(data.baseUrl)) {
    return Response.json({ error: 'E79902: baseUrl must be a valid http(s) URL' }, { status: 400 });
  }
  const format = data.format === 'anthropic' ? 'anthropic' : 'openai';

  const id = data.id || crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO user_model_providers
       (id, user_id, label, base_url, format, model_id, secret_name,
        context_window, max_output_tokens, compatible_harnesses, is_local, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(
      id,
      userId,
      data.label,
      data.baseUrl,
      format,
      data.modelId,
      data.secretName || null,
      data.contextWindow ?? null,
      data.maxOutputTokens ?? null,
      JSON.stringify(data.compatibleHarnesses || []),
      data.isLocal ? 1 : 0
    )
    .run();

  const row = await env.DB.prepare(`SELECT * FROM user_model_providers WHERE id = ?`)
    .bind(id)
    .first();

  return Response.json({ provider: formatProvider(row as Record<string, unknown>) });
}

export async function deleteModelProvider(env: Env, userId: string, id: string): Promise<Response> {
  const result = await env.DB.prepare(
    `DELETE FROM user_model_providers WHERE id = ? AND user_id = ?`
  )
    .bind(id, userId)
    .run();

  if (result.meta.changes === 0) {
    return Response.json({ error: 'E79903: Model provider not found' }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}
