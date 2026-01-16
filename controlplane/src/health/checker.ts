// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Background Health Checker
 *
 * Periodically checks sandbox health and caches the result in D1.
 * This prevents amplification attacks via /health endpoint.
 */

import type { Env } from '../types';
import { SandboxClient } from '../sandbox/client';

export interface HealthStatus {
  service: string;
  isHealthy: boolean;
  lastCheckAt: string;
  lastError: string | null;
  consecutiveFailures: number;
}

/**
 * Check sandbox health and store result in D1
 */
export async function checkAndCacheSandbоxHealth(env: Env): Promise<void> {
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
  const now = new Date().toISOString();

  try {
    const isHealthy = await sandbox.health();

    if (isHealthy) {
      // Success - reset failure count
      await env.DB.prepare(`
        INSERT INTO system_health (service, is_healthy, last_check_at, last_error, consecutive_failures)
        VALUES ('sandbox', 1, ?, NULL, 0)
        ON CONFLICT(service) DO UPDATE SET
          is_healthy = 1,
          last_check_at = excluded.last_check_at,
          last_error = NULL,
          consecutive_failures = 0
      `).bind(now).run();
    } else {
      // Health check returned false
      await incrementFailure(env.DB, 'sandbox', now, 'Health check returned unhealthy');
    }
  } catch (error) {
    // Network or other error
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await incrementFailure(env.DB, 'sandbox', now, errorMessage);
  }
}

/**
 * Increment failure count for a service
 */
async function incrementFailure(
  db: D1Database,
  service: string,
  timestamp: string,
  error: string
): Promise<void> {
  await db.prepare(`
    INSERT INTO system_health (service, is_healthy, last_check_at, last_error, consecutive_failures)
    VALUES (?, 0, ?, ?, 1)
    ON CONFLICT(service) DO UPDATE SET
      is_healthy = 0,
      last_check_at = excluded.last_check_at,
      last_error = excluded.last_error,
      consecutive_failures = consecutive_failures + 1
  `).bind(service, timestamp, error).run();
}

/**
 * Get cached health status for a service
 */
export async function getCachedHealth(
  db: D1Database,
  service: string
): Promise<HealthStatus | null> {
  const row = await db.prepare(`
    SELECT service, is_healthy, last_check_at, last_error, consecutive_failures
    FROM system_health
    WHERE service = ?
  `).bind(service).first<{
    service: string;
    is_healthy: number;
    last_check_at: string;
    last_error: string | null;
    consecutive_failures: number;
  }>();

  if (!row) {
    return null;
  }

  return {
    service: row.service,
    isHealthy: row.is_healthy === 1,
    lastCheckAt: row.last_check_at,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
  };
}

/**
 * Get all cached health statuses
 */
export async function getAllCachedHealth(db: D1Database): Promise<HealthStatus[]> {
  const result = await db.prepare(`
    SELECT service, is_healthy, last_check_at, last_error, consecutive_failures
    FROM system_health
  `).all<{
    service: string;
    is_healthy: number;
    last_check_at: string;
    last_error: string | null;
    consecutive_failures: number;
  }>();

  return (result.results || []).map(row => ({
    service: row.service,
    isHealthy: row.is_healthy === 1,
    lastCheckAt: row.last_check_at,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
  }));
}
