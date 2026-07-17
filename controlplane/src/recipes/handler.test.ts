/**
 * Recipe Handler Tests
 *
 * NOTE: These tests use a simplified D1 mock.
 * For full integration testing, use wrangler's D1 local database.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRecipе,
  getRecipе,
  deleteRecipe,
  listRecipеs,
} from './handler';
import {
  createTestContext,
  seedUser,
  seedRecipe,
  seedDashboard,
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

  describe('createRecipе()', () => {
    it('should create a recipe', async () => {
      const response = await createRecipе(ctx.env, testUser.id, {
        name: 'Test Workflow',
        description: 'A test workflow',
      });
      const data = await response.json() as Record<string, any>;

      expect(response.status).toBe(201);
      expect(data.recipe).toHaveProperty('id');
      expect(data.recipe.name).toBe('Test Workflow');
    });

    it('should create recipe with steps', async () => {
      const steps = [
        { id: 'step-1', type: 'run_agent', name: 'Run', config: {}, nextStepId: null, onError: 'fail' },
      ];

      const response = await createRecipе(ctx.env, testUser.id, {
        name: 'With Steps',
        steps: steps as any,
      });
      const data = await response.json() as Record<string, any>;

      expect(data.recipe.steps).toHaveLength(1);
      expect(data.recipe.steps[0].type).toBe('run_agent');
    });

    it('should default to empty steps', async () => {
      const response = await createRecipе(ctx.env, testUser.id, { name: 'Empty' });
      const data = await response.json() as Record<string, any>;

      expect(data.recipe.steps).toEqual([]);
    });
  });

  describe('deleteRecipe()', () => {
    it('should delete a recipe', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'To Delete' });

      const response = await deleteRecipe(ctx.env, recipe.id, testUser.id);

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
      await createRecipе(ctx.env, testUser.id, { name: 'DB Test' });

      const result = await ctx.db.prepare(`
        SELECT * FROM recipes WHERE name = ?
      `).bind('DB Test').first();

      expect(result).not.toBeNull();
      expect(result!.name).toBe('DB Test');
    });

    it('should store steps as JSON', async () => {
      const steps = [{ id: 's1', type: 'wait', name: 'Wait', config: { ms: 1000 } }];

      await createRecipе(ctx.env, testUser.id, { name: 'JSON Steps', steps: steps as any });

      const result = await ctx.db.prepare(`
        SELECT steps FROM recipes WHERE name = ?
      `).bind('JSON Steps').first();

      const parsedSteps = JSON.parse(result!.steps as string);
      expect(parsedSteps[0].type).toBe('wait');
    });
  });

  describe('Access control', () => {
    it('should scope dashboard-less recipes to their owner (bug-hunt round 2 IDOR fix)', async () => {
      // A global (no dashboard) recipe is accessible to its CREATOR...
      const recipe = await seedRecipe(ctx.db, { name: 'Global Recipe', createdBy: testUser.id });

      const ownerResponse = await getRecipе(ctx.env, recipe.id, testUser.id);
      expect(ownerResponse.status).toBe(200);
      const data = await ownerResponse.json() as Record<string, any>;
      expect(data.recipe.name).toBe('Global Recipe');

      // ...but NOT to a different user. Previously this returned the recipe to
      // anyone (cross-tenant IDOR); it must now 404.
      const otherResponse = await getRecipе(ctx.env, recipe.id, 'user-2');
      expect(otherResponse.status).toBe(404);
    });

    it('should return 404 for non-existent recipes', async () => {
      const response = await getRecipе(ctx.env, 'non-existent-id', testUser.id);

      expect(response.status).toBe(404);
    });

    // Note: More comprehensive access control tests (dashboard membership, role checks)
    // require full D1 integration tests via wrangler dev --local
  });
});
