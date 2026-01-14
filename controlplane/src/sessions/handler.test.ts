/**
 * Session Handler Tests
 *
 * These tests focus on the core session logic without complex JOINs.
 * Full integration tests should use a real D1 database.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
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
import { createSession } from './handler';
import type { TestContext } from '../../tests/helpers';

describe('Session Handlers', () => {
  let ctx: TestContext;
  let testUser: { id: string; email: string; name: string };
  const mockSandbox = createMockSandboxServer();

  beforeAll(() => {
    mockSandbox.server.listen({ onUnhandledRequest: 'error' });
  });

  afterEach(() => {
    mockSandbox.reset();
  });

  afterAll(() => {
    mockSandbox.server.close();
  });

  beforeEach(async () => {
    ctx = await createTestContext();
    testUser = createTestUser({ id: 'user-1' });
    await seedUser(ctx.db, testUser);
  });

  describe('SandboxClient integration', () => {
    it('should create session via sandbox client', async () => {
      const client = new SandboxClient(ctx.env.SANDBOX_URL);

      const session = await client.createSession();

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

      const response = await createSession(ctx.env, dashboard.id, item.id, testUser.id, testUser.name);
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.session.ownerUserId).toBe(testUser.id);
      expect(data.session.ownerName).toBe(testUser.name);
      expect(data.session.sandboxMachineId).toBe('machine-1');

      const result = await ctx.db.prepare(`
        SELECT * FROM sessions WHERE id = ?
      `).bind(data.session.id).first();

      expect(result).not.toBeNull();
      expect(result!.owner_user_id).toBe(testUser.id);
      expect(result!.owner_name).toBe(testUser.name);
      expect(result!.sandbox_machine_id).toBe('machine-1');
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
