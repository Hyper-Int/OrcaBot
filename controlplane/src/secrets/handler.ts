// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Env, UserSecret, SecretType } from '../types';
import {
  encryptSecret,
  decryptSecret,
  getEncryptionKey,
  hasEncryptionKey,
  isEncryptedValue,
} from '../crypto/secrets';
import { SandboxClient } from '../sandbox/client';

/**
 * Auto-apply secrets to all active sessions for affected dashboards.
 * Called after secret CRUD operations to keep .env files in sync.
 *
 * @param env - Environment
 * @param userId - User who owns the secrets
 * @param dashboardId - Dashboard ID or '_global' for global secrets
 */
async function autoApplySecretsToSessions(
  env: Env,
  userId: string,
  dashboardId: string
): Promise<void> {
  const isGlobal = dashboardId === GLOBAL_SECRETS_ID;

  try {
    // Find active sessions that need updating
    // For global secrets: all user's active sessions
    // For dashboard secrets: only that dashboard's sessions
    let sessions;
    if (isGlobal) {
      // Global secret changed - update all user's dashboards with active sessions
      sessions = await env.DB.prepare(`
        SELECT s.id, s.dashboard_id, s.sandbox_session_id, s.sandbox_machine_id
        FROM sessions s
        JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
        WHERE dm.user_id = ? AND s.status = 'active' AND s.sandbox_session_id IS NOT NULL
      `).bind(userId).all();
    } else {
      // Dashboard secret changed - only update that dashboard's sessions
      sessions = await env.DB.prepare(`
        SELECT id, dashboard_id, sandbox_session_id, sandbox_machine_id
        FROM sessions
        WHERE dashboard_id = ? AND status = 'active' AND sandbox_session_id IS NOT NULL
      `).bind(dashboardId).all();
    }

    if (!sessions.results || sessions.results.length === 0) {
      console.log(`[secrets] No active sessions to update for ${isGlobal ? 'global' : dashboardId}`);
      return;
    }

    console.log(`[secrets] Auto-applying secrets to ${sessions.results.length} active session(s)`);

    const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);

    // Process each session - get fresh secrets and apply
    // Use a Set to avoid processing same dashboard twice (for global secrets)
    const processedDashboards = new Set<string>();

    for (const session of sessions.results) {
      const sessionDashboardId = session.dashboard_id as string;
      const sandboxSessionId = session.sandbox_session_id as string;
      const sandboxMachineId = session.sandbox_machine_id as string;

      // Skip if we already processed this dashboard (can happen with global secrets)
      if (processedDashboards.has(sessionDashboardId)) {
        continue;
      }
      processedDashboards.add(sessionDashboardId);

      try {
        // Get fresh secrets for this dashboard
        const secrets = await getSecretsWithProtection(env, userId, sessionDashboardId);

        // Get previously applied secrets to compute unset list
        const dashboardSandbox = await env.DB.prepare(`
          SELECT applied_secret_names FROM dashboard_sandboxes WHERE dashboard_id = ?
        `).bind(sessionDashboardId).first<{ applied_secret_names: string }>();

        const previousNames: string[] = dashboardSandbox?.applied_secret_names
          ? JSON.parse(dashboardSandbox.applied_secret_names)
          : [];
        const currentNames = Object.keys(secrets);

        // Compute what to unset
        const unset: string[] = [];
        for (const name of previousNames) {
          if (!currentNames.includes(name)) {
            unset.push(name);
            unset.push(`${name}_BROKER`);
          }
        }

        console.log(`[secrets] Applying to session ${sandboxSessionId}: ${currentNames.length} secrets, ${unset.length} to unset`);

        // Apply to sandbox
        await sandbox.updateEnv(
          sandboxSessionId,
          { secrets, unset: unset.length > 0 ? unset : undefined, applyNow: false },
          sandboxMachineId || undefined
        );

        // Update tracking
        await env.DB.prepare(`
          INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, applied_secret_names, created_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(dashboard_id) DO UPDATE SET applied_secret_names = excluded.applied_secret_names
        `).bind(sessionDashboardId, sandboxSessionId, sandboxMachineId || '', JSON.stringify(currentNames)).run();

      } catch (error) {
        console.error(`[secrets] Failed to apply to session ${sandboxSessionId}:`, error);
        // Continue with other sessions
      }
    }
  } catch (error) {
    console.error('[secrets] Failed to auto-apply secrets:', error);
    // Non-fatal - don't throw
  }
}

function formatSecret(row: Record<string, unknown>): UserSecret {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    dashboardId: row.dashboard_id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    type: (row.type as SecretType) || 'secret', // Default to 'secret' for backwards compatibility
    brokerProtected: row.broker_protected !== 0, // SQLite stores boolean as 0/1
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

// Special dashboard_id value for user-global secrets
const GLOBAL_SECRETS_ID = '_global';

export async function listSecrets(
  env: Env,
  userId: string,
  dashboardId: string | null,
  type?: SecretType
): Promise<Response> {
  // Allow listing global secrets with '_global' or empty dashboard_id
  const isGlobal = !dashboardId || dashboardId === GLOBAL_SECRETS_ID;
  const effectiveDashboardId = isGlobal ? GLOBAL_SECRETS_ID : dashboardId;

  // For non-global secrets, check dashboard access
  if (!isGlobal) {
    const access = await ensureDashboardAccess(env, dashboardId!, userId);
    if (!access) {
      return Response.json({ error: 'E79734: Not found or no access' }, { status: 404 });
    }
  }

  let query = `SELECT id, user_id, dashboard_id, name, description, type, broker_protected, created_at, updated_at
     FROM user_secrets
     WHERE user_id = ? AND dashboard_id = ?`;
  const params: unknown[] = [userId, effectiveDashboardId];

  if (type) {
    query += ` AND type = ?`;
    params.push(type);
  }

  query += ` ORDER BY updated_at DESC`;

  const rows = await env.DB.prepare(query).bind(...params).all();

  return Response.json({
    secrets: rows.results.map((row) => formatSecret(row as Record<string, unknown>)),
  });
}

export async function createSecret(
  env: Env,
  userId: string,
  data: Partial<UserSecret> & { value?: string; brokerProtected?: boolean; type?: SecretType }
): Promise<Response> {
  if (!data.name || !data.value) {
    return Response.json({ error: 'E79731: name and value are required' }, { status: 400 });
  }

  // Require encryption key - don't store plaintext secrets
  if (!hasEncryptionKey(env)) {
    return Response.json({ error: 'E79738: Secret encryption not configured' }, { status: 500 });
  }

  // Determine if this is a global secret or dashboard-specific
  const isGlobal = !data.dashboardId || data.dashboardId === GLOBAL_SECRETS_ID;
  const effectiveDashboardId = isGlobal ? GLOBAL_SECRETS_ID : data.dashboardId!;

  // For non-global secrets, check dashboard access
  if (!isGlobal) {
    const access = await ensureDashboardAccess(env, data.dashboardId!, userId);
    if (!access || (access.role !== 'owner' && access.role !== 'editor')) {
      return Response.json({ error: 'E79735: Not found or no edit access' }, { status: 404 });
    }
  }

  const id = crypto.randomUUID();
  const description = data.description || '';
  // Default type to 'secret' if not specified
  const type: SecretType = data.type || 'secret';
  // For env_var type, broker protection is always false (they're set directly)
  // For secret type, default to broker protected (true) unless explicitly set to false
  const brokerProtected = type === 'env_var' ? 0 : (data.brokerProtected !== false ? 1 : 0);

  console.log(`[secrets] Creating secret: name=${data.name}, type=${type}, brokerProtected=${brokerProtected}, data.type=${data.type}`);

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
    `INSERT INTO user_secrets (id, user_id, dashboard_id, name, value, description, type, broker_protected, encrypted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`
  )
    .bind(id, userId, effectiveDashboardId, data.name, encryptedValue, description, type, brokerProtected)
    .run();

  const row = await env.DB.prepare(
    `SELECT id, user_id, dashboard_id, name, description, type, broker_protected, created_at, updated_at
     FROM user_secrets WHERE id = ?`
  )
    .bind(id)
    .first();

  // Auto-apply to active sessions (non-blocking)
  autoApplySecretsToSessions(env, userId, effectiveDashboardId).catch(err => {
    console.error('[secrets] Background auto-apply failed:', err);
  });

  return Response.json({ secret: formatSecret(row as Record<string, unknown>) });
}

export async function deleteSecret(
  env: Env,
  userId: string,
  id: string,
  dashboardId: string | null
): Promise<Response> {
  // Allow deleting global secrets with '_global' or empty dashboard_id
  const isGlobal = !dashboardId || dashboardId === GLOBAL_SECRETS_ID;
  const effectiveDashboardId = isGlobal ? GLOBAL_SECRETS_ID : dashboardId;

  // For non-global secrets, check dashboard access
  if (!isGlobal) {
    const access = await ensureDashboardAccess(env, dashboardId!, userId);
    if (!access || (access.role !== 'owner' && access.role !== 'editor')) {
      return Response.json({ error: 'E79737: Not found or no edit access' }, { status: 404 });
    }
  }

  const result = await env.DB.prepare(
    `DELETE FROM user_secrets WHERE id = ? AND user_id = ? AND dashboard_id = ?`
  )
    .bind(id, userId, effectiveDashboardId)
    .run();

  if (result.meta.changes === 0) {
    return Response.json({ error: 'E79732: Secret not found' }, { status: 404 });
  }

  // Auto-apply to active sessions (non-blocking) - this will remove the deleted secret
  autoApplySecretsToSessions(env, userId, effectiveDashboardId).catch(err => {
    console.error('[secrets] Background auto-apply failed:', err);
  });

  return new Response(null, { status: 204 });
}

/**
 * Secret config with broker protection info - used when sending to sandbox.
 */
export interface SecretWithProtection {
  value: string;
  brokerProtected: boolean;
}

/**
 * Get decrypted secrets for a dashboard.
 * Includes both dashboard-specific secrets AND user's global secrets.
 * Used internally when applying secrets to a sandbox session.
 * @deprecated Use getSecretsWithProtection for broker support
 */
export async function getDecryptedSecretsForDashboard(
  env: Env,
  userId: string,
  dashboardId: string
): Promise<Record<string, string>> {
  const secrets = await getSecretsWithProtection(env, userId, dashboardId);
  const result: Record<string, string> = {};
  for (const [name, config] of Object.entries(secrets)) {
    result[name] = config.value;
  }
  return result;
}

/**
 * Get decrypted secrets with broker protection info for a dashboard.
 * Includes both dashboard-specific secrets AND user's global secrets.
 * Used internally when applying secrets to a sandbox session.
 *
 * For type='secret': brokerProtected is respected (default true)
 * For type='env_var': always brokerProtected=false (set directly)
 */
export async function getSecretsWithProtection(
  env: Env,
  userId: string,
  dashboardId: string
): Promise<Record<string, SecretWithProtection>> {
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access) {
    throw new Error('No access to dashboard');
  }

  if (!hasEncryptionKey(env)) {
    throw new Error('Encryption key not configured');
  }

  // Fetch both global secrets and dashboard-specific secrets
  // Dashboard-specific secrets override global ones with the same name
  // Order: global secrets first (0), then dashboard-specific (1) so dashboard-specific can override
  const rows = await env.DB.prepare(
    `SELECT name, value, type, broker_protected, dashboard_id FROM user_secrets
     WHERE user_id = ? AND (dashboard_id = ? OR dashboard_id = ?)
     ORDER BY CASE WHEN dashboard_id = ? THEN 0 ELSE 1 END`
  )
    .bind(userId, GLOBAL_SECRETS_ID, dashboardId, GLOBAL_SECRETS_ID)
    .all();

  const key = await getEncryptionKey(env);
  const result: Record<string, SecretWithProtection> = {};

  for (const row of rows.results) {
    const name = row.name as string;
    const encryptedValue = row.value as string;
    const type = (row.type as SecretType) || 'secret';
    // env_var type is never brokered - always set directly
    // secret type respects the broker_protected flag
    const brokerProtected = type === 'env_var' ? false : row.broker_protected !== 0;

    console.log(`[secrets] Processing secret: name=${name}, type=${type}, broker_protected_db=${row.broker_protected}, brokerProtected=${brokerProtected}`);

    try {
      // Handle both encrypted and legacy plaintext values
      let decryptedValue: string;
      if (isEncryptedValue(encryptedValue)) {
        decryptedValue = await decryptSecret(encryptedValue, key);
      } else {
        // Legacy plaintext value - return as-is (will be encrypted on next update)
        decryptedValue = encryptedValue;
      }
      result[name] = { value: decryptedValue, brokerProtected };
    } catch (error) {
      console.error(`Failed to decrypt secret ${name}:`, error);
      // Skip secrets that fail to decrypt rather than exposing errors
    }
  }

  return result;
}

/**
 * Update a secret's broker protection setting.
 */
export async function updateSecretProtection(
  env: Env,
  userId: string,
  secretId: string,
  dashboardId: string | null,
  brokerProtected: boolean
): Promise<Response> {
  // Allow updating global secrets with '_global' or empty dashboard_id
  const isGlobal = !dashboardId || dashboardId === GLOBAL_SECRETS_ID;
  const effectiveDashboardId = isGlobal ? GLOBAL_SECRETS_ID : dashboardId;

  // For non-global secrets, check dashboard access
  if (!isGlobal) {
    const access = await ensureDashboardAccess(env, dashboardId!, userId);
    if (!access || (access.role !== 'owner' && access.role !== 'editor')) {
      return Response.json({ error: 'E79736: Not found or no edit access' }, { status: 404 });
    }
  }

  const result = await env.DB.prepare(
    `UPDATE user_secrets SET broker_protected = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ? AND dashboard_id = ?`
  )
    .bind(brokerProtected ? 1 : 0, secretId, userId, effectiveDashboardId)
    .run();

  if (result.meta.changes === 0) {
    return Response.json({ error: 'E79733: Secret not found' }, { status: 404 });
  }

  const row = await env.DB.prepare(
    `SELECT id, user_id, dashboard_id, name, description, type, broker_protected, created_at, updated_at
     FROM user_secrets WHERE id = ?`
  )
    .bind(secretId)
    .first();

  // Auto-apply to active sessions (non-blocking) - protection change affects broker config
  autoApplySecretsToSessions(env, userId, effectiveDashboardId).catch(err => {
    console.error('[secrets] Background auto-apply failed:', err);
  });

  return Response.json({ secret: formatSecret(row as Record<string, unknown>) });
}

/**
 * Get decrypted global secrets for a user.
 * Used for listing in the UI.
 */
export async function getDecryptedGlobalSecrets(
  env: Env,
  userId: string
): Promise<Record<string, string>> {
  if (!hasEncryptionKey(env)) {
    throw new Error('Encryption key not configured');
  }

  const rows = await env.DB.prepare(
    `SELECT name, value FROM user_secrets
     WHERE user_id = ? AND dashboard_id = ?`
  )
    .bind(userId, GLOBAL_SECRETS_ID)
    .all();

  const key = await getEncryptionKey(env);
  const result: Record<string, string> = {};

  for (const row of rows.results) {
    const name = row.name as string;
    const encryptedValue = row.value as string;

    try {
      if (isEncryptedValue(encryptedValue)) {
        result[name] = await decryptSecret(encryptedValue, key);
      } else {
        result[name] = encryptedValue;
      }
    } catch (error) {
      console.error(`Failed to decrypt secret ${name}:`, error);
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

// ============================================
// Domain Allowlist (for custom secrets)
// ============================================

export interface DomainAllowlistEntry {
  id: string;
  secretId: string;
  domain: string;
  headerName: string;
  headerFormat: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface PendingApproval {
  id: string;
  secretId: string;
  secretName: string;
  domain: string;
  requestedAt: string;
}

function formatAllowlistEntry(row: Record<string, unknown>): DomainAllowlistEntry {
  return {
    id: row.id as string,
    secretId: row.secret_id as string,
    domain: row.domain as string,
    headerName: row.header_name as string,
    headerFormat: row.header_format as string,
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    revokedAt: row.revoked_at as string | null,
  };
}

/**
 * List approved domains for a secret.
 */
export async function listSecretAllowlist(
  env: Env,
  userId: string,
  secretId: string,
  dashboardId: string | null
): Promise<Response> {
  // Verify ownership of the secret
  const isGlobal = !dashboardId || dashboardId === GLOBAL_SECRETS_ID;
  const effectiveDashboardId = isGlobal ? GLOBAL_SECRETS_ID : dashboardId;

  const secret = await env.DB.prepare(
    `SELECT id FROM user_secrets WHERE id = ? AND user_id = ? AND dashboard_id = ?`
  )
    .bind(secretId, userId, effectiveDashboardId)
    .first();

  if (!secret) {
    return Response.json({ error: 'E79750: Secret not found' }, { status: 404 });
  }

  const rows = await env.DB.prepare(
    `SELECT id, secret_id, domain, header_name, header_format, created_by, created_at, revoked_at
     FROM user_secret_allowlist
     WHERE secret_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC`
  )
    .bind(secretId)
    .all();

  return Response.json({
    allowlist: rows.results.map((row) => formatAllowlistEntry(row as Record<string, unknown>)),
  });
}

/**
 * Approve a domain for a custom secret.
 */
export async function approveSecretDomain(
  env: Env,
  userId: string,
  secretId: string,
  dashboardId: string | null,
  data: { domain: string; headerName?: string; headerFormat?: string }
): Promise<Response> {
  if (!data.domain) {
    return Response.json({ error: 'E79751: domain is required' }, { status: 400 });
  }

  // Validate domain format
  const domain = data.domain.toLowerCase().trim();
  if (!domain || domain.includes('/') || domain.includes(' ')) {
    return Response.json({ error: 'E79752: Invalid domain format' }, { status: 400 });
  }

  // Verify ownership of the secret
  const isGlobal = !dashboardId || dashboardId === GLOBAL_SECRETS_ID;
  const effectiveDashboardId = isGlobal ? GLOBAL_SECRETS_ID : dashboardId;

  const secret = await env.DB.prepare(
    `SELECT id FROM user_secrets WHERE id = ? AND user_id = ? AND dashboard_id = ?`
  )
    .bind(secretId, userId, effectiveDashboardId)
    .first();

  if (!secret) {
    return Response.json({ error: 'E79750: Secret not found' }, { status: 404 });
  }

  // Check if already approved
  const existing = await env.DB.prepare(
    `SELECT id FROM user_secret_allowlist WHERE secret_id = ? AND domain = ? AND revoked_at IS NULL`
  )
    .bind(secretId, domain)
    .first();

  if (existing) {
    return Response.json({ error: 'E79753: Domain already approved' }, { status: 409 });
  }

  const id = crypto.randomUUID();
  const headerName = data.headerName || 'Authorization';
  const headerFormat = data.headerFormat || 'Bearer %s';

  await env.DB.prepare(
    `INSERT INTO user_secret_allowlist (id, secret_id, domain, header_name, header_format, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  )
    .bind(id, secretId, domain, headerName, headerFormat, userId)
    .run();

  // Dismiss any pending approval for this domain
  await env.DB.prepare(
    `UPDATE pending_domain_approvals SET dismissed_at = datetime('now')
     WHERE secret_id = ? AND domain = ? AND dismissed_at IS NULL`
  )
    .bind(secretId, domain)
    .run();

  const row = await env.DB.prepare(
    `SELECT id, secret_id, domain, header_name, header_format, created_by, created_at, revoked_at
     FROM user_secret_allowlist WHERE id = ?`
  )
    .bind(id)
    .first();

  return Response.json({ entry: formatAllowlistEntry(row as Record<string, unknown>) });
}

/**
 * Revoke domain approval for a secret.
 */
export async function revokeSecretDomain(
  env: Env,
  userId: string,
  secretId: string,
  entryId: string,
  dashboardId: string | null
): Promise<Response> {
  // Verify ownership of the secret
  const isGlobal = !dashboardId || dashboardId === GLOBAL_SECRETS_ID;
  const effectiveDashboardId = isGlobal ? GLOBAL_SECRETS_ID : dashboardId;

  const secret = await env.DB.prepare(
    `SELECT id FROM user_secrets WHERE id = ? AND user_id = ? AND dashboard_id = ?`
  )
    .bind(secretId, userId, effectiveDashboardId)
    .first();

  if (!secret) {
    return Response.json({ error: 'E79750: Secret not found' }, { status: 404 });
  }

  const result = await env.DB.prepare(
    `UPDATE user_secret_allowlist SET revoked_at = datetime('now')
     WHERE id = ? AND secret_id = ? AND revoked_at IS NULL`
  )
    .bind(entryId, secretId)
    .run();

  if (result.meta.changes === 0) {
    return Response.json({ error: 'E79754: Allowlist entry not found' }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}

/**
 * List pending domain approval requests for a user's secrets.
 */
export async function listPendingApprovals(
  env: Env,
  userId: string,
  dashboardId: string | null
): Promise<Response> {
  // Get all pending approvals for secrets owned by this user
  const isGlobal = !dashboardId || dashboardId === GLOBAL_SECRETS_ID;

  let query: string;
  let params: unknown[];

  if (isGlobal) {
    // List all pending approvals for the user's global secrets
    query = `
      SELECT p.id, p.secret_id, p.domain, p.requested_at, s.name as secret_name
      FROM pending_domain_approvals p
      JOIN user_secrets s ON p.secret_id = s.id
      WHERE s.user_id = ? AND s.dashboard_id = ? AND p.dismissed_at IS NULL
      ORDER BY p.requested_at DESC
    `;
    params = [userId, GLOBAL_SECRETS_ID];
  } else {
    // List pending approvals for both global and dashboard-specific secrets
    query = `
      SELECT p.id, p.secret_id, p.domain, p.requested_at, s.name as secret_name
      FROM pending_domain_approvals p
      JOIN user_secrets s ON p.secret_id = s.id
      WHERE s.user_id = ? AND (s.dashboard_id = ? OR s.dashboard_id = ?) AND p.dismissed_at IS NULL
      ORDER BY p.requested_at DESC
    `;
    params = [userId, GLOBAL_SECRETS_ID, dashboardId];
  }

  const rows = await env.DB.prepare(query).bind(...params).all();

  const approvals: PendingApproval[] = rows.results.map((row) => ({
    id: row.id as string,
    secretId: row.secret_id as string,
    secretName: row.secret_name as string,
    domain: row.domain as string,
    requestedAt: row.requested_at as string,
  }));

  return Response.json({ pendingApprovals: approvals });
}

/**
 * Dismiss a pending approval (deny the request).
 */
export async function dismissPendingApproval(
  env: Env,
  userId: string,
  approvalId: string
): Promise<Response> {
  // Verify this pending approval is for a secret owned by the user
  const approval = await env.DB.prepare(
    `SELECT p.id, s.user_id
     FROM pending_domain_approvals p
     JOIN user_secrets s ON p.secret_id = s.id
     WHERE p.id = ? AND s.user_id = ? AND p.dismissed_at IS NULL`
  )
    .bind(approvalId, userId)
    .first();

  if (!approval) {
    return Response.json({ error: 'E79755: Pending approval not found' }, { status: 404 });
  }

  await env.DB.prepare(
    `UPDATE pending_domain_approvals SET dismissed_at = datetime('now') WHERE id = ?`
  )
    .bind(approvalId)
    .run();

  return new Response(null, { status: 204 });
}

/**
 * Get domain allowlist entries for a secret (for sandbox to use).
 * Internal function - no auth check.
 */
export async function getAllowlistForSecret(
  env: Env,
  secretId: string
): Promise<DomainAllowlistEntry[]> {
  const rows = await env.DB.prepare(
    `SELECT id, secret_id, domain, header_name, header_format, created_by, created_at, revoked_at
     FROM user_secret_allowlist
     WHERE secret_id = ? AND revoked_at IS NULL`
  )
    .bind(secretId)
    .all();

  return rows.results.map((row) => formatAllowlistEntry(row as Record<string, unknown>));
}

/**
 * Create a pending domain approval request (called by sandbox broker).
 * Internal function - no auth check.
 */
export async function createPendingApproval(
  env: Env,
  secretId: string,
  domain: string
): Promise<void> {
  // Check if already pending
  const existing = await env.DB.prepare(
    `SELECT id FROM pending_domain_approvals WHERE secret_id = ? AND domain = ? AND dismissed_at IS NULL`
  )
    .bind(secretId, domain)
    .first();

  if (existing) {
    return; // Already pending
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO pending_domain_approvals (id, secret_id, domain, requested_at)
     VALUES (?, ?, ?, datetime('now'))`
  )
    .bind(id, secretId, domain)
    .run();
}
