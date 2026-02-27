// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-handler-v5-pending-recovery-and-safe-revoke-rollback
console.log(`[egress] REVISION: egress-handler-v5-pending-recovery-and-safe-revoke-rollback loaded at ${new Date().toISOString()}`);

/**
 * Egress Proxy Management
 *
 * Handles user approval flow for network egress:
 * 1. User sees toast when unknown domain is held
 * 2. User clicks Allow Once / Always Allow / Deny
 * 3. Control plane stores "always" decisions in D1
 * 4. Control plane forwards decision to sandbox proxy
 *
 * Also provides internal endpoints for sandbox to load persisted allowlist on startup.
 */

import type { Env } from '../types';
import { sandboxHeaders, sandboxUrl } from '../sandbox/fetch';

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

// ============================================
// User-facing endpoints (authenticated)
// ============================================

/**
 * POST /api/dashboards/:id/egress/approve
 * User decision on a held egress connection.
 */
export async function handleApproveEgress(
  request: Request,
  env: Env,
  dashboardId: string,
  userId: string,
): Promise<Response> {
  const body = await request.json() as {
    domain?: string;
    decision?: string;
    port?: number;
    request_id?: string;
  };

  if (!body.domain || !body.decision) {
    return Response.json({ error: 'E79870: domain and decision required' }, { status: 400 });
  }
  if (!body.request_id) {
    return Response.json({ error: 'E79878: request_id required' }, { status: 400 });
  }

  const normalizedDomain = body.domain.trim().toLowerCase();

  const validDecisions = ['allow_once', 'allow_always', 'deny'];
  if (!validDecisions.includes(body.decision)) {
    return Response.json({ error: 'E79871: invalid decision' }, { status: 400 });
  }

  // Forward decision to sandbox first. Persist only after sandbox accepts.
  const sandbox = await env.DB.prepare(
    `SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?`
  ).bind(dashboardId).first<{ sandbox_session_id: string; sandbox_machine_id: string }>();

  if (!sandbox) {
    return Response.json(
      { error: 'E79879: no active sandbox to forward decision to' },
      { status: 409 },
    );
  }

  try {
    const approveUrl = sandboxUrl(env, '/egress/approve');
    const headers = sandboxHeaders(env, undefined, sandbox.sandbox_machine_id || undefined);
    headers.set('Content-Type', 'application/json');

    const resp = await fetch(approveUrl.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        domain: normalizedDomain,
        request_id: body.request_id,
        decision: body.decision,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.log(`[egress] Sandbox approve returned ${resp.status} for ${normalizedDomain} dashboardId=${dashboardId}: ${errText}`);
      return Response.json(
        { error: `E79874: sandbox rejected decision (${resp.status})`, detail: errText },
        { status: 502 },
      );
    }
  } catch (err) {
    console.log(`[egress] Failed to forward decision to sandbox dashboardId=${dashboardId}: ${err}`);
    return Response.json(
      { error: `E79875: failed to reach sandbox`, detail: String(err) },
      { status: 502 },
    );
  }

  // If "always allow", persist to D1 only after sandbox accepted the decision.
  if (body.decision === 'allow_always') {
    const entryId = generateId();
    await env.DB.prepare(`
      INSERT INTO egress_allowlist (id, dashboard_id, domain, created_by, created_at)
      SELECT ?, ?, ?, ?, datetime('now')
      WHERE NOT EXISTS (
        SELECT 1 FROM egress_allowlist
        WHERE dashboard_id = ? AND domain = ? AND revoked_at IS NULL
      )
    `).bind(entryId, dashboardId, normalizedDomain, userId, dashboardId, normalizedDomain).run();
  }

  // Log the decision after successful sandbox forward.
  const auditPort = body.port ?? 443;
  const auditId = generateId();
  await env.DB.prepare(`
    INSERT INTO egress_audit_log (id, dashboard_id, domain, port, decision, decided_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(auditId, dashboardId, normalizedDomain, auditPort, body.decision, userId).run();

  return Response.json({ ok: true });
}

/**
 * GET /api/dashboards/:id/egress/allowlist
 * List default + user-approved domains for a dashboard.
 */
export async function handleListEgressAllowlist(
  request: Request,
  env: Env,
  dashboardId: string,
): Promise<Response> {
  const entries = await env.DB.prepare(`
    SELECT id, domain, created_by, created_at
    FROM egress_allowlist
    WHERE dashboard_id = ? AND revoked_at IS NULL
    ORDER BY created_at ASC
  `).bind(dashboardId).all();

  return Response.json({
    entries: entries.results || [],
  });
}

/**
 * GET /api/dashboards/:id/egress/pending
 * List currently pending egress approvals from the sandbox proxy.
 */
export async function handleListPendingEgress(
  request: Request,
  env: Env,
  dashboardId: string,
): Promise<Response> {
  const sandbox = await env.DB.prepare(
    `SELECT sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?`
  ).bind(dashboardId).first<{ sandbox_machine_id: string }>();

  if (!sandbox) {
    return Response.json({ pending: [] });
  }

  try {
    const pendingUrl = sandboxUrl(env, '/egress/pending');
    const headers = sandboxHeaders(env, undefined, sandbox.sandbox_machine_id || undefined);
    const resp = await fetch(pendingUrl.toString(), {
      method: 'GET',
      headers,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.log(`[egress] Sandbox pending returned ${resp.status} dashboardId=${dashboardId}: ${errText}`);
      return Response.json(
        { error: `E79880: sandbox pending lookup failed (${resp.status})`, detail: errText },
        { status: 502 },
      );
    }

    const body = await resp.json() as { pending?: Array<{ domain: string; port: number; request_id: string }> };
    return Response.json({ pending: body.pending || [] });
  } catch (err) {
    console.log(`[egress] Failed to fetch pending approvals from sandbox dashboardId=${dashboardId}: ${err}`);
    return Response.json(
      { error: 'E79881: failed to reach sandbox pending endpoint', detail: String(err) },
      { status: 502 },
    );
  }
}

/**
 * DELETE /api/dashboards/:id/egress/allowlist/:entryId
 * Revoke a user-approved domain.
 */
export async function handleRevokeEgressDomain(
  request: Request,
  env: Env,
  dashboardId: string,
  entryId: string,
): Promise<Response> {
  // Look up the domain before revoking so we can forward to sandbox
  const entry = await env.DB.prepare(`
    SELECT domain FROM egress_allowlist
    WHERE id = ? AND dashboard_id = ? AND revoked_at IS NULL
  `).bind(entryId, dashboardId).first<{ domain: string }>();

  if (!entry) {
    return Response.json({ error: 'E79872: entry not found' }, { status: 404 });
  }

  const activeRows = await env.DB.prepare(`
    SELECT id FROM egress_allowlist
    WHERE dashboard_id = ? AND domain = ? AND revoked_at IS NULL
  `).bind(dashboardId, entry.domain).all<{ id: string }>();
  const activeIds = (activeRows.results || []).map((row) => row.id);
  if (activeIds.length === 0) {
    return Response.json({ error: 'E79872: entry not found' }, { status: 404 });
  }

  const revokedAt = new Date().toISOString();
  const idPlaceholders = placeholders(activeIds.length);

  // Revoke all active rows for the same domain to clean up legacy duplicates.
  await env.DB.prepare(`
    UPDATE egress_allowlist
    SET revoked_at = ?
    WHERE id IN (${idPlaceholders}) AND revoked_at IS NULL
  `).bind(revokedAt, ...activeIds).run();

  // Forward revocation to sandbox so runtime allowlist is updated
  const sandbox = await env.DB.prepare(
    `SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?`
  ).bind(dashboardId).first<{ sandbox_session_id: string; sandbox_machine_id: string }>();

  if (sandbox) {
    try {
      const revokeUrl = sandboxUrl(env, '/egress/revoke');
      const headers = sandboxHeaders(env, undefined, sandbox.sandbox_machine_id || undefined);
      headers.set('Content-Type', 'application/json');

      const resp = await fetch(revokeUrl.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify({ domain: entry.domain }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.log(`[egress] Sandbox revoke returned ${resp.status} for ${entry.domain} dashboardId=${dashboardId}: ${errText}`);
        // Roll back D1 so state stays consistent
        await env.DB.prepare(`
          UPDATE egress_allowlist SET revoked_at = NULL
          WHERE id IN (${idPlaceholders}) AND revoked_at = ?
        `).bind(...activeIds, revokedAt).run();
        return Response.json(
          { error: `E79876: sandbox rejected revocation (${resp.status})`, detail: errText },
          { status: 502 },
        );
      }
    } catch (err) {
      console.log(`[egress] Failed to forward revocation to sandbox dashboardId=${dashboardId}: ${err}`);
      // Roll back D1 so state stays consistent
      await env.DB.prepare(`
        UPDATE egress_allowlist SET revoked_at = NULL
        WHERE id IN (${idPlaceholders}) AND revoked_at = ?
      `).bind(...activeIds, revokedAt).run();
      return Response.json(
        { error: 'E79877: failed to reach sandbox', detail: String(err) },
        { status: 502 },
      );
    }
  }

  return Response.json({ ok: true });
}

/**
 * GET /api/dashboards/:id/egress/audit
 * List recent egress audit log entries.
 */
export async function handleListEgressAudit(
  request: Request,
  env: Env,
  dashboardId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);

  const entries = await env.DB.prepare(`
    SELECT id, domain, port, decision, decided_by, created_at
    FROM egress_audit_log
    WHERE dashboard_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(dashboardId, limit).all();

  return Response.json({
    entries: entries.results || [],
  });
}

// ============================================
// Internal endpoints (sandbox → controlplane)
// ============================================

/**
 * GET /internal/dashboards/:id/egress/allowlist
 * Sandbox loads persisted allowlist on startup.
 */
export async function handleInternalGetAllowlist(
  request: Request,
  env: Env,
  dashboardId: string,
): Promise<Response> {
  const entries = await env.DB.prepare(`
    SELECT domain FROM egress_allowlist
    WHERE dashboard_id = ? AND revoked_at IS NULL
  `).bind(dashboardId).all<{ domain: string }>();

  return Response.json({
    domains: (entries.results || []).map(e => e.domain),
  });
}

/**
 * POST /internal/dashboards/:id/egress/audit
 * Sandbox reports runtime egress decisions not captured by user actions.
 */
export async function handleInternalLogAudit(
  request: Request,
  env: Env,
  dashboardId: string,
): Promise<Response> {
  const body = await request.json() as {
    domain?: string;
    port?: number;
    decision?: string;
    decided_by?: string | null;
  };

  const domain = body.domain?.trim().toLowerCase();
  const port: number = Number.isInteger(body.port) ? body.port! : 0;
  const decision = body.decision?.trim();
  const validDecisions = new Set(['allowed', 'denied', 'timeout', 'default_allowed', 'allow_once', 'allow_always', 'deny']);

  if (!domain || !decision || !validDecisions.has(decision) || port <= 0 || port > 65535) {
    return Response.json({ error: 'E79882: invalid audit payload' }, { status: 400 });
  }

  const auditId = generateId();
  await env.DB.prepare(`
    INSERT INTO egress_audit_log (id, dashboard_id, domain, port, decision, decided_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(auditId, dashboardId, domain, port, decision, body.decided_by ?? null).run();

  return Response.json({ ok: true });
}
