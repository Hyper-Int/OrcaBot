// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cоnnectGithub, callbackGithub } from './handler';
import type { AuthContext } from '../auth/middleware';
import type { EnvWithDriveCache } from '../storage/drive-cache';

// Minimal D1 fake covering the oauth_states and user_sessions queries the OAuth
// state helpers make; anything else returns no rows.
function fakeDb(sessions: Record<string, string>) {
  const states = new Map<string, { user_id: string; provider: string; metadata: string }>();
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    async run() {
      if (sql.includes('INSERT INTO oauth_states')) {
        const [state, user_id, provider, metadata] = args as string[];
        states.set(state, { user_id, provider, metadata });
      } else if (sql.includes('DELETE FROM oauth_states WHERE state')) {
        states.delete(args[0] as string);
      }
      return { success: true };
    },
    async all() {
      if (sql.includes('FROM oauth_states WHERE state')) {
        const row = states.get(args[0] as string);
        return { results: row && row.provider === args[1] ? [{ userId: row.user_id, metadata: row.metadata }] : [] };
      }
      return { results: [] };
    },
    async first() {
      if (sql.includes('FROM user_sessions')) {
        const userId = sessions[args[0] as string];
        return userId ? { id: userId, email: `${userId}@x.test`, name: userId, created_at: '', trial_started_at: null } : null;
      }
      return null;
    },
  });
  return {
    states,
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: Array<ReturnType<typeof stmt>>) => Promise.all(stmts.map((s) => s.all())),
  };
}

const auth = (id: string) => ({ isAuthenticated: true, user: { id, email: `${id}@x.test`, name: id, createdAt: '' } }) as AuthContext;

describe('OAuth state is bound to the browser that started the flow', () => {
  let env: EnvWithDriveCache;
  let fetchMock: ReturnType<typeof vi.fn<[], Promise<Response>>>;

  beforeEach(() => {
    env = {
      DB: fakeDb({ 'victim-session': 'victim', 'attacker-session': 'attacker' }),
      GITHUB_CLIENT_ID: 'cid',
      GITHUB_CLIENT_SECRET: 'csecret',
    } as unknown as EnvWithDriveCache;
    // The token exchange is the first network call after the state check.
    fetchMock = vi.fn<[], Promise<Response>>(async () => new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function startFlow(userId: string) {
    const res = await cоnnectGithub(new Request('https://api.test/integrations/github/connect'), env, auth(userId));
    expect(res.status).toBe(302);
    const state = new URL(res.headers.get('Location')!).searchParams.get('state')!;
    const setCookie = res.headers.get('Set-Cookie')!;
    return { state, cookie: setCookie.split(';')[0], setCookie };
  }

  const callback = (state: string, cookie?: string) =>
    callbackGithub(
      new Request(`https://api.test/integrations/github/callback?code=c&state=${state}`, {
        headers: cookie ? { Cookie: cookie } : {},
      }),
      env
    );

  it('sets an HttpOnly, Lax, Secure cookie scoped to the state', async () => {
    const { state, setCookie } = await startFlow('attacker');
    expect(setCookie).toMatch(new RegExp(`^orcabot_oauth_${state}=[0-9a-f-]{36}; `));
    expect(setCookie).toContain('Path=/integrations');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
    // Only the hash is stored server-side.
    const stored = (env.DB as unknown as ReturnType<typeof fakeDb>).states.get(state)!;
    expect(stored.metadata).not.toContain(setCookie.split(';')[0].split('=')[1]);
  });

  it('rejects a callback finished in another browser (attacker state, victim browser)', async () => {
    const { state } = await startFlow('attacker');
    const res = await callback(state, 'orcabot_session=victim-session');
    expect(await res.text()).toContain('Invalid or expired state');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a callback with no cookies at all', async () => {
    const { state } = await startFlow('attacker');
    expect(await (await callback(state)).text()).toContain('Invalid or expired state');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a forged binding cookie', async () => {
    const { state } = await startFlow('attacker');
    const res = await callback(state, `orcabot_oauth_${state}=00000000-0000-0000-0000-000000000000`);
    expect(await res.text()).toContain('Invalid or expired state');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects one flow\'s cookie presented for another flow\'s state', async () => {
    const mine = await startFlow('victim');
    const theirs = await startFlow('attacker');
    const value = mine.cookie.split('=')[1];
    const res = await callback(theirs.state, `orcabot_oauth_${theirs.state}=${value}`);
    expect(await res.text()).toContain('Invalid or expired state');
  });

  it('accepts the browser that started the flow (binding cookie)', async () => {
    const { state, cookie } = await startFlow('victim');
    await callback(state, cookie);
    expect(fetchMock).toHaveBeenCalledTimes(1); // got past the state check to the token exchange
  });

  it('accepts a session for the same user when the binding cookie is missing', async () => {
    const { state } = await startFlow('victim');
    await callback(state, 'orcabot_session=victim-session');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is single use', async () => {
    const { state, cookie } = await startFlow('victim');
    await callback(state, cookie);
    const again = await callback(state, cookie);
    expect(await again.text()).toContain('Invalid or expired state');
  });
});
