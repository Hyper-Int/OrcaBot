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
  upsertItem,
} from './handler';
import {
  createTestContext,
  seedUser,
  seedDashboard,
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

  describe('API Response Shape', () => {
    it('should return camelCase keys in dashboard response', async () => {
      const response = await createDashboard(ctx.env, testUser.id, { name: 'Shape Test' });
      const data = await response.json() as { dashboard: Record<string, unknown> };

      // Should have camelCase keys
      expect(data.dashboard).toHaveProperty('ownerId');
      expect(data.dashboard).toHaveProperty('createdAt');
      expect(data.dashboard).toHaveProperty('updatedAt');

      // Should NOT have snake_case keys
      expect(data.dashboard).not.toHaveProperty('owner_id');
      expect(data.dashboard).not.toHaveProperty('created_at');
      expect(data.dashboard).not.toHaveProperty('updated_at');
    });

    it('should return camelCase keys in item response', async () => {
      const dashboard = await seedDashboard(ctx.db, testUser.id);

      const response = await upsertItem(ctx.env, dashboard.id, testUser.id, {
        type: 'note',
        content: 'Test content',
      });
      const data = await response.json() as { item: Record<string, unknown> };

      // Should have camelCase keys
      expect(data.item).toHaveProperty('dashboardId');
      expect(data.item).toHaveProperty('createdAt');
      expect(data.item).toHaveProperty('updatedAt');

      // Should NOT have snake_case keys
      expect(data.item).not.toHaveProperty('dashboard_id');
      expect(data.item).not.toHaveProperty('created_at');
      expect(data.item).not.toHaveProperty('position_x');
    });
  });

  describe('upsertItem()', () => {
    it('should allow clearing content to empty string', async () => {
      const dashboard = await seedDashboard(ctx.db, testUser.id);

      // Create item with content
      const createResponse = await upsertItem(ctx.env, dashboard.id, testUser.id, {
        type: 'note',
        content: 'Initial content',
      });
      const { item } = await createResponse.json() as { item: { id: string; content: string } };
      expect(item.content).toBe('Initial content');

      // Update to clear content to empty string
      const updateResponse = await upsertItem(ctx.env, dashboard.id, testUser.id, {
        id: item.id,
        content: '',
      });
      const updated = await updateResponse.json() as { item: { content: string } };

      expect(updated.item.content).toBe('');
    });

    it('should preserve content when not provided in update', async () => {
      const dashboard = await seedDashboard(ctx.db, testUser.id);

      // Create item with content
      const createResponse = await upsertItem(ctx.env, dashboard.id, testUser.id, {
        type: 'note',
        content: 'Keep this',
      });
      const { item } = await createResponse.json() as { item: { id: string; content: string } };

      // Update position only, not content
      const updateResponse = await upsertItem(ctx.env, dashboard.id, testUser.id, {
        id: item.id,
        position: { x: 100, y: 200 },
      });
      const updated = await updateResponse.json() as { item: { content: string } };

      expect(updated.item.content).toBe('Keep this');
    });
  });
});
