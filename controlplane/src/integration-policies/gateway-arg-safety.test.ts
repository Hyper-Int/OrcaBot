// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleGatewayExecute } from './gateway';
import { createPtyToken } from '../auth/pty-token';
import type { Env, IntegrationProvider } from '../types';

// Arg validation is keyed by provider identifier, so it has to be exercised
// with the identifiers the gateway really receives (google_drive, not drive).
const SECRET = 'pty-secret';

function fakeEnv(provider: IntegrationProvider) {
  const audits: unknown[][] = [];
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    async first() {
      if (sql.includes('FROM terminal_integrations ti')) {
        return {
          id: 'ti-1', terminal_id: 'term-1', item_id: null, dashboard_id: 'dash-1', user_id: 'alice',
          provider, user_integration_id: 'ui-1', active_policy_id: 'pol-1',
          policy: JSON.stringify({ canRead: true, canWrite: true }), security_level: 'restricted',
          policy_id: 'pol-1', policy_version: 1,
        };
      }
      return null;
    },
    async all() { return { results: [] }; },
    async run() {
      if (sql.includes('integration_audit_log')) audits.push(args);
      return { success: true };
    },
  });
  const env = {
    DB: { prepare: (sql: string) => stmt(sql), batch: async () => [] },
    PTY_TOKEN_SECRET: SECRET,
    INTERNAL_API_TOKEN: 'internal',
  } as unknown as Env;
  return { env, audits };
}

async function execute(provider: IntegrationProvider, action: string, args: Record<string, unknown>) {
  const { env } = fakeEnv(provider);
  const token = await createPtyToken('term-1', 'sbx-1', 'dash-1', 'alice', SECRET);
  const req = new Request(`https://cp.test/internal/gateway/${provider}/execute`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args }),
  });
  return handleGatewayExecute(req, env, provider);
}

describe('gateway rejects unsafe IDs for Google providers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['google_drive', 'drive.get', { fileId: 'ID?alt=media#' }],
    ['google_drive', 'drive.download', { fileId: 'OTHER/permissions' }],
    ['google_drive', 'drive.list', { folderId: "x' in parents or 'y" }],
    ['google_calendar', 'calendar.get_event', { calendarId: 'primary', eventId: '../../other/events/1' }],
  ] as const)('%s %s %j is denied before any provider call', async (provider, action, args) => {
    const upstream = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', upstream);
    const res = await execute(provider, action, args);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ decision: 'denied', reason: expect.stringMatching(/^E796/) });
    expect(upstream).not.toHaveBeenCalled();
  });
});
