// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: auto-sleep-v1-dashboard-setting
const MODULE_REVISION = 'auto-sleep-v1-dashboard-setting';
console.log(`[auto-sleep] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Auto sleep: a per-dashboard setting (dashboards.auto_sleep, default 1 = on).
 *
 * On (the default): a dashboard nobody is watching goes to sleep. Its terminals stop
 * after the sandbox hub's idle timeout (10 minutes with no viewer), Fly suspends the VM
 * when no traffic reaches it, and the cron retires the VM after
 * AUTO_SLEEP_ON_MAX_IDLE_HOURS without terminal activity.
 *
 * Off (benchmark templates: long unattended runs): the sandbox keeps the dashboard's
 * terminals running with no viewer (session flag, sent with every PTY create and on
 * toggle), the cron pings the VM through the Fly proxy every tick so Fly never suspends
 * it, and the VM is retired only after AUTO_SLEEP_OFF_MAX_IDLE_HOURS without terminal
 * activity (cost safety: never forever). Pings stop at that same limit.
 */

import type { Env } from '../types';
import { SandboxClient } from '../sandbox/client';

/** Hours without terminal activity before an auto-sleep-on dashboard's VM is retired. */
export const AUTO_SLEEP_ON_MAX_IDLE_HOURS = 6;
/** Hours without terminal activity before an auto-sleep-off dashboard's VM is retired
 *  (and its keepalive pings stop). */
export const AUTO_SLEEP_OFF_MAX_IDLE_HOURS = 48;
/** At most this many auto-sleep-off VMs are pinged per cron tick. */
const KEEP_AWAKE_MAX_PER_TICK = 25;
const KEEP_AWAKE_PING_TIMEOUT_MS = 5_000;

/** Newest terminal activity per dashboard (a session's stop, or its start while running). */
export const LAST_ACTIVITY_JOIN = `
  LEFT JOIN (
    SELECT dashboard_id, MAX(COALESCE(stopped_at, created_at)) AS last_activity
    FROM sessions
    GROUP BY dashboard_id
  ) s ON s.dashboard_id = ds.dashboard_id`;

// Whether dashboards.auto_sleep exists yet (initializeDatabase adds it). Until it does,
// every dashboard sleeps as before. Cached per isolate once true.
let columnReady = false;
/** Tests only: forget the cached column check. */
export function resetAutoSleepColumnCache(): void {
  columnReady = false;
}

export async function autoSleepColumnReady(env: Pick<Env, 'DB'>): Promise<boolean> {
  if (columnReady) return true;
  try {
    await env.DB.prepare(`SELECT auto_sleep FROM dashboards LIMIT 0`).all();
    columnReady = true;
  } catch {
    // Column not migrated yet.
  }
  return columnReady;
}

/**
 * SQL condition (on `d` = dashboards, `s` = LAST_ACTIVITY_JOIN, `ds` = dashboard_sandboxes)
 * for a VM idle past its dashboard's limit. Keeps the existing comparison form.
 */
export function idleBeyondLimitSql(withAutoSleep: boolean): string {
  const activity = `COALESCE(s.last_activity, ds.created_at)`;
  if (!withAutoSleep) {
    return `${activity} < datetime('now', '-${AUTO_SLEEP_ON_MAX_IDLE_HOURS} hours')`;
  }
  return `(
    (COALESCE(d.auto_sleep, 1) != 0 AND ${activity} < datetime('now', '-${AUTO_SLEEP_ON_MAX_IDLE_HOURS} hours'))
    OR (COALESCE(d.auto_sleep, 1) = 0 AND ${activity} < datetime('now', '-${AUTO_SLEEP_OFF_MAX_IDLE_HOURS} hours'))
  )`;
}

export function rowAutoSleep(value: unknown): boolean {
  return value === undefined || value === null ? true : Number(value) !== 0;
}

/** The dashboard's Auto sleep (true = on). On if the row or column is missing. */
export async function getDashboardAutoSleep(env: Pick<Env, 'DB'>, dashboardId: string): Promise<boolean> {
  if (!(await autoSleepColumnReady(env))) return true;
  try {
    const row = await env.DB.prepare(`SELECT auto_sleep FROM dashboards WHERE id = ?`)
      .bind(dashboardId).first<{ auto_sleep: number | null }>();
    return rowAutoSleep(row?.auto_sleep);
  } catch {
    return true;
  }
}

/**
 * Tell the dashboard's live sandbox session about a changed Auto sleep. Best effort:
 * with no VM (or an unreachable one) the next PTY create carries the setting anyway.
 */
export async function pushAutoSleepToSandbox(env: Env, dashboardId: string, autoSleep: boolean): Promise<void> {
  try {
    const sb = await env.DB.prepare(`
      SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?
    `).bind(dashboardId).first<{ sandbox_session_id: string; sandbox_machine_id: string }>();
    if (!sb?.sandbox_session_id) return;
    const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN, env.SANDBOX_AUTH_SIGNING_KEY);
    await sandbox.setAutoSleep(sb.sandbox_session_id, autoSleep, sb.sandbox_machine_id || undefined);
    console.log(`[auto-sleep] dashboard ${dashboardId}: auto sleep ${autoSleep ? 'on' : 'off'} sent to session ${sb.sandbox_session_id}`);
  } catch (e) {
    console.warn(`[auto-sleep] dashboard ${dashboardId}: couldn't update the live sandbox (next terminal start carries it): ${e}`);
  }
}

/**
 * Cron: ping every auto-sleep-off dashboard's VM through the Fly proxy so Fly's autostop
 * never suspends it while a benchmark runs unattended. Bounded per tick, and only
 * within AUTO_SLEEP_OFF_MAX_IDLE_HOURS of the dashboard's last terminal activity.
 * A ping also wakes a VM that was suspended before Auto sleep was turned off.
 */
export async function keepAwakeDashboards(env: Env): Promise<void> {
  if (!(await autoSleepColumnReady(env))) return;
  try {
    const rows = await env.DB.prepare(`
      SELECT ds.dashboard_id, ds.sandbox_machine_id
      FROM dashboard_sandboxes ds
      JOIN dashboards d ON d.id = ds.dashboard_id
      ${LAST_ACTIVITY_JOIN}
      WHERE ds.sandbox_machine_id != ''
        AND d.auto_sleep = 0
        AND NOT (COALESCE(s.last_activity, ds.created_at) < datetime('now', '-${AUTO_SLEEP_OFF_MAX_IDLE_HOURS} hours'))
      ORDER BY COALESCE(s.last_activity, ds.created_at) DESC
      LIMIT ${KEEP_AWAKE_MAX_PER_TICK}
    `).all<{ dashboard_id: string; sandbox_machine_id: string }>();
    const list = rows.results || [];
    if (list.length === 0) return;
    const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN, env.SANDBOX_AUTH_SIGNING_KEY);
    const results = await Promise.allSettled(
      list.map(r => sandbox.health(r.sandbox_machine_id, KEEP_AWAKE_PING_TIMEOUT_MS)),
    );
    const down = list.filter((_, i) => {
      const r = results[i];
      return r.status !== 'fulfilled' || !r.value;
    });
    if (down.length > 0) {
      console.warn(`[auto-sleep] keepalive: ${down.length}/${list.length} VM(s) didn't answer: ${down.map(r => r.dashboard_id).join(', ')}`);
    }
  } catch (e) {
    console.error(`[auto-sleep] keepalive failed: ${e}`);
  }
}
