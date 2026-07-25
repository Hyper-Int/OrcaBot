// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: auth-middleware-v2-pat-method-gate

/**
 * Auth Middleware
 *
 * Supports two authentication modes:
 * 1. Development: Header-based auth (DEV_AUTH_ENABLED=true)
 * 2. Production: Cloudflare Access JWT validation (CF_ACCESS_TEAM_DOMAIN set)
 */

import type { Env, User } from '../types';
import { validateCfAccessTоken, cfAccessUserIdFrоmSub } from './cf-access';
import { getUserForSession } from './sessions';
import { getUserForApiToken, PAT_PREFIX } from './api-token';

/** How the request authenticated. Used to gate sensitive routes (e.g. token
 * management must not be reachable with a PAT — a leaked PAT could otherwise mint
 * a replacement and survive revocation). */
export type AuthMethod = 'session' | 'pat' | 'cf-access' | 'dev';

export interface AuthContext {
  user: User | null;
  isAuthenticated: boolean;
  method?: AuthMethod;
}

// Extract user from request
export async function authenticate(
  request: Request,
  env: Env
): Promise<AuthContext> {
  const sessionUser = await getUserForSession(request, env);
  if (sessionUser) {
    return { user: sessionUser, isAuthenticated: true, method: 'session' };
  }

  // Personal access token (CLI / external tools). Prefix-gated so it never
  // collides with the PTY/gateway JWT bearer tokens (verified elsewhere).
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice('Bearer '.length).trim();
    if (bearer.startsWith(PAT_PREFIX)) {
      const patUser = await getUserForApiToken(env, bearer);
      if (patUser) {
        return { user: patUser, isAuthenticated: true, method: 'pat' };
      }
      // Malformed/expired/revoked PAT: fail closed (don't fall through to other modes).
      return { user: null, isAuthenticated: false };
    }
  }

  // Try Cloudflare Access first (production mode)
  if (env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) {
    return authenticateWithCfAccеss(request, env);
  }

  // Fall back to dev auth if enabled. Dev-auth is header-spoofable, and on
  // desktop a process inside the sandbox VM can reach the control plane — so when
  // a per-boot SURFACE_TOKEN is provisioned, only honor dev-auth for requests
  // from the trusted host frontend (matching X-Orcabot-Surface). No token
  // (cloud, local dev, older builds) = unchanged behavior.
  const devAuthEnabled = env.DEV_AUTH_ENABLED === 'true';
  if (devAuthEnabled && devAuthSurfaceTrusted(request, env)) {
    return authenticateDevMоde(request, env);
  }

  // No auth method available
  return { user: null, isAuthenticated: false };
}

/**
 * Desktop trust boundary: dev-auth is header-spoofable and the sandbox VM can
 * reach the control plane. When a per-boot SURFACE_TOKEN is provisioned, only
 * the host frontend (which sends the matching X-Orcabot-Surface header) may use
 * dev-auth. When unset (cloud / local dev / older builds), enforcement is off.
 */
export function devAuthSurfaceTrusted(request: Request, env: Env): boolean {
  const expected = env.SURFACE_TOKEN;
  if (!expected) return true;
  // Header for fetch/XHR; query param for top-level browser navigations (OAuth
  // connect opened in the OS browser), which can't set custom headers.
  const got =
    request.headers.get('X-Orcabot-Surface') ||
    new URL(request.url).searchParams.get('surface');
  return got === expected;
}

// Production: Cloudflare Access JWT validation
async function authenticateWithCfAccеss(
  request: Request,
  env: Env
): Promise<AuthContext> {
  const identity = await validateCfAccessTоken(request, env);

  if (!identity) {
    return { user: null, isAuthenticated: false };
  }

  const userId = cfAccessUserIdFrоmSub(identity.sub);

  // Check if user exists in DB
  interface DbUser {
    id: string;
    email: string;
    name: string;
    created_at: string;
    trial_started_at: string | null;
  }
  const dbUser = await env.DB.prepare(`
    SELECT id, email, name, created_at, trial_started_at FROM users WHERE id = ?
  `).bind(userId).first<DbUser>();

  let user: User | null = dbUser ? {
    id: dbUser.id,
    email: dbUser.email,
    name: dbUser.name,
    createdAt: dbUser.trial_started_at || dbUser.created_at,
  } : null;

  // Auto-create user on first login
  if (!user) {
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO users (id, email, name, created_at, trial_started_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(userId, identity.email, identity.name || identity.email.split('@')[0], now, now).run();

    user = {
      id: userId,
      email: identity.email,
      name: identity.name || identity.email.split('@')[0],
      createdAt: now,
    };
  }

  return {
    user,
    isAuthenticated: true,
    method: 'cf-access',
  };
}

// Development: Header-based auth (simplified)
async function authenticateDevMоde(
  request: Request,
  env: Env
): Promise<AuthContext> {
  // Check for user ID in header (development mode)
  let userId = request.headers.get('X-User-ID');
  let userEmail = request.headers.get('X-User-Email');
  let userName = request.headers.get('X-User-Name');

  // For WebSocket connections, also check query parameters
  // (browsers can't set custom headers on WebSocket requests)
  if (!userId) {
    const url = new URL(request.url);
    userId = url.searchParams.get('user_id');
    userEmail = url.searchParams.get('user_email');
    userName = url.searchParams.get('user_name');
  }

  if (!userId) {
    return { user: null, isAuthenticated: false };
  }

  // Check if user exists in DB
  interface DbUser {
    id: string;
    email: string;
    name: string;
    created_at: string;
    trial_started_at: string | null;
  }
  const dbUser = await env.DB.prepare(`
    SELECT id, email, name, created_at, trial_started_at FROM users WHERE id = ?
  `).bind(userId).first<DbUser>();

  let user: User | null = dbUser ? {
    id: dbUser.id,
    email: dbUser.email,
    name: dbUser.name,
    createdAt: dbUser.trial_started_at || dbUser.created_at,
  } : null;

  // Auto-create user if not exists (development mode)
  if (!user && userEmail) {
    // Check if a user with this email already exists under a different ID
    // (can happen when the client-side ID generation changes between versions)
    const existingByEmail = await env.DB.prepare(`
      SELECT id, email, name, created_at, trial_started_at FROM users WHERE email = ?
    `).bind(userEmail).first<DbUser>();

    if (existingByEmail) {
      user = {
        id: existingByEmail.id,
        email: existingByEmail.email,
        name: existingByEmail.name,
        createdAt: existingByEmail.trial_started_at || existingByEmail.created_at,
      };
    } else {
      const now = new Date().toISOString();
      await env.DB.prepare(`
        INSERT INTO users (id, email, name, created_at, trial_started_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(userId, userEmail, userName || 'Anonymous', now, now).run();

      user = {
        id: userId,
        email: userEmail,
        name: userName || 'Anonymous',
        createdAt: now,
      };
    }
  }

  if (!user) {
    return { user: null, isAuthenticated: false };
  }

  return {
    user,
    isAuthenticated: true,
    method: 'dev',
  };
}

// Middleware to require authentication
export function requireAuth(ctx: AuthContext): Response | null {
  if (!ctx.isAuthenticated || !ctx.user) {
    return Response.json(
      { error: 'E79401: Authentication required' },
      { status: 401 }
    );
  }
  return null;
}

// Reject requests authenticated by a PAT. Token management (mint/list/revoke)
// must be done with a real session (browser/CF Access) or dev auth — never with a
// PAT, or a leaked token could mint a replacement and survive its own revocation.
export function rejectPatAuth(ctx: AuthContext): Response | null {
  if (ctx.method === 'pat') {
    return Response.json(
      { error: 'E79411: Personal access tokens cannot manage tokens — use the web app' },
      { status: 403 }
    );
  }
  return null;
}

// Validate internal API token for service-to-service calls
export function requireInternalAuth(
  request: Request,
  env: Env
): Response | null {
  const token = request.headers.get('X-Internal-Token');

  if (!env.INTERNAL_API_TOKEN) {
    // If no token configured, reject all internal requests
    return Response.json(
      { error: 'E79402: Internal API not configured' },
      { status: 503 }
    );
  }

  if (!token || !constantTimeEqual(token, env.INTERNAL_API_TOKEN)) {
    const url = new URL(request.url);
    const got = tokenFingerprint(token);
    const want = tokenFingerprint(env.INTERNAL_API_TOKEN);
    console.error(`[requireInternalAuth] REJECT ${request.method} ${url.pathname} - token mismatch (got ${got}, want ${want})`);
    return Response.json(
      { error: 'E79403: Invalid internal token' },
      { status: 401 }
    );
  }

  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function tokenFingerprint(token: string | null): string {
  if (!token) return '(none)';
  const n = token.length;
  if (n <= 8) return `${token}(len=${n})`;
  return `prefix=${token.slice(0, 4)} suffix=${token.slice(-4)} len=${n}`;
}

import { verifyDashboardToken, type DashboardTokenClaims } from './dashboard-token';

export interface McpAuthResult {
  isValid: boolean;
  isFullAccess: boolean; // true if X-Internal-Token (full trust), false if X-Dashboard-Token (scoped)
  dashboardId?: string;  // Only present if scoped token
  sessionId?: string;    // Only present if scoped token
  error?: Response;
}

/**
 * Validate MCP proxy authentication
 * Accepts either:
 * - X-Internal-Token: Full trust (schedules, internal services)
 * - X-Dashboard-Token: Scoped to specific dashboard (sandbox MCP proxy)
 */
export async function validateMcpAuth(
  request: Request,
  env: Env
): Promise<McpAuthResult> {
  // First, check for full internal token
  const internalToken = request.headers.get('X-Internal-Token');
  if (internalToken) {
    if (!env.INTERNAL_API_TOKEN) {
      return {
        isValid: false,
        isFullAccess: false,
        error: Response.json(
          { error: 'E79402: Internal API not configured' },
          { status: 503 }
        ),
      };
    }
    if (constantTimeEqual(internalToken, env.INTERNAL_API_TOKEN)) {
      return { isValid: true, isFullAccess: true };
    }
  }

  // Check for dashboard-scoped token
  const dashboardToken = request.headers.get('X-Dashboard-Token');
  if (dashboardToken) {
    // Require INTERNAL_API_TOKEN to be configured - prevents forging with empty secret
    if (!env.INTERNAL_API_TOKEN) {
      return {
        isValid: false,
        isFullAccess: false,
        error: Response.json(
          { error: 'E79402: Internal API not configured' },
          { status: 503 }
        ),
      };
    }
    const claims = await verifyDashboardToken(dashboardToken, env.INTERNAL_API_TOKEN);
    if (claims) {
      return {
        isValid: true,
        isFullAccess: false,
        dashboardId: claims.dashboard_id,
        sessionId: claims.session_id,
      };
    }
  }

  // No valid token
  return {
    isValid: false,
    isFullAccess: false,
    error: Response.json(
      { error: 'E79403: Invalid or missing MCP token' },
      { status: 401 }
    ),
  };
}
