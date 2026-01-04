/**
 * Schedule Handler Tests
 *
 * NOTE: These tests use a simplified D1 mock.
 * For full integration testing, use wrangler's D1 local database.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSchedule,
  deleteSchedule,
} from './handler';
import {
  createTestContext,
  seedUser,
  seedRecipe,
  seedSchedule,
  createTestUser,
} from '../../tests/helpers';
import type { TestContext } from '../../tests/helpers';

describe('Schedule Handlers', () => {
  let ctx: TestContext;
  let testUser: { id: string; email: string; name: string };

  beforeEach(async () => {
    ctx = await createTestContext();
    testUser = createTestUser({ id: 'user-1' });
    await seedUser(ctx.db, testUser);
  });

  describe('createSchedule()', () => {
    it('should create cron schedule', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Recipe' });

      const response = await createSchedule(ctx.env, {
        recipeId: recipe.id,
        name: 'Daily Run',
        cron: '0 9 * * *',
      });
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.schedule.cron).toBe('0 9 * * *');
      expect(data.schedule.enabled).toBe(true);
    });

    it('should create event-based schedule', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Recipe' });

      const response = await createSchedule(ctx.env, {
        recipeId: recipe.id,
        name: 'On Push',
        eventTrigger: 'code.push',
      });
      const data = await response.json();

      expect(data.schedule.eventTrigger).toBe('code.push');
      expect(data.schedule.cron).toBeNull();
    });

    it('should return 400 when neither cron nor event provided', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Recipe' });

      const response = await createSchedule(ctx.env, {
        recipeId: recipe.id,
        name: 'Invalid',
      });

      expect(response.status).toBe(400);
    });

    it('should create disabled schedule', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Recipe' });

      const response = await createSchedule(ctx.env, {
        recipeId: recipe.id,
        name: 'Disabled',
        cron: '0 * * * *',
        enabled: false,
      });
      const data = await response.json();

      expect(data.schedule.enabled).toBe(false);
    });
  });

  describe('deleteSchedule()', () => {
    it('should delete schedule', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Recipe' });
      const schedule = await seedSchedule(ctx.db, recipe.id, { name: 'To Delete' });

      const response = await deleteSchedule(ctx.env, schedule.id);

      expect(response.status).toBe(204);

      const result = await ctx.db.prepare(`
        SELECT * FROM schedules WHERE id = ?
      `).bind(schedule.id).first();
      expect(result).toBeNull();
    });
  });

  describe('Database operations', () => {
    it('should insert schedule into database', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Recipe' });

      await createSchedule(ctx.env, {
        recipeId: recipe.id,
        name: 'DB Test',
        cron: '0 0 * * *',
      });

      const result = await ctx.db.prepare(`
        SELECT * FROM schedules WHERE name = ?
      `).bind('DB Test').first();

      expect(result).not.toBeNull();
      expect(result!.cron).toBe('0 0 * * *');
    });
  });
});
