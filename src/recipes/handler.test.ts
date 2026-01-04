/**
 * Recipe Handler Tests
 *
 * NOTE: These tests use a simplified D1 mock.
 * For full integration testing, use wrangler's D1 local database.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRecipe,
  deleteRecipe,
} from './handler';
import {
  createTestContext,
  seedUser,
  seedRecipe,
  seedExecution,
  createTestUser,
} from '../../tests/helpers';
import type { TestContext } from '../../tests/helpers';

describe('Recipe Handlers', () => {
  let ctx: TestContext;
  let testUser: { id: string; email: string; name: string };

  beforeEach(async () => {
    ctx = await createTestContext();
    testUser = createTestUser({ id: 'user-1' });
    await seedUser(ctx.db, testUser);
  });

  describe('createRecipe()', () => {
    it('should create a recipe', async () => {
      const response = await createRecipe(ctx.env, {
        name: 'Test Workflow',
        description: 'A test workflow',
      });
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.recipe).toHaveProperty('id');
      expect(data.recipe.name).toBe('Test Workflow');
    });

    it('should create recipe with steps', async () => {
      const steps = [
        { id: 'step-1', type: 'run_agent', name: 'Run', config: {}, nextStepId: null, onError: 'fail' },
      ];

      const response = await createRecipe(ctx.env, {
        name: 'With Steps',
        steps: steps as any,
      });
      const data = await response.json();

      expect(data.recipe.steps).toHaveLength(1);
      expect(data.recipe.steps[0].type).toBe('run_agent');
    });

    it('should default to empty steps', async () => {
      const response = await createRecipe(ctx.env, { name: 'Empty' });
      const data = await response.json();

      expect(data.recipe.steps).toEqual([]);
    });
  });

  describe('deleteRecipe()', () => {
    it('should delete a recipe', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'To Delete' });

      const response = await deleteRecipe(ctx.env, recipe.id);

      expect(response.status).toBe(204);

      // Verify deleted
      const result = await ctx.db.prepare(`
        SELECT * FROM recipes WHERE id = ?
      `).bind(recipe.id).first();
      expect(result).toBeNull();
    });
  });

  describe('Database operations', () => {
    it('should insert recipe into database', async () => {
      await createRecipe(ctx.env, { name: 'DB Test' });

      const result = await ctx.db.prepare(`
        SELECT * FROM recipes WHERE name = ?
      `).bind('DB Test').first();

      expect(result).not.toBeNull();
      expect(result!.name).toBe('DB Test');
    });

    it('should store steps as JSON', async () => {
      const steps = [{ id: 's1', type: 'wait', name: 'Wait', config: { ms: 1000 } }];

      await createRecipe(ctx.env, { name: 'JSON Steps', steps: steps as any });

      const result = await ctx.db.prepare(`
        SELECT steps FROM recipes WHERE name = ?
      `).bind('JSON Steps').first();

      const parsedSteps = JSON.parse(result!.steps as string);
      expect(parsedSteps[0].type).toBe('wait');
    });
  });
});
