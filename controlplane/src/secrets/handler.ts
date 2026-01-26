// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Env, UserSecret } from '../types';
import {
  encryptSecret,
  decryptSecret,
  getEncryptionKey,
  hasEncryptionKey,
  isEncryptedValue,
} from '../crypto/secrets';

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

  // Require encryption key - don't store plaintext secrets
  if (!hasEncryptionKey(env)) {
    return Response.json({ error: 'E79738: Secret encryption not configured' }, { status: 500 });
  }

  const access = await ensureDashboardAccess(env, data.dashboardId, userId);
  if (!access || (access.role !== 'owner' && access.role !== 'editor')) {
    return Response.json({ error: 'E79735: Not found or no edit access' }, { status: 404 });
  }

  const id = crypto.randomUUID();
  const description = data.description || '';

  // Encrypt the secret value before storing
  let encryptedValue: string;
  try {
    const key = await getEncryptionKey(env);
    encryptedValue = await encryptSecret(data.value, key);
  } catch (error) {
    console.error('Failed to encrypt secret:', error);
    return Response.json({ error: 'E79739: Failed to encrypt secret' }, { status: 500 });
  }

  await env.DB.prepare(
    `INSERT INTO user_secrets (id, user_id, dashboard_id, name, value, description, encrypted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`
  )
    .bind(id, userId, data.dashboardId, data.name, encryptedValue, description)
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

/**
 * Get decrypted secrets for a dashboard.
 * Used internally when applying secrets to a sandbox session.
 */
export async function getDecryptedSecretsForDashboard(
  env: Env,
  userId: string,
  dashboardId: string
): Promise<Record<string, string>> {
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access) {
    throw new Error('No access to dashboard');
  }

  if (!hasEncryptionKey(env)) {
    throw new Error('Encryption key not configured');
  }

  const rows = await env.DB.prepare(
    `SELECT name, value FROM user_secrets
     WHERE user_id = ? AND dashboard_id = ?`
  )
    .bind(userId, dashboardId)
    .all();

  const key = await getEncryptionKey(env);
  const result: Record<string, string> = {};

  for (const row of rows.results) {
    const name = row.name as string;
    const encryptedValue = row.value as string;

    try {
      // Handle both encrypted and legacy plaintext values
      if (isEncryptedValue(encryptedValue)) {
        result[name] = await decryptSecret(encryptedValue, key);
      } else {
        // Legacy plaintext value - return as-is (will be encrypted on next update)
        result[name] = encryptedValue;
      }
    } catch (error) {
      console.error(`Failed to decrypt secret ${name}:`, error);
      // Skip secrets that fail to decrypt rather than exposing errors
    }
  }

  return result;
}

/**
 * Migrate unencrypted secrets to encrypted format.
 * Internal endpoint called via POST /internal/migrate-secrets.
 */
export async function migrateUnencryptedSecrets(env: Env): Promise<Response> {
  if (!hasEncryptionKey(env)) {
    return Response.json({ error: 'E79741: Encryption key not configured' }, { status: 500 });
  }

  const key = await getEncryptionKey(env);

  // Find all secrets that haven't been encrypted yet
  const rows = await env.DB.prepare(
    `SELECT id, value FROM user_secrets WHERE encrypted_at IS NULL`
  ).all();

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows.results) {
    const id = row.id as string;
    const value = row.value as string;

    // Skip if already appears to be encrypted
    if (isEncryptedValue(value)) {
      await env.DB.prepare(
        `UPDATE user_secrets SET encrypted_at = datetime('now') WHERE id = ?`
      ).bind(id).run();
      skipped++;
      continue;
    }

    try {
      const encryptedValue = await encryptSecret(value, key);
      await env.DB.prepare(
        `UPDATE user_secrets SET value = ?, encrypted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).bind(encryptedValue, id).run();
      migrated++;
    } catch (error) {
      console.error(`Failed to migrate secret ${id}:`, error);
      failed++;
    }
  }

  return Response.json({
    migrated,
    skipped,
    failed,
    total: rows.results.length,
  });
}
