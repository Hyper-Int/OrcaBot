// Copyright 2026 Robert Macrae. All rights reserved.
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

/**
 * Template item stored in items_json
 */
export interface TemplateItem {
  placeholderId: string;
  type: DashboardItemType;
  content: string;
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
  createdAt: string;
  updatedAt: string;
}

/**
 * Dashboard template with full data for import
 */
export interface DashboardTemplateWithData extends DashboardTemplate {
  items: TemplateItem[];
  edges: TemplateEdge[];
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
  return {
    ...base,
    items: JSON.parse((row.items_json as string) || '[]'),
    edges: JSON.parse((row.edges_json as string) || '[]'),
  };
}

/**
 * List all templates (optionally filtered by category)
 * GET /templates?category=coding
 */
export async function listTemplates(
  env: Env,
  category?: string
): Promise<Response> {
  let query = `
    SELECT id, name, description, category, preview_image_url,
           author_id, author_name, item_count, is_featured, use_count,
           created_at, updated_at
    FROM dashboard_templates
  `;
  const bindings: string[] = [];

  if (category && category !== 'all') {
    query += ' WHERE category = ?';
    bindings.push(category);
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
  }
): Promise<Response> {
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

    templateItems.push({
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
    });
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

  // 7. Insert template
  const templateId = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(
    `
    INSERT INTO dashboard_templates
    (id, name, description, category, author_id, author_name,
     items_json, edges_json, item_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      templateItems.length,
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
      },
    },
    { status: 201 }
  );
}

/**
 * Delete a template (author only)
 * DELETE /templates/:id
 */
export async function deleteTemplate(
  env: Env,
  userId: string,
  templateId: string
): Promise<Response> {
  // Check ownership
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

  if (template.author_id !== userId) {
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
 * Populate a dashboard from a template
 * Called internally when creating a dashboard with templateId
 */
export async function populateFromTemplate(
  env: Env,
  dashboardId: string,
  templateId: string
): Promise<void> {
  const template = await env.DB.prepare(
    `SELECT items_json, edges_json FROM dashboard_templates WHERE id = ?`
  )
    .bind(templateId)
    .first<{ items_json: string; edges_json: string }>();

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
      (id, dashboard_id, type, content, position_x, position_y, width, height, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  // Increment template use count
  await env.DB.prepare(
    `UPDATE dashboard_templates SET use_count = use_count + 1 WHERE id = ?`
  )
    .bind(templateId)
    .run();
}
