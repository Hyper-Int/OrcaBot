// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Dashboard Template API Handlers
 *
 * Templates are globally shared dashboard layouts that any user can import.
 * When exported, sensitive data (notes, todos, terminal sessions, recipe configs)
 * is scrubbed to protect privacy.
 */

import type { Env } from '../types';
import { scrubItemContent, type DashboardItemType } from './scrubber';
import starterTemplates from './starter-templates.json';

/**
 * Ensure the status and viewport_json columns exist on dashboard_templates.
 * Runs once per worker lifetime via the migrated flag.
 */
let migrated = false;
async function ensureTemplateColumns(env: Env): Promise<void> {
  if (migrated) return;
  try {
    await env.DB.prepare(
      `ALTER TABLE dashboard_templates ADD COLUMN viewport_json TEXT`
    ).run();
  } catch { /* already exists */ }
  try {
    await env.DB.prepare(
      `ALTER TABLE dashboard_templates ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'`
    ).run();
  } catch { /* already exists */ }
  try {
    await env.DB.prepare(
      `ALTER TABLE dashboard_templates ADD COLUMN setup_guide TEXT`
    ).run();
  } catch { /* already exists */ }
  migrated = true;
}

/**
 * Template item stored in items_json
 */
export interface TemplateItem {
  placeholderId: string;
  type: DashboardItemType;
  content: string;
  metadata?: Record<string, unknown>;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

/**
 * Template edge stored in edges_json
 */
export interface TemplateEdge {
  sourcePlaceholderId: string;
  targetPlaceholderId: string;
  sourceHandle?: string;
  targetHandle?: string;
}

// Starter templates seeded into a fresh desktop DB — verbatim copies of the
// curated prod templates (the cloud has real user-submitted templates; desktop
// starts empty). Block/edge/viewport data lives in starter-templates.json.

/**
 * Seed the curated starter templates into a fresh desktop DB. Desktop only
 * (SURFACE_TOKEN is set only by the desktop app) and once per DB (a schema
 * marker, so a user who deletes them isn't re-seeded). Called from /init-db.
 */
export async function seedStarterTemplates(env: Env): Promise<void> {
  if (!env.SURFACE_TOKEN) return;
  await ensureTemplateColumns(env);

  // Two markers on purpose. The v2 marker still guards the ORIGINAL catalog, so a
  // user who deliberately deleted one of those starters keeps it deleted. Bumping a
  // single marker to v3 would have re-inserted the whole catalog and resurrected
  // them. Newly-added starters get their own marker and are seeded on their own.
  const baseMarker = 'seed_desktop_starter_templates_v2';
  const seededBase = await env.DB.prepare(
    `SELECT 1 FROM schema_migrations WHERE name = ?`
  ).bind(baseMarker).first();

  // Starters introduced after the v2 catalog — seeded independently so they reach
  // existing DBs without touching what the user has already curated.
  const LATER_STARTERS = new Set(['starter-slopcodebench']);
  const laterMarker = 'seed_desktop_starter_slopcodebench_v1';
  const seededLater = await env.DB.prepare(
    `SELECT 1 FROM schema_migrations WHERE name = ?`
  ).bind(laterMarker).first();

  if (seededBase && seededLater) return;

  if (!seededBase) {
    // Drop the earlier hand-made starters, superseded by these prod copies.
    await env.DB.prepare(
      `DELETE FROM dashboard_templates WHERE id IN
       ('starter-agentic-coding', 'starter-automation', 'starter-documentation')`
    ).run();
  }

  const now = new Date().toISOString();
  for (const t of starterTemplates) {
    const isLater = LATER_STARTERS.has(t.id);
    if (isLater ? seededLater : seededBase) continue; // already handled for this group
    await env.DB.prepare(
      `INSERT INTO dashboard_templates
       (id, name, description, category, author_id, author_name,
        items_json, edges_json, viewport_json, setup_guide, item_count, is_featured, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'orcabot', 'Orcabot', ?, ?, ?, ?, ?, 1, 'approved', ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(
      t.id, t.name, t.description, t.category,
      JSON.stringify(t.items), JSON.stringify(t.edges),
      t.viewport ? JSON.stringify(t.viewport) : null,
      (t as { setupGuide?: string }).setupGuide ?? null,
      t.itemCount, now, now
    ).run();
  }
  if (!seededBase) {
    await env.DB.prepare(`INSERT INTO schema_migrations (name) VALUES (?)`).bind(baseMarker).run();
  }
  if (!seededLater) {
    await env.DB.prepare(`INSERT INTO schema_migrations (name) VALUES (?)`).bind(laterMarker).run();
  }
}

/**
 * Dashboard template (summary for listing)
 */
export interface DashboardTemplate {
  id: string;
  name: string;
  description: string;
  category: 'coding' | 'automation' | 'documentation' | 'custom';
  previewImageUrl?: string;
  authorId: string;
  authorName: string;
  itemCount: number;
  isFeatured: boolean;
  useCount: number;
  status: 'pending_review' | 'approved' | 'rejected';
  createdAt: string;
  updatedAt: string;
}

/**
 * Dashboard template with full data for import
 */
export interface DashboardTemplateWithData extends DashboardTemplate {
  items: TemplateItem[];
  edges: TemplateEdge[];
  viewport?: { x: number; y: number; zoom: number };
  /**
   * Optional guided-setup script. When present, it is copied onto a dashboard
   * created from this template; the Orcabot chat injects it so it can walk the
   * user through setup (clone a repo, sync deps, add keys, run a first job).
   */
  setupGuide?: string;
}

function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Format a raw DB template row to camelCase (summary only)
 */
function formatTemplate(row: Record<string, unknown>): DashboardTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    category: row.category as DashboardTemplate['category'],
    previewImageUrl: (row.preview_image_url as string) || undefined,
    authorId: row.author_id as string,
    authorName: row.author_name as string,
    itemCount: row.item_count as number,
    isFeatured: (row.is_featured as number) === 1,
    useCount: row.use_count as number,
    status: (row.status as DashboardTemplate['status']) || 'approved',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Format a raw DB template row with full data
 */
function formatTemplateWithData(
  row: Record<string, unknown>
): DashboardTemplateWithData {
  const base = formatTemplate(row);
  const viewport = row.viewport_json
    ? JSON.parse(row.viewport_json as string)
    : undefined;
  return {
    ...base,
    items: JSON.parse((row.items_json as string) || '[]'),
    edges: JSON.parse((row.edges_json as string) || '[]'),
    ...(viewport && { viewport }),
    ...(row.setup_guide ? { setupGuide: row.setup_guide as string } : {}),
  };
}

/**
 * List all templates (optionally filtered by category)
 * GET /templates?category=coding
 */
export async function listTemplates(
  env: Env,
  category?: string,
  isAdmin = false
): Promise<Response> {
  await ensureTemplateColumns(env);

  let query = `SELECT * FROM dashboard_templates`;
  const conditions: string[] = [];
  const bindings: string[] = [];

  // Non-admins only see approved templates
  if (!isAdmin) {
    conditions.push("status = 'approved'");
  }

  if (category && category !== 'all') {
    conditions.push('category = ?');
    bindings.push(category);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY is_featured DESC, use_count DESC, created_at DESC';

  const result = await env.DB.prepare(query)
    .bind(...bindings)
    .all();

  const templates = result.results.map(formatTemplate);
  return Response.json({ templates });
}

/**
 * Get a single template with full data
 * GET /templates/:id
 */
export async function getTemplate(
  env: Env,
  templateId: string
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT * FROM dashboard_templates WHERE id = ?`
  )
    .bind(templateId)
    .first();

  if (!row) {
    return Response.json(
      { error: 'E79801: Template not found' },
      { status: 404 }
    );
  }

  return Response.json({ template: formatTemplateWithData(row) });
}

/**
 * Export a dashboard as a template
 * POST /templates
 */
export async function createTemplate(
  env: Env,
  userId: string,
  data: {
    dashboardId: string;
    name: string;
    description?: string;
    category?: string;
    viewport?: { x: number; y: number; zoom: number };
  }
): Promise<Response> {
  await ensureTemplateColumns(env);

  // 1. Verify user has access to dashboard
  const access = await env.DB.prepare(
    `
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `
  )
    .bind(data.dashboardId, userId)
    .first<{ role: string }>();

  if (!access) {
    return Response.json(
      { error: 'E79802: Dashboard not found or no access' },
      { status: 404 }
    );
  }

  // 2. Fetch dashboard items and edges
  const itemRows = await env.DB.prepare(
    `SELECT * FROM dashboard_items WHERE dashboard_id = ?`
  )
    .bind(data.dashboardId)
    .all();

  const edgeRows = await env.DB.prepare(
    `SELECT * FROM dashboard_edges WHERE dashboard_id = ?`
  )
    .bind(data.dashboardId)
    .all();

  // 3. Build ID mapping and scrub items
  const idToPlaceholder = new Map<string, string>();
  const templateItems: TemplateItem[] = [];

  itemRows.results.forEach((row, index) => {
    const placeholderId = `item_${index}`;
    idToPlaceholder.set(row.id as string, placeholderId);

    // Parse metadata if present (stored as JSON string in DB)
    const rawMetadata = row.metadata
      ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Record<string, unknown>
      : undefined;

    const item: TemplateItem = {
      placeholderId,
      type: row.type as DashboardItemType,
      content: scrubItemContent(
        row.type as DashboardItemType,
        row.content as string
      ),
      position: {
        x: row.position_x as number,
        y: row.position_y as number,
      },
      size: {
        width: row.width as number,
        height: row.height as number,
      },
    };

    // Preserve metadata for visual properties (e.g. note color, font size, minimized state)
    if (rawMetadata) {
      item.metadata = rawMetadata;
    }

    templateItems.push(item);
  });

  // 4. Remap edge IDs
  const templateEdges: TemplateEdge[] = edgeRows.results
    .filter(
      (row) =>
        idToPlaceholder.has(row.source_item_id as string) &&
        idToPlaceholder.has(row.target_item_id as string)
    )
    .map((row) => ({
      sourcePlaceholderId: idToPlaceholder.get(row.source_item_id as string)!,
      targetPlaceholderId: idToPlaceholder.get(row.target_item_id as string)!,
      sourceHandle: (row.source_handle as string) || undefined,
      targetHandle: (row.target_handle as string) || undefined,
    }));

  // 5. Get author info
  const user = await env.DB.prepare(`SELECT name FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ name: string }>();

  // 6. Validate category
  const validCategories = ['coding', 'automation', 'documentation', 'custom'];
  const category = validCategories.includes(data.category || '')
    ? data.category
    : 'custom';

  // 7. Insert template (ensureTemplateColumns guarantees status + viewport_json exist)
  const templateId = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(
    `
    INSERT INTO dashboard_templates
    (id, name, description, category, author_id, author_name,
     items_json, edges_json, viewport_json, item_count, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  )
    .bind(
      templateId,
      data.name,
      data.description || '',
      category,
      userId,
      user?.name || 'Unknown',
      JSON.stringify(templateItems),
      JSON.stringify(templateEdges),
      data.viewport ? JSON.stringify(data.viewport) : null,
      templateItems.length,
      'pending_review',
      now,
      now
    )
    .run();

  return Response.json(
    {
      template: {
        id: templateId,
        name: data.name,
        description: data.description || '',
        category,
        itemCount: templateItems.length,
        status: 'pending_review',
      },
    },
    { status: 201 }
  );
}

/**
 * Delete a template (author or admin)
 * DELETE /templates/:id
 */
export async function deleteTemplate(
  env: Env,
  userId: string,
  templateId: string,
  isAdmin = false
): Promise<Response> {
  // Check existence
  const template = await env.DB.prepare(
    `SELECT author_id FROM dashboard_templates WHERE id = ?`
  )
    .bind(templateId)
    .first<{ author_id: string }>();

  if (!template) {
    return Response.json(
      { error: 'E79803: Template not found' },
      { status: 404 }
    );
  }

  // Admins can delete any template; otherwise author-only
  if (!isAdmin && template.author_id !== userId) {
    return Response.json(
      { error: 'E79804: Not authorized to delete this template' },
      { status: 403 }
    );
  }

  await env.DB.prepare(`DELETE FROM dashboard_templates WHERE id = ?`)
    .bind(templateId)
    .run();

  return new Response(null, { status: 204 });
}

/**
 * Approve or reject a template (admin only)
 * POST /templates/:id/approve
 */
export async function approveTemplate(
  env: Env,
  templateId: string,
  newStatus: 'approved' | 'rejected'
): Promise<Response> {
  if (newStatus !== 'approved' && newStatus !== 'rejected') {
    return Response.json(
      { error: 'E79805: Invalid status. Must be "approved" or "rejected"' },
      { status: 400 }
    );
  }

  const template = await env.DB.prepare(
    `SELECT id, name FROM dashboard_templates WHERE id = ?`
  )
    .bind(templateId)
    .first<{ id: string; name: string }>();

  if (!template) {
    return Response.json(
      { error: 'E79806: Template not found' },
      { status: 404 }
    );
  }

  await env.DB.prepare(
    `UPDATE dashboard_templates SET status = ?, updated_at = ? WHERE id = ?`
  )
    .bind(newStatus, new Date().toISOString(), templateId)
    .run();

  return Response.json({ template: { id: templateId, status: newStatus } });
}

/**
 * Populate a dashboard from a template
 * Called internally when creating a dashboard with templateId
 */
export async function populateFromTemplate(
  env: Env,
  dashboardId: string,
  templateId: string
): Promise<{ viewport?: { x: number; y: number; zoom: number }; hasSetupGuide?: boolean } | undefined> {
  await ensureTemplateColumns(env);
  const template = await env.DB.prepare(
    `SELECT items_json, edges_json, viewport_json, setup_guide FROM dashboard_templates WHERE id = ?`
  )
    .bind(templateId)
    .first<{ items_json: string; edges_json: string; viewport_json: string | null; setup_guide: string | null }>();

  if (!template) return;

  const items: TemplateItem[] = JSON.parse(template.items_json);
  const edges: TemplateEdge[] = JSON.parse(template.edges_json);

  // Create ID mapping from placeholder to real IDs
  const placeholderToRealId = new Map<string, string>();
  const now = new Date().toISOString();

  // Insert items with new IDs
  for (const item of items) {
    const newId = generateId();
    placeholderToRealId.set(item.placeholderId, newId);

    await env.DB.prepare(
      `
      INSERT INTO dashboard_items
      (id, dashboard_id, type, content, position_x, position_y, width, height, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
      .bind(
        newId,
        dashboardId,
        item.type,
        item.content,
        item.position.x,
        item.position.y,
        item.size.width,
        item.size.height,
        item.metadata ? JSON.stringify(item.metadata) : null,
        now,
        now
      )
      .run();
  }

  // Insert edges with remapped IDs
  for (const edge of edges) {
    const sourceId = placeholderToRealId.get(edge.sourcePlaceholderId);
    const targetId = placeholderToRealId.get(edge.targetPlaceholderId);

    if (sourceId && targetId) {
      await env.DB.prepare(
        `
        INSERT INTO dashboard_edges
        (id, dashboard_id, source_item_id, target_item_id, source_handle, target_handle, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
        .bind(
          generateId(),
          dashboardId,
          sourceId,
          targetId,
          edge.sourceHandle || null,
          edge.targetHandle || null,
          now,
          now
        )
        .run();
    }
  }

  // Copy the template's setup guide onto the dashboard so the Orcabot chat can
  // walk the user through setup for this dashboard (best-effort; column added
  // by migration). Skipped silently if the column isn't present yet.
  if (template.setup_guide) {
    try {
      await env.DB.prepare(
        `UPDATE dashboards SET setup_guide = ? WHERE id = ?`
      )
        .bind(template.setup_guide, dashboardId)
        .run();
    } catch { /* dashboards.setup_guide not migrated yet */ }
  }

  // Increment template use count
  await env.DB.prepare(
    `UPDATE dashboard_templates SET use_count = use_count + 1 WHERE id = ?`
  )
    .bind(templateId)
    .run();

  const viewport = template.viewport_json
    ? JSON.parse(template.viewport_json)
    : undefined;
  return { viewport, hasSetupGuide: !!template.setup_guide };
}
