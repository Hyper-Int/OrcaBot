// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, it, expect } from 'vitest';
import { updateIntegrationPolicy, detachIntegration } from './handler';
import type { Env } from '../types';

// The terminal-access helper uses a JOIN the shared D1 mock can't run, so this
// fake answers just the queries these two handlers make before their writes.
function fakeEnv(roles: Record<string, string>, attachedBy: string) {
  const writes: string[] = [];
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    async first() {
      if (sql.includes('FROM dashboard_members WHERE dashboard_id')) {
        const role = roles[args[1] as string];
        return role ? { role } : null;
      }
      if (sql.includes('FROM sessions s')) return roles[args[1] as string] ? { dashboard_id: 'dash-1' } : null;
      if (sql.includes('FROM terminal_integrations')) return { id: 'ti-1', active_policy_id: 'pol-1', user_id: attachedBy };
      return null;
    },
    async run() {
      writes.push(sql);
      return { success: true };
    },
    async all() {
      return { results: [] };
    },
  });
  const env = { DB: { prepare: (sql: string) => stmt(sql), batch: async () => [] } } as unknown as Env;
  return { env, writes };
}

const roles = { alice: 'editor', bob: 'editor', olivia: 'owner' };

describe('integration policy changes are limited to the account holder', () => {
  it('another editor cannot rewrite the policy on an integration attached with alice\'s account', async () => {
    const { env, writes } = fakeEnv(roles, 'alice');
    const res = await updateIntegrationPolicy(env, 'dash-1', 'pty-1', 'gmail', 'bob', { policy: {} as never });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('E79615') });
    expect(writes).toHaveLength(0);
  });

  it('the dashboard owner cannot rewrite it either', async () => {
    const { env } = fakeEnv(roles, 'alice');
    const res = await updateIntegrationPolicy(env, 'dash-1', 'pty-1', 'gmail', 'olivia', { policy: {} as never });
    expect(res.status).toBe(403);
  });

  it('another editor cannot detach it', async () => {
    const { env, writes } = fakeEnv(roles, 'alice');
    const res = await detachIntegration(env, 'dash-1', 'pty-1', 'gmail', 'bob');
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('the attacher and the dashboard owner can detach it', async () => {
    for (const user of ['alice', 'olivia']) {
      const { env, writes } = fakeEnv(roles, 'alice');
      const res = await detachIntegration(env, 'dash-1', 'pty-1', 'gmail', user);
      expect(res.status).toBe(200);
      expect(writes.some((w) => w.includes('UPDATE terminal_integrations'))).toBe(true);
    }
  });
});
