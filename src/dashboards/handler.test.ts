/**
 * Dashboard Handler Tests
 *
 * NOTE: These tests use a simplified D1 mock that doesn't support complex JOINs.
 * For full integration testing, use wrangler's D1 local database.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  listDashboards,
  createDashboard,
} from './handler';
import {
  createTestContext,
  seedUser,
  createTestUser,
} from '../../tests/helpers';
import type { TestContext } from '../../tests/helpers';

describe('Dashboard Handlers', () => {
  let ctx: TestContext;
  let testUser: { id: string; email: string; name: string };

  beforeEach(async () => {
    ctx = await createTestContext();
    testUser = createTestUser({ id: 'user-1' });
    await seedUser(ctx.db, testUser);
  });

  describe('createDashboard()', () => {
    it('should create a new dashboard', async () => {
      const response = await createDashboard(ctx.env, testUser.id, { name: 'My Dashboard' });
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.dashboard).toHaveProperty('id');
      expect(data.dashboard.name).toBe('My Dashboard');
      expect(data.dashboard.ownerId).toBe(testUser.id);
    });

    it('should set timestamps on creation', async () => {
      const response = await createDashboard(ctx.env, testUser.id, { name: 'Test' });
      const data = await response.json();

      expect(data.dashboard.createdAt).toBeTruthy();
      expect(data.dashboard.updatedAt).toBeTruthy();
    });
  });

  describe('Database operations', () => {
    it('should insert dashboard into database', async () => {
      await createDashboard(ctx.env, testUser.id, { name: 'DB Test' });

      const result = await ctx.db.prepare(`
        SELECT * FROM dashboards WHERE owner_id = ?
      `).bind(testUser.id).first();

      expect(result).not.toBeNull();
      expect(result!.name).toBe('DB Test');
    });

    it('should create dashboard_members entry', async () => {
      const response = await createDashboard(ctx.env, testUser.id, { name: 'Member Test' });
      const { dashboard } = await response.json();

      const member = await ctx.db.prepare(`
        SELECT dashboard_id, user_id, role FROM dashboard_members WHERE dashboard_id = ?
      `).bind(dashboard.id).first();

      expect(member).not.toBeNull();
      expect(member!.dashboard_id).toBe(dashboard.id);
      expect(member!.user_id).toBe(testUser.id);
    });
  });
});
