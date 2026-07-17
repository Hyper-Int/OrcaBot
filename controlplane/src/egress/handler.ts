// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-handler-v9-deny-always
console.log(`[egress] REVISION: egress-handler-v9-deny-always loaded at ${new Date().toISOString()}`);

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
import egressDefaultsCatalog from '../../../sandbox/internal/egress/defaults.json';

type EgressDefaultEntry = {
  pattern: string;
  category: string;
  label: string;
  rationale: string;
};

const CANONICAL_DEFAULTS = (egressDefaultsCatalog.defaults as EgressDefaultEntry[]).map((entry) => ({
  ...entry,
  pattern: entry.pattern.trim().toLowerCase(),
}));

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

  const validDecisions = ['allow_once', 'allow_always', 'deny', 'deny_always'];
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

  // If "always allow", persist to the allowlist only after sandbox accepted.
  // Bug-hunt round 2: a concurrent allow_always + deny_always (two collaborators
  // resolving the same toast) could leave the domain active in BOTH lists; later
  // lifting the deny then silently re-allowed it. Guard the insert with NOT EXISTS
  // an active blocklist row (deny precedence at write time). Because SQLite/D1
  // serializes writes, this + the atomic deny batch below make the two mutually
  // exclusive: whichever commits first excludes the other.
  if (body.decision === 'allow_always') {
    const entryId = generateId();
    await env.DB.prepare(`
      INSERT INTO egress_allowlist (id, dashboard_id, domain, created_by, created_at)
      SELECT ?, ?, ?, ?, datetime('now')
      WHERE NOT EXISTS (
        SELECT 1 FROM egress_allowlist
        WHERE dashboard_id = ? AND domain = ? AND revoked_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM egress_blocklist
        WHERE dashboard_id = ? AND domain = ? AND revoked_at IS NULL
      )
    `).bind(
      entryId, dashboardId, normalizedDomain, userId,
      dashboardId, normalizedDomain,
      dashboardId, normalizedDomain,
    ).run();
  }

  // If "deny always", persist to the blocklist and revoke any conflicting allowlist
  // entry for the same domain so the deny is unambiguous (deny wins). Run the
  // revoke-allow + insert-block as one atomic batch so a racing allow_always can
  // never observe a half-applied deny.
  if (body.decision === 'deny_always') {
    const entryId = generateId();
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE egress_allowlist SET revoked_at = datetime('now')
        WHERE dashboard_id = ? AND domain = ? AND revoked_at IS NULL
      `).bind(dashboardId, normalizedDomain),
      env.DB.prepare(`
        INSERT INTO egress_blocklist (id, dashboard_id, domain, created_by, created_at)
        SELECT ?, ?, ?, ?, datetime('now')
        WHERE NOT EXISTS (
          SELECT 1 FROM egress_blocklist
          WHERE dashboard_id = ? AND domain = ? AND revoked_at IS NULL
        )
      `).bind(entryId, dashboardId, normalizedDomain, userId, dashboardId, normalizedDomain),
    ]);
  }

  // Log the decision after successful sandbox forward.
  // The audit_log CHECK constraint predates "deny_always"; record it as "deny"
  // (the persistent blocklist row above is the durable record of the "always").
  const auditPort = body.port ?? 443;
  const auditDecision = body.decision === 'deny_always' ? 'deny' : body.decision;
  const auditId = generateId();
  await env.DB.prepare(`
    INSERT INTO egress_audit_log (id, dashboard_id, domain, port, decision, decided_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(auditId, dashboardId, normalizedDomain, auditPort, auditDecision, userId).run();

  return Response.json({ ok: true });
}

/**
 * GET /api/dashboards/:id/egress/allowlist
 * List canonical defaults, blocked overrides, and user-approved domains for a dashboard.
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

  const blockedRows = await env.DB.prepare(`
    SELECT pattern FROM egress_blocked_defaults
    WHERE dashboard_id = ?
      AND revoked_at IS NULL
    ORDER BY created_at ASC
  `).bind(dashboardId).all<{ pattern: string }>();

  const denied = await env.DB.prepare(`
    SELECT id, domain, created_by, created_at
    FROM egress_blocklist
    WHERE dashboard_id = ? AND revoked_at IS NULL
    ORDER BY created_at ASC
  `).bind(dashboardId).all();

  return Response.json({
    entries: entries.results || [],
    defaults: CANONICAL_DEFAULTS,
    blocked: (blockedRows.results || []).map((row) => row.pattern),
    denied: denied.results || [],
    revision: egressDefaultsCatalog.revision,
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
 * DELETE /api/dashboards/:id/egress/blocklist/:entryId
 * Lift a permanent deny ("deny always") so the domain requires approval again.
 */
export async function handleRevokeEgressDenied(
  request: Request,
  env: Env,
  dashboardId: string,
  entryId: string,
): Promise<Response> {
  const entry = await env.DB.prepare(`
    SELECT domain FROM egress_blocklist
    WHERE id = ? AND dashboard_id = ? AND revoked_at IS NULL
  `).bind(entryId, dashboardId).first<{ domain: string }>();

  if (!entry) {
    return Response.json({ error: 'E79883: entry not found' }, { status: 404 });
  }

  const activeRows = await env.DB.prepare(`
    SELECT id FROM egress_blocklist
    WHERE dashboard_id = ? AND domain = ? AND revoked_at IS NULL
  `).bind(dashboardId, entry.domain).all<{ id: string }>();
  const activeIds = (activeRows.results || []).map((row) => row.id);
  if (activeIds.length === 0) {
    return Response.json({ error: 'E79883: entry not found' }, { status: 404 });
  }

  const revokedAt = new Date().toISOString();
  const idPlaceholders = placeholders(activeIds.length);

  await env.DB.prepare(`
    UPDATE egress_blocklist
    SET revoked_at = ?
    WHERE id IN (${idPlaceholders}) AND revoked_at IS NULL
  `).bind(revokedAt, ...activeIds).run();

  // Forward to sandbox so the runtime deny set is cleared (same endpoint as
  // allowlist revoke — it clears both allow and deny entries for the domain).
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
        console.log(`[egress] Sandbox un-deny returned ${resp.status} for ${entry.domain} dashboardId=${dashboardId}: ${errText}`);
        await env.DB.prepare(`
          UPDATE egress_blocklist SET revoked_at = NULL
          WHERE id IN (${idPlaceholders}) AND revoked_at = ?
        `).bind(...activeIds, revokedAt).run();
        return Response.json(
          { error: `E79884: sandbox rejected un-deny (${resp.status})`, detail: errText },
          { status: 502 },
        );
      }
    } catch (err) {
      console.log(`[egress] Failed to forward un-deny to sandbox dashboardId=${dashboardId}: ${err}`);
      await env.DB.prepare(`
        UPDATE egress_blocklist SET revoked_at = NULL
        WHERE id IN (${idPlaceholders}) AND revoked_at = ?
      `).bind(...activeIds, revokedAt).run();
      return Response.json(
        { error: 'E79885: failed to reach sandbox', detail: String(err) },
        { status: 502 },
      );
    }
  }

  return Response.json({ ok: true });
}

/**
 * POST /api/dashboards/:id/egress/blocked-defaults
 * Override a built-in default pattern so it requires approval again.
 */
export async function handleBlockDefault(
  request: Request,
  env: Env,
  dashboardId: string,
  userId: string,
): Promise<Response> {
  const body = await request.json() as { pattern?: string };
  const normalizedPattern = body.pattern?.trim().toLowerCase();
  if (!normalizedPattern) {
    return Response.json({ error: 'E79895: pattern required' }, { status: 400 });
  }
  if (!CANONICAL_DEFAULTS.some((entry) => entry.pattern === normalizedPattern)) {
    return Response.json({ error: 'E79896: unknown built-in pattern' }, { status: 400 });
  }

  const entryId = generateId();
  const existing = await env.DB.prepare(`
    SELECT id, revoked_at FROM egress_blocked_defaults
    WHERE dashboard_id = ? AND pattern = ?
  `).bind(dashboardId, normalizedPattern).first<{ id: string; revoked_at: string | null }>();

  let rollbackMode: 'none' | 'revoke' | 'restore-revoked-at' = 'none';
  let rollbackId = '';
  let rollbackRevokedAt: string | null = null;

  if (!existing) {
    const insertResult = await env.DB.prepare(`
      INSERT INTO egress_blocked_defaults (id, dashboard_id, pattern, created_by, created_at, revoked_at)
      VALUES (?, ?, ?, ?, datetime('now'), NULL)
    `).bind(entryId, dashboardId, normalizedPattern, userId).run();
    if (insertResult.meta.changes > 0) {
      rollbackMode = 'revoke';
      rollbackId = entryId;
    }
  } else if (existing.revoked_at !== null) {
    const updateResult = await env.DB.prepare(`
      UPDATE egress_blocked_defaults
      SET revoked_at = NULL
      WHERE id = ? AND revoked_at = ?
    `).bind(existing.id, existing.revoked_at).run();
    if (updateResult.meta.changes > 0) {
      rollbackMode = 'restore-revoked-at';
      rollbackId = existing.id;
      rollbackRevokedAt = existing.revoked_at;
    }
  }

  const sandbox = await env.DB.prepare(
    `SELECT sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?`
  ).bind(dashboardId).first<{ sandbox_machine_id: string }>();

  if (sandbox) {
    try {
      const blockUrl = sandboxUrl(env, '/egress/block-default');
      const headers = sandboxHeaders(env, undefined, sandbox.sandbox_machine_id || undefined);
      headers.set('Content-Type', 'application/json');
      const resp = await fetch(blockUrl.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify({ pattern: normalizedPattern }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.log(`[egress] Sandbox block-default returned ${resp.status} pattern=${normalizedPattern} dashboardId=${dashboardId}: ${errText}`);
        await rollbackBlockedDefaultChange(env, rollbackMode, rollbackId, rollbackRevokedAt, normalizedPattern, dashboardId);
        return Response.json(
          { error: `E79897: sandbox rejected block-default (${resp.status})`, detail: errText },
          { status: 502 },
        );
      }
    } catch (err) {
      console.log(`[egress] Failed to forward block-default to sandbox dashboardId=${dashboardId}: ${err}`);
      await rollbackBlockedDefaultChange(env, rollbackMode, rollbackId, rollbackRevokedAt, normalizedPattern, dashboardId);
      return Response.json(
        { error: 'E79898: failed to reach sandbox', detail: String(err) },
        { status: 502 },
      );
    }
  }

  return new Response(null, { status: 204 });
}

/**
 * DELETE /api/dashboards/:id/egress/blocked-defaults/:pattern
 * Restore a built-in default pattern.
 */
export async function handleUnblockDefault(
  request: Request,
  env: Env,
  dashboardId: string,
  pattern: string,
): Promise<Response> {
  const normalizedPattern = pattern.trim().toLowerCase();
  const existing = await env.DB.prepare(`
    SELECT id FROM egress_blocked_defaults
    WHERE dashboard_id = ? AND pattern = ?
      AND revoked_at IS NULL
  `).bind(dashboardId, normalizedPattern).first<{ id: string }>();

  if (!existing) {
    return new Response(null, { status: 204 });
  }

  const revokedAt = new Date().toISOString();

  await env.DB.prepare(`
    UPDATE egress_blocked_defaults
    SET revoked_at = ?
    WHERE id = ? AND revoked_at IS NULL
  `).bind(revokedAt, existing.id).run();

  const sandbox = await env.DB.prepare(
    `SELECT sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?`
  ).bind(dashboardId).first<{ sandbox_machine_id: string }>();

  if (sandbox) {
    try {
      const unblockUrl = sandboxUrl(env, `/egress/block-default/${encodeURIComponent(normalizedPattern)}`);
      const headers = sandboxHeaders(env, undefined, sandbox.sandbox_machine_id || undefined);
      const resp = await fetch(unblockUrl.toString(), {
        method: 'DELETE',
        headers,
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        await env.DB.prepare(`
          UPDATE egress_blocked_defaults
          SET revoked_at = NULL
          WHERE id = ? AND revoked_at = ?
        `).bind(existing.id, revokedAt).run();
        return Response.json(
          { error: `E79899: sandbox rejected unblock-default (${resp.status})`, detail: errText },
          { status: 502 },
        );
      }
    } catch (err) {
      await env.DB.prepare(`
        UPDATE egress_blocked_defaults
        SET revoked_at = NULL
        WHERE id = ? AND revoked_at = ?
      `).bind(existing.id, revokedAt).run();
      return Response.json(
        { error: 'E79900: failed to reach sandbox', detail: String(err) },
        { status: 502 },
      );
    }
  }

  return new Response(null, { status: 204 });
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
  // parseInt('abc') → NaN, which binds non-finite into D1 → 500. Guard it.
  const parsedLimit = parseInt(url.searchParams.get('limit') || '50', 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 50;

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
 * Sandbox loads persisted allowlist state on startup.
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

  const blockedRows = await env.DB.prepare(`
    SELECT pattern FROM egress_blocked_defaults
    WHERE dashboard_id = ?
      AND revoked_at IS NULL
  `).bind(dashboardId).all<{ pattern: string }>();

  const deniedRows = await env.DB.prepare(`
    SELECT domain FROM egress_blocklist
    WHERE dashboard_id = ? AND revoked_at IS NULL
  `).bind(dashboardId).all<{ domain: string }>();

  return Response.json({
    domains: (entries.results || []).map(e => e.domain),
    blocked_patterns: (blockedRows.results || []).map((row) => row.pattern),
    denied_domains: (deniedRows.results || []).map((row) => row.domain),
  });
}

async function rollbackBlockedDefaultChange(
  env: Env,
  rollbackMode: 'none' | 'revoke' | 'restore-revoked-at',
  rollbackId: string,
  rollbackRevokedAt: string | null,
  normalizedPattern: string,
  dashboardId: string,
): Promise<void> {
  if (rollbackMode === 'revoke' && rollbackId) {
    await env.DB.prepare(`
      UPDATE egress_blocked_defaults
      SET revoked_at = datetime('now')
      WHERE id = ? AND revoked_at IS NULL
    `).bind(rollbackId).run();
    console.log(`[egress] Rolled back block-default by revoking inserted row pattern=${normalizedPattern} dashboardId=${dashboardId}`);
    return;
  }

  if (rollbackMode === 'restore-revoked-at' && rollbackId && rollbackRevokedAt !== null) {
    await env.DB.prepare(`
      UPDATE egress_blocked_defaults
      SET revoked_at = ?
      WHERE id = ? AND revoked_at IS NULL
    `).bind(rollbackRevokedAt, rollbackId).run();
    console.log(`[egress] Rolled back block-default by restoring prior revoked_at pattern=${normalizedPattern} dashboardId=${dashboardId}`);
  }
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
