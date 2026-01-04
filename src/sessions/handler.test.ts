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

    it('should create and list PTYs', async () => {
      const client = new SandboxClient(ctx.env.SANDBOX_URL);

      const session = await client.createSession();
      const pty = await client.createPTY(session.id);

      expect(pty.id).toBeTruthy();

      const ptys = await client.listPTYs(session.id);
      expect(ptys).toHaveLength(1);
    });

    it('should manage agent lifecycle', async () => {
      const client = new SandboxClient(ctx.env.SANDBOX_URL);

      const session = await client.createSession();

      // Start agent
      const agent = await client.startAgent(session.id);
      expect(agent.state).toBe('running');

      // Pause
      const paused = await client.pauseAgent(session.id);
      expect(paused.state).toBe('paused');

      // Resume
      const resumed = await client.resumeAgent(session.id);
      expect(resumed.state).toBe('running');

      // Stop
      await client.stopAgent(session.id);
      const stopped = await client.getAgent(session.id);
      expect(stopped).toBeNull();
    });

    it('should manage files', async () => {
      const client = new SandboxClient(ctx.env.SANDBOX_URL);

      const session = await client.createSession();

      // Write
      await client.writeFile(session.id, '/test.txt', 'Hello World');

      // Read
      const content = await client.readFile(session.id, '/test.txt');
      expect(new TextDecoder().decode(content)).toBe('Hello World');

      // List
      const files = await client.listFiles(session.id, '/');
      expect(files).toHaveLength(1);

      // Delete
      await client.deleteFile(session.id, '/test.txt');
      const afterDelete = await client.listFiles(session.id, '/');
      expect(afterDelete).toHaveLength(0);
    });
  });

  describe('Session database operations', () => {
    it('should seed and query sessions', async () => {
      const dashboard = await seedDashboard(ctx.db, testUser.id);
      const item = await seedDashboardItem(ctx.db, dashboard.id, { type: 'terminal' });
      const session = await seedSession(ctx.db, dashboard.id, item.id, {
        sandboxSessionId: 'sandbox-123',
      });

      // Query the session directly
      const result = await ctx.db.prepare(`
        SELECT * FROM sessions WHERE id = ?
      `).bind(session.id).first();

      expect(result).not.toBeNull();
      expect(result!.status).toBe('active');
      expect(result!.sandbox_session_id).toBe('sandbox-123');
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
