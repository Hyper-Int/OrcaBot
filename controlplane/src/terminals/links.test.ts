// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: terminal-links-tests-v1
import { describe, it, expect } from 'vitest';
import { handleInternalTerminalLinks } from './links';

function fakeEnv(rows: Array<{ id: string; content: string; pty_id: string | null }>) {
  const seen: Array<{ sql: string; args: unknown[] }> = [];
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    async first() {
      seen.push({ sql, args });
      if (sql.includes('FROM sessions')) return args[1] === 'pty-engine' ? { item_id: 'engine' } : null;
      return null;
    },
    async all() {
      seen.push({ sql, args });
      return { results: sql.includes('FROM dashboard_edges') ? rows : [] };
    },
  });
  return { env: { DB: { prepare: (sql: string) => stmt(sql) } } as unknown as { DB: D1Database }, seen };
}

describe('terminal links', () => {
  it('lists the terminals linked to this one, with their names and PTYs', async () => {
    const { env, seen } = fakeEnv([
      { id: 'seat-1', content: JSON.stringify({ name: 'Claude Code', bootCommand: 'x' }), pty_id: 'pty-a' },
      { id: 'seat-2', content: JSON.stringify({ name: 'Codex' }), pty_id: null },  // not started yet
      { id: 'seat-1', content: JSON.stringify({ name: 'Claude Code' }), pty_id: 'pty-a' },  // linked both ways
      { id: 'seat-3', content: 'not json', pty_id: 'pty-c' },
    ]);
    const r = await (await handleInternalTerminalLinks(env, 'dash-1', 'pty-engine')).json() as { terminals: unknown[] };
    expect(r.terminals).toEqual([
      { itemId: 'seat-1', name: 'Claude Code', ptyId: 'pty-a' },
      { itemId: 'seat-2', name: 'Codex', ptyId: '' },
      { itemId: 'seat-3', name: '', ptyId: 'pty-c' },
    ]);
    // Only this dashboard's terminals, and never the terminal itself; boot commands are not returned.
    const edgeQuery = seen.find((s) => s.sql.includes('FROM dashboard_edges'))!;
    expect(edgeQuery.sql).toContain("i.type = 'terminal'");
    expect(edgeQuery.sql).toContain('i.dashboard_id = e.dashboard_id');
    expect(edgeQuery.args).toEqual(['engine', 'dash-1', 'engine', 'engine', 'engine']);
    expect(JSON.stringify(r)).not.toContain('bootCommand');
  });

  it('knows nothing for a PTY it has no session for', async () => {
    const { env } = fakeEnv([{ id: 'seat-1', content: '{}', pty_id: 'pty-a' }]);
    const r = await (await handleInternalTerminalLinks(env, 'dash-1', 'pty-unknown')).json() as { terminals: unknown[] };
    expect(r.terminals).toEqual([]);
  });
});
