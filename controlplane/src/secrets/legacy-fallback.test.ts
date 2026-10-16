// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: secrets-legacy-fallback-tests-v1
import { describe, it, expect, afterEach, vi } from 'vitest';
import { pushOwnerSecretsToCurrentSandbox } from './handler';
import { SandboxClient } from '../sandbox/client';
import type { Env } from '../types';

// A live sandbox that predates dashboard_sandboxes (no row). Stateful fake D1:
// one dashboard_sandboxes row at most, and a mutable owner secret list.
function legacyEnv(ownerSecrets: string[]) {
  let row: { sandbox_session_id: string; sandbox_machine_id: string; applied_secret_names: string } | null = null;
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    async first() {
      if (sql.includes('FROM dashboard_sandboxes')) return row;
      if (sql.includes('dashboard_members')) return { role: 'owner' };
      return null;
    },
    async all() {
      if (sql.includes('FROM user_secrets')) {
        return { results: ownerSecrets.map(name => ({ name, value: `${name}-value`, type: 'secret', broker_protected: 1, dashboard_id: 'dash-1' })) };
      }
      return { results: [] };
    },
    async run() {
      if (sql.includes('INSERT INTO dashboard_sandboxes') && !row) {
        row = { sandbox_session_id: String(args[1]), sandbox_machine_id: String(args[2]), applied_secret_names: String(args[3]) };
      } else if (sql.includes('UPDATE dashboard_sandboxes SET applied_secret_names') && row && row.sandbox_session_id === args[2]) {
        row.applied_secret_names = String(args[0]);
      }
      return { success: true, meta: { changes: 1 } };
    },
  });
  const env = {
    DB: { prepare: (sql: string) => stmt(sql) },
    SANDBOX_URL: 'http://sandbox.test',
    SANDBOX_INTERNAL_TOKEN: 'tok',
    SECRETS_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  } as unknown as Env;
  return { env, getRow: () => row };
}

describe('legacy sandbox without a dashboard_sandboxes row', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a deleted secret is unset on the second push', async () => {
    const secrets = ['API_KEY'];
    const { env, getRow } = legacyEnv(secrets);
    const pushes: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      pushes.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response('{}');
    }));
    const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);

    expect(await pushOwnerSecretsToCurrentSandbox(env, sandbox, 'dash-1', 'owner', 'legacy-sbx', 'm1')).not.toBeNull();
    expect(getRow()?.sandbox_session_id).toBe('legacy-sbx');

    secrets.length = 0; // owner deletes the secret
    expect(await pushOwnerSecretsToCurrentSandbox(env, sandbox, 'dash-1', 'owner', 'legacy-sbx', 'm1')).not.toBeNull();

    const last = pushes.filter(p => p.url.includes('/sessions/legacy-sbx/env')).pop();
    expect(last).toBeDefined();
    expect(JSON.parse(last!.body).unset).toEqual(['API_KEY', 'API_KEY_BROKER']);
  });
});
