/**
 * Test Helpers
 */

import { MockD1Database } from './mocks/d1';
import { MockDurableObjectNamespace } from './mocks/durable-object';
import { DashboardDO } from '../src/dashboards/DurableObject';
import type { Env } from '../src/types';
import { initializeDatabase } from '../src/db/schema';

export interface TestContext {
  env: Env;
  db: MockD1Database;
  reset: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const db = new MockD1Database();

  // Initialize schema
  await initializeDatabase(db);

  const env: Env = {
    DB: db,
    DASHBOARD: new MockDurableObjectNamespace(DashboardDO) as unknown as DurableObjectNamespace,
    SANDBOX_URL: 'http://localhost:8080',
  };

  return {
    env,
    db,
    reset: async () => {
      db.clear();
      await initializeDatabase(db);
    },
  };
}

export function createTestUser(overrides: Partial<{ id: string; email: string; name: string }> = {}) {
  return {
    id: overrides.id || `user-${Date.now()}`,
    email: overrides.email || 'test@example.com',
    name: overrides.name || 'Test User',
  };
}

export function createAuthHeaders(user: { id: string; email: string; name: string }) {
  return {
    'X-User-ID': user.id,
    'X-User-Email': user.email,
    'X-User-Name': user.name,
  };
}

export async function seedUser(db: MockD1Database, user: { id: string; email: string; name: string }) {
  await db.prepare(`
    INSERT INTO users (id, email, name, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(user.id, user.email, user.name, new Date().toISOString()).run();
}

export async function seedDashboard(
  db: MockD1Database,
  ownerId: string,
  data: { id?: string; name?: string } = {}
) {
  const id = data.id || `dashboard-${Date.now()}`;
  const name = data.name || 'Test Dashboard';
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO dashboards (id, name, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, name, ownerId, now, now).run();

  await db.prepare(`
    INSERT INTO dashboard_members (dashboard_id, user_id, role, added_at)
    VALUES (?, ?, 'owner', ?)
  `).bind(id, ownerId, now).run();

  return { id, name, ownerId, createdAt: now, updatedAt: now };
}

export async function seedDashboardItem(
  db: MockD1Database,
  dashboardId: string,
  data: {
    id?: string;
    type?: 'note' | 'todo' | 'terminal' | 'link';
    content?: string;
  } = {}
) {
  const id = data.id || `item-${Date.now()}-${Math.random()}`;
  const type = data.type || 'note';
  const content = data.content || '';
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO dashboard_items (id, dashboard_id, type, content, position_x, position_y, width, height, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 0, 200, 150, ?, ?)
  `).bind(id, dashboardId, type, content, now, now).run();

  return { id, dashboardId, type, content };
}

export async function seedSession(
  db: MockD1Database,
  dashboardId: string,
  itemId: string,
  data: { id?: string; sandboxSessionId?: string; status?: string } = {}
) {
  const id = data.id || `session-${Date.now()}`;
  const sandboxSessionId = data.sandboxSessionId || `sandbox-${Date.now()}`;
  const status = data.status || 'active';
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO sessions (id, dashboard_id, item_id, sandbox_session_id, status, region, created_at)
    VALUES (?, ?, ?, ?, ?, 'local', ?)
  `).bind(id, dashboardId, itemId, sandboxSessionId, status, now).run();

  return { id, dashboardId, itemId, sandboxSessionId, status };
}

export async function seedRecipe(
  db: MockD1Database,
  data: {
    id?: string;
    dashboardId?: string;
    name?: string;
    steps?: unknown[];
  } = {}
) {
  const id = data.id || `recipe-${Date.now()}-${Math.random()}`;
  const name = data.name || 'Test Recipe';
  const steps = JSON.stringify(data.steps || []);
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO recipes (id, dashboard_id, name, description, steps, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, data.dashboardId || null, name, '', steps, now, now).run();

  return { id, name, steps: data.steps || [] };
}

export async function seedSchedule(
  db: MockD1Database,
  recipeId: string,
  data: {
    id?: string;
    name?: string;
    cron?: string;
    eventTrigger?: string;
    enabled?: boolean;
  } = {}
) {
  const id = data.id || `schedule-${Date.now()}-${Math.random()}`;
  const name = data.name || 'Test Schedule';
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO schedules (id, recipe_id, name, cron, event_trigger, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    recipeId,
    name,
    data.cron || null,
    data.eventTrigger || null,
    data.enabled !== false ? 1 : 0,
    now
  ).run();

  return { id, recipeId, name, cron: data.cron, eventTrigger: data.eventTrigger };
}

export async function seedExecution(
  db: MockD1Database,
  recipeId: string,
  data: {
    id?: string;
    status?: string;
    context?: Record<string, unknown>;
  } = {}
) {
  const id = data.id || `exec-${Date.now()}-${Math.random()}`;
  const status = data.status || 'running';
  const context = JSON.stringify(data.context || {});
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO executions (id, recipe_id, status, current_step_id, context, started_at)
    VALUES (?, ?, ?, NULL, ?, ?)
  `).bind(id, recipeId, status, context, now).run();

  return { id, recipeId, status, context: data.context || {} };
}
