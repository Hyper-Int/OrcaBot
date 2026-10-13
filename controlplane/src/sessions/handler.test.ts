// REVISION: session-tests-v4-fail-closed-no-pty
/**
 * Session Handler Tests
 *
 * These tests focus on the core session logic without complex JOINs.
 * Full integration tests should use a real D1 database.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import { createSessiоn } from './handler';
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
