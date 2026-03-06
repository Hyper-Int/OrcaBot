// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: links-v3-destination-rbac

import type { Env, DashboardItem, DashboardEdge } from '../types';

// Inlined formatters to avoid circular dependency with dashboards/handler
function formatItem(row: Record<string, unknown>): DashboardItem {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata && typeof row.metadata === 'string') {
    try { metadata = JSON.parse(row.metadata); } catch { metadata = undefined; }
  }
  return {
    id: row.id as string,
    dashboardId: row.dashboard_id as string,
    type: row.type as DashboardItem['type'],
    content: row.content as string,
    position: { x: row.position_x as number, y: row.position_y as number },
    size: { width: row.width as number, height: row.height as number },
    metadata,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function formatEdge(row: Record<string, unknown>): DashboardEdge {
  return {
    id: row.id as string,
    dashboardId: row.dashboard_id as string,
    sourceItemId: row.source_item_id as string,
    targetItemId: row.target_item_id as string,
    sourceHandle: (row.source_handle as string | null) ?? undefined,
    targetHandle: (row.target_handle as string | null) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

const MODULE_REVISION = "links-v3-destination-rbac";
console.log(`[links] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

function generateId(): string {
  return crypto.randomUUID();
}

// Integration block types that are user-specific (binding is per-user)
const INTEGRATION_TYPES = new Set([
  'gmail', 'calendar', 'contacts', 'sheets', 'forms',
  'slack', 'discord', 'telegram', 'whatsapp', 'teams', 'matrix', 'google_chat',
]);

/**
 * Scrub item content for linking — strips only session-specific fields.
 * Preserves structural content. Integration blocks are cleared (user-specific binding).
 */
function scrubItemContentForLink(type: DashboardItem['type'], content: string): string {
  if (INTEGRATION_TYPES.has(type)) {
    // Integration binding is user-specific — clear content
    return '';
  }

  if (type === 'terminal') {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return JSON.stringify({
        name: parsed.name || 'Terminal',
        agentic: parsed.agentic ?? false,
        bootCommand: parsed.bootCommand || '',
        subagentIds: [],
        skillIds: [],
        mcpToolIds: [],
      });
    } catch {
      return JSON.stringify({ name: 'Terminal', agentic: false, bootCommand: '' });
    }
  }

  // note, todo, prompt, link, browser, workspace, recipe, schedule — preserve as-is
  return content;
}

function scrubMetadataForLink(type: DashboardItem['type'], metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (INTEGRATION_TYPES.has(type)) {
    // Clear integration metadata (account email, labels, etc.)
    return undefined;
  }
  return metadata;
}

// ===== createLink =====

export interface CreateLinkResult {
  linkId: string;
  linkedDashboardId: string;
  linkedDashboardName: string;
}

export async function createLink(
  env: Env,
  sourceDashboardId: string,
  userId: string
): Promise<Response> {
  // Only owners may create links — editors would create a persistent exfiltration
  // path (they could be removed from the source later but keep receiving synced updates)
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(sourceDashboardId, userId).first<{ role: string }>();

  if (!access || access.role !== 'owner') {
    return Response.json({ error: 'E79401: Must be owner to create a linked dashboard' }, { status: 403 });
  }

  // Get source dashboard name
  const sourceDb = await env.DB.prepare(`
    SELECT name FROM dashboards WHERE id = ?
  `).bind(sourceDashboardId).first<{ name: string }>();

  if (!sourceDb) {
    return Response.json({ error: 'E79402: Source dashboard not found' }, { status: 404 });
  }

  const now = new Date().toISOString();
  const linkedDashboardId = generateId();
  const linkedDashboardName = `${sourceDb.name} (linked)`;

  // Create new dashboard
  await env.DB.prepare(`
    INSERT INTO dashboards (id, name, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(linkedDashboardId, linkedDashboardName, userId, now, now).run();

  // Add owner as member
  await env.DB.prepare(`
    INSERT INTO dashboard_members (dashboard_id, user_id, role, added_at)
    VALUES (?, ?, ?, ?)
  `).bind(linkedDashboardId, userId, 'owner', now).run();

  // Fetch source items and edges
  const sourceItems = await env.DB.prepare(`
    SELECT * FROM dashboard_items WHERE dashboard_id = ?
  `).bind(sourceDashboardId).all<Record<string, unknown>>();

  const sourceEdges = await env.DB.prepare(`
    SELECT * FROM dashboard_edges WHERE dashboard_id = ?
  `).bind(sourceDashboardId).all<Record<string, unknown>>();

  // Build old → new item ID map and clone items
  const itemIdMap = new Map<string, string>(); // sourceItemId → linkedItemId

  for (const row of sourceItems.results) {
    const sourceItem = formatItem(row);
    const newItemId = generateId();
    itemIdMap.set(sourceItem.id, newItemId);

    const scrubbedContent = scrubItemContentForLink(sourceItem.type, sourceItem.content);
    const scrubbedMeta = scrubMetadataForLink(sourceItem.type, sourceItem.metadata);
    const metaJson = scrubbedMeta !== undefined ? JSON.stringify(scrubbedMeta) : null;

    await env.DB.prepare(`
      INSERT INTO dashboard_items (id, dashboard_id, type, content, position_x, position_y, width, height, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newItemId,
      linkedDashboardId,
      sourceItem.type,
      scrubbedContent,
      sourceItem.position.x,
      sourceItem.position.y,
      sourceItem.size.width,
      sourceItem.size.height,
      metaJson,
      now,
      now
    ).run();
  }

  // Clone edges using mapped item IDs
  const edgeIdMap = new Map<string, string>(); // sourceEdgeId → linkedEdgeId

  for (const row of sourceEdges.results) {
    const sourceEdge = formatEdge(row);
    const newSourceItemId = itemIdMap.get(sourceEdge.sourceItemId);
    const newTargetItemId = itemIdMap.get(sourceEdge.targetItemId);

    if (!newSourceItemId || !newTargetItemId) continue; // Skip orphaned edges

    const newEdgeId = generateId();
    edgeIdMap.set(sourceEdge.id, newEdgeId);

    await env.DB.prepare(`
      INSERT INTO dashboard_edges (id, dashboard_id, source_item_id, target_item_id, source_handle, target_handle, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newEdgeId,
      linkedDashboardId,
      newSourceItemId,
      newTargetItemId,
      sourceEdge.sourceHandle ?? null,
      sourceEdge.targetHandle ?? null,
      now,
      now
    ).run();
  }

  // Create dashboard_link record
  const linkId = generateId();
  await env.DB.prepare(`
    INSERT INTO dashboard_links (id, dashboard_a_id, dashboard_b_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(linkId, sourceDashboardId, linkedDashboardId, userId, now).run();

  // Insert link_item_map rows
  for (const [sourceItemId, linkedItemId] of itemIdMap) {
    await env.DB.prepare(`
      INSERT INTO link_item_map (link_id, item_a_id, item_b_id) VALUES (?, ?, ?)
    `).bind(linkId, sourceItemId, linkedItemId).run();
  }

  // Insert link_edge_map rows
  for (const [sourceEdgeId, linkedEdgeId] of edgeIdMap) {
    await env.DB.prepare(`
      INSERT INTO link_edge_map (link_id, edge_a_id, edge_b_id) VALUES (?, ?, ?)
    `).bind(linkId, sourceEdgeId, linkedEdgeId).run();
  }

  return Response.json({
    linkId,
    linkedDashboardId,
    linkedDashboardName,
  }, { status: 201 });
}

// ===== getLinks =====

export async function getLinks(
  env: Env,
  dashboardId: string,
  userId: string
): Promise<Response> {
  // Verify access
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79403: Not found or no access' }, { status: 404 });
  }

  // Query links where this dashboard is A or B
  const linkRows = await env.DB.prepare(`
    SELECT dl.id, dl.dashboard_a_id, dl.dashboard_b_id, dl.created_at,
           da.name as name_a, db.name as name_b
    FROM dashboard_links dl
    JOIN dashboards da ON da.id = dl.dashboard_a_id
    JOIN dashboards db ON db.id = dl.dashboard_b_id
    WHERE dl.dashboard_a_id = ? OR dl.dashboard_b_id = ?
  `).bind(dashboardId, dashboardId).all<{
    id: string;
    dashboard_a_id: string;
    dashboard_b_id: string;
    created_at: string;
    name_a: string;
    name_b: string;
  }>();

  const links = linkRows.results.map((row) => {
    const isA = row.dashboard_a_id === dashboardId;
    const linkedDashboardId = isA ? row.dashboard_b_id : row.dashboard_a_id;
    const linkedDashboardName = isA ? row.name_b : row.name_a;
    return {
      id: row.id,
      linkedDashboardId,
      linkedDashboardName,
      createdAt: row.created_at,
    };
  });

  return Response.json({ links });
}

// ===== deleteLink =====

export async function deleteLink(
  env: Env,
  linkId: string,
  dashboardId: string,
  userId: string
): Promise<Response> {
  // Fetch the link to verify it touches this dashboard
  const link = await env.DB.prepare(`
    SELECT id, dashboard_a_id, dashboard_b_id FROM dashboard_links WHERE id = ?
  `).bind(linkId).first<{ id: string; dashboard_a_id: string; dashboard_b_id: string }>();

  if (!link) {
    return Response.json({ error: 'E79404: Link not found' }, { status: 404 });
  }

  if (link.dashboard_a_id !== dashboardId && link.dashboard_b_id !== dashboardId) {
    return Response.json({ error: 'E79405: Link does not belong to this dashboard' }, { status: 403 });
  }

  // Verify user is owner of at least one of the two dashboards
  const ownerCheck = await env.DB.prepare(`
    SELECT COUNT(*) as cnt FROM dashboard_members
    WHERE user_id = ? AND role = 'owner'
      AND dashboard_id IN (?, ?)
  `).bind(userId, link.dashboard_a_id, link.dashboard_b_id).first<{ cnt: number }>();

  if (!ownerCheck || ownerCheck.cnt === 0) {
    return Response.json({ error: 'E79406: Must be owner of a linked dashboard to unlink' }, { status: 403 });
  }

  // Delete link (cascades to link_item_map and link_edge_map)
  await env.DB.prepare(`
    DELETE FROM dashboard_links WHERE id = ?
  `).bind(linkId).run();

  return new Response(null, { status: 204 });
}

// ===== syncItemToLinked =====

export async function syncItemToLinked(
  env: Env,
  sourceDashboardId: string,
  item: DashboardItem,
  operation: 'upsert' | 'delete',
  actingUserId: string
): Promise<void> {
  // Find all links for this dashboard, joining created_by for stale-link check
  const linkRows = await env.DB.prepare(`
    SELECT id, dashboard_a_id, dashboard_b_id, created_by
    FROM dashboard_links
    WHERE dashboard_a_id = ? OR dashboard_b_id = ?
  `).bind(sourceDashboardId, sourceDashboardId).all<{
    id: string;
    dashboard_a_id: string;
    dashboard_b_id: string;
    created_by: string;
  }>();

  for (const link of linkRows.results) {
    try {
      const isA = link.dashboard_a_id === sourceDashboardId;
      const otherDashboardId = isA ? link.dashboard_b_id : link.dashboard_a_id;
      const selfCol = isA ? 'item_a_id' : 'item_b_id';

      // Housekeeping: if the link creator is no longer a member of the source,
      // the trust relationship that established this link no longer exists.
      const creatorStillMember = await env.DB.prepare(`
        SELECT 1 FROM dashboard_members
        WHERE dashboard_id = ? AND user_id = ?
      `).bind(sourceDashboardId, link.created_by).first();

      if (!creatorStillMember) {
        await env.DB.prepare(`DELETE FROM dashboard_links WHERE id = ?`).bind(link.id).run();
        console.warn(`[links] Auto-deleted stale link ${link.id}: creator ${link.created_by} no longer a member of source ${sourceDashboardId}`);
        continue;
      }

      // Authorization: the acting user must have editor+ rights on the destination.
      // Without this check, an editor on B with no rights on A could propagate
      // writes into A via the sync path — a cross-dashboard write escalation.
      const destAccess = await env.DB.prepare(`
        SELECT role FROM dashboard_members
        WHERE dashboard_id = ? AND user_id = ?
      `).bind(otherDashboardId, actingUserId).first<{ role: string }>();

      if (!destAccess || !['owner', 'editor'].includes(destAccess.role)) {
        // Skip this link for this actor — not an error, just no write rights on destination
        continue;
      }

      // Find mapped item
      const mapped = await env.DB.prepare(`
        SELECT item_a_id, item_b_id FROM link_item_map
        WHERE link_id = ? AND ${selfCol} = ?
      `).bind(link.id, item.id).first<{ item_a_id: string; item_b_id: string }>();

      if (operation === 'delete') {
        if (!mapped) continue;
        const otherItemId = isA ? mapped.item_b_id : mapped.item_a_id;

        // Delete the mapped item
        await env.DB.prepare(`
          DELETE FROM dashboard_items WHERE id = ? AND dashboard_id = ?
        `).bind(otherItemId, otherDashboardId).run();

        // Remove mapping
        await env.DB.prepare(`
          DELETE FROM link_item_map WHERE link_id = ? AND ${selfCol} = ?
        `).bind(link.id, item.id).run();

        // Notify DO
        await notifyDO(env, otherDashboardId, 'DELETE', '/item', { itemId: otherItemId });

      } else {
        // upsert
        const scrubbedContent = scrubItemContentForLink(item.type, item.content);
        const scrubbedMeta = scrubMetadataForLink(item.type, item.metadata);
        // null means "clear metadata on the linked side" — use direct assignment, not COALESCE
        const metaJson = scrubbedMeta !== undefined ? JSON.stringify(scrubbedMeta) : null;
        const now = new Date().toISOString();

        if (mapped) {
          // Update existing mapped item
          const otherItemId = isA ? mapped.item_b_id : mapped.item_a_id;

          await env.DB.prepare(`
            UPDATE dashboard_items SET
              content = ?,
              position_x = ?,
              position_y = ?,
              width = ?,
              height = ?,
              metadata = ?,
              updated_at = ?
            WHERE id = ? AND dashboard_id = ?
          `).bind(
            scrubbedContent,
            item.position.x,
            item.position.y,
            item.size.width,
            item.size.height,
            metaJson,
            now,
            otherItemId,
            otherDashboardId
          ).run();

          const updatedRow = await env.DB.prepare(`
            SELECT * FROM dashboard_items WHERE id = ?
          `).bind(otherItemId).first();

          if (updatedRow) {
            await notifyDO(env, otherDashboardId, 'PUT', '/item', formatItem(updatedRow));
          }

        } else {
          // New item — insert on other dashboard
          const newItemId = generateId();

          await env.DB.prepare(`
            INSERT INTO dashboard_items (id, dashboard_id, type, content, position_x, position_y, width, height, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            newItemId,
            otherDashboardId,
            item.type,
            scrubbedContent,
            item.position.x,
            item.position.y,
            item.size.width,
            item.size.height,
            metaJson ?? null,
            now,
            now
          ).run();

          // Add to item map
          const aId = isA ? item.id : newItemId;
          const bId = isA ? newItemId : item.id;
          await env.DB.prepare(`
            INSERT OR IGNORE INTO link_item_map (link_id, item_a_id, item_b_id) VALUES (?, ?, ?)
          `).bind(link.id, aId, bId).run();

          const insertedRow = await env.DB.prepare(`
            SELECT * FROM dashboard_items WHERE id = ?
          `).bind(newItemId).first();

          if (insertedRow) {
            await notifyDO(env, otherDashboardId, 'POST', '/item', formatItem(insertedRow));
          }
        }
      }
    } catch (err) {
      // Best-effort sync — don't fail the originating request
      console.error(`[links] syncItemToLinked error for link ${link.id}:`, err);
    }
  }
}

// ===== syncEdgeToLinked =====

export async function syncEdgeToLinked(
  env: Env,
  sourceDashboardId: string,
  edge: DashboardEdge,
  operation: 'upsert' | 'delete',
  actingUserId: string
): Promise<void> {
  const linkRows = await env.DB.prepare(`
    SELECT id, dashboard_a_id, dashboard_b_id, created_by
    FROM dashboard_links
    WHERE dashboard_a_id = ? OR dashboard_b_id = ?
  `).bind(sourceDashboardId, sourceDashboardId).all<{
    id: string;
    dashboard_a_id: string;
    dashboard_b_id: string;
    created_by: string;
  }>();

  for (const link of linkRows.results) {
    try {
      const isA = link.dashboard_a_id === sourceDashboardId;
      const otherDashboardId = isA ? link.dashboard_b_id : link.dashboard_a_id;
      const selfCol = isA ? 'edge_a_id' : 'edge_b_id';

      // Stale-link housekeeping
      const creatorStillMember = await env.DB.prepare(`
        SELECT 1 FROM dashboard_members
        WHERE dashboard_id = ? AND user_id = ?
      `).bind(sourceDashboardId, link.created_by).first();

      if (!creatorStillMember) {
        await env.DB.prepare(`DELETE FROM dashboard_links WHERE id = ?`).bind(link.id).run();
        console.warn(`[links] Auto-deleted stale link ${link.id}: creator ${link.created_by} no longer a member of source ${sourceDashboardId}`);
        continue;
      }

      // Destination RBAC: acting user must have editor+ on the destination
      const destAccess = await env.DB.prepare(`
        SELECT role FROM dashboard_members
        WHERE dashboard_id = ? AND user_id = ?
      `).bind(otherDashboardId, actingUserId).first<{ role: string }>();

      if (!destAccess || !['owner', 'editor'].includes(destAccess.role)) {
        continue;
      }

      // Find mapped edge
      const mappedEdge = await env.DB.prepare(`
        SELECT edge_a_id, edge_b_id FROM link_edge_map
        WHERE link_id = ? AND ${selfCol} = ?
      `).bind(link.id, edge.id).first<{ edge_a_id: string; edge_b_id: string }>();

      if (operation === 'delete') {
        if (!mappedEdge) continue;
        const otherEdgeId = isA ? mappedEdge.edge_b_id : mappedEdge.edge_a_id;

        await env.DB.prepare(`
          DELETE FROM dashboard_edges WHERE id = ? AND dashboard_id = ?
        `).bind(otherEdgeId, otherDashboardId).run();

        await env.DB.prepare(`
          DELETE FROM link_edge_map WHERE link_id = ? AND ${selfCol} = ?
        `).bind(link.id, edge.id).run();

        await notifyDO(env, otherDashboardId, 'DELETE', '/edge', { edgeId: otherEdgeId });

      } else {
        // upsert — only insert if not already mapped
        if (mappedEdge) continue;

        // Map source and target items to other dashboard
        const srcMappedItem = await env.DB.prepare(`
          SELECT item_a_id, item_b_id FROM link_item_map
          WHERE link_id = ? AND ${isA ? 'item_a_id' : 'item_b_id'} = ?
        `).bind(link.id, edge.sourceItemId).first<{ item_a_id: string; item_b_id: string }>();

        const tgtMappedItem = await env.DB.prepare(`
          SELECT item_a_id, item_b_id FROM link_item_map
          WHERE link_id = ? AND ${isA ? 'item_a_id' : 'item_b_id'} = ?
        `).bind(link.id, edge.targetItemId).first<{ item_a_id: string; item_b_id: string }>();

        if (!srcMappedItem || !tgtMappedItem) continue; // Items not synced yet

        const otherSourceItemId = isA ? srcMappedItem.item_b_id : srcMappedItem.item_a_id;
        const otherTargetItemId = isA ? tgtMappedItem.item_b_id : tgtMappedItem.item_a_id;

        const now = new Date().toISOString();
        const newEdgeId = generateId();

        await env.DB.prepare(`
          INSERT OR IGNORE INTO dashboard_edges (id, dashboard_id, source_item_id, target_item_id, source_handle, target_handle, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          newEdgeId,
          otherDashboardId,
          otherSourceItemId,
          otherTargetItemId,
          edge.sourceHandle ?? null,
          edge.targetHandle ?? null,
          now,
          now
        ).run();

        const aEdgeId = isA ? edge.id : newEdgeId;
        const bEdgeId = isA ? newEdgeId : edge.id;
        await env.DB.prepare(`
          INSERT OR IGNORE INTO link_edge_map (link_id, edge_a_id, edge_b_id) VALUES (?, ?, ?)
        `).bind(link.id, aEdgeId, bEdgeId).run();

        const insertedRow = await env.DB.prepare(`
          SELECT * FROM dashboard_edges WHERE id = ?
        `).bind(newEdgeId).first();

        if (insertedRow) {
          await notifyDO(env, otherDashboardId, 'POST', '/edge', formatEdge(insertedRow));
        }
      }
    } catch (err) {
      console.error(`[links] syncEdgeToLinked error for link ${link.id}:`, err);
    }
  }
}

// ===== Internal helpers =====

async function notifyDO(
  env: Env,
  dashboardId: string,
  method: 'POST' | 'PUT' | 'DELETE',
  path: '/item' | '/edge',
  body: unknown
): Promise<void> {
  try {
    const doId = env.DASHBOARD.idFromName(dashboardId);
    const stub = env.DASHBOARD.get(doId);
    await stub.fetch(new Request(`http://do${path}`, {
      method,
      body: JSON.stringify(body),
    }));
  } catch (err) {
    console.error(`[links] notifyDO error for dashboard ${dashboardId}:`, err);
  }
}
