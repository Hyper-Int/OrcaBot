// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, it, expect, afterEach, vi } from 'vitest';
import { autoApplySecretsToSessions, dashboardSecretsOwner } from './handler';
import type { Env } from '../types';

// Fake D1 for the auto-apply path: one active session on dashboard `dash-1`
// (owned by `owner`), and one stored secret per user.
function fakeEnv() {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    async first() {
      if (sql.includes('SELECT owner_id FROM dashboards')) return args[0] === 'dash-1' ? { owner_id: 'owner' } : null;
      if (sql.includes('dashboard_members')) return { role: 'owner' };
      return null;
    },
    async all() {
      if (sql.includes('FROM sessions')) {
        return { results: [{ id: 's1', dashboard_id: 'dash-1', sandbox_session_id: 'sbx-1', sandbox_machine_id: '' }] };
      }
      if (sql.includes('FROM user_secrets')) {
        return { results: [{ name: `${args[0]}_KEY`, value: `${args[0]}-value`, type: 'secret', broker_protected: 1, dashboard_id: 'dash-1' }] };
      }
      return { results: [] };
    },
    async run() {
      return { success: true };
    },
  });
  return {
    DB: { prepare: (sql: string) => stmt(sql) },
    SANDBOX_URL: 'http://sandbox.test',
    SANDBOX_INTERNAL_TOKEN: 'tok',
    SECRETS_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  } as unknown as Env;
}

describe('a dashboard VM only receives its owner\'s secrets', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function captureEnvPushes() {
    const pushes: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      pushes.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response('{}');
    }));
    return pushes;
  }

  it('resolves the owner', async () => {
    expect(await dashboardSecretsOwner(fakeEnv(), 'dash-1')).toBe('owner');
  });

  it('a collaborator changing their secrets does not push them into the owner\'s VM', async () => {
    const pushes = captureEnvPushes();
    await autoApplySecretsToSessions(fakeEnv(), 'collaborator', 'dash-1');
    expect(pushes).toHaveLength(0);
  });

  it('a collaborator\'s global secret change does not reach dashboards they don\'t own', async () => {
    const pushes = captureEnvPushes();
    await autoApplySecretsToSessions(fakeEnv(), 'collaborator', '_global');
    expect(pushes).toHaveLength(0);
  });

  it('the owner changing secrets pushes the owner\'s secrets', async () => {
    const pushes = captureEnvPushes();
    await autoApplySecretsToSessions(fakeEnv(), 'owner', 'dash-1');
    const envPush = pushes.find((p) => p.url.includes('/sessions/sbx-1/env'));
    expect(envPush?.body).toContain('owner_KEY');
    expect(envPush?.body).not.toContain('collaborator');
  });
});
