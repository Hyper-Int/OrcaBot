import { describe, it, expect, beforeEach } from 'vitest';
import {
  authorizeSandboxForDashboard,
  dashboardIdForSandboxSession,
  refreshSandboxDashboardToken,
  sandboxInternalTokenEnv,
} from './sandbox-auth';
import { createDashboardToken, verifyDashboardToken } from './dashboard-token';
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

    beforeEach(async () => {
      await seedDashboard(ctx.db, 'owner-1', { id: 'dash-a' });
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
