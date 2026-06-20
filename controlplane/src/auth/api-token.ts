// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: api-token-v1-pat

/**
 * Personal access tokens (PATs) for CLI / external tools (`orcabot push`/`pull`).
 *
 * Issuance sits behind the normal user auth (Cloudflare Access in prod, dev-auth
 * locally) — see the routes in index.ts. The plaintext token is shown exactly
 * once at creation; only its SHA-256 hash is stored. Bearer presentation is
 * validated in auth/middleware.ts (prefix-gated so it never collides with the
 * PTY/gateway JWT bearer tokens, which are verified elsewhere).
 *
 * A PAT inherits the owning user's identity — and therefore their subscription
 * status — so the paywall applies to CLI writes exactly as it does in the UI.
 */

import type { Env, User } from '../types';

export const PAT_PREFIX = 'orca_pat_';

/** SHA-256 hex of the given string. */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${PAT_PREFIX}${body}`;
}

export interface ApiTokenMeta {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** Create a PAT for a user. Returns the plaintext token (shown once) + metadata. */
export async function createApiToken(
  env: Env,
  userId: string,
  name: string,
  ttlDays?: number
): Promise<{ token: string; meta: ApiTokenMeta }> {
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt =
    ttlDays && ttlDays > 0
      ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

  await env.DB.prepare(
    `INSERT INTO api_tokens (id, user_id, token_hash, name, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, userId, tokenHash, name || 'cli', createdAt, expiresAt)
    .run();

  return {
    token,
    meta: { id, name: name || 'cli', createdAt, lastUsedAt: null, expiresAt },
  };
}

/** List a user's PATs (metadata only — never the hash or plaintext). */
export async function listApiTokens(env: Env, userId: string): Promise<ApiTokenMeta[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name, created_at, last_used_at, expires_at
     FROM api_tokens
     WHERE user_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC`
  )
    .bind(userId)
    .all<{
      id: string;
      name: string;
      created_at: string;
      last_used_at: string | null;
      expires_at: string | null;
    }>();
  return (rows.results || []).map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
  }));
}

/** Revoke a PAT by id (must belong to the user). Returns true if a row was revoked. */
export async function revokeApiToken(env: Env, userId: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE api_tokens SET revoked_at = datetime('now')
     WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
  )
    .bind(id, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Resolve a bearer PAT to a user. Returns null if the token is malformed,
 * unknown, revoked, or expired. Fail-closed. Updates last_used_at on success.
 */
export async function getUserForApiToken(env: Env, token: string): Promise<User | null> {
  if (!token.startsWith(PAT_PREFIX)) return null;
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare(
    `SELECT t.id as token_id, t.expires_at as expires_at, t.revoked_at as revoked_at,
            u.id as id, u.email as email, u.name as name,
            u.created_at as created_at, u.trial_started_at as trial_started_at
     FROM api_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ?`
  )
    .bind(tokenHash)
    .first<{
      token_id: string;
      expires_at: string | null;
      revoked_at: string | null;
      id: string;
      email: string;
      name: string;
      created_at: string;
      trial_started_at: string | null;
    }>();

  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

  // Best-effort last-used stamp (don't fail auth if it errors).
  try {
    await env.DB.prepare(`UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?`)
      .bind(row.token_id)
      .run();
  } catch {
    // ignore
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.trial_started_at || row.created_at,
  };
}
