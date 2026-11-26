// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AUTO_SLEEP_OFF_MAX_IDLE_HOURS,
  LAST_ACTIVITY_JOIN,
  autoSleepColumnReady,
  getDashboardAutoSleep,
  idleBeyondLimitSql,
  keepAwakeDashboards,
  pushAutoSleepToSandbox,
  resetAutoSleepColumnCache,
} from './auto-sleep';
import type { Env } from '../types';
import { populateFromTemplate } from '../templates/handler';

// Node's built-in SQLite (as in sandbox/warm-pool.test.ts): the real SQL runs.
interface SqliteStatement {
  get(...a: unknown[]): unknown;
  all(...a: unknown[]): unknown[];
  run(...a: unknown[]): { changes: number | bigint };
}
interface DatabaseSync { exec(sql: string): void; prepare(sql: string): SqliteStatement }
const { DatabaseSync } = (globalThis as unknown as {
  process: { getBuiltinModule(id: string): { DatabaseSync: new (path: string) => DatabaseSync } };
}).process.getBuiltinModule('node:sqlite');

function d1(db: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    let binds: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) { binds = args; return stmt; },
      async first<T>() { return (db.prepare(sql).get(...binds) as T) ?? null; },
      async all<T>() { return { results: db.prepare(sql).all(...binds) as T[] }; },
      async run() { const r = db.prepare(sql).run(...binds); return { meta: { changes: Number(r.changes) } }; },
    };
    return stmt;
  };
  return { prepare } as unknown as D1Database;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

function makeDb(withColumn: boolean): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE dashboards (id TEXT PRIMARY KEY, name TEXT${withColumn ? ', auto_sleep INTEGER NOT NULL DEFAULT 1' : ''})`);
  raw.exec(`CREATE TABLE dashboard_sandboxes (dashboard_id TEXT PRIMARY KEY, sandbox_session_id TEXT,
    sandbox_machine_id TEXT, fly_volume_id TEXT, created_at TEXT)`);
  raw.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, dashboard_id TEXT, created_at TEXT, stopped_at TEXT)`);
  return raw;
}

function addDashboard(raw: DatabaseSync, id: string, autoSleep: number | null, lastActivityHoursAgo: number) {
  if (autoSleep === null) raw.prepare(`INSERT INTO dashboards (id, name) VALUES (?, ?)`).run(id, id);
  else raw.prepare(`INSERT INTO dashboards (id, name, auto_sleep) VALUES (?, ?, ?)`).run(id, id, autoSleep);
  raw.prepare(`INSERT INTO dashboard_sandboxes VALUES (?, ?, ?, ?, ?)`)
    .run(id, `sess-${id}`, `machine-${id}`, `vol-${id}`, hoursAgo(200));
  // A terminal still running since then (no stop yet).
  raw.prepare(`INSERT INTO sessions VALUES (?, ?, ?, NULL)`).run(`s-${id}`, id, hoursAgo(lastActivityHoursAgo));
}

function envFor(raw: DatabaseSync): Env {
  return { DB: d1(raw), SANDBOX_URL: 'http://sandbox.test' } as unknown as Env;
}

describe('auto sleep', () => {
  beforeEach(() => resetAutoSleepColumnCache());
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is on for every dashboard until the column exists, and nothing is kept awake', async () => {
    const raw = makeDb(false);
    raw.prepare(`INSERT INTO dashboards (id, name) VALUES ('a', 'a')`).run();
    const env = envFor(raw);
    expect(await autoSleepColumnReady(env)).toBe(false);
    expect(await getDashboardAutoSleep(env, 'a')).toBe(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await keepAwakeDashboards(env);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the setting, defaulting to on', async () => {
    const raw = makeDb(true);
    addDashboard(raw, 'on', 1, 1);
    addDashboard(raw, 'off', 0, 1);
    addDashboard(raw, 'default', null, 1);
    const env = envFor(raw);
    expect(await getDashboardAutoSleep(env, 'on')).toBe(true);
    expect(await getDashboardAutoSleep(env, 'off')).toBe(false);
    expect(await getDashboardAutoSleep(env, 'default')).toBe(true);
    expect(await getDashboardAutoSleep(env, 'missing')).toBe(true);
  });

  it('retires an idle VM after 6h with Auto sleep on, but 48h with it off', async () => {
    const raw = makeDb(true);
    addDashboard(raw, 'on-idle-day', 1, 30);
    addDashboard(raw, 'on-fresh', 1, 1);
    addDashboard(raw, 'off-idle-day', 0, 30);
    addDashboard(raw, 'off-idle-week', 0, 24 * 7);
    const query = (withColumn: boolean) => raw.prepare(`
      SELECT ds.dashboard_id FROM dashboard_sandboxes ds
      LEFT JOIN dashboards d ON ds.dashboard_id = d.id
      ${LAST_ACTIVITY_JOIN}
      WHERE ds.sandbox_machine_id != '' AND (d.id IS NULL OR ${idleBeyondLimitSql(withColumn)})
      ORDER BY ds.dashboard_id`).all().map((r) => (r as { dashboard_id: string }).dashboard_id);
    expect(query(true)).toEqual(['off-idle-week', 'on-idle-day']);
    // Before the migration: the old 6h rule for everyone.
    expect(query(false)).toEqual(['off-idle-day', 'off-idle-week', 'on-idle-day']);
  });

  it('pings only auto-sleep-off VMs within the 48h limit', async () => {
    const raw = makeDb(true);
    addDashboard(raw, 'on', 1, 1);
    addDashboard(raw, 'off-live', 0, 1);
    addDashboard(raw, 'off-day', 0, 30);
    addDashboard(raw, 'off-stale', 0, AUTO_SLEEP_OFF_MAX_IDLE_HOURS + 48);
    const pinged: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://sandbox.test/health');
      pinged.push(new Headers(init.headers).get('X-Sandbox-Machine-ID') || '');
      return new Response('ok');
    }));
    await keepAwakeDashboards(envFor(raw));
    expect(pinged.sort()).toEqual(['machine-off-day', 'machine-off-live']);
  });

  it('tells the live sandbox session when it changes', async () => {
    const raw = makeDb(true);
    addDashboard(raw, 'd', 1, 1);
    const calls: Array<{ url: string; body: string; machine: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), machine: new Headers(init.headers).get('X-Sandbox-Machine-ID') });
      return Response.json({ auto_sleep: false });
    }));
    await pushAutoSleepToSandbox(envFor(raw), 'd', false);
    expect(calls).toEqual([{ url: 'http://sandbox.test/sessions/sess-d/auto-sleep', body: '{"auto_sleep":false}', machine: 'machine-d' }]);
    // No VM: nothing to tell, no error.
    await pushAutoSleepToSandbox(envFor(raw), 'missing', true);
    expect(calls).toHaveLength(1);
  });

  it('a dashboard made from a template takes its Auto sleep', async () => {
    const raw = makeDb(true);
    raw.exec(`CREATE TABLE dashboard_templates (id TEXT PRIMARY KEY, items_json TEXT, edges_json TEXT,
      viewport_json TEXT, setup_guide TEXT, status TEXT, use_count INTEGER DEFAULT 0,
      auto_sleep INTEGER NOT NULL DEFAULT 1)`);
    raw.exec(`CREATE TABLE dashboard_items (id TEXT, dashboard_id TEXT, type TEXT, content TEXT, position_x REAL,
      position_y REAL, width REAL, height REAL, metadata TEXT, created_at TEXT, updated_at TEXT)`);
    raw.exec(`CREATE TABLE dashboard_edges (id TEXT, dashboard_id TEXT, source_item_id TEXT, target_item_id TEXT,
      source_handle TEXT, target_handle TEXT, created_at TEXT, updated_at TEXT)`);
    raw.exec(`INSERT INTO dashboard_templates (id, items_json, edges_json, auto_sleep) VALUES
      ('bench', '[]', '[]', 0), ('plain', '[]', '[]', 1)`);
    raw.exec(`INSERT INTO dashboards (id, name) VALUES ('from-bench', 'a'), ('from-plain', 'b')`);
    const env = envFor(raw);
    await populateFromTemplate(env, 'from-bench', 'bench');
    await populateFromTemplate(env, 'from-plain', 'plain');
    expect(await getDashboardAutoSleep(env, 'from-bench')).toBe(false);
    expect(await getDashboardAutoSleep(env, 'from-plain')).toBe(true);
  });
});
