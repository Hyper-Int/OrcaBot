/**
 * Hyper Control Plane - Cloudflare Worker Entry Point
 *
 * This is the main entry point for the control plane.
 * Routes requests to appropriate handlers.
 */

import type { Env, DashboardItem, RecipeStep } from './types';
import { authenticate, requireAuth, requireInternalAuth } from './auth/middleware';
import { checkRateLimit } from './ratelimit/middleware';
import { initializeDatabase } from './db/schema';
import * as dashboards from './dashboards/handler';
import * as sessions from './sessions/handler';
import * as recipes from './recipes/handler';
import * as schedules from './schedules/handler';
import { SandboxClient } from './sandbox/client';

// Export Durable Object
export { DashboardDO } from './dashboards/DurableObject';

// CORS headers
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-User-ID, X-User-Email, X-User-Name',
};

function corsResponse(response: Response): Response {
  // Don't wrap WebSocket upgrade responses - they have a special webSocket property
  // that would be lost if we create a new Response
  if (response.status === 101) {
    return response;
  }

  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // Check rate limit
      const rateLimitResult = await checkRateLimit(request, env);
      if (!rateLimitResult.allowed) {
        return corsResponse(rateLimitResult.response!);
      }

      const response = await handleRequest(request, env);
      return corsResponse(response);
    } catch (error) {
      console.error('Request error:', error);
      return corsResponse(Response.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      ));
    }
  },

  // Scheduled handler for cron triggers
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    await schedules.processDueSchedules(env);
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Health check
  if (path === '/health' && method === 'GET') {
    const sandbox = new SandboxClient(env.SANDBOX_URL);
    const sandboxHealthy = await sandbox.health();
    return Response.json({
      status: 'ok',
      sandbox: sandboxHealthy ? 'connected' : 'disconnected',
      sandboxUrl: env.SANDBOX_URL,
    });
  }

  // Initialize database (requires internal auth token)
  if (path === '/init-db' && method === 'POST') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    await initializeDatabase(env.DB);
    return Response.json({ success: true, message: 'Database initialized' });
  }

  // Authenticate
  const auth = await authenticate(request, env);

  // Parse path segments
  const segments = path.split('/').filter(Boolean);

  // ============================================
  // Dashboard routes
  // ============================================

  // GET /dashboards - List dashboards
  if (segments[0] === 'dashboards' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return dashboards.listDashboards(env, auth.user!.id);
  }

  // POST /dashboards - Create dashboard
  if (segments[0] === 'dashboards' && segments.length === 1 && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as { name: string };
    return dashboards.createDashboard(env, auth.user!.id, data);
  }

  // GET /dashboards/:id - Get dashboard
  if (segments[0] === 'dashboards' && segments.length === 2 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return dashboards.getDashboard(env, segments[1], auth.user!.id);
  }

  // PUT /dashboards/:id - Update dashboard
  if (segments[0] === 'dashboards' && segments.length === 2 && method === 'PUT') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as { name?: string };
    return dashboards.updateDashboard(env, segments[1], auth.user!.id, data);
  }

  // DELETE /dashboards/:id - Delete dashboard
  if (segments[0] === 'dashboards' && segments.length === 2 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return dashboards.deleteDashboard(env, segments[1], auth.user!.id);
  }

  // WebSocket /dashboards/:id/ws - Real-time collaboration
  if (segments[0] === 'dashboards' && segments.length === 3 && segments[2] === 'ws') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return dashboards.connectWebSocket(
      env,
      segments[1],
      auth.user!.id,
      auth.user!.name,
      request
    );
  }

  // POST /dashboards/:id/items - Create item
  if (segments[0] === 'dashboards' && segments.length === 3 && segments[2] === 'items' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as Partial<DashboardItem>;
    return dashboards.upsertItem(env, segments[1], auth.user!.id, data);
  }

  // PUT /dashboards/:id/items/:itemId - Update item
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'items' && method === 'PUT') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as Partial<DashboardItem>;
    return dashboards.upsertItem(env, segments[1], auth.user!.id, { ...data, id: segments[3] });
  }

  // DELETE /dashboards/:id/items/:itemId - Delete item
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'items' && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return dashboards.deleteItem(env, segments[1], segments[3], auth.user!.id);
  }

  // ============================================
  // Session routes
  // ============================================

  // POST /dashboards/:id/items/:itemId/session - Create session for terminal
  if (segments[0] === 'dashboards' && segments.length === 5 && segments[2] === 'items' && segments[4] === 'session' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return sessions.createSession(env, segments[1], segments[3], auth.user!.id);
  }

  // GET /sessions/:id - Get session
  if (segments[0] === 'sessions' && segments.length === 2 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return sessions.getSession(env, segments[1], auth.user!.id);
  }

  // DELETE /sessions/:id - Stop session
  if (segments[0] === 'sessions' && segments.length === 2 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return sessions.stopSession(env, segments[1], auth.user!.id);
  }

  // ============================================
  // Recipe routes
  // ============================================

  // GET /recipes - List recipes
  if (segments[0] === 'recipes' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const dashboardId = url.searchParams.get('dashboard_id') || undefined;
    return recipes.listRecipes(env, auth.user!.id, dashboardId);
  }

  // POST /recipes - Create recipe
  if (segments[0] === 'recipes' && segments.length === 1 && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as {
      dashboardId?: string;
      name: string;
      description?: string;
      steps?: RecipeStep[];
    };
    return recipes.createRecipe(env, auth.user!.id, data);
  }

  // GET /recipes/:id - Get recipe
  if (segments[0] === 'recipes' && segments.length === 2 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return recipes.getRecipe(env, segments[1], auth.user!.id);
  }

  // PUT /recipes/:id - Update recipe
  if (segments[0] === 'recipes' && segments.length === 2 && method === 'PUT') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as {
      name?: string;
      description?: string;
      steps?: RecipeStep[];
    };
    return recipes.updateRecipe(env, segments[1], auth.user!.id, data);
  }

  // DELETE /recipes/:id - Delete recipe
  if (segments[0] === 'recipes' && segments.length === 2 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return recipes.deleteRecipe(env, segments[1], auth.user!.id);
  }

  // GET /recipes/:id/executions - List executions
  if (segments[0] === 'recipes' && segments.length === 3 && segments[2] === 'executions' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return recipes.listExecutions(env, segments[1], auth.user!.id);
  }

  // POST /recipes/:id/execute - Start execution
  if (segments[0] === 'recipes' && segments.length === 3 && segments[2] === 'execute' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json().catch(() => ({})) as { context?: Record<string, unknown> };
    return recipes.startExecution(env, segments[1], auth.user!.id, data.context);
  }

  // GET /executions/:id - Get execution
  if (segments[0] === 'executions' && segments.length === 2 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return recipes.getExecution(env, segments[1], auth.user!.id);
  }

  // POST /executions/:id/pause - Pause execution
  if (segments[0] === 'executions' && segments.length === 3 && segments[2] === 'pause' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return recipes.pauseExecution(env, segments[1], auth.user!.id);
  }

  // POST /executions/:id/resume - Resume execution
  if (segments[0] === 'executions' && segments.length === 3 && segments[2] === 'resume' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return recipes.resumeExecution(env, segments[1], auth.user!.id);
  }

  // ============================================
  // Internal routes (service-to-service, token auth)
  // ============================================

  // POST /internal/executions/:id/artifacts - Add artifact (called by sandbox)
  if (segments[0] === 'internal' && segments[1] === 'executions' && segments.length === 4 && segments[3] === 'artifacts' && method === 'POST') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    const data = await request.json() as {
      stepId: string;
      type: 'file' | 'log' | 'summary' | 'output';
      name: string;
      content: string;
    };
    return recipes.addArtifact(env, segments[2], data);
  }

  // ============================================
  // Schedule routes
  // ============================================

  // GET /schedules - List schedules
  if (segments[0] === 'schedules' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const recipeId = url.searchParams.get('recipe_id') || undefined;
    return schedules.listSchedules(env, auth.user!.id, recipeId);
  }

  // POST /schedules - Create schedule
  if (segments[0] === 'schedules' && segments.length === 1 && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as {
      recipeId: string;
      name: string;
      cron?: string;
      eventTrigger?: string;
      enabled?: boolean;
    };
    return schedules.createSchedule(env, auth.user!.id, data);
  }

  // GET /schedules/:id - Get schedule
  if (segments[0] === 'schedules' && segments.length === 2 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return schedules.getSchedule(env, segments[1], auth.user!.id);
  }

  // PUT /schedules/:id - Update schedule
  if (segments[0] === 'schedules' && segments.length === 2 && method === 'PUT') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as {
      name?: string;
      cron?: string;
      eventTrigger?: string;
      enabled?: boolean;
    };
    return schedules.updateSchedule(env, segments[1], auth.user!.id, data);
  }

  // DELETE /schedules/:id - Delete schedule
  if (segments[0] === 'schedules' && segments.length === 2 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return schedules.deleteSchedule(env, segments[1], auth.user!.id);
  }

  // POST /schedules/:id/enable - Enable schedule
  if (segments[0] === 'schedules' && segments.length === 3 && segments[2] === 'enable' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return schedules.enableSchedule(env, segments[1], auth.user!.id);
  }

  // POST /schedules/:id/disable - Disable schedule
  if (segments[0] === 'schedules' && segments.length === 3 && segments[2] === 'disable' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return schedules.disableSchedule(env, segments[1], auth.user!.id);
  }

  // POST /schedules/:id/trigger - Trigger schedule manually
  if (segments[0] === 'schedules' && segments.length === 3 && segments[2] === 'trigger' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return schedules.triggerSchedule(env, segments[1], auth.user!.id);
  }

  // POST /internal/events - Emit event (called by external systems with token)
  if (segments[0] === 'internal' && segments[1] === 'events' && segments.length === 2 && method === 'POST') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    const data = await request.json() as { event: string; payload?: Record<string, unknown> };
    return schedules.emitEvent(env, data.event, data.payload);
  }

  // Not found
  return Response.json({ error: 'Not found' }, { status: 404 });
}
