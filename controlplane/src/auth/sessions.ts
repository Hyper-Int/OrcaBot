// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Env, User } from '../types';

export const SESSION_COOKIE_NAME = 'orcabot_session';
const SESSION_MAX_AGE_DAYS = 30;

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }

  for (const part of header.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (!name) continue;
    const value = valueParts.join('=');
    cookies.set(name, value);
  }

  return cookies;
}

export function readSessionId(request: Request): string | null {
  const cookies = parseCookies(request.headers.get('Cookie'));
  return cookies.get(SESSION_COOKIE_NAME) || null;
}

export async function getUserForSession(
  request: Request,
  env: Env
): Promise<User | null> {
  const sessionId = readSessionId(request);
  if (!sessionId) {
    return null;
  }

  const record = await env.DB.prepare(`
    SELECT
      users.id as id,
      users.email as email,
      users.name as name,
      users.created_at as created_at,
      users.trial_started_at as trial_started_at
    FROM user_sessions
    JOIN users ON users.id = user_sessions.user_id
    WHERE user_sessions.id = ? AND user_sessions.expires_at > datetime('now')
  `).bind(sessionId).first<{
    id: string;
    email: string;
    name: string;
    created_at: string;
    trial_started_at: string | null;
  }>();

  if (!record) {
    return null;
  }

  return {
    id: record.id,
    email: record.email,
    name: record.name,
    // Use trial_started_at for trial countdown (falls back to created_at for users
    // who haven't logged in since the subscription system was deployed)
    createdAt: record.trial_started_at || record.created_at,
  };
}

export async function createUserSession(
  env: Env,
  userId: string
): Promise<{ id: string; expiresAt: string }> {
  const id = crypto.randomUUID();
  const expiresAt = new Date(
    Date.now() + SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  await env.DB.prepare(`
    INSERT INTO user_sessions (id, user_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(id, userId, expiresAt).run();

  return { id, expiresAt };
}

export function buildSessionCookie(
  request: Request,
  sessionId: string,
  expiresAt: string
): string {
  const expiresDate = new Date(expiresAt);
  const maxAgeSeconds = Math.max(
    0,
    Math.floor((expiresDate.getTime() - Date.now()) / 1000)
  );
  const isSecure = new URL(request.url).protocol === 'https:';
  const sameSite = isSecure ? 'None' : 'Lax';

  const parts = [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    `SameSite=${sameSite}`,
  ];

  if (isSecure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

export async function deleteUserSession(
  env: Env,
  sessionId: string
): Promise<void> {
  await env.DB.prepare(`
    DELETE FROM user_sessions WHERE id = ?
  `).bind(sessionId).run();
}

export function buildClearSessionCookie(request: Request): string {
  const isSecure = new URL(request.url).protocol === 'https:';
  const sameSite = isSecure ? 'None' : 'Lax';
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    `SameSite=${sameSite}`,
  ];
  if (isSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}
