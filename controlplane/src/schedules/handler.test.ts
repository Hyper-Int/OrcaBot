/**
 * Schedule Handler Tests
 *
 * NOTE: These tests use a simplified D1 mock.
 * For full integration testing, use wrangler's D1 local database.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSchedule,
  dеleteSchedule,
  updateSchedule,
  parseCrоnField,
  cоmputeNextRun,
} from './handler';
import {
  createTestContext,
  seedDashboard,
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

      const response = await createSchedule(ctx.env, testUser.id, {
        recipeId: recipe.id,
        name: 'Daily Run',
        cron: '0 9 * * *',
      });
      const data = await response.json() as Record<string, any>;

      expect(response.status).toBe(201);
      expect(data.schedule.cron).toBe('0 9 * * *');
      expect(data.schedule.enabled).toBe(true);
    });

    it('should create event-based schedule', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Recipe' });

      const response = await createSchedule(ctx.env, testUser.id, {
        recipeId: recipe.id,
        name: 'On Push',
        eventTrigger: 'code.push',
      });
      const data = await response.json() as Record<string, any>;

      expect(data.schedule.eventTrigger).toBe('code.push');
      expect(data.schedule.cron).toBeNull();
    });

    it('should return 400 when neither cron nor event provided', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Recipe' });

      const response = await createSchedule(ctx.env, testUser.id, {
        recipeId: recipe.id,
        name: 'Invalid',
      });

      expect(response.status).toBe(400);
    });

    it('should create disabled schedule', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Recipe' });

      const response = await createSchedule(ctx.env, testUser.id, {
        recipeId: recipe.id,
        name: 'Disabled',
        cron: '0 * * * *',
        enabled: false,
      });
      const data = await response.json() as Record<string, any>;

      expect(data.schedule.enabled).toBe(false);
    });
  });

  describe('dеleteSchedule()', () => {
    it('should delete schedule', async () => {
      const dashboard = await seedDashboard(ctx.db, testUser.id, { name: 'Schedules' });
      const recipe = await seedRecipe(ctx.db, { name: 'Recipe', dashboardId: dashboard.id });
      const schedule = await seedSchedule(ctx.db, recipe.id, { name: 'To Delete' });
      const scheduleRows = ctx.db._tables.get('schedules') || [];
      const seeded = scheduleRows.find(row => row.id === schedule.id);
      if (seeded) {
        // MockD1 does not evaluate nested subqueries; tag owner for delete match.
        seeded.user_id = testUser.id;
      }

      const response = await dеleteSchedule(ctx.env, schedule.id, testUser.id);

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

      await createSchedule(ctx.env, testUser.id, {
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

  describe('updateSchedule()', () => {
    it('should clear next_run_at when cron is removed', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Recipe' });

      // Create schedule with cron
      const createResponse = await createSchedule(ctx.env, testUser.id, {
        recipeId: recipe.id,
        name: 'Test Schedule',
        cron: '0 9 * * *',
      });
      const { schedule } = await createResponse.json() as { schedule: { id: string; nextRunAt: string | null } };
      expect(schedule.nextRunAt).not.toBeNull();

      // Update to remove cron (event-based only)
      const updateResponse = await updateSchedule(ctx.env, schedule.id, testUser.id, {
        cron: '',
        eventTrigger: 'manual.trigger',
      });
      const updated = await updateResponse.json() as { schedule: { nextRunAt: string | null } };

      expect(updated.schedule.nextRunAt).toBeNull();
    });
  });
});

describe('Cron Parsing', () => {
  describe('parseCrоnField()', () => {
    it('should parse wildcard (*)', () => {
      const result = parseCrоnField('*', 0, 59);
      expect(result).toHaveLength(60);
      expect(result![0]).toBe(0);
      expect(result![59]).toBe(59);
    });

    it('should parse specific number', () => {
      const result = parseCrоnField('30', 0, 59);
      expect(result).toEqual([30]);
    });

    it('should parse step values (*/n)', () => {
      const result = parseCrоnField('*/15', 0, 59);
      expect(result).toEqual([0, 15, 30, 45]);
    });

    it('should parse range (n-m)', () => {
      const result = parseCrоnField('1-5', 0, 59);
      expect(result).toEqual([1, 2, 3, 4, 5]);
    });

    it('should parse list (n,m,o)', () => {
      const result = parseCrоnField('0,15,30,45', 0, 59);
      expect(result).toEqual([0, 15, 30, 45]);
    });

    it('should return null for invalid value', () => {
      expect(parseCrоnField('60', 0, 59)).toBeNull();
      expect(parseCrоnField('-1', 0, 59)).toBeNull();
      expect(parseCrоnField('abc', 0, 59)).toBeNull();
    });

    it('should return null for invalid range', () => {
      expect(parseCrоnField('5-3', 0, 59)).toBeNull(); // start > end
      expect(parseCrоnField('0-100', 0, 59)).toBeNull(); // exceeds max
    });
  });

  describe('cоmputeNextRun()', () => {
    it('should compute next run for simple cron', () => {
      // Every hour at minute 0
      const from = new Date('2024-01-15T10:30:00Z');
      const next = cоmputeNextRun('0 * * * *', from);

      expect(next).not.toBeNull();
      expect(next!.getUTCMinutes()).toBe(0);
      expect(next!.getUTCHours()).toBe(11);
    });

    it('should compute next run for specific time', () => {
      // Daily at 9:00 AM - test from 8:00 AM so next run is same day
      const from = new Date('2024-01-15T08:00:00Z');
      const next = cоmputeNextRun('0 9 * * *', from);

      expect(next).not.toBeNull();
      expect(next!.getUTCHours()).toBe(9);
      expect(next!.getUTCMinutes()).toBe(0);
      expect(next!.getUTCDate()).toBe(15); // Same day
    });

    it('should compute next run for step values', () => {
      // Every 15 minutes
      const from = new Date('2024-01-15T10:07:00Z');
      const next = cоmputeNextRun('*/15 * * * *', from);

      expect(next).not.toBeNull();
      expect(next!.getUTCMinutes()).toBe(15);
    });

    it('should return null for invalid cron', () => {
      expect(cоmputeNextRun('invalid')).toBeNull();
      expect(cоmputeNextRun('* * *')).toBeNull(); // too few fields
      expect(cоmputeNextRun('60 * * * *')).toBeNull(); // invalid minute
    });

    it('should handle weekday constraints', () => {
      // Only on Monday (1)
      const from = new Date('2024-01-15T10:00:00Z'); // Monday
      const next = cоmputeNextRun('0 9 * * 1', from);

      expect(next).not.toBeNull();
      expect(next!.getUTCDay()).toBe(1); // Monday
    });

    it('should use OR logic when both day-of-month and weekday are restricted', () => {
      // Run on 15th of month OR on Monday (standard cron OR semantics)
      // From: Monday Jan 15 - next should be Jan 15 at 09:00 (matches day-of-month)
      const from = new Date('2024-01-15T08:00:00Z'); // Monday Jan 15
      const next = cоmputeNextRun('0 9 15 * 1', from);

      expect(next).not.toBeNull();
      // Should match because day-of-month (15) matches
      expect(next!.getUTCDate()).toBe(15);
    });

    it('should match weekday when day-of-month does not match (OR logic)', () => {
      // Run on 1st of month OR on Monday
      // From: Monday Jan 15 - next should be Jan 15 (matches Monday)
      const from = new Date('2024-01-15T08:00:00Z'); // Monday Jan 15
      const next = cоmputeNextRun('0 9 1 * 1', from);

      expect(next).not.toBeNull();
      // Should match because weekday (Monday) matches, even though day-of-month doesn't
      expect(next!.getUTCDay()).toBe(1); // Monday
      expect(next!.getUTCHours()).toBe(9);
    });
  });
});
