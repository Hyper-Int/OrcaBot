// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_CONTROLPLANE_URL,
  machineControlplaneEnv,
  countOwnWarmMachines,
  migrateWarmMachinesOwner,
  pickOwnWarmMachine,
  recordWarmMachine,
  sandboxControlplaneUrl,
} from './warm-pool';

const DEV = 'https://api.dev.orcabot.com';

// Node's built-in SQLite (Node 22.5+), loaded at runtime: vitest 1 can't resolve
// `node:sqlite` as an import, and this package is typed for Workers, not Node.
interface SqliteStatement {
  get(...a: unknown[]): unknown;
  all(...a: unknown[]): unknown[];
  run(...a: unknown[]): { changes: number | bigint };
}
interface DatabaseSync { exec(sql: string): void; prepare(sql: string): SqliteStatement }
const { DatabaseSync } = (globalThis as unknown as {
  process: { getBuiltinModule(id: string): { DatabaseSync: new (path: string) => DatabaseSync } };
}).process.getBuiltinModule('node:sqlite');

/** Just enough of D1 over node:sqlite to run the real SQL. */
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

describe('warm pool per control plane', () => {
  let raw: DatabaseSync;
  let db: D1Database;

  beforeEach(async () => {
    raw = new DatabaseSync(':memory:');
    // The table as it exists before the migration.
    raw.exec(`CREATE TABLE warm_machines (machine_id TEXT PRIMARY KEY, volume_id TEXT NOT NULL,
      region TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    raw.exec(`INSERT INTO warm_machines (machine_id, volume_id, region) VALUES ('legacy-1', 'vol-l1', 'sjc')`);
    db = d1(raw);
    await migrateWarmMachinesOwner(db);
  });

  it('migration adds the column and is safe to run again', async () => {
    await migrateWarmMachinesOwner(db);
    const cols = (raw.prepare(`PRAGMA table_info(warm_machines)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('controlplane_url');
  });

  it('dev never claims a machine made by production (the bug)', async () => {
    await recordWarmMachine(db, DEFAULT_CONTROLPLANE_URL, 'prod-1', 'vol-p1', 'sjc');
    expect(await pickOwnWarmMachine(db, DEV, 'sjc')).toBeNull();
    expect(await pickOwnWarmMachine(db, DEV)).toBeNull();
    expect(await countOwnWarmMachines(db, DEV)).toEqual([]);
  });

  it('production never claims a machine made by dev', async () => {
    await recordWarmMachine(db, DEV, 'dev-1', 'vol-d1', 'ams');
    const picked = await pickOwnWarmMachine(db, DEFAULT_CONTROLPLANE_URL, 'ams');
    expect(picked?.machine_id).not.toBe('dev-1');
  });

  it('each control plane claims its own, preferring the region', async () => {
    await recordWarmMachine(db, DEV, 'dev-sjc', 'vol-1', 'sjc');
    await recordWarmMachine(db, DEV, 'dev-ams', 'vol-2', 'ams');
    expect((await pickOwnWarmMachine(db, DEV, 'ams'))?.machine_id).toBe('dev-ams');
    expect((await pickOwnWarmMachine(db, DEV, 'syd'))?.machine_id).toMatch(/^dev-/);
  });

  it('untagged rows from before the migration count as production\'s only', async () => {
    expect((await pickOwnWarmMachine(db, DEFAULT_CONTROLPLANE_URL))?.machine_id).toBe('legacy-1');
    expect(await countOwnWarmMachines(db, DEFAULT_CONTROLPLANE_URL)).toEqual([{ region: 'sjc', cnt: 1 }]);
    expect(await pickOwnWarmMachine(db, DEV)).toBeNull();
  });

  it('counts are per control plane', async () => {
    await recordWarmMachine(db, DEV, 'dev-1', 'v1', 'sjc');
    await recordWarmMachine(db, DEV, 'dev-2', 'v2', 'sjc');
    await recordWarmMachine(db, DEFAULT_CONTROLPLANE_URL, 'prod-1', 'v3', 'sjc');
    expect(await countOwnWarmMachines(db, DEV)).toEqual([{ region: 'sjc', cnt: 2 }]);
    expect(await countOwnWarmMachines(db, DEFAULT_CONTROLPLANE_URL)).toEqual([{ region: 'sjc', cnt: 2 }]); // prod-1 + legacy-1
  });

  it('the owner is the URL the VM is given', () => {
    expect(sandboxControlplaneUrl({ FLY_SANDBOX_CONTROLPLANE_URL: DEV })).toBe(DEV);
    expect(sandboxControlplaneUrl({})).toBe(DEFAULT_CONTROLPLANE_URL);
  });

  it('VMs get the URL under a name no Fly app secret shadows', () => {
    expect(machineControlplaneEnv({ FLY_SANDBOX_CONTROLPLANE_URL: DEV }))
      .toEqual({ CONTROLPLANE_URL: DEV, ORCABOT_CONTROLPLANE_URL: DEV });
    expect(machineControlplaneEnv({}).ORCABOT_CONTROLPLANE_URL).toBe(DEFAULT_CONTROLPLANE_URL);
  });
});
