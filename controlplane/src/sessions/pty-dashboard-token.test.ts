// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: pty-dashboard-token-tests-v2-identifier-renames
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mintCurrentSandboxDashboardToken, recоrdAppliedSecretNames } from './handler';
import { createTestContext } from '../../tests/helpers';
import { verifyDashboardToken, sandboxGeneration } from '../auth/dashboard-token';
import { SandboxClient } from '../sandbox/client';
import type { Env } from '../types';

// A VM only got a dashboard token at sandbox-session create; each new PTY now
// carries a fresh one for the current generation so a VM whose token was
// refused (PTY_TOKEN_SECRET rotated) recovers on the next terminal.
function envWithRow(row: { sandbox_session_id: string; created_at: string } | null) {
  return {
    DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
    PTY_TOKEN_SECRET: 'cp-only-secret',
    INTERNAL_API_TOKEN: 'vm-readable',
  } as unknown as Env;
}

describe('mintCurrentSandboxDashboardToken', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('mints a token bound to the current row generation, signed with PTY_TOKEN_SECRET', async () => {
    const createdAt = '2026-10-01 12:00:00';
    const token = await mintCurrentSandboxDashboardToken(envWithRow({ sandbox_session_id: 's1', created_at: createdAt }), 'd1', 's1');
    expect(token).toBeTruthy();
    const claims = await verifyDashboardToken(token!, 'cp-only-secret');
    expect(claims?.dashboard_id).toBe('d1');
    expect(claims?.sbx_gen).toBe(sandboxGeneration(createdAt));
    expect(await verifyDashboardToken(token!, 'vm-readable')).toBeNull();
  });

  it('mints nothing for a replaced or retired sandbox', async () => {
    expect(await mintCurrentSandboxDashboardToken(envWithRow({ sandbox_session_id: 's2', created_at: '2026-10-01 12:00:00' }), 'd1', 's1')).toBeUndefined();
    expect(await mintCurrentSandboxDashboardToken(envWithRow({ sandbox_session_id: '', created_at: '2026-10-01 12:00:00' }), 'd1', '')).toBeUndefined();
    expect(await mintCurrentSandboxDashboardToken(envWithRow(null), 'd1', 's1')).toBeUndefined();
  });

  it('createPty sends it as mcp_token', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ id: 'p1' });
    }));
    await new SandboxClient('http://sbx.test').createPty('s1', 'alice', undefined, undefined, { dashboardToken: 'tok' });
    expect(body.mcp_token).toBe('tok');
  });
});

// A concurrent owner secret push recorded names this terminal start never saw:
// the final tracking write must keep them, or deleting that secret later
// would never unset it in the VM.
describe('recordAppliedSecretNames', () => {
  async function seeded(names: string[]) {
    const ctx = await createTestContext();
    await ctx.db.prepare(`
      INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, applied_secret_names, created_at)
      VALUES (?, ?, '', ?, ?)
    `).bind('d1', 's1', JSON.stringify(names), '2026-10-01 12:00:00').run();
    const read = async () => JSON.parse((await ctx.db.prepare(
      'SELECT applied_secret_names FROM dashboard_sandboxes WHERE dashboard_id = ?').bind('d1').first<{ applied_secret_names: string }>())!.applied_secret_names);
    return { env: ctx.env as unknown as Env, read };
  }

  it('replaces the tracking exactly when nothing changed since the pre-apply', async () => {
    const { env, read } = await seeded(['OLD']);
    await recоrdAppliedSecretNames(env, 'd1', 's1', '', ['A'], JSON.stringify(['OLD']), 'x');
    expect(await read()).toEqual(['A']);
  });

  it('merges names a concurrent push recorded', async () => {
    const { env, read } = await seeded(['A', 'PUSHED']);
    await recоrdAppliedSecretNames(env, 'd1', 's1', '', ['A'], JSON.stringify(['A']), 'x');
    expect((await read()).sort()).toEqual(['A', 'PUSHED']);
  });
});
