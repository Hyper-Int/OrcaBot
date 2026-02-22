// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: analytics-v1-first-party-analytics
const analyticsRevision = "analytics-v1-first-party-analytics";
console.log(`[analytics] REVISION: ${analyticsRevision} loaded at ${new Date().toISOString()}`);

import type { Env } from '../types';
import { isAdminEmail } from '../auth/admin';

/**
 * Update user's last_active_at timestamp.
 * Uses a conditional WHERE clause as a throttle — only writes if the existing
 * value is NULL or older than 5 minutes. No read-then-write race.
 * Called via ctx.waitUntil() so it never blocks requests.
 */
export async function updateLastActive(db: D1Database, userId: string): Promise<void> {
  try {
    await db.prepare(`
      UPDATE users SET last_active_at = datetime('now')
      WHERE id = ? AND (last_active_at IS NULL OR last_active_at < datetime('now', '-5 minutes'))
    `).bind(userId).run();
  } catch (err) {
    // Fire-and-forget — never break requests for analytics
    console.error('[analytics] updateLastActive failed:', err);
  }
}

/**
 * Detect agent type from boot command.
 * Handles `cd ... && <agent>` prefixes that the frontend adds when
 * workspaceCwd !== "/", e.g. `cd "$HOME/project" && claude`.
 * Must be called on the raw bootCommand before talkito wrapping.
 */
export function detectAgentType(bootCommand: string): string | null {
  if (!bootCommand) return null;
  let cmd = bootCommand.trim();

  // Strip leading `cd ... &&` prefix (the frontend prepends this for workspace cwd).
  // Handles: `cd "$HOME/foo" && claude`, `cd /path && gemini --flag`, etc.
  cmd = cmd.replace(/^cd\s+[^&]*&&\s*/i, '');

  const firstWord = cmd.toLowerCase().split(/\s+/)[0];
  switch (firstWord) {
    case 'claude': return 'claude';
    case 'gemini': return 'gemini';
    case 'codex': return 'codex';
    case 'opencode': return 'opencode';
    case 'droid': return 'droid';
    case 'openclaw': return 'openclaw';
    default: return cmd ? 'shell' : null;
  }
}

interface AnalyticsEvent {
  event_name: string;
  dashboard_id?: string;
  properties?: Record<string, unknown>;
}

/**
 * Ingest a batch of analytics events from the frontend.
 * POST /analytics/events
 */
export async function ingestEvents(
  env: Env,
  userId: string,
  request: Request
): Promise<Response> {
  let body: { events?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'E79901: Invalid JSON body' }, { status: 400 });
  }

  if (!Array.isArray(body.events)) {
    return Response.json({ error: 'E79902: events must be an array' }, { status: 400 });
  }

  const events = body.events as AnalyticsEvent[];
  if (events.length === 0) {
    return Response.json({ ingested: 0 });
  }
  if (events.length > 50) {
    return Response.json({ error: 'E79903: Max 50 events per batch' }, { status: 400 });
  }

  // Validate each event — guard against null/non-object entries
  for (const event of events) {
    if (typeof event !== 'object' || event === null) {
      return Response.json({ error: 'E79904: Each event must be a non-null object' }, { status: 400 });
    }
    if (typeof event.event_name !== 'string' || !event.event_name) {
      return Response.json({ error: 'E79904: Each event must have event_name string' }, { status: 400 });
    }
  }

  // Collect unique dashboard IDs from the batch and verify the user has access.
  // Events with a dashboard_id the user cannot access get their dashboard_id nulled
  // rather than rejected — this prevents data loss while ensuring metrics integrity.
  const claimedDashboardIds = new Set(
    events.map(e => e.dashboard_id).filter((id): id is string => typeof id === 'string' && id.length > 0)
  );
  const allowedDashboardIds = new Set<string>();
  if (claimedDashboardIds.size > 0) {
    const placeholders = [...claimedDashboardIds].map(() => '?').join(',');
    const rows = await env.DB.prepare(`
      SELECT dashboard_id FROM dashboard_members
      WHERE user_id = ? AND dashboard_id IN (${placeholders})
    `).bind(userId, ...claimedDashboardIds).all<{ dashboard_id: string }>();
    for (const row of rows.results ?? []) {
      allowedDashboardIds.add(row.dashboard_id);
    }
  }

  try {
    const stmts = events.map(event => {
      // Only keep dashboard_id if user proved membership; otherwise null it out
      const verifiedDashboardId = event.dashboard_id && allowedDashboardIds.has(event.dashboard_id)
        ? event.dashboard_id
        : null;
      return env.DB.prepare(`
        INSERT INTO analytics_events (id, user_id, dashboard_id, event_name, properties, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).bind(
        crypto.randomUUID(),
        userId,
        verifiedDashboardId,
        event.event_name,
        JSON.stringify(event.properties || {}),
      );
    });

    await env.DB.batch(stmts);
    return Response.json({ ingested: events.length });
  } catch (err) {
    console.error('[analytics] ingestEvents failed:', err);
    return Response.json({ error: 'E79905: Failed to ingest events' }, { status: 500 });
  }
}

/**
 * Fire-and-forget helper for logging server-side analytics events.
 */
export async function logServerEvent(
  db: D1Database,
  userId: string,
  eventName: string,
  dashboardId?: string,
  properties?: Record<string, unknown>
): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO analytics_events (id, user_id, dashboard_id, event_name, properties, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      crypto.randomUUID(),
      userId,
      dashboardId || null,
      eventName,
      JSON.stringify(properties || {}),
    ).run();
  } catch (err) {
    // Fire-and-forget — never break requests for analytics
    console.error('[analytics] logServerEvent failed:', err);
  }
}

/**
 * Admin metrics endpoint.
 * GET /admin/metrics — requires admin email.
 */
export async function getAdminMetrics(
  env: Env,
  userEmail: string
): Promise<Response> {
  if (!isAdminEmail(env, userEmail)) {
    return Response.json({ error: 'E79906: Admin access required' }, { status: 403 });
  }

  // Each metric query is independently resilient — if a table/column doesn't exist
  // yet (migration not run), that metric returns its fallback instead of 500-ing
  // the entire endpoint. This makes /admin/metrics safe during rolling deploys.
  async function safeFirst<T>(query: D1PreparedStatement, fallback: T): Promise<T> {
    try { return (await query.first<T>()) ?? fallback; }
    catch { return fallback; }
  }
  async function safeAll<T>(query: D1PreparedStatement, fallback: T[]): Promise<T[]> {
    try { return (await query.all<T>()).results ?? fallback; }
    catch { return fallback; }
  }

  try {
    const [
      dauResult,
      wauResult,
      mauResult,
      signupsByDay,
      activeDashboardsByDay,
      sessionsByDay,
      blockTypeDistribution,
      integrationAdoption,
      subscriptionBreakdown,
      topUsers,
      retentionResult,
      totals,
    ] = await Promise.all([
      // DAU (users active today) — needs users.last_active_at
      safeFirst(env.DB.prepare(`
        SELECT COUNT(*) as count FROM users
        WHERE last_active_at >= datetime('now', '-1 day')
      `), { count: 0 }),

      // WAU (users active this week) — needs users.last_active_at
      safeFirst(env.DB.prepare(`
        SELECT COUNT(*) as count FROM users
        WHERE last_active_at >= datetime('now', '-7 days')
      `), { count: 0 }),

      // MAU (users active this month) — needs users.last_active_at
      safeFirst(env.DB.prepare(`
        SELECT COUNT(*) as count FROM users
        WHERE last_active_at >= datetime('now', '-30 days')
      `), { count: 0 }),

      // Signups by day (last 30 days)
      // datetime(created_at) normalizes ISO 'T' separator to SQLite space format
      // so text comparison against datetime('now',...) is chronologically correct.
      safeAll<{ day: string; count: number }>(env.DB.prepare(`
        SELECT date(created_at) as day, COUNT(*) as count
        FROM users
        WHERE datetime(created_at) >= datetime('now', '-30 days')
        GROUP BY date(created_at)
        ORDER BY day DESC
      `), []),

      // Active dashboards by day — needs analytics_events table
      safeAll<{ day: string; count: number }>(env.DB.prepare(`
        SELECT date(created_at) as day, COUNT(DISTINCT dashboard_id) as count
        FROM analytics_events
        WHERE dashboard_id IS NOT NULL AND datetime(created_at) >= datetime('now', '-30 days')
        GROUP BY date(created_at)
        ORDER BY day DESC
      `), []),

      // Terminal sessions by day with agent_type breakdown — needs sessions.agent_type
      safeAll<{ day: string; agent_type: string | null; count: number }>(env.DB.prepare(`
        SELECT date(created_at) as day, agent_type, COUNT(*) as count
        FROM sessions
        WHERE datetime(created_at) >= datetime('now', '-30 days')
        GROUP BY date(created_at), agent_type
        ORDER BY day DESC
      `), []),

      // Block type distribution
      safeAll<{ type: string; count: number }>(env.DB.prepare(`
        SELECT type, COUNT(*) as count
        FROM dashboard_items
        GROUP BY type
        ORDER BY count DESC
      `), []),

      // Integration adoption by provider
      safeAll<{ provider: string; count: number }>(env.DB.prepare(`
        SELECT provider, COUNT(*) as count
        FROM user_integrations
        GROUP BY provider
        ORDER BY count DESC
      `), []),

      // Subscription status breakdown
      safeAll<{ status: string; count: number }>(env.DB.prepare(`
        SELECT status, COUNT(*) as count
        FROM user_subscriptions
        GROUP BY status
        ORDER BY count DESC
      `), []),

      // Top 20 users by event count — needs analytics_events table
      safeAll<{ user_id: string; email: string; name: string; event_count: number }>(env.DB.prepare(`
        SELECT ae.user_id, u.email, u.name, COUNT(*) as event_count
        FROM analytics_events ae
        JOIN users u ON u.id = ae.user_id
        WHERE datetime(ae.created_at) >= datetime('now', '-30 days')
        GROUP BY ae.user_id
        ORDER BY event_count DESC
        LIMIT 20
      `), []),

      // 7-day retention rate — needs users.last_active_at
      // Denominator: ALL users created >7 days ago (including those who never returned).
      // Numerator: subset of those who were active in the last 7 days.
      // COALESCE guards against SUM returning NULL when there are zero eligible rows.
      safeFirst(env.DB.prepare(`
        SELECT
          COUNT(*) as total_eligible,
          COALESCE(SUM(CASE WHEN last_active_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END), 0) as retained
        FROM users
        WHERE datetime(created_at) <= datetime('now', '-7 days')
      `), { total_eligible: 0, retained: 0 }),

      // Totals
      safeFirst(env.DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM users) as total_users,
          (SELECT COUNT(*) FROM dashboards) as total_dashboards,
          (SELECT COUNT(*) FROM sessions) as total_sessions
      `), { total_users: 0, total_dashboards: 0, total_sessions: 0 }),
    ]);

    return Response.json({
      revision: analyticsRevision,
      generatedAt: new Date().toISOString(),
      dau: dauResult?.count ?? 0,
      wau: wauResult?.count ?? 0,
      mau: mauResult?.count ?? 0,
      signupsByDay,
      activeDashboardsByDay,
      sessionsByDay,
      blockTypeDistribution,
      integrationAdoption,
      subscriptionBreakdown,
      topUsers,
      retention7d: retentionResult
        ? {
            totalEligible: retentionResult.total_eligible,
            retained: retentionResult.retained,
            rate: retentionResult.total_eligible > 0
              ? Math.round((retentionResult.retained / retentionResult.total_eligible) * 100)
              : 0,
          }
        : { totalEligible: 0, retained: 0, rate: 0 },
      totals: {
        users: totals?.total_users ?? 0,
        dashboards: totals?.total_dashboards ?? 0,
        sessions: totals?.total_sessions ?? 0,
      },
    });
  } catch (err) {
    console.error('[analytics] getAdminMetrics failed:', err);
    return Response.json({ error: 'E79907: Failed to compute metrics' }, { status: 500 });
  }
}
