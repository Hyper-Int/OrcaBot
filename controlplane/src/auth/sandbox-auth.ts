// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: sandbox-auth-v1-dashboard-scoped
const MODULE_REVISION = 'sandbox-auth-v1-dashboard-scoped';
console.log(`[sandbox-auth] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Authentication for sandbox → control plane `/internal/*` calls.
 *
 * Every sandbox VM is root-readable by its own user, so any credential it holds
 * must only open that VM's own dashboard. A VM authenticates with the
 * dashboard-scoped token (X-Dashboard-Token) it receives at session creation,
 * and each route checks that the resource it touches belongs to that dashboard.
 *
 * X-Internal-Token (INTERNAL_API_TOKEN) remains full trust for control-plane-side
 * callers. VMs are weaned off it; once WITHHOLD_INTERNAL_TOKEN_FROM_SANDBOX is set
 * new VMs no longer receive it at all.
 */

import type { Env } from '../types';
import { requireInternalAuth } from './middleware';
import { createDashboardToken, verifyDashboardToken } from './dashboard-token';
import { tokenSigningSecret } from './pty-token';

export type SandboxAuth =
  | { kind: 'full' }
  | { kind: 'dashboard'; dashboardId: string };

/**
 * Accepts X-Internal-Token (full trust) or X-Dashboard-Token (scoped to one dashboard).
 */
export async function authenticateSandbox(request: Request, env: Env): Promise<SandboxAuth | Response> {
  if (request.headers.get('X-Internal-Token')) {
    const err = requireInternalAuth(request, env);
    return err ?? { kind: 'full' };
  }

  const dashboardToken = request.headers.get('X-Dashboard-Token');
  if (dashboardToken) {
    const claims = await verifyDashboardToken(dashboardToken, tokenSigningSecret(env));
    if (claims) {
      return { kind: 'dashboard', dashboardId: claims.dashboard_id };
    }
  }

  const url = new URL(request.url);
  console.warn(`[sandbox-auth] REJECT ${request.method} ${url.pathname} - missing or invalid sandbox credential`);
  return Response.json({ error: 'E79393: Invalid or missing sandbox credential' }, { status: 401 });
}

/**
 * Full-trust callers pass. Dashboard-scoped callers pass only when the resource's
 * dashboard is known and matches the credential.
 */
export function requireSandboxDashboard(
  auth: SandboxAuth,
  dashboardId: string | null | undefined,
  request: Request
): Response | null {
  if (auth.kind === 'full') return null;
  if (dashboardId && dashboardId === auth.dashboardId) return null;
  const url = new URL(request.url);
  console.warn(`[sandbox-auth] REJECT ${request.method} ${url.pathname} - credential for dashboard ${auth.dashboardId} used against ${dashboardId || '(unknown)'}`);
  return Response.json({ error: 'E79394: Sandbox credential is not valid for this dashboard' }, { status: 403 });
}

/**
 * Authenticate and scope-check in one step.
 */
export async function authorizeSandboxForDashboard(
  request: Request,
  env: Env,
  dashboardId: string | null | undefined
): Promise<Response | null> {
  const auth = await authenticateSandbox(request, env);
  if (auth instanceof Response) return auth;
  return requireSandboxDashboard(auth, dashboardId, request);
}

/**
 * Resolve the dashboard that owns a sandbox session id.
 */
export async function dashboardIdForSandboxSession(env: Env, sandboxSessionId: string): Promise<string | null> {
  if (!sandboxSessionId) return null;
  const session = await env.DB.prepare(
    'SELECT dashboard_id FROM sessions WHERE sandbox_session_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(sandboxSessionId).first<{ dashboard_id: string }>();
  if (session?.dashboard_id) return session.dashboard_id;
  const sandbox = await env.DB.prepare(
    'SELECT dashboard_id FROM dashboard_sandboxes WHERE sandbox_session_id = ?'
  ).bind(sandboxSessionId).first<{ dashboard_id: string }>();
  return sandbox?.dashboard_id ?? null;
}

/**
 * Resolve the dashboard that owns a schedule execution (null for recipe schedules
 * that have no dashboard — those are only reachable with full trust).
 */
export async function dashboardIdForScheduleExecution(env: Env, executionId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT s.dashboard_id AS dashboard_id FROM schedule_executions e JOIN schedules s ON s.id = e.schedule_id WHERE e.id = ?'
  ).bind(executionId).first<{ dashboard_id: string | null }>();
  return row?.dashboard_id ?? null;
}

/**
 * Env vars for a new sandbox VM carrying INTERNAL_API_TOKEN — omitted once
 * WITHHOLD_INTERNAL_TOKEN_FROM_SANDBOX=true, after which the VM authenticates
 * only with its dashboard token.
 */
export function sandboxInternalTokenEnv(env: Env): Record<string, string> {
  if (env.WITHHOLD_INTERNAL_TOKEN_FROM_SANDBOX === 'true') return {};
  return { INTERNAL_API_TOKEN: env.INTERNAL_API_TOKEN || '' };
}

/**
 * POST /internal/sandbox/dashboard-token/refresh
 *
 * Sandbox sessions are created once per dashboard and live as long as the VM,
 * which can outlast the 7-day token. The sandbox exchanges its token for a fresh
 * one before it expires. A token that expired while the VM was suspended is still
 * accepted here for REFRESH_EXPIRED_GRACE_SECONDS. Only dashboard tokens are
 * accepted, and only while the dashboard still exists.
 */
const REFRESH_EXPIRED_GRACE_SECONDS = 30 * 24 * 60 * 60;

export async function refreshSandboxDashboardToken(request: Request, env: Env): Promise<Response> {
  const presented = request.headers.get('X-Dashboard-Token');
  const claims = presented
    ? await verifyDashboardToken(presented, tokenSigningSecret(env), REFRESH_EXPIRED_GRACE_SECONDS)
    : null;
  if (!claims) {
    console.warn('[sandbox-auth] refresh denied: missing or invalid dashboard token');
    return Response.json({ error: 'E79395: A valid dashboard token is required to refresh' }, { status: 401 });
  }

  const dashboard = await env.DB.prepare('SELECT id FROM dashboards WHERE id = ?')
    .bind(claims.dashboard_id).first<{ id: string }>();
  if (!dashboard) {
    console.warn(`[sandbox-auth] refresh denied: dashboard ${claims.dashboard_id} no longer exists`);
    return Response.json({ error: 'E79396: Dashboard not found' }, { status: 404 });
  }

  const token = await createDashboardToken(claims.dashboard_id, tokenSigningSecret(env));
  return Response.json({ token, revision: MODULE_REVISION });
}
