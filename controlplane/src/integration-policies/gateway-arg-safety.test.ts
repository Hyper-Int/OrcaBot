// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: gateway-arg-safety-tests-v3-empty-ids
import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleGatewayExecute } from './gateway';
import { createPtyToken } from '../auth/pty-token';
import type { Env, IntegrationProvider } from '../types';

// Arg validation is keyed by provider identifier, so it has to be exercised
// with the identifiers the gateway really receives (google_drive, not drive).
const SECRET = 'pty-secret';

function fakeEnv(provider: IntegrationProvider, policy: Record<string, unknown> = { canRead: true, canWrite: true }) {
  const audits: unknown[][] = [];
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    async first() {
      if (sql.includes('FROM terminal_integrations ti')) {
        return {
          id: 'ti-1', terminal_id: 'term-1', item_id: null, dashboard_id: 'dash-1', user_id: 'alice',
          provider, user_integration_id: 'ui-1', active_policy_id: 'pol-1',
          policy: JSON.stringify(policy), security_level: 'restricted',
          policy_id: 'pol-1', policy_version: 1,
        };
      }
      if (sql.includes('FROM user_integrations WHERE id')) {
        return { access_token: 'tok', refresh_token: null, expires_at: null, metadata: null };
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

async function execute(provider: IntegrationProvider, action: string, args: Record<string, unknown>, policy?: Record<string, unknown>) {
  const { env } = fakeEnv(provider, policy);
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

describe('gateway rejects args the policy check would skip', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const onlyAllowed = { canRead: true, calendarFilter: { mode: 'allowlist', calendarIds: ['ALLOWED'] } };

  it.each([
    // An array was skipped by the calendar check (so it counted as the default
    // calendar) but sent as /me/calendars/FORBIDDEN.
    ['outlook_calendar.list_events', { calendarId: ['FORBIDDEN'] }],
    ['outlook_calendar.get_event', { calendar_id: { id: 'FORBIDDEN' }, event_id: 'e1' }],
    ['outlook_calendar.get_event', { calendarId: 'ALLOWED', event_id: '../../calendars/FORBIDDEN/events/e1' }],
  ] as const)('%s %j is denied before any provider call', async (action, args) => {
    const upstream = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', upstream);
    const res = await execute('outlook_calendar', action, args, onlyAllowed);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ decision: 'denied', reason: expect.stringMatching(/^E796/) });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('a non-allowlisted string calendarId is still denied by policy', async () => {
    const upstream = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', upstream);
    const res = await execute('outlook_calendar', 'outlook_calendar.list_events', { calendarId: 'FORBIDDEN' }, onlyAllowed);
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('gateway treats empty path IDs as omitted', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drive.list with folderId "" is not denied and sends no empty folder', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Response.json({ files: [] });
    }));
    const res = await execute('google_drive', 'drive.list', { folderId: '' });
    expect(res.status).toBe(200);
    expect(urls.length).toBe(1);
    expect(decodeURIComponent(urls[0])).not.toContain("'' in parents");
  });
});
