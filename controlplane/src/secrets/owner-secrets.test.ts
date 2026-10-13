// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, it, expect, afterEach, vi } from 'vitest';
// REVISION: owner-secrets-tests-v4-apply-endpoint-tracking
import { applyDashboardOwnerSecrets, autoApplySecretsToSessions, dashboardSecretsOwner } from './handler';
import { applySecretsToSession } from '../sessions/handler';
import { SandboxClient } from '../sandbox/client';
import type { Env } from '../types';

// Fake D1 for the auto-apply path: one active session on dashboard `dash-1`
// (owned by `owner`), and one stored secret per user.
function fakeEnv(previousNames: string[] | string = [], emptyOwner = false, writes: string[] = []) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    async first() {
      if (sql.includes('FROM sessions s')) {
        return { id: 's1', dashboard_id: 'dash-1', sandbox_session_id: 'sbx-1', sandbox_machine_id: '', status: 'active', role: 'owner' };
      }
      if (sql.includes('SELECT owner_id FROM dashboards')) return args[0] === 'dash-1' ? { owner_id: 'owner' } : null;
      if (sql.includes('SELECT applied_secret_names')) return { applied_secret_names: typeof previousNames === 'string' ? previousNames : JSON.stringify(previousNames) };
      if (sql.includes('dashboard_members')) return { role: 'owner' };
      return null;
    },
    async all() {
      if (sql.includes('FROM sessions')) {
        return { results: [{ id: 's1', dashboard_id: 'dash-1', sandbox_session_id: 'sbx-1', sandbox_machine_id: '' }] };
      }
      if (sql.includes('FROM user_secrets')) {
        if (emptyOwner && args[0] === 'owner') return { results: [] };
        return { results: [{ name: `${args[0]}_KEY`, value: `${args[0]}-value`, type: 'secret', broker_protected: 1, dashboard_id: 'dash-1' }] };
      }
      return { results: [] };
    },
    async run() {
      writes.push(sql);
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

  it.each([false, true])('removes legacy collaborator keys before tracking owner secrets (empty owner: %s)', async (emptyOwner) => {
    const env = fakeEnv(['collaborator_KEY', 'owner_KEY'], emptyOwner);
    const pushes = captureEnvPushes();
    const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
    const names = await applyDashboardOwnerSecrets(env, sandbox, 'dash-1', 'sbx-1', '');
    expect(pushes).toHaveLength(1);
    const body = JSON.parse(pushes[0].body);
    expect(body.unset).toEqual(emptyOwner
      ? ['collaborator_KEY', 'collaborator_KEY_BROKER', 'owner_KEY', 'owner_KEY_BROKER']
      : ['collaborator_KEY', 'collaborator_KEY_BROKER']);
    expect(names).toEqual(emptyOwner ? [] : ['owner_KEY']);
    expect(body.secrets?.collaborator_KEY).toBeUndefined();
  });

  it('fails startup rather than forgetting tracking when cleanup fails', async () => {
    const env = fakeEnv(['collaborator_KEY'], true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('cleanup failed', { status: 403 })));
    const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
    await expect(applyDashboardOwnerSecrets(env, sandbox, 'dash-1', 'sbx-1', '')).rejects.toThrow();
  });

  it('still cleans up, and starts the terminal, when owner secrets cannot be loaded', async () => {
    // e.g. a deployment without SECRETS_ENCRYPTION_KEY: this used to block
    // every terminal once the pre-apply step became fail-closed.
    const env = fakeEnv(['collaborator_KEY', 'owner_KEY']);
    delete (env as unknown as Record<string, unknown>).SECRETS_ENCRYPTION_KEY;
    const pushes = captureEnvPushes();
    const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
    const names = await applyDashboardOwnerSecrets(env, sandbox, 'dash-1', 'sbx-1', '');
    expect(names).toEqual([]);
    expect(pushes).toHaveLength(1);
    const body = JSON.parse(pushes[0].body);
    expect(body.unset).toEqual(['collaborator_KEY', 'collaborator_KEY_BROKER', 'owner_KEY', 'owner_KEY_BROKER']);
    expect(body.secrets).toBeUndefined();
  });

  it('does not block terminals on corrupt tracking data', async () => {
    const env = fakeEnv('{not json');
    const pushes = captureEnvPushes();
    const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
    const names = await applyDashboardOwnerSecrets(env, sandbox, 'dash-1', 'sbx-1', '');
    expect(names).toEqual(['owner_KEY']);
    expect(JSON.parse(pushes[0].body).unset).toBeUndefined();
  });

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

  describe('explicit apply endpoint', () => {
    const tracked = (writes: string[]) => writes.filter((sql) => sql.includes('applied_secret_names'));

    it('keeps the old tracking when the sandbox rejects the cleanup', async () => {
      const writes: string[] = [];
      const env = fakeEnv(['collaborator_KEY'], false, writes);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('cleanup failed', { status: 403 })));
      const res = await applySecretsToSession(env as never, 's1', 'owner');
      expect(res.status).toBe(500);
      expect(tracked(writes)).toHaveLength(0);
    });

    it('unsets collaborator names (and _BROKER), then updates tracking', async () => {
      const writes: string[] = [];
      const env = fakeEnv(['collaborator_KEY'], false, writes);
      const pushes = captureEnvPushes();
      const res = await applySecretsToSession(env as never, 's1', 'owner');
      expect(res.status).toBe(200);
      const body = JSON.parse(pushes.find((p) => p.url.includes('/sessions/sbx-1/env'))!.body);
      expect(body.unset).toEqual(['collaborator_KEY', 'collaborator_KEY_BROKER']);
      expect(Object.keys(body.secrets)).toEqual(['owner_KEY']);
      expect(tracked(writes)).toHaveLength(1);
    });
  });
});
