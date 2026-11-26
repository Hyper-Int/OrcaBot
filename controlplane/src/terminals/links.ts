// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: terminal-links-v1
const MODULE_REVISION = 'terminal-links-v1';
console.log(`[terminal-links] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Terminals linked to a terminal on the canvas (an edge either way), for programs
 * that coordinate other terminals, e.g. a game engine seating the players linked to
 * it. Called by the dashboard's VM (dashboard-scoped token, checked by the caller);
 * the VM serves it to the terminal itself over the privileged socket or MCPLocal.
 *
 * Like Agent blocks: no edge, no link. Only other terminals of the same dashboard,
 * with the name shown on the canvas and the PTY their latest session runs (empty if
 * the terminal hasn't started).
 */

export interface LinkedTerminal {
  itemId: string;
  name: string;
  ptyId: string;
}

interface Env { DB: D1Database }

export async function handleInternalTerminalLinks(env: Env, dashboardId: string, ptyId: string): Promise<Response> {
  const session = await env.DB.prepare(
    `SELECT item_id FROM sessions WHERE dashboard_id = ? AND pty_id = ? AND pty_id != '' ORDER BY created_at DESC LIMIT 1`,
  ).bind(dashboardId, ptyId).first<{ item_id: string }>();
  if (!session) return Response.json({ terminals: [], revision: MODULE_REVISION });
  const rows = await env.DB.prepare(`
    SELECT i.id, i.content,
      (SELECT s.pty_id FROM sessions s
        WHERE s.dashboard_id = i.dashboard_id AND s.item_id = i.id AND s.pty_id != ''
        ORDER BY (s.status = 'active') DESC, s.created_at DESC LIMIT 1) AS pty_id
    FROM dashboard_edges e
    JOIN dashboard_items i ON i.id = CASE WHEN e.source_item_id = ? THEN e.target_item_id ELSE e.source_item_id END
    WHERE e.dashboard_id = ? AND (e.source_item_id = ? OR e.target_item_id = ?)
      AND i.dashboard_id = e.dashboard_id AND i.type = 'terminal' AND i.id != ?
  `).bind(session.item_id, dashboardId, session.item_id, session.item_id, session.item_id)
    .all<{ id: string; content: string; pty_id: string | null }>();
  const terminals: LinkedTerminal[] = [];
  for (const row of rows.results ?? []) {
    if (terminals.some((t) => t.itemId === row.id)) continue;  // linked both ways
    let name = '';
    try {
      const c = JSON.parse(row.content || '{}') as { name?: unknown };
      if (typeof c.name === 'string') name = c.name.slice(0, 120);
    } catch { /* unnamed */ }
    terminals.push({ itemId: row.id, name, ptyId: row.pty_id || '' });
  }
  return Response.json({ terminals, revision: MODULE_REVISION });
}
