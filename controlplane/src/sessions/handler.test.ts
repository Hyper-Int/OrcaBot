// REVISION: session-tests-v6-push-current-sandbox
/**
 * Session Handler Tests
 *
 * These tests focus on the core session logic without complex JOINs.
 * Full integration tests should use a real D1 database.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import * as secretsHandler from '../secrets/handler';
import {
  createTestContext,
  seedUser,
  seedDashboard,
  seedDashboardItem,
  seedSession,
  createTestUser,
} from '../../tests/helpers';
import { createMockSandboxServer } from '../../tests/mocks/sandbox';
import { SandboxClient } from '../sandbox/client';
import { createSessiоn, applySecretsToSession } from './handler';
import { ensureDriveCache } from '../storage/drive-cache';
import type { TestContext } from '../../tests/helpers';

describe('Session Handlers', () => {
  let ctx: TestContext;
  let testUser: { id: string; email: string; name: string };
  const mockSandbox = createMockSandboxServer();

  beforeAll(() => {
    mockSandbox.server.listen({ onUnhandledRequest: 'error' });
  });

  // The terminal must not start: no PTY in any sandbox session.
  const ptysStarted = () => [...mockSandbox.sessions.values()].reduce((n, s) => n + s.ptys.size, 0);

  afterEach(() => {
    mockSandbox.reset();
    mockSandbox.server.resetHandlers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    mockSandbox.server.close();
  });

  beforeEach(async () => {
    ctx = await createTestContext();
    ctx.env.SECRETS_ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    testUser = createTestUser({ id: 'user-1' });
    await seedUser(ctx.db, testUser);
  });

  describe('SandboxClient integration', () => {
    it('should create session via sandbox client', async () => {
      const client = new SandboxClient(ctx.env.SANDBOX_URL);

      const session = await client.createSessiоn();

      expect(session).toHaveProperty('id');
      expect(session.id).toBeTruthy();
    });

    // Note: PTY, Agent, and Filesystem operations are accessed directly via sandbox URLs,
    // not proxied through the control plane. See CLAUDE.md for architecture details.
  });

  describe('Session database operations', () => {
    it('should store owner info when creating a session', async () => {
      const dashboard = await seedDashboard(ctx.db, testUser.id);
      const item = await seedDashboardItem(ctx.db, dashboard.id, { type: 'terminal' });

      const response = await createSessiоn(ensureDriveCache(ctx.env), dashboard.id, item.id, testUser.id, testUser.name);
      expect(response.status).toBe(201);

      const data = await response.json() as Record<string, any>;
      expect(data.session.ownerUserId).toBe(testUser.id);
      expect(data.session.ownerName).toBe(testUser.name);
      expect(
        data.session.sandboxMachineId === undefined
          || typeof data.session.sandboxMachineId === 'string'
      ).toBe(true);

      const result = await ctx.db.prepare(`
        SELECT * FROM sessions WHERE id = ?
      `).bind(data.session.id).first();

      expect(result).not.toBeNull();
      expect(result!.owner_user_id).toBe(testUser.id);
      expect(result!.owner_name).toBe(testUser.name);
      expect(
        result!.sandbox_machine_id === undefined
          || typeof result!.sandbox_machine_id === 'string'
      ).toBe(true);
    });

    it('reprovisions instead of failing when the sandbox session is gone at secret cleanup', async () => {
      const dashboard = await seedDashboard(ctx.db, testUser.id);
      const item = await seedDashboardItem(ctx.db, dashboard.id, { type: 'terminal' });
      // The first sandbox session vanishes (redeploy) before secret cleanup:
      // updateEnv 404s. That must take the reprovision path, not fail creation.
      const calls: string[] = [];
      vi.spyOn(secretsHandler, 'applyDashboardOwnerSecrets').mockImplementation(async (_e, _s, _d, sessionId) => {
        calls.push(sessionId);
        if (calls.length === 1) throw new Error('Failed to update env: 404');
        return ['OWNER_KEY'];
      });

      const response = await createSessiоn(ensureDriveCache(ctx.env), dashboard.id, item.id, testUser.id, testUser.name);
      expect(response.status).toBe(201);
      expect(calls).toHaveLength(2);
      expect(calls[1]).not.toBe(calls[0]);
      const data = await response.json() as Record<string, any>;
      expect(data.session.status).toBe('active');
      expect(data.session.sandboxSessionId).toBe(calls[1]);
    });

    it('keeps secret tracking across a reprovision and unsets it in the replacement session', async () => {
      const dashboard = await seedDashboard(ctx.db, testUser.id);
      const item = await seedDashboardItem(ctx.db, dashboard.id, { type: 'terminal' });
      // A live sandbox session with a collaborator's secret still tracked.
      const old = await new SandboxClient(ctx.env.SANDBOX_URL).createSessiоn();
      await ctx.db.prepare(`
        INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, applied_secret_names, created_at)
        VALUES (?, ?, '', ?, ?)
      `).bind(dashboard.id, old.id, JSON.stringify(['COLLAB_KEY']), new Date().toISOString()).run();

      // It vanishes between validation and cleanup. On desktop the replacement
      // shares its workspace .env, so the replacement must get the unset.
      const pushes: Array<{ session: string; body: Record<string, unknown> }> = [];
      mockSandbox.server.use(http.post(`${ctx.env.SANDBOX_URL}/sessions/:id/env`, async ({ params, request }) => {
        if (params.id === old.id) return HttpResponse.json({ error: 'session not found' }, { status: 404 });
        pushes.push({ session: params.id as string, body: await request.json() as Record<string, unknown> });
        return HttpResponse.json({ status: 'ok' });
      }));

      const response = await createSessiоn(ensureDriveCache(ctx.env), dashboard.id, item.id, testUser.id, testUser.name);
      expect(response.status).toBe(201);
      const data = await response.json() as Record<string, any>;
      expect(data.session.sandboxSessionId).not.toBe(old.id);
      expect(pushes).toHaveLength(1);
      expect(pushes[0].session).toBe(data.session.sandboxSessionId);
      expect(pushes[0].body.unset).toEqual(['COLLAB_KEY', 'COLLAB_KEY_BROKER']);
      const row = await ctx.db.prepare(`SELECT sandbox_session_id, applied_secret_names FROM dashboard_sandboxes WHERE dashboard_id = ?`)
        .bind(dashboard.id).first<{ sandbox_session_id: string; applied_secret_names: string }>();
      expect(row?.sandbox_session_id).toBe(data.session.sandboxSessionId);
      expect(JSON.parse(row!.applied_secret_names)).toEqual([]);
    });

    it('keeps secret tracking when validation finds the sandbox session gone', async () => {
      const dashboard = await seedDashboard(ctx.db, testUser.id);
      const item = await seedDashboardItem(ctx.db, dashboard.id, { type: 'terminal' });
      // Not known to the mock sandbox: the /ptys validation 404s up front.
      await ctx.db.prepare(`
        INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, applied_secret_names, created_at)
        VALUES (?, 'gone-session', '', ?, ?)
      `).bind(dashboard.id, JSON.stringify(['COLLAB_KEY']), new Date().toISOString()).run();
      const pushes: Array<Record<string, unknown>> = [];
      mockSandbox.server.use(http.post(`${ctx.env.SANDBOX_URL}/sessions/:id/env`, async ({ request }) => {
        pushes.push(await request.json() as Record<string, unknown>);
        return HttpResponse.json({ status: 'ok' });
      }));

      const response = await createSessiоn(ensureDriveCache(ctx.env), dashboard.id, item.id, testUser.id, testUser.name);
      expect(response.status).toBe(201);
      expect(pushes.map((b) => b.unset)).toEqual([['COLLAB_KEY', 'COLLAB_KEY_BROKER']]);
    });

    // A reprovision (timeout, 502/503) leaves older `sessions` rows pointing at
    // the replaced sandbox session, which may still be alive.
    it.each([
      ['secret change', (dashboardId: string, sessionId: string) =>
        secretsHandler.autoApplySecretsToSessions(ctx.env, testUser.id, dashboardId).then(() => sessionId)],
      ['explicit apply', async (_dashboardId: string, sessionId: string) => {
        expect((await applySecretsToSession(ensureDriveCache(ctx.env), sessionId, testUser.id)).status).toBe(200);
      }],
    ] as const)('%s pushes to the current sandbox session, not a replaced one', async (_name, run) => {
      const dashboard = await seedDashboard(ctx.db, testUser.id);
      const item = await seedDashboardItem(ctx.db, dashboard.id, { type: 'terminal' });
      const client = new SandboxClient(ctx.env.SANDBOX_URL);
      const old = await client.createSessiоn();
      const current = await client.createSessiоn();
      const stale = await seedSession(ctx.db, dashboard.id, item.id, { sandboxSessionId: old.id, ownerUserId: testUser.id });
      await ctx.db.prepare(`
        INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, applied_secret_names, created_at)
        VALUES (?, ?, '', ?, ?)
      `).bind(dashboard.id, current.id, JSON.stringify(['DELETED_KEY']), new Date().toISOString()).run();
      const pushes: Array<{ session: string; body: Record<string, unknown> }> = [];
      mockSandbox.server.use(http.post(`${ctx.env.SANDBOX_URL}/sessions/:id/env`, async ({ params, request }) => {
        pushes.push({ session: params.id as string, body: await request.json() as Record<string, unknown> });
        return HttpResponse.json({ status: 'ok' });
      }));

      await run(dashboard.id, stale.id);

      expect(pushes.map((p) => p.session)).toEqual([current.id]);
      expect(pushes[0].body.unset).toEqual(['DELETED_KEY', 'DELETED_KEY_BROKER']);
      const row = await ctx.db.prepare(`SELECT sandbox_session_id, applied_secret_names FROM dashboard_sandboxes WHERE dashboard_id = ?`)
        .bind(dashboard.id).first<{ sandbox_session_id: string; applied_secret_names: string }>();
      expect(row?.sandbox_session_id).toBe(current.id);
      expect(JSON.parse(row!.applied_secret_names)).toEqual([]);
    });

    it('does not push to a retired sandbox', async () => {
      const dashboard = await seedDashboard(ctx.db, testUser.id);
      const item = await seedDashboardItem(ctx.db, dashboard.id, { type: 'terminal' });
      const old = await new SandboxClient(ctx.env.SANDBOX_URL).createSessiоn();
      await seedSession(ctx.db, dashboard.id, item.id, { sandboxSessionId: old.id, ownerUserId: testUser.id });
      await ctx.db.prepare(`
        INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, applied_secret_names, created_at)
        VALUES (?, '', '', ?, ?)
      `).bind(dashboard.id, JSON.stringify(['DELETED_KEY']), new Date().toISOString()).run();
      const pushes: string[] = [];
      mockSandbox.server.use(http.post(`${ctx.env.SANDBOX_URL}/sessions/:id/env`, ({ params }) => {
        pushes.push(params.id as string);
        return HttpResponse.json({ status: 'ok' });
      }));
      await secretsHandler.autoApplySecretsToSessions(ctx.env, testUser.id, dashboard.id);
      expect(pushes).toEqual([]);
      const row = await ctx.db.prepare(`SELECT applied_secret_names FROM dashboard_sandboxes WHERE dashboard_id = ?`)
        .bind(dashboard.id).first<{ applied_secret_names: string }>();
      expect(JSON.parse(row!.applied_secret_names)).toEqual(['DELETED_KEY']);
    });

    it.each([
      ['cleanup rejected by the sandbox', 'Failed to update env: 403'],
      ['tracking could not be written', 'D1 error'],
    ])('still fails closed when %s', async (_name, message) => {
      const dashboard = await seedDashboard(ctx.db, testUser.id);
      const item = await seedDashboardItem(ctx.db, dashboard.id, { type: 'terminal' });
      vi.spyOn(secretsHandler, 'applyDashboardOwnerSecrets').mockRejectedValue(new Error(message));

      const response = await createSessiоn(ensureDriveCache(ctx.env), dashboard.id, item.id, testUser.id, testUser.name);
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(ptysStarted()).toBe(0);
    });

    it('fails closed when cleanup fails on the reprovisioned sandbox too', async () => {
      const dashboard = await seedDashboard(ctx.db, testUser.id);
      const item = await seedDashboardItem(ctx.db, dashboard.id, { type: 'terminal' });
      const spy = vi.spyOn(secretsHandler, 'applyDashboardOwnerSecrets')
        .mockRejectedValueOnce(new Error('Failed to update env: 404'))
        .mockRejectedValueOnce(new Error('Failed to update env: 403'));

      const response = await createSessiоn(ensureDriveCache(ctx.env), dashboard.id, item.id, testUser.id, testUser.name);
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(ptysStarted()).toBe(0);
    });

    it('should seed and query sessions', async () => {
      const dashboard = await seedDashboard(ctx.db, testUser.id);
      const item = await seedDashboardItem(ctx.db, dashboard.id, { type: 'terminal' });
      const session = await seedSession(ctx.db, dashboard.id, item.id, {
        sandboxSessionId: 'sandbox-123',
        sandboxMachineId: 'machine-123',
      });

      // Query the session directly
      const result = await ctx.db.prepare(`
        SELECT * FROM sessions WHERE id = ?
      `).bind(session.id).first();

      expect(result).not.toBeNull();
      expect(result!.status).toBe('active');
      expect(result!.sandbox_session_id).toBe('sandbox-123');
      expect(result!.sandbox_machine_id).toBe('machine-123');
    });

    it('should query session by sandbox_session_id', async () => {
      const dashboard = await seedDashboard(ctx.db, testUser.id);
      const item = await seedDashboardItem(ctx.db, dashboard.id, { type: 'terminal' });
      await seedSession(ctx.db, dashboard.id, item.id, {
        sandboxSessionId: 'unique-sandbox-id',
      });

      const result = await ctx.db.prepare(`
        SELECT * FROM sessions WHERE sandbox_session_id = ?
      `).bind('unique-sandbox-id').first();

      expect(result).not.toBeNull();
      expect(result!.dashboard_id).toBe(dashboard.id);
    });
  });
});
