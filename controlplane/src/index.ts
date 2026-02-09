// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: controlplane-v2-bugreport

// REVISION: index-v9-orcabot-chat
console.log(`[controlplane] REVISION: index-v9-orcabot-chat loaded at ${new Date().toISOString()}`);

/**
 * OrcaBot Control Plane - Cloudflare Worker Entry Point
 *
 * This is the main entry point for the control plane.
 * Routes requests to appropriate handlers.
 */

import type { Env, DashboardItem, RecipeStep, Session } from './types';
import { authenticate, requireAuth, requireInternalAuth, validateMcpAuth, type AuthContext } from './auth/middleware';
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
import * as integrationPolicies from './integration-policies/handler';
import * as templates from './templates/handler';
import * as members from './members/handler';
import * as mcpUi from './mcp-ui/handler';
import * as bugReports from './bug-reports/handler';
import * as agentState from './agent-state/handler';
import * as chat from './chat/handler';
import * as googleAuth from './auth/google';
import * as authLogout from './auth/logout';
import { isAdminEmail } from './auth/admin';
import { buildSessionCookie, createUserSession } from './auth/sessions';
import { checkAndCacheSandbоxHealth, getCachedHealth } from './health/checker';
import { sendEmail, buildInterestThankYouEmail, buildInterestNotificationEmail, buildTemplateReviewEmail } from './email/resend';
import { sandboxHeaders, sandboxUrl } from './sandbox/fetch';

// Export Durable Objects
export { DashboardDO } from './dashboards/DurableObject';
export { RateLimitCounter } from './rate-limit/DurableObject';

// CORS headers (base - origin is added dynamically)
const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_ALLOWED_HEADERS = 'Content-Type, X-User-ID, X-User-Email, X-User-Name';

/**
 * Parse allowed origins from env. Returns null if all origins allowed (dev mode).
 */
function parseAllоwedOrigins(env: Env): Set<string> | null {
  if (!env.ALLOWED_ORIGINS) {
    return env.DEV_AUTH_ENABLED === 'true' ? null : new Set(); // Fail closed unless explicitly in dev
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
const EMBED_FETCH_TIMEOUT_MS = 5_000;
const EMBED_MAX_REDIRECTS = 5;

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

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function resolveRedirectUrl(current: URL, location: string): URL | null {
  try {
    return new URL(location, current);
  } catch {
    return null;
  }
}

async function fetchEmbedTarget(targetUrl: URL): Promise<{ response: Response; finalUrl: URL }> {
  let current = targetUrl;
  for (let i = 0; i <= EMBED_MAX_REDIRECTS; i++) {
    let response = await fetchWithTimeout(
      current.toString(),
      { method: 'HEAD', redirect: 'manual' },
      EMBED_FETCH_TIMEOUT_MS
    );
    if (response.status === 405 || response.status === 501) {
      response = await fetchWithTimeout(
        current.toString(),
        { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'manual' },
        EMBED_FETCH_TIMEOUT_MS
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      if (!location) {
        return { response, finalUrl: current };
      }
      const nextUrl = resolveRedirectUrl(current, location);
      if (!nextUrl || !EMBED_ALLOWED_PROTOCOLS.has(nextUrl.protocol) || isPrivateHоstname(nextUrl.hostname)) {
        throw new Error('E79736: URL not allowed');
      }
      current = nextUrl;
      continue;
    }

    return { response, finalUrl: current };
  }
  throw new Error('E79737: Too many redirects');
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
  const sandboxUrlValue = sandboxUrl(env, `/sessions/${sandboxSessionId}/ptys/${ptyId}/ws`);
  sandboxUrlValue.searchParams.set('user_id', userId);

  const headers = sandboxHeaders(env, request.headers, machineId);
  headers.delete('Host');

  const body = ['POST', 'PUT', 'PATCH'].includes(request.method)
    ? request.clone().body
    : undefined;
  const proxyRequest = new Request(sandboxUrlValue.toString(), {
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
  const sandboxUrlValue = sandboxUrl(env, `/sessions/${sandboxSessionId}/control`);

  const headers = sandboxHeaders(env, request.headers, machineId);
  headers.delete('Host');

  const proxyRequest = new Request(sandboxUrlValue.toString(), {
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
  const sandboxUrlValue = sandboxUrl(env, path);
  sandboxUrlValue.search = new URL(request.url).search;

  const headers = sandboxHeaders(env, request.headers, machineId);
  headers.delete('Host');

  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body;
  const proxyRequest = new Request(sandboxUrlValue.toString(), {
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
  const sandboxUrlValue = sandboxUrl(env, path);
  sandboxUrlValue.search = new URL(request.url).search;

  const headers = sandboxHeaders(env, request.headers, machineId);
  headers.delete('Host');

  const proxyRequest = new Request(sandboxUrlValue.toString(), {
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
  async fetch(request: Request, env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
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
      const response = await handleRequest(request, envWithBindings, ctx);
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
      await schedules.cleanupStaleExecutions(envWithBindings);
      // Messaging: retry buffered messages, wake stale, and clean up expired ones
      const { retryBufferedMessages, wakeAndDrainStaleMessages, cleanupExpiredMessages } = await import('./messaging/delivery');
      await retryBufferedMessages(envWithBindings);
      await wakeAndDrainStaleMessages(envWithBindings);
      await cleanupExpiredMessages(envWithBindings);
      // Clean up expired agent memories (runs every minute, lightweight operation)
      const expiredCount = await agentState.cleanupExpiredMemory(envWithBindings);
      if (expiredCount > 0) {
        console.log(`[scheduled] Cleaned up ${expiredCount} expired memory entries`);
      }
    } catch (error) {
      if (isDesktopFeatureDisabledError(error)) {
        return;
      }
      throw error;
    }
  },
};

async function handleRequest(request: Request, env: EnvWithBindings, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
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

  // POST /register-interest - Register interest (no auth required)
  if (segments[0] === 'register-interest' && segments.length === 1 && method === 'POST') {
    // Rate limit by IP for this unauthenticated endpoint
    const ipLimitResult = await checkRateLimitIp(request, env);
    if (!ipLimitResult.allowed) {
      return ipLimitResult.response!;
    }

    const data = await request.json() as { email?: string; note?: string };
    const email = typeof data.email === 'string' ? data.email.trim() : '';
    const note = typeof data.note === 'string' ? data.note.trim() : '';

    // Validate email
    if (!email || !email.includes('@')) {
      return Response.json({ error: 'Valid email is required' }, { status: 400 });
    }

    // Limit note length
    const truncatedNote = note.slice(0, 1000);

    try {
      // Send thank-you email to the user
      const thankYouEmail = buildInterestThankYouEmail();
      await sendEmail(env, {
        to: email,
        subject: thankYouEmail.subject,
        html: thankYouEmail.html,
      });

      // Send notification email to admin
      const notificationEmail = buildInterestNotificationEmail({
        email,
        note: truncatedNote || undefined,
      });
      await sendEmail(env, {
        to: 'rob.d.macrae@gmail.com',
        subject: notificationEmail.subject,
        html: notificationEmail.html,
      });

      return Response.json({ success: true, message: 'Interest registered successfully' }, { status: 201 });
    } catch (error) {
      console.error('Failed to send interest registration emails:', error);
      return Response.json({ error: 'Failed to register interest. Please try again.' }, { status: 500 });
    }
  }

  // POST /bug-reports - Submit bug report (requires auth)
  if (segments[0] === 'bug-reports' && segments.length === 1 && method === 'POST') {
    console.log('[controlplane] Bug report route matched, revision: controlplane-v2-bugreport');
    const authError = requireAuth(auth);
    if (authError) {
      console.log('[controlplane] Bug report auth error:', authError);
      return authError;
    }

    let data: {
      notes?: string;
      screenshot?: string;
      dashboardId?: string;
      dashboardName?: string;
      userAgent?: string;
      url?: string;
    };
    try {
      data = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    return bugReports.submitBugReport(env, auth.user!, data);
  }

  // ============================================
  // Chat routes (Orcabot conversational interface)
  // ============================================

  // POST /chat/message - Send a message and get streaming response
  if (segments[0] === 'chat' && segments[1] === 'message' && segments.length === 2 && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return chat.streamMessage(request, env, auth.user!.id);
  }

  // GET /chat/history - Get conversation history
  if (segments[0] === 'chat' && segments[1] === 'history' && segments.length === 2 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return chat.getHistory(request, env, auth.user!.id);
  }

  // DELETE /chat/history - Clear conversation history
  if (segments[0] === 'chat' && segments[1] === 'history' && segments.length === 2 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return chat.clearHistory(request, env, auth.user!.id);
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
    let finalUrl: URL;
    try {
      const result = await fetchEmbedTarget(targetUrl);
      response = result.response;
      finalUrl = result.finalUrl;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('E79736')) {
        return Response.json({ error: 'E79736: URL not allowed' }, { status: 400 });
      }
      if (error instanceof Error && error.message.startsWith('E79737')) {
        return Response.json({ error: 'E79737: Too many redirects' }, { status: 400 });
      }
      console.warn('Embed check fetch failed:', error);
      return Response.json({ embeddable: true, reason: 'fetch_failed' });
    }

    const checkedUrl = finalUrl.toString();
    const checkedOrigin = finalUrl.origin;
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

  // POST /dashboards/:id/ui-command-result - Send UI command result back
  if (segments[0] === 'dashboards' && segments.length === 3 && segments[2] === 'ui-command-result' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as {
      command_id: string;
      success: boolean;
      error?: string;
      created_item_id?: string;
    };
    return dashboards.sendUICommandResult(env, segments[1], auth.user!.id, data);
  }

  // ============================================
  // Agent State routes (Tasks & Memory)
  // ============================================

  // GET /dashboards/:id/tasks - List tasks
  // Session-scoped access: dashboard members can view tasks for any session in their dashboard (collaborative model)
  // The handler validates sessionId belongs to the dashboard to prevent cross-dashboard access
  if (segments[0] === 'dashboards' && segments.length === 3 && segments[2] === 'tasks' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    // Support multiple status values via repeated query params (e.g., ?status=pending&status=in_progress)
    const statusParams = url.searchParams.getAll('status') as import('./types').AgentTaskStatus[];
    const filters = {
      status: statusParams.length > 0 ? statusParams : undefined,
      sessionId: url.searchParams.get('session_id') || undefined,
      parentId: url.searchParams.get('parent_id') || undefined,
      ownerAgent: url.searchParams.get('owner_agent') || undefined,
      includeCompleted: url.searchParams.get('include_completed') === 'true',
    };
    return agentState.listTasks(env, segments[1], auth.user!.id, filters);
  }

  // POST /dashboards/:id/tasks - Create task
  // Session-scoped creation requires PTY token (via internal gateway) to prove terminal ownership
  // Public API only creates dashboard-wide tasks
  if (segments[0] === 'dashboards' && segments.length === 3 && segments[2] === 'tasks' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as import('./types').CreateTaskInput;
    // createTask rejects sessionId unless allowSessionScope=true (internal gateway only)
    return agentState.createTask(env, segments[1], auth.user!.id, data);
  }

  // GET /dashboards/:id/tasks/:taskId - Get task
  // Session-scoped access: dashboard members can view tasks for any session in their dashboard
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'tasks' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const sessionId = url.searchParams.get('session_id') || undefined;
    return agentState.getTask(env, segments[1], segments[3], auth.user!.id, sessionId);
  }

  // PATCH /dashboards/:id/tasks/bulk - Bulk update tasks
  // Session-scoped access: dashboard members can update tasks for any session in their dashboard
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'tasks' && segments[3] === 'bulk' && method === 'PATCH') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const { updates } = await request.json() as { updates: Array<{ taskId: string; status?: import('./types').AgentTaskStatus; subject?: string; description?: string; priority?: number; metadata?: Record<string, unknown> }> };
    const sessionId = url.searchParams.get('session_id') || undefined;
    return agentState.bulkUpdateTasks(env, segments[1], auth.user!.id, updates, { sessionId });
  }

  // PATCH /dashboards/:id/tasks/:taskId - Update task
  // Session-scoped access: dashboard members can update tasks for any session in their dashboard
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'tasks' && method === 'PATCH') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as import('./types').UpdateTaskInput;
    const sessionId = url.searchParams.get('session_id') || undefined;
    return agentState.updateTask(env, segments[1], segments[3], auth.user!.id, data, { sessionId });
  }

  // DELETE /dashboards/:id/tasks/:taskId - Delete task
  // Session-scoped access: dashboard members can delete tasks for any session in their dashboard
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'tasks' && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const sessionId = url.searchParams.get('session_id') || undefined;
    return agentState.deleteTask(env, segments[1], segments[3], auth.user!.id, sessionId);
  }

  // GET /dashboards/:id/memory - List memory
  // Session-scoped access: dashboard members can view memory for any session in their dashboard (collaborative model)
  if (segments[0] === 'dashboards' && segments.length === 3 && segments[2] === 'memory' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const filters = {
      sessionId: url.searchParams.get('session_id') || undefined,
      memoryType: url.searchParams.get('memory_type') as import('./types').AgentMemoryType | undefined,
      prefix: url.searchParams.get('prefix') || undefined,
      tags: url.searchParams.get('tags')?.split(',').filter(Boolean) || undefined,
    };
    return agentState.listMemory(env, segments[1], auth.user!.id, filters);
  }

  // GET /dashboards/:id/memory/:key - Get memory by key
  // Session-scoped access: dashboard members can view memory for any session in their dashboard
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'memory' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const sessionId = url.searchParams.get('session_id') || undefined;
    return agentState.getMemory(env, segments[1], segments[3], auth.user!.id, sessionId);
  }

  // PUT /dashboards/:id/memory/:key - Set memory (upsert)
  // Session-scoped creation requires PTY token (via internal gateway) to prove terminal ownership
  // Public API only creates dashboard-wide memory (setMemory rejects sessionId unless allowSessionScope=true)
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'memory' && method === 'PUT') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as Omit<import('./types').SetMemoryInput, 'key'>;
    // setMemory rejects sessionId unless allowSessionScope=true (internal gateway only)
    return agentState.setMemory(env, segments[1], auth.user!.id, { ...data, key: segments[3] });
  }

  // DELETE /dashboards/:id/memory/:key - Delete memory
  // Session-scoped access: dashboard members can delete memory for any session in their dashboard
  if (segments[0] === 'dashboards' && segments.length === 4 && segments[2] === 'memory' && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const sessionId = url.searchParams.get('session_id') || undefined;
    return agentState.deleteMemory(env, segments[1], segments[3], auth.user!.id, sessionId);
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
  // Terminal Integration Policy routes
  // ============================================

  // GET /dashboards/:id/integration-labels - Get integration labels for edge enrichment on reload
  if (segments[0] === 'dashboards' && segments.length === 3 && segments[2] === 'integration-labels' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return integrationPolicies.listDashboardIntegrationLabels(env, segments[1], auth.user!.id);
  }

  // GET /dashboards/:id/terminals/:terminalId/available-integrations - List integrations available to attach
  if (segments[0] === 'dashboards' && segments.length === 5 && segments[2] === 'terminals' && segments[4] === 'available-integrations' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return integrationPolicies.listAvailableIntegrations(env, segments[1], segments[3], auth.user!.id);
  }

  // GET /dashboards/:id/terminals/:terminalId/integrations - List attached integrations
  if (segments[0] === 'dashboards' && segments.length === 5 && segments[2] === 'terminals' && segments[4] === 'integrations' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return integrationPolicies.listTerminalIntegrations(env, segments[1], segments[3], auth.user!.id);
  }

  // POST /dashboards/:id/terminals/:terminalId/integrations - Attach integration to terminal
  if (segments[0] === 'dashboards' && segments.length === 5 && segments[2] === 'terminals' && segments[4] === 'integrations' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as {
      provider: string;
      userIntegrationId?: string;
      policy?: Record<string, unknown>;
      accountLabel?: string;
      highRiskConfirmations?: string[];
    };
    return integrationPolicies.attachIntegration(env, segments[1], segments[3], auth.user!.id, data as Parameters<typeof integrationPolicies.attachIntegration>[4]);
  }

  // PUT /dashboards/:id/terminals/:terminalId/integrations/:provider - Update integration policy
  if (segments[0] === 'dashboards' && segments.length === 6 && segments[2] === 'terminals' && segments[4] === 'integrations' && method === 'PUT') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as {
      policy: Record<string, unknown>;
      highRiskConfirmations?: string[];
    };
    return integrationPolicies.updateIntegrationPolicy(
      env,
      segments[1],
      segments[3],
      segments[5] as Parameters<typeof integrationPolicies.updateIntegrationPolicy>[3],
      auth.user!.id,
      data as Parameters<typeof integrationPolicies.updateIntegrationPolicy>[5]
    );
  }

  // DELETE /dashboards/:id/terminals/:terminalId/integrations/:provider - Detach integration
  if (segments[0] === 'dashboards' && segments.length === 6 && segments[2] === 'terminals' && segments[4] === 'integrations' && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return integrationPolicies.detachIntegration(
      env,
      segments[1],
      segments[3],
      segments[5] as Parameters<typeof integrationPolicies.detachIntegration>[3],
      auth.user!.id
    );
  }

  // GET /dashboards/:id/terminals/:terminalId/integrations/:provider/history - Policy history
  if (segments[0] === 'dashboards' && segments.length === 7 && segments[2] === 'terminals' && segments[4] === 'integrations' && segments[6] === 'history' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return integrationPolicies.getPolicyHistory(
      env,
      segments[1],
      segments[3],
      segments[5] as Parameters<typeof integrationPolicies.getPolicyHistory>[3],
      auth.user!.id
    );
  }

  // GET /dashboards/:id/terminals/:terminalId/integrations/:provider/audit - Audit log
  if (segments[0] === 'dashboards' && segments.length === 7 && segments[2] === 'terminals' && segments[4] === 'integrations' && segments[6] === 'audit' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    return integrationPolicies.getAuditLog(
      env,
      segments[1],
      segments[3],
      segments[5] as Parameters<typeof integrationPolicies.getAuditLog>[3],
      auth.user!.id,
      limit,
      offset
    );
  }

  // GET /dashboards/:id/integration-audit - Dashboard-wide audit log
  if (segments[0] === 'dashboards' && segments.length === 3 && segments[2] === 'integration-audit' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    return integrationPolicies.getDashboardAuditLog(env, segments[1], auth.user!.id, limit, offset);
  }

  // GET /dashboards/:id/workspace-snapshot - Get cached workspace file listing from R2
  if (segments[0] === 'dashboards' && segments.length === 3 && segments[2] === 'workspace-snapshot' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return sessions.getWorkspaceSnapshot(env, segments[1], auth.user!.id);
  }

  // ============================================
  // Template routes
  // ============================================

  // GET /templates - List templates (admins see all, non-admins see approved only)
  if (segments[0] === 'templates' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const category = url.searchParams.get('category') || undefined;
    const admin = isAdminEmail(env, auth.user!.email);
    return templates.listTemplates(env, category, admin);
  }

  // GET /templates/:id - Get template with data
  if (segments[0] === 'templates' && segments.length === 2 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return templates.getTemplate(env, segments[1]);
  }

  // POST /templates - Create template from dashboard (starts as pending_review)
  if (segments[0] === 'templates' && segments.length === 1 && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as {
      dashboardId: string;
      name: string;
      description?: string;
      category?: string;
      viewport?: { x: number; y: number; zoom: number };
    };
    const response = await templates.createTemplate(env, auth.user!.id, data);

    // Send review notification email to admin via waitUntil so it survives after response
    if (response.ok) {
      const cloned = response.clone();
      ctx.waitUntil(
        cloned.json().then((body: any) => {
          const reviewEmail = buildTemplateReviewEmail({
            templateName: data.name,
            authorName: auth.user!.name || 'Unknown',
            authorEmail: auth.user!.email,
            category: data.category || 'custom',
            itemCount: body.template.itemCount,
          });
          return sendEmail(env, {
            to: 'rob.d.macrae@gmail.com',
            subject: reviewEmail.subject,
            html: reviewEmail.html,
          });
        }).catch((err) => console.error('Failed to send template review email:', err))
      );
    }

    return response;
  }

  // POST /templates/:id/approve - Approve or reject template (admin only)
  if (segments[0] === 'templates' && segments.length === 3 && segments[2] === 'approve' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    if (!isAdminEmail(env, auth.user!.email)) {
      return Response.json(
        { error: 'E79807: Admin access required' },
        { status: 403 }
      );
    }
    const { status: newStatus } = await request.json() as { status: 'approved' | 'rejected' };
    return templates.approveTemplate(env, segments[1], newStatus);
  }

  // DELETE /templates/:id - Delete template (author or admin)
  if (segments[0] === 'templates' && segments.length === 2 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const admin = isAdminEmail(env, auth.user!.email);
    return templates.deleteTemplate(env, auth.user!.id, segments[1], admin);
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

  // GET /secrets - List secrets (optionally filter by type: 'secret' or 'env_var')
  if (segments[0] === 'secrets' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const url = new URL(request.url);
    const dashboardId = url.searchParams.get('dashboard_id');
    const type = url.searchParams.get('type') as 'secret' | 'env_var' | null;
    return secrets.listSecrets(env, auth.user!.id, dashboardId, type || undefined);
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
      'DELETE google/drive/disconnect': integrations.disconnectGoogleDrive,
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
      'DELETE github/disconnect': integrations.disconnectGithub,
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
      'DELETE box/disconnect': integrations.disconnectBox,
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
      'DELETE onedrive/disconnect': integrations.disconnectOnedrive,
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
      // Slack
      'GET slack/connect': integrations.connectSlack,
      'GET slack/callback': (request, env) => integrations.callbackSlack(request, env),
      'GET slack': integrations.getSlackIntegration,
      'GET slack/status': integrations.getSlackStatus,
      'GET slack/channels': integrations.listSlackChannels,
      'DELETE slack': integrations.disconnectSlack,
      // Discord
      'GET discord/connect': integrations.connectDiscord,
      'GET discord/callback': (request, env) => integrations.callbackDiscord(request, env),
      'GET discord': integrations.getDiscordIntegration,
      'GET discord/status': integrations.getDiscordStatus,
      'GET discord/channels': integrations.listDiscordChannels,
      'DELETE discord': integrations.disconnectDiscord,
      // Telegram (token-based)
      'POST telegram/connect-token': integrations.connectMessagingToken,
      'GET telegram': integrations.getMessagingIntegration,
      'GET telegram/chats': integrations.listMessagingChannels,
      'DELETE telegram': integrations.disconnectMessaging,
      // WhatsApp (token-based)
      'POST whatsapp/connect-token': integrations.connectMessagingToken,
      'GET whatsapp': integrations.getMessagingIntegration,
      'GET whatsapp/chats': integrations.listMessagingChannels,
      'DELETE whatsapp': integrations.disconnectMessaging,
      // Teams (token-based)
      'POST teams/connect-token': integrations.connectMessagingToken,
      'GET teams': integrations.getMessagingIntegration,
      'GET teams/channels': integrations.listMessagingChannels,
      'DELETE teams': integrations.disconnectMessaging,
      // Matrix (token-based)
      'POST matrix/connect-token': integrations.connectMessagingToken,
      'GET matrix': integrations.getMessagingIntegration,
      'GET matrix/rooms': integrations.listMessagingChannels,
      'DELETE matrix': integrations.disconnectMessaging,
      // Google Chat (token-based)
      'POST google_chat/connect-token': integrations.connectMessagingToken,
      'GET google_chat': integrations.getMessagingIntegration,
      'GET google_chat/spaces': integrations.listMessagingChannels,
      'DELETE google_chat': integrations.disconnectMessaging,
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

  // PATCH /secrets/:id/protection - Update secret broker protection setting
  if (segments[0] === 'secrets' && segments.length === 3 && segments[2] === 'protection' && method === 'PATCH') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const url = new URL(request.url);
    const dashboardId = url.searchParams.get('dashboard_id');
    const data = await request.json() as { brokerProtected: boolean };
    return secrets.updateSecretProtection(env, auth.user!.id, segments[1], dashboardId, data.brokerProtected);
  }

  // GET /secrets/:id/allowlist - List approved domains for a secret
  if (segments[0] === 'secrets' && segments.length === 3 && segments[2] === 'allowlist' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const url = new URL(request.url);
    const dashboardId = url.searchParams.get('dashboard_id');
    return secrets.listSecretAllowlist(env, auth.user!.id, segments[1], dashboardId);
  }

  // POST /secrets/:id/allowlist - Approve a domain for a secret
  if (segments[0] === 'secrets' && segments.length === 3 && segments[2] === 'allowlist' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const url = new URL(request.url);
    const dashboardId = url.searchParams.get('dashboard_id');
    const data = await request.json() as { domain: string; headerName?: string; headerFormat?: string };
    return secrets.approveSecretDomain(env, auth.user!.id, segments[1], dashboardId, data);
  }

  // DELETE /secrets/:id/allowlist/:entryId - Revoke domain approval
  if (segments[0] === 'secrets' && segments.length === 4 && segments[2] === 'allowlist' && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const url = new URL(request.url);
    const dashboardId = url.searchParams.get('dashboard_id');
    return secrets.revokeSecretDomain(env, auth.user!.id, segments[1], segments[3], dashboardId);
  }

  // GET /pending-approvals - List pending domain approval requests
  if (segments[0] === 'pending-approvals' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const url = new URL(request.url);
    const dashboardId = url.searchParams.get('dashboard_id');
    return secrets.listPendingApprovals(env, auth.user!.id, dashboardId);
  }

  // DELETE /pending-approvals/:id - Dismiss a pending approval
  if (segments[0] === 'pending-approvals' && segments.length === 2 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return secrets.dismissPendingApproval(env, auth.user!.id, segments[1]);
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

  // POST /dashboards/:id/browser/* - Proxy browser control (screenshot, click, type, etc.)
  if (segments[0] === 'dashboards' && segments[2] === 'browser' && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;

    const access = await env.DB.prepare(`
      SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
    `).bind(segments[1], auth.user!.id).first();
    if (!access) {
      return Response.json({ error: 'E79301: Not found or no access' }, { status: 404 });
    }

    const sandbox = await env.DB.prepare(`
      SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?
    `).bind(segments[1]).first<{ sandbox_session_id: string; sandbox_machine_id: string }>();
    if (!sandbox?.sandbox_session_id) {
      return Response.json({ error: 'E79816: Browser session not found' }, { status: 404 });
    }

    const suffix = segments.slice(3).join('/');
    const path = `/sessions/${sandbox.sandbox_session_id}/browser/${suffix}`;
    return prоxySandbоxRequest(request, env, path, sandbox.sandbox_machine_id);
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

  // GET /dashboards/:id/metrics - Dashboard-scoped sandbox metrics
  if (segments[0] === 'dashboards' && segments.length === 3 && segments[2] === 'metrics' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;

    const access = await env.DB.prepare(`
      SELECT 1 FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
    `).bind(segments[1], auth.user!.id).first();
    if (!access) {
      return Response.json({ error: 'E79301: Not found or no access' }, { status: 404 });
    }

    const sandbox = await env.DB.prepare(`
      SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?
    `).bind(segments[1]).first<{ sandbox_session_id: string; sandbox_machine_id: string }>();
    if (!sandbox?.sandbox_session_id) {
      return Response.json({ error: 'E79817: No active sandbox for this dashboard' }, { status: 404 });
    }

    return prоxySandbоxRequest(
      request,
      env,
      `/sessions/${sandbox.sandbox_session_id}/metrics`,
      sandbox.sandbox_machine_id
    );
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
    return Response.json({
      user: auth.user,
      isAdmin: isAdminEmail(env, auth.user!.email),
    });
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

  // POST /internal/sessions/:sessionId/approval-request - Create pending approval (called by sandbox broker)
  if (segments[0] === 'internal' && segments[1] === 'sessions' && segments.length === 4 && segments[3] === 'approval-request' && method === 'POST') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    const data = await request.json() as { secretName: string; domain: string };
    return sessions.createApprovalRequestInternal(env, segments[2], data);
  }

  // GET /internal/sessions/:sessionId/approved-domains - Get approved domain configs (called by sandbox)
  if (segments[0] === 'internal' && segments[1] === 'sessions' && segments.length === 4 && segments[3] === 'approved-domains' && method === 'GET') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    return sessions.getApprovedDomainsInternal(env, segments[2]);
  }

  // ============================================
  // Internal Integration Gateway routes (Sandbox → Control Plane)
  // ============================================

  // POST /internal/gateway/:provider/validate - Validate gateway request and get policy (DEPRECATED - use token-based validation)
  if (segments[0] === 'internal' && segments[1] === 'gateway' && segments.length === 4 && segments[3] === 'validate' && method === 'POST') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    const data = await request.json() as {
      terminalId: string;
      dashboardId: string;
      userId: string;
    };
    return integrationPolicies.validateGatewayRequest(
      env,
      data.terminalId,
      segments[2] as Parameters<typeof integrationPolicies.validateGatewayRequest>[2],
      data.dashboardId,
      data.userId
    );
  }

  // POST /internal/gateway/:provider/validate-token - Validate using PTY token (SECURE)
  // Security: terminal_id extracted from cryptographically verified token, not from body
  // Body: { action?: string, args?: Record<string, unknown> }
  // NOTE: context is derived server-side from args (same as execute endpoint) to prevent spoofing
  if (segments[0] === 'internal' && segments[1] === 'gateway' && segments.length === 4 && segments[3] === 'validate-token' && method === 'POST') {
    const ptyToken = request.headers.get('X-PTY-Token');
    if (!ptyToken) {
      return Response.json({ error: 'AUTH_DENIED', reason: 'Missing X-PTY-Token header' }, { status: 401 });
    }
    let action: string | undefined;
    let args: Record<string, unknown> | undefined;
    try {
      const body = await request.json() as {
        action?: string;
        args?: Record<string, unknown>;
      };
      action = body.action;
      args = body.args;
    } catch {
      // No body or invalid JSON - action and args remain undefined
    }
    // Derive context server-side from args (never trust body.context)
    const { deriveEnforcementContext } = await import('./integration-policies/gateway');
    const context = args && action ? deriveEnforcementContext(action, args) : undefined;
    return integrationPolicies.validateGatewayWithToken(
      env,
      ptyToken,
      segments[2] as Parameters<typeof integrationPolicies.validateGatewayWithToken>[2],
      action,
      context
    );
  }

  // ============================================
  // Internal Agent State Gateway (Tasks & Memory)
  // NOTE: These MUST come before the generic /internal/gateway/:provider/execute route
  // ============================================

  // POST /internal/gateway/tasks/execute - Execute task action
  // Security: Accepts PTY token (Bearer) or X-Dashboard-Token
  // REVISION: agent-state-gateway-v3-multi-auth
  // - PTY token: provides terminal_id (for session-scoped) and dashboard_id
  // - Dashboard token: provides only dashboard_id (dashboard-wide access only)
  if (segments[0] === 'internal' && segments[1] === 'gateway' && segments[2] === 'tasks' && segments[3] === 'execute' && segments.length === 4 && method === 'POST') {
    const { verifyPtyToken } = await import('./auth/pty-token');

    let dashboardId: string | null = null;
    let terminalId: string | null = null;

    // Try PTY token first (Bearer Authorization)
    const authHeader = request.headers.get('Authorization');
    const ptyToken = authHeader?.replace('Bearer ', '');
    if (ptyToken) {
      const claims = await verifyPtyToken(ptyToken, env.INTERNAL_API_TOKEN);
      if (claims) {
        dashboardId = claims.dashboard_id;
        terminalId = claims.terminal_id;
      }
    }

    // Fall back to X-Dashboard-Token (dashboard-scoped, no terminal access)
    if (!dashboardId) {
      const mcpAuth = await validateMcpAuth(request, env);
      if (mcpAuth.isValid) {
        dashboardId = mcpAuth.dashboardId || null;
        terminalId = null; // Dashboard token doesn't provide terminal context
      }
    }

    if (!dashboardId) {
      return Response.json({ error: 'Missing valid PTY token or X-Dashboard-Token' }, { status: 401 });
    }

    const body = await request.json() as { action: string; args: Record<string, unknown> };
    const result = await agentState.executeTaskAction(
      env,
      dashboardId,
      terminalId,
      body.action,
      body.args
    );
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    return Response.json(result.data);
  }

  // POST /internal/gateway/memory/execute - Execute memory action
  // Security: Accepts PTY token (Bearer) or X-Dashboard-Token
  // REVISION: agent-state-gateway-v3-multi-auth
  // - PTY token: provides terminal_id (for session-scoped) and dashboard_id
  // - Dashboard token: provides only dashboard_id (dashboard-wide access only)
  if (segments[0] === 'internal' && segments[1] === 'gateway' && segments[2] === 'memory' && segments[3] === 'execute' && segments.length === 4 && method === 'POST') {
    const { verifyPtyToken } = await import('./auth/pty-token');

    let dashboardId: string | null = null;
    let terminalId: string | null = null;

    // Try PTY token first (Bearer Authorization)
    const authHeader = request.headers.get('Authorization');
    const ptyToken = authHeader?.replace('Bearer ', '');
    if (ptyToken) {
      const claims = await verifyPtyToken(ptyToken, env.INTERNAL_API_TOKEN);
      if (claims) {
        dashboardId = claims.dashboard_id;
        terminalId = claims.terminal_id;
      }
    }

    // Fall back to X-Dashboard-Token (dashboard-scoped, no terminal access)
    if (!dashboardId) {
      const mcpAuth = await validateMcpAuth(request, env);
      if (mcpAuth.isValid) {
        dashboardId = mcpAuth.dashboardId || null;
        terminalId = null; // Dashboard token doesn't provide terminal context
      }
    }

    if (!dashboardId) {
      return Response.json({ error: 'Missing valid PTY token or X-Dashboard-Token' }, { status: 401 });
    }

    const body = await request.json() as { action: string; args: Record<string, unknown> };
    const result = await agentState.executeMemoryAction(
      env,
      dashboardId,
      terminalId,
      body.action,
      body.args
    );
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    return Response.json(result.data);
  }

  // POST /internal/gateway/:provider/execute - Execute gateway request with full policy enforcement
  // REVISION: gateway-execute-v1-route
  // Security: PTY token in Authorization header (Bearer <token>), terminal_id extracted from verified token
  // Body: { action: string, args: Record<string, unknown>, context?: { url?, recipient?, ... } }
  if (segments[0] === 'internal' && segments[1] === 'gateway' && segments.length === 4 && segments[3] === 'execute' && method === 'POST') {
    const { handleGatewayExecute } = await import('./integration-policies/gateway');
    return handleGatewayExecute(
      request,
      env,
      segments[2] as Parameters<typeof handleGatewayExecute>[2]
    );
  }

  // GET /internal/terminals/:ptyId/integrations - List integrations attached to a terminal
  // REVISION: terminal-integrations-v1-route
  // Security: PTY token in Authorization header, ptyId must match token's terminal_id
  if (segments[0] === 'internal' && segments[1] === 'terminals' && segments.length === 4 && segments[3] === 'integrations' && method === 'GET') {
    const { handleListTerminalIntegrations } = await import('./integration-policies/gateway');
    return handleListTerminalIntegrations(
      request,
      env,
      segments[2]
    );
  }

  // POST /internal/gateway/audit - Log audit entry for gateway operation
  if (segments[0] === 'internal' && segments[1] === 'gateway' && segments[2] === 'audit' && segments.length === 3 && method === 'POST') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    const data = await request.json() as Parameters<typeof integrationPolicies.logAuditEntry>[1];
    return integrationPolicies.logAuditEntry(env, data);
  }

  // ============================================
  // Messaging webhook routes (unauthenticated — signature-verified per platform)
  // ============================================

  // POST /webhooks/:provider - Global webhook for Slack/Discord (single app-level URL)
  // POST /webhooks/:provider/:hookId - Per-subscription webhook for Telegram (per-bot URL)
  // REVISION: messaging-webhook-v2-route-global
  // Security: Unauthenticated but signature-verified per platform
  // GET /webhooks/whatsapp — WhatsApp webhook verification challenge
  if (segments[0] === 'webhooks' && segments[1] === 'whatsapp' && segments.length === 2 && method === 'GET') {
    const url = new URL(request.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200 });
    }
    return Response.json({ error: 'Verification failed' }, { status: 403 });
  }

  if (segments[0] === 'webhooks' && (segments.length === 2 || segments.length === 3) && method === 'POST') {
    const { handleInboundWebhook } = await import('./messaging/webhook-handler');
    const provider = segments[1];
    const hookId = segments.length === 3 ? segments[2] : undefined;
    return handleInboundWebhook(request, env, provider, hookId, ctx);
  }

  // ============================================
  // Messaging subscription routes (authenticated)
  // ============================================

  // GET /messaging/subscriptions?dashboard_id=... - List subscriptions for a dashboard
  // Security: Requires dashboard membership
  if (segments[0] === 'messaging' && segments[1] === 'subscriptions' && segments.length === 2 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const dashboardId = url.searchParams.get('dashboard_id');
    if (!dashboardId) {
      return Response.json({ error: 'dashboard_id required' }, { status: 400 });
    }
    // Verify dashboard membership
    const membership = await env.DB.prepare(
      'SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?'
    ).bind(dashboardId, auth.user!.id).first();
    if (!membership) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const { listSubscriptions } = await import('./messaging/webhook-handler');
    return Response.json(await listSubscriptions(env, dashboardId));
  }

  // POST /messaging/subscriptions - Create a messaging subscription
  // Security: Requires dashboard membership + itemId must belong to dashboard
  if (segments[0] === 'messaging' && segments[1] === 'subscriptions' && segments.length === 2 && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as {
      dashboardId: string;
      itemId: string;
      provider: string;
      channelId?: string;
      channelName?: string;
      chatId?: string;
    };
    if (!data.dashboardId || !data.itemId || !data.provider) {
      return Response.json({ error: 'dashboardId, itemId, and provider are required' }, { status: 400 });
    }
    // Validate provider against providers with implemented webhook handlers.
    // The full set of messaging providers is: slack, discord, telegram, whatsapp, teams, matrix, google_chat
    // But only providers with signature verification + message parsing in webhook-handler.ts are accepted.
    // Only providers with implemented webhook signature verification are allowed.
    // teams, matrix, google_chat are excluded until JWT/shared-secret verification is added.
    const WEBHOOK_READY_PROVIDERS = ['slack', 'discord', 'telegram', 'whatsapp'];
    if (!WEBHOOK_READY_PROVIDERS.includes(data.provider)) {
      return Response.json({ error: `Provider '${data.provider}' does not have webhook support yet` }, { status: 400 });
    }
    // Verify dashboard membership
    const membership = await env.DB.prepare(
      'SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?'
    ).bind(data.dashboardId, auth.user!.id).first();
    if (!membership) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    // Verify itemId belongs to the dashboard AND is a messaging block matching the provider.
    // Without this, subscriptions could be created for any item (terminals, notes, etc.),
    // causing confusing delivery behavior.
    const item = await env.DB.prepare(
      'SELECT id, type FROM dashboard_items WHERE id = ? AND dashboard_id = ?'
    ).bind(data.itemId, data.dashboardId).first<{ id: string; type: string }>();
    if (!item) {
      return Response.json({ error: 'Item not found in dashboard' }, { status: 404 });
    }
    if (item.type !== data.provider) {
      return Response.json(
        { error: `Item type '${item.type}' does not match provider '${data.provider}'` },
        { status: 400 },
      );
    }
    // Require channelId for Slack/Discord (not just channelName) so subscription scoping
    // doesn't depend on runtime name resolution during webhook delivery. Telegram uses chatId.
    if ((data.provider === 'slack' || data.provider === 'discord' || data.provider === 'teams' || data.provider === 'google_chat') && !data.channelId) {
      return Response.json(
        { error: `channelId is required for ${data.provider} subscriptions — resolve channel name to ID client-side` },
        { status: 400 },
      );
    }
    if ((data.provider === 'telegram' || data.provider === 'whatsapp' || data.provider === 'matrix') && !data.chatId) {
      return Response.json(
        { error: `chatId is required for ${data.provider} subscriptions` },
        { status: 400 },
      );
    }

    const { createSubscription, SubscriptionError } = await import('./messaging/webhook-handler');
    const webhookBaseUrl = env.OAUTH_REDIRECT_BASE?.replace(/\/$/, '') || new URL(request.url).origin;
    try {
      const result = await createSubscription(env, data.dashboardId, data.itemId, auth.user!.id, data.provider, {
        channelId: data.channelId,
        channelName: data.channelName,
        chatId: data.chatId,
      }, webhookBaseUrl);
      return Response.json(result, { status: 201 });
    } catch (err) {
      if (err instanceof SubscriptionError) {
        return Response.json({ error: err.message, code: err.code }, { status: 400 });
      }
      throw err;
    }
  }

  // DELETE /messaging/subscriptions/:id - Delete a messaging subscription
  // Security: Requires subscription ownership (user_id match) + dashboard membership
  if (segments[0] === 'messaging' && segments[1] === 'subscriptions' && segments.length === 3 && method === 'DELETE') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    // Verify the subscription exists and belongs to the user, and user is a dashboard member
    const sub = await env.DB.prepare(
      `SELECT ms.id, ms.dashboard_id FROM messaging_subscriptions ms
       JOIN dashboard_members dm ON dm.dashboard_id = ms.dashboard_id AND dm.user_id = ?
       WHERE ms.id = ? AND ms.user_id = ?`
    ).bind(auth.user!.id, segments[2], auth.user!.id).first();
    if (!sub) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const { deleteSubscription } = await import('./messaging/webhook-handler');
    await deleteSubscription(env, segments[2], auth.user!.id);
    return Response.json({ ok: true });
  }

  // ============================================
  // Schedule routes
  // ============================================

  // GET /schedules - List schedules
  if (segments[0] === 'schedules' && segments.length === 1 && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return schedules.listSchedules(env, auth.user!.id, {
      recipeId: url.searchParams.get('recipe_id') || undefined,
      dashboardId: url.searchParams.get('dashboard_id') || undefined,
      dashboardItemId: url.searchParams.get('dashboard_item_id') || undefined,
    });
  }

  // POST /schedules - Create schedule
  if (segments[0] === 'schedules' && segments.length === 1 && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    const data = await request.json() as {
      recipeId?: string;
      dashboardId?: string;
      dashboardItemId?: string;
      command?: string;
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
      command?: string;
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

  // GET /schedules/:id/executions - List schedule executions
  if (segments[0] === 'schedules' && segments.length === 3 && segments[2] === 'executions' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    return schedules.listScheduleExecutions(env, segments[1], auth.user!.id);
  }

  // POST /internal/schedule-executions/:id/pty-completed - Sandbox callback when PTY finishes
  if (segments[0] === 'internal' && segments[1] === 'schedule-executions' && segments.length === 4 && segments[3] === 'pty-completed' && method === 'POST') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    const data = await request.json() as {
      ptyId: string;
      status: 'completed' | 'failed' | 'timed_out';
      lastMessage?: string;
      error?: string;
    };
    if (!data.ptyId || !data.status) {
      return Response.json({ error: 'E79745: ptyId and status are required' }, { status: 400 });
    }
    return schedules.handlePtyCompleted(env, segments[2], data);
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

  // ============================================
  // Internal MCP UI Server routes (for schedules, workflows, server-side automation)
  // ============================================
  // These accept either:
  // - X-Internal-Token: Full trust (schedules, internal services)
  // - X-Dashboard-Token: Scoped to specific dashboard (sandbox MCP proxy)

  // GET /internal/mcp/ui/tools - List available UI tools (internal)
  if (segments[0] === 'internal' && segments[1] === 'mcp' && segments[2] === 'ui' && segments[3] === 'tools' && segments.length === 4 && method === 'GET') {
    const mcpAuth = await validateMcpAuth(request, env);
    if (!mcpAuth.isValid) return mcpAuth.error!;
    return mcpUi.listTools();
  }

  // POST /internal/mcp/ui/tools/call - Execute a UI tool (internal)
  if (segments[0] === 'internal' && segments[1] === 'mcp' && segments[2] === 'ui' && segments[3] === 'tools' && segments[4] === 'call' && segments.length === 5 && method === 'POST') {
    const mcpAuth = await validateMcpAuth(request, env);
    if (!mcpAuth.isValid) return mcpAuth.error!;

    const data = await request.json() as {
      name: string;
      arguments: Record<string, unknown>;
      source_terminal_id?: string;
    };

    // dashboard_id must be in arguments for internal calls
    if (!data.arguments.dashboard_id) {
      return Response.json({ error: 'E79801: dashboard_id is required in arguments' }, { status: 400 });
    }

    // If using scoped token, verify dashboard_id matches the token's claim
    if (!mcpAuth.isFullAccess && mcpAuth.dashboardId !== data.arguments.dashboard_id) {
      return Response.json(
        { error: 'E79804: Dashboard token does not match dashboard_id in request' },
        { status: 403 }
      );
    }

    return mcpUi.callTool(env, data.name, data.arguments, data.source_terminal_id);
  }

  // GET /internal/mcp/ui/dashboards/:id/items - List items in a dashboard (internal)
  if (segments[0] === 'internal' && segments[1] === 'mcp' && segments[2] === 'ui' && segments[3] === 'dashboards' && segments.length === 6 && segments[5] === 'items' && method === 'GET') {
    const mcpAuth = await validateMcpAuth(request, env);
    if (!mcpAuth.isValid) return mcpAuth.error!;

    const requestedDashboardId = segments[4];

    // If using scoped token, verify dashboard_id matches the token's claim
    if (!mcpAuth.isFullAccess && mcpAuth.dashboardId !== requestedDashboardId) {
      return Response.json(
        { error: 'E79804: Dashboard token does not match requested dashboard' },
        { status: 403 }
      );
    }

    return mcpUi.getItems(env, requestedDashboardId);
  }

  // GET /internal/dashboards/:id/mcp-tools - Get user's MCP tools for a dashboard (used by sandbox)
  if (segments[0] === 'internal' && segments[1] === 'dashboards' && segments.length === 4 && segments[3] === 'mcp-tools' && method === 'GET') {
    const authError = requireInternalAuth(request, env);
    if (authError) return authError;
    return mcpTools.getMcpToolsForDashboard(env, segments[2]);
  }

  // ============================================
  // MCP UI Server routes (user-facing, requires user auth)
  // ============================================
  // These endpoints implement the MCP protocol for UI control tools
  // They allow authenticated users to control dashboard UI elements

  // GET /mcp/ui/tools - List available UI tools
  if (segments[0] === 'mcp' && segments[1] === 'ui' && segments[2] === 'tools' && segments.length === 3 && method === 'GET') {
    // This endpoint can be called without auth for tool discovery
    return mcpUi.listTools();
  }

  // POST /mcp/ui/tools/call - Execute a UI tool
  if (segments[0] === 'mcp' && segments[1] === 'ui' && segments[2] === 'tools' && segments[3] === 'call' && segments.length === 4 && method === 'POST') {
    const authError = requireAuth(auth);
    if (authError) return authError;

    const data = await request.json() as {
      name: string;
      arguments: Record<string, unknown>;
      source_terminal_id?: string;
    };

    // Pass userId for access control check
    return mcpUi.callTool(env, data.name, data.arguments, data.source_terminal_id, auth.user!.id);
  }

  // GET /mcp/ui/dashboards/:id/items - List items in a dashboard
  if (segments[0] === 'mcp' && segments[1] === 'ui' && segments[2] === 'dashboards' && segments.length === 5 && segments[4] === 'items' && method === 'GET') {
    const authError = requireAuth(auth);
    if (authError) return authError;
    // Pass userId for access control check
    return mcpUi.getItems(env, segments[3], auth.user!.id);
  }

  // Not found
  return Response.json({ error: 'E79999: Not found' }, { status: 404 });
}
