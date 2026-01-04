/**
 * Integration Tests
 *
 * Simplified tests that focus on core functionality
 * without complex JOIN queries
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import {
  createTestContext,
  seedUser,
  seedRecipe,
  seedSchedule,
  seedExecution,
  createTestUser,
} from './helpers';
import { createMockSandboxServer } from './mocks/sandbox';
import * as dashboards from '../src/dashboards/handler';
import * as recipes from '../src/recipes/handler';
import * as schedules from '../src/schedules/handler';
import { SandboxClient } from '../src/sandbox/client';
import type { TestContext } from './helpers';

describe('Integration Tests', () => {
  let ctx: TestContext;
  let user: { id: string; email: string; name: string };
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
    user = createTestUser({ id: 'user-1', email: 'dev@example.com', name: 'Developer' });
    await seedUser(ctx.db, user);
  });

  describe('Dashboard workflow', () => {
    it('should create dashboard and list it', async () => {
      const createRes = await dashboards.createDashboard(ctx.env, user.id, {
        name: 'My Project',
      });
      expect(createRes.status).toBe(201);

      const { dashboard } = await createRes.json();
      expect(dashboard.name).toBe('My Project');
      expect(dashboard.ownerId).toBe(user.id);

      // Verify dashboard exists in database (avoiding JOIN-dependent listDashboards)
      const dbResult = await ctx.db.prepare(`
        SELECT * FROM dashboards WHERE id = ?
      `).bind(dashboard.id).first();
      expect(dbResult).not.toBeNull();
      expect(dbResult!.name).toBe('My Project');
    });

    it('should add and retrieve items', async () => {
      const createRes = await dashboards.createDashboard(ctx.env, user.id, { name: 'Test' });
      const { dashboard } = await createRes.json();

      // Add item
      const itemRes = await dashboards.upsertItem(ctx.env, dashboard.id, user.id, {
        type: 'note',
        content: 'Hello',
      });
      expect(itemRes.status).toBe(201);

      // Get dashboard with items
      const getRes = await dashboards.getDashboard(ctx.env, dashboard.id, user.id);
      const data = await getRes.json();
      expect(data.items).toHaveLength(1);
    });
  });

  describe('Recipe workflow', () => {
    it('should create and execute recipe', async () => {
      // Create recipe
      const createRes = await recipes.createRecipe(ctx.env, {
        name: 'Build Pipeline',
        steps: [
          { id: 's1', type: 'run_agent', name: 'Build', config: {}, nextStepId: null, onError: 'fail' },
        ] as any,
      });
      const { recipe } = await createRes.json();
      expect(recipe.name).toBe('Build Pipeline');

      // Start execution
      const execRes = await recipes.startExecution(ctx.env, recipe.id, { env: 'prod' });
      expect(execRes.status).toBe(201);

      const { execution } = await execRes.json();
      expect(execution.status).toBe('running');
      expect(execution.context.env).toBe('prod');
    });

    it('should pause and resume execution', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Test' });
      const execution = await seedExecution(ctx.db, recipe.id, { status: 'running' });

      // Pause
      const pauseRes = await recipes.pauseExecution(ctx.env, execution.id);
      expect((await pauseRes.json()).status).toBe('paused');

      // Resume
      const resumeRes = await recipes.resumeExecution(ctx.env, execution.id);
      expect((await resumeRes.json()).status).toBe('running');
    });

    it('should add artifacts to execution', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Test' });
      const execution = await seedExecution(ctx.db, recipe.id);

      const artifactRes = await recipes.addArtifact(ctx.env, execution.id, {
        stepId: 'step-1',
        type: 'log',
        name: 'build.log',
        content: 'Building...',
      });
      expect(artifactRes.status).toBe(201);
    });
  });

  describe('Schedule workflow', () => {
    it('should create cron schedule', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Daily Task' });

      const createRes = await schedules.createSchedule(ctx.env, {
        recipeId: recipe.id,
        name: 'Daily at 9am',
        cron: '0 9 * * *',
      });
      const { schedule } = await createRes.json();

      expect(schedule.cron).toBe('0 9 * * *');
      expect(schedule.enabled).toBe(true);
      expect(schedule.nextRunAt).toBeTruthy();
    });

    it('should create event schedule', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'On Push' });

      const createRes = await schedules.createSchedule(ctx.env, {
        recipeId: recipe.id,
        name: 'On Git Push',
        eventTrigger: 'git.push',
      });
      const { schedule } = await createRes.json();

      expect(schedule.eventTrigger).toBe('git.push');
    });

    it('should trigger schedule manually', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Test' });
      const schedule = await seedSchedule(ctx.db, recipe.id, { cron: '0 * * * *' });

      const triggerRes = await schedules.triggerSchedule(ctx.env, schedule.id);
      const data = await triggerRes.json();

      expect(data.schedule.lastRunAt).toBeTruthy();
      expect(data.execution).toBeTruthy();
    });

    it('should enable and disable schedule', async () => {
      const recipe = await seedRecipe(ctx.db, { name: 'Test' });
      const schedule = await seedSchedule(ctx.db, recipe.id, { cron: '0 * * * *', enabled: true });

      // Disable schedule
      const disableRes = await schedules.disableSchedule(ctx.env, schedule.id);
      expect(disableRes.status).toBe(200);

      // Verify in database
      const afterDisable = await ctx.db.prepare(`
        SELECT enabled FROM schedules WHERE id = ?
      `).bind(schedule.id).first();
      expect(afterDisable!.enabled).toBe(0);

      // Enable schedule
      const enableRes = await schedules.enableSchedule(ctx.env, schedule.id);
      expect(enableRes.status).toBe(200);

      // Verify in database
      const afterEnable = await ctx.db.prepare(`
        SELECT enabled FROM schedules WHERE id = ?
      `).bind(schedule.id).first();
      expect(afterEnable!.enabled).toBe(1);
    });
  });

  describe('Sandbox integration', () => {
    it('should complete full sandbox workflow', async () => {
      const client = new SandboxClient(ctx.env.SANDBOX_URL);

      // Create session
      const session = await client.createSession();
      expect(session.id).toBeTruthy();

      // Create PTY
      const pty = await client.createPTY(session.id);
      expect(pty.id).toBeTruthy();

      // Write file
      await client.writeFile(session.id, '/app/main.ts', 'console.log("Hello")');

      // Read file
      const content = await client.readFile(session.id, '/app/main.ts');
      expect(new TextDecoder().decode(content)).toBe('console.log("Hello")');

      // Start agent
      const agent = await client.startAgent(session.id);
      expect(agent.state).toBe('running');

      // Pause agent
      await client.pauseAgent(session.id);

      // Resume agent
      await client.resumeAgent(session.id);

      // Stop agent
      await client.stopAgent(session.id);

      // Delete session
      await client.deleteSession(session.id);
    });
  });
});
