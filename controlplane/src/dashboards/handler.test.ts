/**
 * Dashboard Handler Tests
 *
 * NOTE: These tests use a simplified D1 mock that doesn't support complex JOINs.
 * For full integration testing, use wrangler's D1 local database.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  listDashbоards,
  createDashbоard,
  upsertItem,
  createEdge,
  updateDashbоard,
} from './handler';
import { resetAutoSleepColumnCache } from './auto-sleep';
import {
  createTestContext,
  seedUser,
  seedDashboard,
  seedDashboardItem,
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

  describe('createDashbоard()', () => {
    it('should create a new dashboard', async () => {
      const response = await createDashbоard(ctx.env, testUser.id, { name: 'My Dashboard' });
      const data = await response.json() as Record<string, Record<string, unknown>>;

      expect(response.status).toBe(201);
      expect(data.dashboard).toHaveProperty('id');
      expect(data.dashboard.name).toBe('My Dashboard');
      expect(data.dashboard.ownerId).toBe(testUser.id);
    });

    it('should set timestamps on creation', async () => {
      const response = await createDashbоard(ctx.env, testUser.id, { name: 'Test' });
      const data = await response.json() as Record<string, Record<string, unknown>>;

      expect(data.dashboard.createdAt).toBeTruthy();
      expect(data.dashboard.updatedAt).toBeTruthy();
    });

    it('refuses a template that no longer exists, creating nothing', async () => {
      // e.g. re-seeded under a new id while the dashboards page still listed the old one
      const response = await createDashbоard(ctx.env, testUser.id, { name: 'Stale', templateId: 'gone' });
      const data = await response.json() as { error: string };
      expect(response.status).toBe(404);
      expect(data.error).toContain('E79307');
      const row = await ctx.db.prepare(`SELECT id FROM dashboards WHERE name = ?`).bind('Stale').first();
      expect(row).toBeNull();
    });
  });

  describe('Auto sleep', () => {
    it('is on for a new dashboard and can be turned off and on by an editor', async () => {
      resetAutoSleepColumnCache();
      const created = await createDashbоard(ctx.env, testUser.id, { name: 'Bench' });
      const { dashboard } = await created.json() as { dashboard: { id: string; autoSleep: boolean } };
      expect(dashboard.autoSleep).toBe(true);

      const off = await updateDashbоard(ctx.env, dashboard.id, testUser.id, { autoSleep: false });
      expect(off.status).toBe(200);
      expect((await off.json() as { dashboard: { autoSleep: boolean } }).dashboard.autoSleep).toBe(false);

      const on = await updateDashbоard(ctx.env, dashboard.id, testUser.id, { autoSleep: true });
      expect((await on.json() as { dashboard: { autoSleep: boolean } }).dashboard.autoSleep).toBe(true);
    });

    it('rejects a value that is not a boolean', async () => {
      const created = await createDashbоard(ctx.env, testUser.id, { name: 'Bench' });
      const { dashboard } = await created.json() as { dashboard: { id: string } };
      const bad = await updateDashbоard(ctx.env, dashboard.id, testUser.id, { autoSleep: 'no' as unknown as boolean });
      expect(bad.status).toBe(400);
      // (Edit access is the same owner/editor check as renaming; the simplified D1
      // mock can't model membership filtering, so it isn't asserted here.)
    });
  });

  describe('Database operations', () => {
    it('should insert dashboard into database', async () => {
      await createDashbоard(ctx.env, testUser.id, { name: 'DB Test' });

      const result = await ctx.db.prepare(`
        SELECT * FROM dashboards WHERE owner_id = ?
      `).bind(testUser.id).first();

      expect(result).not.toBeNull();
      expect(result!.name).toBe('DB Test');
    });

    it('should create dashboard_members entry', async () => {
      const response = await createDashbоard(ctx.env, testUser.id, { name: 'Member Test' });
      const { dashboard } = await response.json() as { dashboard: { id: string } };

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
      const response = await createDashbоard(ctx.env, testUser.id, { name: 'Shape Test' });
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

  describe('createEdge()', () => {
    // Seed directly: the D1 mock's multi-line re-select in upsertItem returns the first row.
    async function makeNote(dashboardId: string) {
      return (await seedDashboardItem(ctx.db, dashboardId, { type: 'terminal' })).id;
    }

    it('creates an edge between two items on the same dashboard', async () => {
      const dashboard = await seedDashboard(ctx.db, testUser.id, { id: 'dash-edge-same' });
      const a = await makeNote(dashboard.id);
      const b = await makeNote(dashboard.id);
      const res = await createEdge(ctx.env, dashboard.id, testUser.id, { sourceItemId: a, targetItemId: b });
      expect(res.status).toBe(201);
    });

    it('rejects an edge whose target lives on another dashboard', async () => {
      const mine = await seedDashboard(ctx.db, testUser.id, { id: 'dash-mine-1' });
      const other = await seedDashboard(ctx.db, testUser.id, { id: 'dash-other-1' });
      const source = await makeNote(mine.id);
      const foreign = await makeNote(other.id);
      const res = await createEdge(ctx.env, mine.id, testUser.id, { sourceItemId: source, targetItemId: foreign });
      expect(res.status).toBe(400);
    });

    it('rejects an edge whose source lives on another dashboard', async () => {
      const mine = await seedDashboard(ctx.db, testUser.id, { id: 'dash-mine-2' });
      const other = await seedDashboard(ctx.db, testUser.id, { id: 'dash-other-2' });
      const target = await makeNote(mine.id);
      const foreign = await makeNote(other.id);
      const res = await createEdge(ctx.env, mine.id, testUser.id, { sourceItemId: foreign, targetItemId: target });
      expect(res.status).toBe(400);
    });
  });
});
