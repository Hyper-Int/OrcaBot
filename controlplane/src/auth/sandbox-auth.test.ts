// REVISION: sandbox-auth-tests-v2-refresh-bound-to-sandbox
import { describe, it, expect, beforeEach } from 'vitest';
import {
  authorizeSandboxForDashboard,
  dashboardIdForSandboxSession,
  refreshSandboxDashboardToken,
  sandboxInternalTokenEnv,
} from './sandbox-auth';
import { createDashboardToken, sandboxGeneration, verifyDashboardToken } from './dashboard-token';
import { tokenSigningSecret } from './pty-token';
import { createTestContext, seedDashboard, seedSession } from '../../tests/helpers';
import type { TestContext } from '../../tests/helpers';

function req(headers: Record<string, string>, method = 'GET'): Request {
  return new Request('https://api.example.com/internal/drive/file?dashboard_id=x', { method, headers });
}

// Signed with the same secret, but with an arbitrary expiry (createDashboardToken always uses now + 7d).
async function tokenWithExp(dashboardId: string, secret: string, expOffsetSeconds: number): Promise<string> {
  const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify({ dashboard_id: dashboardId, aud: 'mcp-ui', iat: now, exp: now + expOffsetSeconds }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return `${header}.${payload}.${b64(bin)}`;
}

describe('sandbox auth', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
    ctx.env.PTY_TOKEN_SECRET = 'test-pty-secret';
  });

  describe('authorizeSandboxForDashboard()', () => {
    it('lets the internal token through for any dashboard', async () => {
      expect(await authorizeSandboxForDashboard(req({ 'X-Internal-Token': 'test-internal-token' }), ctx.env, 'dash-a')).toBeNull();
    });

    it('rejects a wrong internal token', async () => {
      const res = await authorizeSandboxForDashboard(req({ 'X-Internal-Token': 'nope' }), ctx.env, 'dash-a');
      expect(res?.status).toBe(401);
    });

    it('lets a dashboard token through for its own dashboard', async () => {
      const token = await createDashboardToken('dash-a', tokenSigningSecret(ctx.env));
      expect(await authorizeSandboxForDashboard(req({ 'X-Dashboard-Token': token }), ctx.env, 'dash-a')).toBeNull();
    });

    it("rejects a dashboard token used against another dashboard", async () => {
      const token = await createDashboardToken('dash-a', tokenSigningSecret(ctx.env));
      const res = await authorizeSandboxForDashboard(req({ 'X-Dashboard-Token': token }), ctx.env, 'dash-b');
      expect(res?.status).toBe(403);
    });

    it('rejects a dashboard token when the resource dashboard is unknown', async () => {
      const token = await createDashboardToken('dash-a', tokenSigningSecret(ctx.env));
      const res = await authorizeSandboxForDashboard(req({ 'X-Dashboard-Token': token }), ctx.env, null);
      expect(res?.status).toBe(403);
    });

    it('rejects a dashboard token signed with INTERNAL_API_TOKEN (the VM-readable secret)', async () => {
      const forged = await createDashboardToken('dash-b', ctx.env.INTERNAL_API_TOKEN);
      const res = await authorizeSandboxForDashboard(req({ 'X-Dashboard-Token': forged }), ctx.env, 'dash-b');
      expect(res?.status).toBe(401);
    });

    it('rejects an expired dashboard token', async () => {
      const expired = await tokenWithExp('dash-a', tokenSigningSecret(ctx.env), -60);
      const res = await authorizeSandboxForDashboard(req({ 'X-Dashboard-Token': expired }), ctx.env, 'dash-a');
      expect(res?.status).toBe(401);
    });

    it('rejects a request with no credential', async () => {
      const res = await authorizeSandboxForDashboard(req({}), ctx.env, 'dash-a');
      expect(res?.status).toBe(401);
    });
  });

  describe('dashboardIdForSandboxSession()', () => {
    it('resolves the owning dashboard of a sandbox session', async () => {
      await seedSession(ctx.db, 'dash-a', 'item-1', { id: 'sess-1', sandboxSessionId: 'sbx-1' });
      expect(await dashboardIdForSandboxSession(ctx.env, 'sbx-1')).toBe('dash-a');
    });

    it('returns null for an unknown session', async () => {
      expect(await dashboardIdForSandboxSession(ctx.env, 'sbx-missing')).toBeNull();
    });
  });

  describe('refreshSandboxDashboardToken()', () => {
    const refreshReq = (headers: Record<string, string>) =>
      new Request('https://api.example.com/internal/sandbox/dashboard-token/refresh', { method: 'POST', headers });

    const CREATED_AT = '2026-10-01T12:00:00.000Z';
    const GEN = sandboxGeneration(CREATED_AT);
    const setSandbox = (sessionId: string, createdAt = CREATED_AT) => ctx.db.prepare(`
      INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, created_at)
      VALUES ('dash-a', ?, '', ?)
      ON CONFLICT(dashboard_id) DO UPDATE SET sandbox_session_id = excluded.sandbox_session_id, created_at = excluded.created_at
    `).bind(sessionId, createdAt).run();
    const refresh = async (token: string) => {
      const res = await refreshSandboxDashboardToken(refreshReq({ 'X-Dashboard-Token': token }), ctx.env);
      return { res, body: await res.json() as { token?: string; error?: string } };
    };

    beforeEach(async () => {
      await seedDashboard(ctx.db, 'owner-1', { id: 'dash-a' });
      await setSandbox('sbx-a');
    });

    it('keeps the token bound to the sandbox it was minted for', async () => {
      const token = await createDashboardToken('dash-a', tokenSigningSecret(ctx.env), undefined, GEN);
      const { res, body } = await refresh(token);
      expect(res.status).toBe(200);
      expect((await verifyDashboardToken(body.token!, tokenSigningSecret(ctx.env)))?.sbx_gen).toBe(GEN);
    });

    it('binds a token minted before sandbox generations to the current sandbox', async () => {
      const { res, body } = await refresh(await createDashboardToken('dash-a', tokenSigningSecret(ctx.env)));
      expect(res.status).toBe(200);
      expect((await verifyDashboardToken(body.token!, tokenSigningSecret(ctx.env)))?.sbx_gen).toBe(GEN);
    });

    it('a token copied out of a VM stops refreshing once that sandbox is replaced', async () => {
      let token = await createDashboardToken('dash-a', tokenSigningSecret(ctx.env), undefined, GEN);
      token = (await refresh(token)).body.token!;
      await setSandbox('sbx-b', '2026-10-09T08:00:00.000Z');
      const { res, body } = await refresh(token);
      expect(res.status).toBe(401);
      expect(body.error).toMatch(/^E79398/);
    });

    it('refuses while the dashboard has no live sandbox (retired)', async () => {
      await setSandbox('');
      const { res, body } = await refresh(await createDashboardToken('dash-a', tokenSigningSecret(ctx.env), undefined, GEN));
      expect(res.status).toBe(401);
      expect(body.error).toMatch(/^E79399/);
    });

    it('reads SQLite datetime() timestamps as UTC', () => {
      expect(sandboxGeneration('2026-10-01 12:00:00')).toBe(Date.parse('2026-10-01T12:00:00Z'));
    });

    it('issues a fresh token for the same dashboard', async () => {
      const token = await createDashboardToken('dash-a', tokenSigningSecret(ctx.env));
      const res = await refreshSandboxDashboardToken(refreshReq({ 'X-Dashboard-Token': token }), ctx.env);
      expect(res.status).toBe(200);
      const body = await res.json() as { token: string };
      const claims = await verifyDashboardToken(body.token, tokenSigningSecret(ctx.env));
      expect(claims?.dashboard_id).toBe('dash-a');
    });

    it('accepts a token that expired recently (VM was suspended)', async () => {
      const expired = await tokenWithExp('dash-a', tokenSigningSecret(ctx.env), -3 * 24 * 60 * 60);
      const res = await refreshSandboxDashboardToken(refreshReq({ 'X-Dashboard-Token': expired }), ctx.env);
      expect(res.status).toBe(200);
    });

    it('rejects a token that expired beyond the grace period', async () => {
      const expired = await tokenWithExp('dash-a', tokenSigningSecret(ctx.env), -31 * 24 * 60 * 60);
      const res = await refreshSandboxDashboardToken(refreshReq({ 'X-Dashboard-Token': expired }), ctx.env);
      expect(res.status).toBe(401);
    });

    it('refuses to mint from the internal token', async () => {
      const res = await refreshSandboxDashboardToken(refreshReq({ 'X-Internal-Token': 'test-internal-token' }), ctx.env);
      expect(res.status).toBe(401);
    });

    it('refuses once the dashboard is gone', async () => {
      const token = await createDashboardToken('dash-deleted', tokenSigningSecret(ctx.env));
      const res = await refreshSandboxDashboardToken(refreshReq({ 'X-Dashboard-Token': token }), ctx.env);
      expect(res.status).toBe(404);
    });
  });

  describe('sandboxInternalTokenEnv()', () => {
    it('passes INTERNAL_API_TOKEN to new VMs by default', () => {
      expect(sandboxInternalTokenEnv(ctx.env)).toEqual({ INTERNAL_API_TOKEN: 'test-internal-token' });
    });

    it('withholds it when WITHHOLD_INTERNAL_TOKEN_FROM_SANDBOX=true', () => {
      ctx.env.WITHHOLD_INTERNAL_TOKEN_FROM_SANDBOX = 'true';
      expect(sandboxInternalTokenEnv(ctx.env)).toEqual({});
    });
  });
});
