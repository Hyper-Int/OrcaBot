// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: warm-pool-v2-machine-controlplane-url
const MODULE_REVISION = 'warm-pool-v2-machine-controlplane-url';
console.log(`[warm-pool] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * The warm pool belongs to the control plane that made it.
 *
 * Several control planes (production and dev) share one D1 database and one Fly app,
 * so they share the warm_machines table. A warm VM is created with its control plane's
 * CONTROLPLANE_URL (and origins, auth) baked into its environment; a dashboard given a
 * VM made by another control plane talks to the wrong one for everything (MCP, egress
 * approvals, agent links). So each row records the control plane it reports to, and a
 * control plane counts and claims only its own.
 *
 * Rows from before the column existed (NULL) count as production's: production made
 * nearly all of them, and once every control plane runs this code nobody adds more.
 */

export const DEFAULT_CONTROLPLANE_URL = 'https://api.orcabot.com';

/** The control plane URL this control plane gives its VMs (CONTROLPLANE_URL in the VM). */
export function sandboxControlplaneUrl(env: { FLY_SANDBOX_CONTROLPLANE_URL?: string }): string {
  return env.FLY_SANDBOX_CONTROLPLANE_URL || DEFAULT_CONTROLPLANE_URL;
}

/**
 * The env that tells a new VM which control plane to talk to. Both names: the Fly app has
 * CONTROLPLANE_URL as an app-wide secret (production's), and Fly secrets override a
 * machine's own env, so CONTROLPLANE_URL alone never reached the VM. The sandbox prefers
 * ORCABOT_CONTROLPLANE_URL (cpauth.ApplyMachineControlPlaneURL), which no secret shadows.
 */
export function machineControlplaneEnv(env: { FLY_SANDBOX_CONTROLPLANE_URL?: string }): Record<string, string> {
  const url = sandboxControlplaneUrl(env);
  return { CONTROLPLANE_URL: url, ORCABOT_CONTROLPLANE_URL: url };
}

/** WHERE clause (and its binds) for the warm machines that belong to `owner`. */
function ownRows(owner: string): { sql: string; binds: string[] } {
  if (owner === DEFAULT_CONTROLPLANE_URL) {
    return { sql: '(controlplane_url = ? OR controlplane_url IS NULL)', binds: [owner] };
  }
  return { sql: 'controlplane_url = ?', binds: [owner] };
}

/** Adds warm_machines.controlplane_url to an existing table (no-op when present). */
export async function migrateWarmMachinesOwner(db: D1Database): Promise<void> {
  try {
    await db.prepare(`ALTER TABLE warm_machines ADD COLUMN controlplane_url TEXT`).run();
  } catch {
    // Column already exists.
  }
}

/** Warm machines per region that belong to `owner`. */
export async function countOwnWarmMachines(db: D1Database, owner: string): Promise<{ region: string; cnt: number }[]> {
  const own = ownRows(owner);
  const r = await db.prepare(
    `SELECT region, COUNT(*) AS cnt FROM warm_machines WHERE ${own.sql} GROUP BY region`,
  ).bind(...own.binds).all<{ region: string; cnt: number }>();
  return r.results || [];
}

/** One of `owner`'s warm machines, preferring `region`; null when it has none. Not yet claimed. */
export async function pickOwnWarmMachine(
  db: D1Database, owner: string, region?: string,
): Promise<{ machine_id: string; volume_id: string } | null> {
  const own = ownRows(owner);
  if (region) {
    const inRegion = await db.prepare(
      `SELECT machine_id, volume_id FROM warm_machines WHERE region = ? AND ${own.sql} LIMIT 1`,
    ).bind(region, ...own.binds).first<{ machine_id: string; volume_id: string }>();
    if (inRegion) return inRegion;
  }
  return db.prepare(
    `SELECT machine_id, volume_id FROM warm_machines WHERE ${own.sql} LIMIT 1`,
  ).bind(...own.binds).first<{ machine_id: string; volume_id: string }>();
}

/** Records a new warm machine as `owner`'s. */
export async function recordWarmMachine(
  db: D1Database, owner: string, machineId: string, volumeId: string, region: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO warm_machines (machine_id, volume_id, region, controlplane_url) VALUES (?, ?, ?, ?)`,
  ).bind(machineId, volumeId, region, owner).run();
}
