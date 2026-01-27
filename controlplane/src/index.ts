// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * OrcaBot Control Plane - Cloudflare Worker Entry Point
 *
 * This is the main entry point for the control plane.
 * Routes requests to appropriate handlers.
 */

import type { Env, DashboardItem, RecipeStep, Session } from './types';
import { authenticate, requireAuth, requireInternalAuth, type AuthContext } from './auth/middleware';
import { checkRateLimitIp, checkRateLimitUser } from './ratelimit/middleware';
import { initializeDatabase } from './db/schema';
import { ensureDb, type EnvWithDb } from './db/remote';
import {
  ensureDriveCache,
  isDesktopFeatureDisabledError,
  type EnvWithDriveCache,
} from './storage/drive-cache';
import * as dashboards from './dashboards/handler';
import * as sessions from './sessions/handler';
import * as recipes from './recipes/handler';
import * as schedules from './schedules/handler';
import * as subagents from './subagents/handler';
import * as secrets from './secrets/handler';
import * as agentSkills from './agent-skills/handler';
import * as mcpTools from './mcp-tools/handler';
import * as attachments from './attachments/handler';
import * as integrations from './integrations/handler';
import * as templates from './templates/handler';
import * as members from './members/handler';
import * as googleAuth from './auth/google';
import * as authLogout from './auth/logout';
import { buildSessionCookie, createUserSession } from './auth/sessions';
import { checkAndCacheSandbоxHealth, getCachedHealth } from './health/checker';

// Export Durable Object
export { DashboardDO } from './dashboards/DurableObject';

// CORS headers (base - origin is added dynamically)
const CORS_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const CORS_ALLOWED_HEADERS = 'Content-Type, X-User-ID, X-User-Email, X-User-Name';

/**
 * Parse allowed origins from env. Returns null if all origins allowed (dev mode).
 */
function parseAllоwedOrigins(env: Env): Set<string> | null {
  if (!env.ALLOWED_ORIGINS) {
    return null; // Dev mode - allow all
  }
  return new Set(
    env.ALLOWED_ORIGINS.split(',')
      .map(o => o.trim())
      .filter(Boolean)
  );
}

/**
 * Check if origin is allowed. Rejects null/empty origins when allowlist is configured.
 */
function isOriginAllоwed(origin: string | null, allowedOrigins: Set<string> | null): boolean {
  // Dev mode - allow everything
  if (allowedOrigins === null) {
    return true;
  }
  // Reject null/empty origins (file://, sandboxed iframes, etc.)
  if (!origin) {
    return false;
  }
  return allowedOrigins.has(origin);
}

const EMBED_ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function cоrsRespоnse(response: Response, origin: string | null, allowedOrigins: Set<string> | null): Response {
  // Don't wrap WebSocket upgrade responses - they have a special webSocket property
  // that would be lost if we create a new Response
  if (response.status === 101) {
    return response;
  }

  // Preserve Set-Cookie headers by cloning the response instead of copying headers.
  const newResponse = new Response(response.body, response);
  const newHeaders = newResponse.headers;
  newHeaders.set('Access-Control-Allow-Methods', CORS_METHODS);
  newHeaders.set('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);

  const allowOrigin = origin && (allowedOrigins === null || allowedOrigins.has(origin));
  if (allowOrigin) {
    newHeaders.set('Access-Control-Allow-Origin', origin);
    newHeaders.set('Vary', 'Origin');
    newHeaders.set('Access-Control-Allow-Credentials', 'true');
  } else if (allowedOrigins === null) {
    newHeaders.set('Access-Control-Allow-Origin', '*');
  }
  // If origin not allowed, don't set Access-Control-Allow-Origin (browser will reject)

  return newResponse;
}

function isPrivateHоstname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local')) {
    return true;
  }

  if (lower.startsWith('[') && lower.endsWith(']')) {
    const ipv6 = lower.slice(1, -1);
    if (ipv6 === '::1') return true;
    if (ipv6.startsWith('fc') || ipv6.startsWith('fd')) return true; // fc00::/7
    if (ipv6.startsWith('fe80')) return true; // fe80::/10
    return false;
  }

  const ipv4Match = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4Match) return false;

  const octets = ipv4Match.slice(1).map((part) => Number(part));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function parseFrameAncestоrs(csp: string | null): string[] | null {
  if (!csp) return null;
  const directives = csp
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const frameAncestors = directives.find((directive) =>
    directive.toLowerCase().startsWith('frame-ancestors')
  );
  if (!frameAncestors) return null;
  return frameAncestors.split(/\s+/).slice(1);
}

function matchSоurceExpressiоn(source: string, origin: string): boolean {
  if (source === '*') return true;

  if (source === "'self'") {
    return false;
  }

  if (!source.startsWith('http://') && !source.startsWith('https://')) {
    return false;
  }

  if (!source.includes('*')) {
    return source === origin;
  }

  const escaped = source.replace(/[-/\^$+?.()|[\]{}]/g, '\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(origin);
}

function isOriginAllоwedByFrameAncestors(
  sources: string[],
  origin: string | null,
  targetOrigin: string
): boolean {
  if (sources.includes("'none'")) return false;
  if (sources.includes('*')) return true;

  if (!origin) {
    return true;
  }

  if (sources.includes("'self'")) {
    return origin === targetOrigin;
  }

  return sources.some((source) => matchSоurceExpressiоn(source, origin));
}

async function prоxySandbоxWebSоcket(
  request: Request,
  env: Env,
  sandboxSessionId: string,
  ptyId: string,
  userId: string,
  machineId?: string
): Promise<Response> {
  const sandboxUrl = new URL(`${env.SANDBOX_URL.replace(/\/$/, '')}/sessions/${sandboxSessionId}/ptys/${ptyId}/ws`);
  sandboxUrl.searchParams.set('user_id', userId);

  const headers = new Headers(request.headers);
  headers.set('X-Internal-Token', env.SANDBOX_INTERNAL_TOKEN);
  if (machineId) {
    headers.set('X-Sandbox-Machine-ID', machineId);
  }
  headers.delete('Host');

  const body = ['POST', 'PUT', 'PATCH'].includes(request.method)
    ? request.clone().body
    : undefined;
  const proxyRequest = new Request(sandboxUrl.toString(), {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
  });

  return fetch(proxyRequest);
}

async function prоxySandbоxControlWebSоcket(
  request: Request,
  env: Env,
  sandboxSessionId: string,
  machineId?: string
): Promise<Response> {
  const sandboxUrl = new URL(`${env.SANDBOX_URL.replace(/\/$/, '')}/sessions/${sandboxSessionId}/control`);

  const headers = new Headers(request.headers);
  headers.set('X-Internal-Token', env.SANDBOX_INTERNAL_TOKEN);
  if (machineId) {
    headers.set('X-Sandbox-Machine-ID', machineId);
  }
  headers.delete('Host');

  const proxyRequest = new Request(sandboxUrl.toString(), {
    method: request.method,
    headers,
    redirect: 'manual',
  });

  return fetch(proxyRequest);
}

async function prоxySandbоxRequest(
  request: Request,
  env: Env,
  path: string,
  machineId?: string
): Promise<Response> {
  const sandboxUrl = new URL(`${env.SANDBOX_URL.replace(/\/$/, '')}${path}`);
  sandboxUrl.search = new URL(request.url).search;

  const headers = new Headers(request.headers);
  headers.set('X-Internal-Token', env.SANDBOX_INTERNAL_TOKEN);
  if (machineId) {
    headers.set('X-Sandbox-Machine-ID', machineId);
  }
  headers.delete('Host');

  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body;
  const proxyRequest = new Request(sandboxUrl.toString(), {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
  });

  return fetch(proxyRequest);
}

async function prоxySandbоxWebSоcketPath(
  request: Request,
  env: Env,
  path: string,
  machineId?: string
): Promise<Response> {
  const sandboxUrl = new URL(`${env.SANDBOX_URL.replace(/\/$/, '')}${path}`);
  sandboxUrl.search = new URL(request.url).search;

  const headers = new Headers(request.headers);
  headers.set('X-Internal-Token', env.SANDBOX_INTERNAL_TOKEN);
  if (machineId) {
    headers.set('X-Sandbox-Machine-ID', machineId);
  }
  headers.delete('Host');

  const proxyRequest = new Request(sandboxUrl.toString(), {
    method: request.method,
    headers,
    redirect: 'manual',
  });

  return fetch(proxyRequest);
}

type EnvWithBindings = EnvWithDb & EnvWithDriveCache;

async function getSessiоnWithAccess(
  env: EnvWithBindings,
  sessionId: string,
  userId: string
): Promise<Record<string, unknown> | null> {
  const session = await env.DB.prepare(`
      SELECT s.* FROM sessions s
      JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
      WHERE s.id = ? AND dm.user_id = ?
    `).bind(sessionId, userId).first();
  return session as Record<string, unknown> | null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const envWithDb = ensureDb(env);
    const envWithBindings = ensureDriveCache(envWithDb);
    const origin = request.headers.get('Origin');
    const allowedOrigins = parseAllоwedOrigins(envWithBindings);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      const headers: Record<string, string> = {
        'Access-Control-Allow-Methods': CORS_METHODS,
        'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS,
      };
      const allowOrigin = origin && (allowedOrigins === null || allowedOrigins.has(origin));
      if (allowOrigin) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Vary'] = 'Origin';
        headers['Access-Control-Allow-Credentials'] = 'true';
      } else if (allowedOrigins === null) {
        headers['Access-Control-Allow-Origin'] = '*';
      }
      // If origin not allowed, don't include Access-Control-Allow-Origin
      return new Response(null, { status: 204, headers });
    }

    try {
      const response = await handleRequest(request, envWithBindings);
      return cоrsRespоnse(response, origin, allowedOrigins);
    } catch (error) {
      if (isDesktopFeatureDisabledError(error)) {
        return cоrsRespоnse(Response.json(
          { error: 'Desktop feature disabled', message: (error as Error).message },
          { status: 501 }
        ), origin, allowedOrigins);
      }
      console.error('Request error:', error);
      return cоrsRespоnse(Response.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      ), origin, allowedOrigins);
    }
  },

  // Scheduled handler for cron triggers (runs every minute)
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const envWithDb = ensureDb(env);
    const envWithBindings = ensureDriveCache(envWithDb);
    await checkAndCacheSandbоxHealth(envWithBindings);
    try {
      await schedules.prоcessDueSchedules(envWithBindings);
    } catch (error) {
      if (isDesktopFeatureDisabledError(error)) {
        return;
      }
      throw error;
    }
  },
};

async function handleRequest(request: Request, env: EnvWithBindings): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Health check - uses cached status (no outbound calls, prevents amplification)
  if (path === '/health' && method === 'GET') {
    let sandboxHealth;
    try {
      sandboxHealth = await getCachedHealth(env.DB, 'sandbox');
    } catch (error) {
      // Initialize schema on first run to ensure health cache table exists.
      await initializeDatabase(env.DB);
      return Response.json({
        status: 'ok',
        sandbox: 'unknown',
        message: 'Health check not yet cached (initializing schema)',
      });
    }

    // If no cached health yet, report unknown (cron hasn't run)
    if (!sandboxHealth) {
      return Response.json({
        status: 'ok',
        sandbox: 'unknown',
        message: 'Health check not yet cached (waiting for first cron run)',
      });
    }

    return Response.json({
      status: 'ok',
      sandbox: sandboxHealth.isHealthy ? 'connected' : 'disconnected',
      lastChecked: sandboxHealth.lastCheckAt,
      ...(sandboxHealth.consecutiveFailures > 0 && {
        consecutiveFailures: sandboxHealth.consecutiveFailures,
      }),
    });
  }

  if (path === '/_desktop/db-status' && method === 'GET') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all();
    return Response.json({
      ok: true,
      tableCount: tables.results.length,
      tables: tables.results.map(row => row.name),
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

  // Unauthenticated IP rate limit (after auth to avoid double-limiting)
  if (!auth.user) {
    const skipIpRateLimit =
      path === '/auth/google/callback'
      || path === '/auth/google/login'
      || /^\/integrations\/[^/]+\/callback$/.test(path)
      || /^\/integrations\/[^/]+\/connect$/.test(path);

    if (!skipIpRateLimit) {
      const ipLimitResult = await checkRateLimitIp(request, env);
      if (!ipLimitResult.allowed) {
        return ipLimitResult.response!;
      }
    }
  }

  // Authenticated user rate limit (per-user)
  if (auth.user) {
    const userLimitResult = await checkRateLimitUser(auth.user.id, env);
    if (!userLimitResult.allowed) {
      return userLimitResult.response!;
    }
  }

  // Parse path segments
  const segments = path.split('/').filter(Boolean);

  // GET /auth/google/login - Google OAuth login
  if (segments[0] === 'auth' && segments[1] === 'google' && segments[2] === 'login' && method === 'GET') {
    return googleAuth.loginWithGoogle(request, env);
  }

  // GET /auth/google/callback - Google OAuth callback
  if (segments[0] === 'auth' && segments[1] === 'google' && segments[2] === 'callback' && method === 'GET') {
    return googleAuth.callbackGoogle(request, env);
  }

  // POST /auth/logout - clear session cookie
  if (segments[0] === 'auth' && segments[1] === 'logout' && segments.length === 2 && method === 'POST') {
    return authLogout.logout(request, env);
  }

  // POST /auth/dev/session - create session cookie in dev mode
  if (segments[0] === 'auth' && segments[1] === 'dev' && segments[2] === 'session' && method === 'POST') {
    if (env.DEV_AUTH_ENABLED !== 'true') {
      return Response.json({ error: 'E79406: Dev auth disabled' }, { status: 403 });
    }

    const authError = requireAuth(auth);
    if (authError) return authError;

    const session = await createUserSession(env, auth.user!.id);
    const cookie = buildSessionCookie(request, session.id, session.expiresAt);

    return new Response(null, {
      status: 204,
      headers: {
        'Set-Cookie': cookie,
      },
    });
  }

  // GET /embed-check - Check if a URL can be embedded in an iframe
  if (segments[0] === 'embed-check' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError && env.DEV_AUTH_ENABLED !== 'true') {
      return authError;
    }

    const targetUrlParam = url.searchParams.get('url');
    if (!targetUrlParam) {
      return Response.json({ error: 'E79733: Missing url parameter' }, { status: 400 });
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(targetUrlParam);
    } catch {
      return Response.json({ error: 'E79734: Invalid url parameter' }, { status: 400 });
    }

    if (!EMBED_ALLOWED_PROTOCOLS.has(targetUrl.protocol)) {
      return Response.json({ error: 'E79735: Unsupported URL protocol' }, { status: 400 });
    }

    if (isPrivateHоstname(targetUrl.hostname)) {
      return Response.json({ error: 'E79736: URL not allowed' }, { status: 400 });
    }

    const originParam = url.searchParams.get('origin') || request.headers.get('Origin');
    let origin: string | null = null;
    try {
      if (originParam) {
        origin = new URL(originParam).origin;
      }
    } catch {
      origin = null;
    }

    let response: Response;
    try {
      response = await fetch(targetUrl.toString(), { method: 'HEAD', redirect: 'follow' });
      if (response.status === 405 || response.status === 501) {
        response = await fetch(targetUrl.toString(), {
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
          redirect: 'follow',
        });
      }
    } catch (error) {
      console.warn('Embed check fetch failed:', error);
      return Response.json({ embeddable: true, reason: 'fetch_failed' });
    }

    const checkedUrl = response.url || targetUrl.toString();
    const checkedOrigin = new URL(checkedUrl).origin;
    const xfo = response.headers.get('x-frame-options');
    const csp = response.headers.get('content-security-policy');

    let embeddable = true;
    let reason: string | undefined;

    if (xfo) {
      const value = xfo.toLowerCase();
      if (value.includes('deny')) {
        embeddable = false;
        reason = 'x_frame_options_deny';
      } else if (value.includes('sameorigin')) {
        embeddable = origin === checkedOrigin;
        reason = embeddable ? undefined : 'x_frame_options_sameorigin';
      } else if (value.includes('allow-from')) {
        embeddable = origin ? value.includes(origin) : false;
        reason = embeddable ? undefined : 'x_frame_options_allow_from';
      }
    }

    if (embeddable) {
      const ancestors = parseFrameAncestоrs(csp);
      if (ancestors) {
        embeddable = isOriginAllоwedByFrameAncestors(ancestors, origin, checkedOrigin);
        if (!embeddable) {
          reason = 'frame_ancestors';
        }
      }
    }

    return Response.json({
      embeddable,
      reason,
      checkedUrl,
    });
  }

  // ============================================
  // Dashboard routes
  // ============================================

  // GET /dashboards - List dashboards
  if (segments[0] === 'dashboards' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return dashboards.listDashbоards(env, auth.user!.id);
  }

  // POST /dashboards - Create dashboard
  if (segments[0] === 'dashboards' && segments.length === 1 && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as { name: string; templateId?: string };
    return dashboards.createDashbоard(env, auth.user!.id, data);
  }

  // GET /dashboards/:id - Get dashboard
  if (segments[0] === 'dashboards' && segments.length === 2 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return dashboards.getDashbоard(env, segments[1], auth.user!.id);
  }

  // PUT /dashboards/:id - Update dashboard
  if (segments[0] === 'dashboards' && segments.length === 2 && method === 'PUT') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as { name?: string };
    return dashboards.updateDashbоard(env, segments[1], auth.user!.id, data);
  }

  // DELETE /dashboards/:id - Delete dashboard
  if (segments[0] === 'dashboards' && segments.length === 2 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return dashboards.deleteDashbоard(env, segments[1], auth.user!.id);
  }

  // WebSocket /dashboards/:id/ws - Real-time collaboration
  if (segments[0] === 'dashboards' && segments.length === 3 && segments[2] === 'ws') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return dashboards.cоnnectWebSоcket(
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

  // POST /dashboards/:id/edges - Create edge
  if (segments[0] === 'dashboards' && segments.length === 3 && segments[2] === 'edges' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json();
    return dashboards.createEdge(env, segments[1], auth.user!.id, data);
  }

  // DELETE /dashboards/:id/edges/:edgeId - Delete edge
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'edges' && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return dashboards.deleteEdge(env, segments[1], segments[3], auth.user!.id);
  }

  // ============================================
  // Dashboard member routes
  // ============================================

  // GET /dashboards/:id/members - List members and invitations
  if (segments[0] === 'dashboards' && segments.length === 3 && segments[2] === 'members' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return members.listMembers(env, segments[1], auth.user!.id);
  }

  // POST /dashboards/:id/members - Add member or send invitation
  if (segments[0] === 'dashboards' && segments.length === 3 && segments[2] === 'members' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as { email: string; role: 'editor' | 'viewer' };
    return members.addMember(env, segments[1], auth.user!.id, data);
  }

  // PUT /dashboards/:id/members/:memberId - Update member role
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'members' && method === 'PUT') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as { role: 'editor' | 'viewer' };
    return members.updateMemberRole(env, segments[1], auth.user!.id, segments[3], data);
  }

  // DELETE /dashboards/:id/members/:memberId - Remove member
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'members' && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return members.removeMember(env, segments[1], auth.user!.id, segments[3]);
  }

  // POST /dashboards/:id/invitations/:invId/resend - Resend invitation
  if (segments[0] === 'dashboards' && segments.length === 5 && segments[2] === 'invitations' && segments[4] === 'resend' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return members.resendInvitation(env, segments[1], auth.user!.id, segments[3]);
  }

  // DELETE /dashboards/:id/invitations/:invId - Cancel invitation
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'invitations' && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return members.cancelInvitation(env, segments[1], auth.user!.id, segments[3]);
  }

  // ============================================
  // Template routes
  // ============================================

  // GET /templates - List templates
  if (segments[0] === 'templates' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const category = url.searchParams.get('category') || undefined;
    return templates.listTemplates(env, category);
  }

  // GET /templates/:id - Get template with data
  if (segments[0] === 'templates' && segments.length === 2 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return templates.getTemplate(env, segments[1]);
  }

  // POST /templates - Create template from dashboard
  if (segments[0] === 'templates' && segments.length === 1 && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as {
      dashboardId: string;
      name: string;
      description?: string;
      category?: string;
    };
    return templates.createTemplate(env, auth.user!.id, data);
  }

  // DELETE /templates/:id - Delete template
  if (segments[0] === 'templates' && segments.length === 2 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return templates.deleteTemplate(env, auth.user!.id, segments[1]);
  }

  // ============================================
  // Subagent routes
  // ============================================

  // GET /subagents - List saved subagents
  if (segments[0] === 'subagents' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return subagents.listSubagents(env, auth.user!.id);
  }

  // ============================================
  // Secrets routes
  // ============================================

  // GET /secrets - List secrets
  if (segments[0] === 'secrets' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const url = new URL(request.url);
    const dashboardId = url.searchParams.get('dashboard_id');
    return secrets.listSecrets(env, auth.user!.id, dashboardId);
  }

  // ============================================
  // Integration routes
  // ============================================

  if (segments[0] === 'integrations') {
    const routeKey = `${method} ${segments.slice(1).join('/')}`;
    const integrationRoutes: Record<string, (request: Request, env: Env, auth: AuthContext) => Promise<Response> | Response> = {
      'GET google/drive/connect': integrations.cоnnectGооgleDrive,
      'GET google/drive/callback': (request, env) => integrations.callbackGооgleDrive(request, env),
      'GET google/drive': integrations.getGооgleDriveIntegratiоn,
      'GET google/drive/picker': integrations.renderGооgleDrivePicker,
      'POST google/drive/folder': integrations.setGооgleDriveFоlder,
      'DELETE google/drive/folder': integrations.unlinkGооgleDriveFоlder,
      'GET google/drive/status': integrations.getGооgleDriveSyncStatus,
      'GET google/drive/manifest': integrations.getGооgleDriveManifest,
      'POST google/drive/sync': integrations.syncGооgleDriveMirrоr,
      'POST google/drive/sync/large': integrations.syncGооgleDriveLargeFiles,
      'GET github/connect': integrations.cоnnectGithub,
      'GET github/callback': (request, env) => integrations.callbackGithub(request, env),
      'GET github': integrations.getGithubIntegratiоn,
      'GET github/repos': integrations.getGithubRepоs,
      'POST github/repo': integrations.setGithubRepо,
      'DELETE github/repo': integrations.unlinkGithubRepо,
      'GET github/status': integrations.getGithubSyncStatus,
      'POST github/sync': integrations.syncGithubMirrоr,
      'POST github/sync/large': integrations.syncGithubLargeFiles,
      'GET github/manifest': integrations.getGithubManifest,
      'GET box/connect': integrations.cоnnectBоx,
      'GET box/callback': (request, env) => integrations.callbackBоx(request, env),
      'GET box': integrations.getBоxIntegratiоn,
      'GET box/folders': integrations.getBоxFоlders,
      'POST box/folder': integrations.setBоxFоlder,
      'DELETE box/folder': integrations.unlinkBоxFоlder,
      'GET box/status': integrations.getBоxSyncStatus,
      'POST box/sync': integrations.syncBоxMirrоr,
      'POST box/sync/large': integrations.syncBоxLargeFiles,
      'GET box/manifest': integrations.getBоxManifest,
      'GET onedrive/connect': integrations.cоnnectОnedrive,
      'GET onedrive/callback': (request, env) => integrations.callbackОnedrive(request, env),
      'GET onedrive': integrations.getОnedriveIntegratiоn,
      'GET onedrive/folders': integrations.getОnedriveFоlders,
      'POST onedrive/folder': integrations.setОnedriveFоlder,
      'DELETE onedrive/folder': integrations.unlinkОnedriveFоlder,
      'GET onedrive/status': integrations.getОnedriveSyncStatus,
      'POST onedrive/sync': integrations.syncОnedriveMirrоr,
      'POST onedrive/sync/large': integrations.syncОnedriveLargeFiles,
      'GET onedrive/manifest': integrations.getОnedriveManifest,
      // Gmail
      'GET google/gmail/connect': integrations.connectGmail,
      'GET google/gmail/callback': (request, env) => integrations.callbackGmail(request, env),
      'GET google/gmail': integrations.getGmailIntegration,
      'POST google/gmail/setup': integrations.setupGmailMirror,
      'DELETE google/gmail': integrations.unlinkGmailMirror,
      'GET google/gmail/status': integrations.getGmailStatus,
      'POST google/gmail/sync': integrations.syncGmailMirror,
      'GET google/gmail/messages': integrations.getGmailMessages,
      'GET google/gmail/message': integrations.getGmailMessageDetail,
      'POST google/gmail/action': integrations.performGmailAction,
      'POST google/gmail/watch': integrations.startGmailWatch,
      'POST google/gmail/stop': integrations.stopGmailWatchEndpoint,
      'POST google/gmail/push': (request, env) => integrations.handleGmailPush(request, env),
      'DELETE google/gmail/disconnect': integrations.disconnectGmail,
      // Google Calendar
      'GET google/calendar/connect': integrations.connectCalendar,
      'GET google/calendar/callback': (request, env) => integrations.callbackCalendar(request, env),
      'GET google/calendar': integrations.getCalendarIntegration,
      'POST google/calendar/setup': integrations.setupCalendarMirror,
      'DELETE google/calendar': integrations.unlinkCalendarMirror,
      'GET google/calendar/status': integrations.getCalendarStatus,
      'POST google/calendar/sync': integrations.syncCalendarMirror,
      'GET google/calendar/events': integrations.getCalendarEvents,
      'GET google/calendar/event': integrations.getCalendarEventDetail,
      'DELETE google/calendar/disconnect': integrations.disconnectCalendar,
      // Google Contacts
      'GET google/contacts/connect': integrations.connectContacts,
      'GET google/contacts/callback': (request, env) => integrations.callbackContacts(request, env),
      'GET google/contacts': integrations.getContactsIntegration,
      'POST google/contacts/setup': integrations.setupContactsMirror,
      'DELETE google/contacts': integrations.unlinkContactsMirror,
      'GET google/contacts/status': integrations.getContactsStatus,
      'POST google/contacts/sync': integrations.syncContactsMirror,
      'GET google/contacts/list': integrations.getContacts,
      'GET google/contacts/detail': integrations.getContactDetail,
      'GET google/contacts/search': integrations.searchContactsEndpoint,
      'DELETE google/contacts/disconnect': integrations.disconnectContacts,
      // Google Sheets
      'GET google/sheets/connect': integrations.connectSheets,
      'GET google/sheets/callback': (request, env) => integrations.callbackSheets(request, env),
      'GET google/sheets': integrations.getSheetsIntegration,
      'POST google/sheets/setup': integrations.setupSheetsMirror,
      'DELETE google/sheets': integrations.unlinkSheetsMirror,
      'GET google/sheets/list': integrations.listSpreadsheetsEndpoint,
      'GET google/sheets/spreadsheet': integrations.getSpreadsheetEndpoint,
      'GET google/sheets/values': integrations.readSheetValues,
      'POST google/sheets/values': integrations.writeSheetValues,
      'POST google/sheets/append': integrations.appendSheetValuesEndpoint,
      'POST google/sheets/link': integrations.setLinkedSpreadsheet,
      'DELETE google/sheets/disconnect': integrations.disconnectSheets,
      // Google Forms
      'GET google/forms/connect': integrations.connectForms,
      'GET google/forms/callback': (request, env) => integrations.callbackForms(request, env),
      'GET google/forms': integrations.getFormsIntegration,
      'POST google/forms/setup': integrations.setupFormsMirror,
      'DELETE google/forms': integrations.unlinkFormsMirror,
      'GET google/forms/list': integrations.listFormsEndpoint,
      'GET google/forms/form': integrations.getFormEndpoint,
      'GET google/forms/responses': integrations.getFormResponsesEndpoint,
      'POST google/forms/link': integrations.setLinkedForm,
      'DELETE google/forms/disconnect': integrations.disconnectForms,
    };

    const handler = integrationRoutes[routeKey];
    if (handler) {
      return handler(request, env, auth);
    }
  }

  // POST /subagents - Create subagent
  if (segments[0] === 'subagents' && segments.length === 1 && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as Record<string, unknown>;
    return subagents.createSubagent(env, auth.user!.id, data);
  }

  // POST /secrets - Create secret
  if (segments[0] === 'secrets' && segments.length === 1 && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as Record<string, unknown>;
    return secrets.createSecret(env, auth.user!.id, data);
  }

  // DELETE /subagents/:id - Delete subagent
  if (segments[0] === 'subagents' && segments.length === 2 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return subagents.deleteSubagent(env, auth.user!.id, segments[1]);
  }

  // DELETE /secrets/:id - Delete secret
  if (segments[0] === 'secrets' && segments.length === 2 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const url = new URL(request.url);
    const dashboardId = url.searchParams.get('dashboard_id');
    return secrets.deleteSecret(env, auth.user!.id, segments[1], dashboardId);
  }

  // ============================================
  // Agent Skills routes
  // ============================================

  // GET /agent-skills - List saved agent skills
  if (segments[0] === 'agent-skills' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return agentSkills.listAgentSkills(env, auth.user!.id);
  }

  // POST /agent-skills - Create agent skill
  if (segments[0] === 'agent-skills' && segments.length === 1 && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as Record<string, unknown>;
    return agentSkills.createAgentSkill(env, auth.user!.id, data);
  }

  // DELETE /agent-skills/:id - Delete agent skill
  if (segments[0] === 'agent-skills' && segments.length === 2 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return agentSkills.deleteAgentSkill(env, auth.user!.id, segments[1]);
  }

  // ============================================
  // MCP Tools routes
  // ============================================

  // GET /mcp-tools - List saved MCP tools
  if (segments[0] === 'mcp-tools' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return mcpTools.listMcpTооls(env, auth.user!.id);
  }

  // POST /mcp-tools - Create MCP tool
  if (segments[0] === 'mcp-tools' && segments.length === 1 && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as Record<string, unknown>;
    return mcpTools.createMcpTооl(env, auth.user!.id, data);
  }

  // DELETE /mcp-tools/:id - Delete MCP tool
  if (segments[0] === 'mcp-tools' && segments.length === 2 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return mcpTools.deleteMcpTооl(env, auth.user!.id, segments[1]);
  }

  // ============================================
  // Session routes
  // ============================================

  // POST /dashboards/:id/items/:itemId/session - Create session for terminal
  if (segments[0] === 'dashboards' && segments.length === 5 && segments[2] === 'items' && segments[4] === 'session' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return sessions.createSessiоn(env, segments[1], segments[3], auth.user!.id, auth.user!.name);
  }

  // POST /dashboards/:id/browser/start - Start dashboard browser
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'browser' && segments[3] === 'start' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return sessions.startDashbоardBrowser(env, segments[1], auth.user!.id);
  }

  // POST /dashboards/:id/browser/stop - Stop dashboard browser
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'browser' && segments[3] === 'stop' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return sessions.stоpDashbоardBrowser(env, segments[1], auth.user!.id);
  }

  // GET /dashboards/:id/browser/status - Browser status
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'browser' && segments[3] === 'status' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return sessions.getDashbоardBrowserStatus(env, segments[1], auth.user!.id);
  }

  // POST /dashboards/:id/browser/open - Open URL in browser
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'browser' && segments[3] === 'open' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as { url?: string };
    const url = typeof data.url === 'string' ? data.url : '';
    return sessions.openDashbоardBrowser(env, segments[1], auth.user!.id, url);
  }

  // GET /dashboards/:id/browser/* - Proxy browser UI
  if (segments[0] === 'dashboards' && segments[2] === 'browser' && method === 'GET') {
    const authError = requireAuth(auth);
    const allowDevBypass = env.DEV_AUTH_ENABLED === 'true' && Boolean(authError);
    if (authError && env.DEV_AUTH_ENABLED === 'true' && env.BROWSER_AUTH_DEBUG === 'true') {
      const url = new URL(request.url);
      const suffix = segments.slice(3).join('/');
      const isAssetRequest = Boolean(suffix) && !suffix.startsWith('websockify');
      if (!isAssetRequest) {
        console.log('[desktop][browser-auth] missing auth', {
          path: url.pathname,
          hasUserIdHeader: Boolean(request.headers.get('X-User-ID')),
          hasUserEmailHeader: Boolean(request.headers.get('X-User-Email')),
          hasUserNameHeader: Boolean(request.headers.get('X-User-Name')),
          userIdParam: url.searchParams.get('user_id'),
          userEmailParam: url.searchParams.get('user_email'),
          userNameParam: url.searchParams.get('user_name'),
        });
      }
    }
    if (authError && !allowDevBypass) return authError;

    if (!allowDevBypass) {
      const access = await env.DB.prepare(`
        SELECT 1 FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
      `).bind(segments[1], auth.user!.id).first();
      if (!access) {
        return Response.json({ error: 'E79301: Not found or no access' }, { status: 404 });
      }
    }

    const sandbox = await env.DB.prepare(`
      SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?
    `).bind(segments[1]).first<{ sandbox_session_id: string; sandbox_machine_id: string }>();
    if (!sandbox?.sandbox_session_id) {
      return Response.json({ error: 'E79816: Browser session not found' }, { status: 404 });
    }

    const suffix = segments.slice(3).join('/');
    const path = suffix
      ? `/sessions/${sandbox.sandbox_session_id}/browser/${suffix}`
      : `/sessions/${sandbox.sandbox_session_id}/browser`;

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      return prоxySandbоxWebSоcketPath(
        request,
        env,
        path,
        sandbox.sandbox_machine_id
      );
    }

    const proxyResponse = await prоxySandbоxRequest(
      request,
      env,
      path,
      sandbox.sandbox_machine_id
    );

    if (proxyResponse.status === 101) {
      return proxyResponse;
    }

    const framedResponse = new Response(proxyResponse.body, proxyResponse);
    const headers = framedResponse.headers;
    const frontendUrl = env.FRONTEND_URL || '';
    if (frontendUrl) {
      headers.set('Content-Security-Policy', `frame-ancestors ${frontendUrl}`);
    }
    headers.delete('X-Frame-Options');
    return framedResponse;
  }

  // GET /sessions/:id - Get session
  if (segments[0] === 'sessions' && segments.length === 2 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return sessions.getSessiоn(env, segments[1], auth.user!.id);
  }

  // WebSocket /sessions/:id/control - Session control channel (proxied)
  if (segments[0] === 'sessions' && segments.length === 3 && segments[2] === 'control' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;

    const session = await getSessiоnWithAccess(env, segments[1], auth.user!.id);

    if (!session) {
      return Response.json({ error: 'E79737: Session not found or no access' }, { status: 404 });
    }
    if (session.owner_user_id !== auth.user!.id) {
      return Response.json({ error: 'E79738: Only the owner can control the session' }, { status: 403 });
    }

    return prоxySandbоxControlWebSоcket(
      request,
      env,
      session.sandbox_session_id as string,
      session.sandbox_machine_id as string
    );
  }

  // POST /sessions/:id/env - Update session environment variables
  if (segments[0] === 'sessions' && segments.length === 3 && segments[2] === 'env' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as { set?: Record<string, string>; unset?: string[]; applyNow?: boolean };
    return sessions.updateSessiоnEnv(env, segments[1], auth.user!.id, data);
  }

  // POST /sessions/:id/apply-secrets - Apply stored secrets to session
  if (segments[0] === 'sessions' && segments.length === 3 && segments[2] === 'apply-secrets' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return sessions.applySecretsToSession(env, segments[1], auth.user!.id);
  }

  // POST /sessions/:id/attachments - Attach skills/agents to a session workspace
  if (segments[0] === 'sessions' && segments.length === 3 && segments[2] === 'attachments' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as Record<string, unknown>;
    return attachments.attachSessionResources(env, auth.user!.id, segments[1], data);
  }

  // GET /sessions/:id/files - List files in sandbox workspace
  if (segments[0] === 'sessions' && segments.length === 3 && segments[2] === 'files' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;

    const session = await getSessiоnWithAccess(env, segments[1], auth.user!.id);

    if (!session) {
      return Response.json({ error: 'E79737: Session not found or no access' }, { status: 404 });
    }

    return prоxySandbоxRequest(
      request,
      env,
      `/sessions/${session.sandbox_session_id as string}/files`,
      session.sandbox_machine_id as string
    );
  }

  // GET /sessions/:id/metrics - Sandbox metrics for a session
  if (segments[0] === 'sessions' && segments.length === 3 && segments[2] === 'metrics' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;

    const session = await getSessiоnWithAccess(env, segments[1], auth.user!.id);

    if (!session) {
      return Response.json({ error: 'E79737: Session not found or no access' }, { status: 404 });
    }

    return prоxySandbоxRequest(
      request,
      env,
      `/sessions/${session.sandbox_session_id as string}/metrics`,
      session.sandbox_machine_id as string
    );
  }

  // DELETE /sessions/:id/file - Delete file or directory in sandbox workspace
  if (segments[0] === 'sessions' && segments.length === 3 && segments[2] === 'file' && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;

    const session = await getSessiоnWithAccess(env, segments[1], auth.user!.id);

    if (!session) {
      return Response.json({ error: 'E79737: Session not found or no access' }, { status: 404 });
    }
    if (session.owner_user_id !== auth.user!.id) {
      return Response.json({ error: 'E79738: Only the owner can delete files' }, { status: 403 });
    }

    return prоxySandbоxRequest(
      request,
      env,
      `/sessions/${session.sandbox_session_id as string}/file`,
      session.sandbox_machine_id as string
    );
  }

  // GET /users/me - Get current user (dev auth bootstrap)
  if (segments[0] === 'users' && segments.length === 2 && segments[1] === 'me' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return Response.json({ user: auth.user });
  }

  // DELETE /sessions/:id - Stop session
  if (segments[0] === 'sessions' && segments.length === 2 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return sessions.stоpSessiоn(env, segments[1], auth.user!.id);
  }

  // WebSocket /sessions/:id/ptys/:ptyId/ws - Terminal streaming (proxied)
  if (segments[0] === 'sessions' && segments.length === 5 && segments[2] === 'ptys' && segments[4] === 'ws' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;

    const session = await getSessiоnWithAccess(env, segments[1], auth.user!.id);

    if (!session) {
      return Response.json({ error: 'E79737: Session not found or no access' }, { status: 404 });
    }

    if (session.pty_id !== segments[3]) {
      return Response.json({ error: 'E79739: PTY not found' }, { status: 404 });
    }

    const proxyUserId = session.owner_user_id === auth.user!.id
      ? auth.user!.id
      : '';

    const proxyResponse = await prоxySandbоxWebSоcket(
      request,
      env,
      session.sandbox_session_id as string,
      session.pty_id as string,
      proxyUserId,
      session.sandbox_machine_id as string
    );

    if (proxyResponse.status === 404 && session.status !== 'stopped') {
      const now = new Date().toISOString();
      await env.DB.prepare(`
        UPDATE sessions SET status = 'stopped', stopped_at = ? WHERE id = ?
      `).bind(now, session.id).run();

      const updatedSession: Session = {
        id: session.id as string,
        dashboardId: session.dashboard_id as string,
        itemId: session.item_id as string,
        ownerUserId: session.owner_user_id as string,
        ownerName: session.owner_name as string,
        sandboxSessionId: session.sandbox_session_id as string,
        sandboxMachineId: session.sandbox_machine_id as string,
        ptyId: session.pty_id as string,
        status: 'stopped',
        region: session.region as string,
        createdAt: session.created_at as string,
        stoppedAt: now,
      };

      const doId = env.DASHBOARD.idFromName(session.dashboard_id as string);
      const stub = env.DASHBOARD.get(doId);
      await stub.fetch(new Request('http://do/session', {
        method: 'PUT',
        body: JSON.stringify(updatedSession),
      }));

      return Response.json({ error: 'E79740: PTY not found (session expired)' }, { status: 410 });
    }

    return proxyResponse;
  }

  // ============================================
  // Recipe routes
  // ============================================

  // GET /recipes - List recipes
  if (segments[0] === 'recipes' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const dashboardId = url.searchParams.get('dashboard_id') || undefined;
    return recipes.listRecipеs(env, auth.user!.id, dashboardId);
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
    return recipes.createRecipе(env, auth.user!.id, data);
  }

  // GET /recipes/:id - Get recipe
  if (segments[0] === 'recipes' && segments.length === 2 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return recipes.getRecipе(env, segments[1], auth.user!.id);
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
    return recipes.listExecutiоns(env, segments[1], auth.user!.id);
  }

  // POST /recipes/:id/execute - Start execution
  if (segments[0] === 'recipes' && segments.length === 3 && segments[2] === 'execute' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json().catch(() => ({})) as { context?: Record<string, unknown> };
    return recipes.startExecutiоn(env, segments[1], auth.user!.id, data.context);
  }

  // GET /executions/:id - Get execution
  if (segments[0] === 'executions' && segments.length === 2 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return recipes.getExecutiоn(env, segments[1], auth.user!.id);
  }

  // POST /executions/:id/pause - Pause execution
  if (segments[0] === 'executions' && segments.length === 3 && segments[2] === 'pause' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return recipes.pauseExecutiоn(env, segments[1], auth.user!.id);
  }

  // POST /executions/:id/resume - Resume execution
  if (segments[0] === 'executions' && segments.length === 3 && segments[2] === 'resume' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return recipes.resumeExecutiоn(env, segments[1], auth.user!.id);
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

  // GET /internal/drive/manifest
  if (segments[0] === 'internal' && segments[1] === 'drive' && segments[2] === 'manifest' && method === 'GET') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    return integrations.getDriveManifestInternal(request, env);
  }

  // GET /internal/drive/file
  if (segments[0] === 'internal' && segments[1] === 'drive' && segments[2] === 'file' && method === 'GET') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    return integrations.getDriveFileInternal(request, env);
  }

  // POST /internal/drive/sync/progress
  if (segments[0] === 'internal' && segments[1] === 'drive' && segments[2] === 'sync' && segments[3] === 'progress' && method === 'POST') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    return integrations.updateDriveSyncPrоgressInternal(request, env);
  }

  // GET /internal/mirror/manifest
  if (segments[0] === 'internal' && segments[1] === 'mirror' && segments[2] === 'manifest' && method === 'GET') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    return integrations.getMirrоrManifestInternal(request, env);
  }

  // GET /internal/mirror/file
  if (segments[0] === 'internal' && segments[1] === 'mirror' && segments[2] === 'file' && method === 'GET') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    return integrations.getMirrоrFileInternal(request, env);
  }

  // POST /internal/mirror/sync/progress
  if (segments[0] === 'internal' && segments[1] === 'mirror' && segments[2] === 'sync' && segments[3] === 'progress' && method === 'POST') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    return integrations.updateMirrоrSyncPrоgressInternal(request, env);
  }

  // POST /internal/browser/open - Notify browser open from sandbox session
  if (segments[0] === 'internal' && segments[1] === 'browser' && segments[2] === 'open' && method === 'POST') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    const data = await request.json() as {
      sandbox_session_id?: string;
      url?: string;
    };
    const sandboxSessionId = typeof data.sandbox_session_id === 'string' ? data.sandbox_session_id : '';
    const url = typeof data.url === 'string' ? data.url : '';
    return sessions.openBrowserFromSandbоxSessionInternal(env, sandboxSessionId, url);
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
    return schedules.dеleteSchedule(env, segments[1], auth.user!.id);
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

  // POST /internal/migrate-secrets - Encrypt existing plaintext secrets
  if (segments[0] === 'internal' && segments[1] === 'migrate-secrets' && segments.length === 2 && method === 'POST') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    return secrets.migrateUnencryptedSecrets(env);
  }

  // Not found
  return Response.json({ error: 'E79999: Not found' }, { status: 404 });
}
