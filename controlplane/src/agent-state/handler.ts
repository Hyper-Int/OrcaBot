// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: agent-state-v27-d1-compat-fallback
console.log(`[agent-state] REVISION: agent-state-v27-d1-compat-fallback loaded at ${new Date().toISOString()}`);

/**
 * Agent State Handler
 *
 * Provides task and memory management for AI agents.
 * Works across all deployment modes (Cloud, Desktop) using D1.
 */

import type {
  Env,
  AgentTask,
  AgentMemory,
  AgentTaskStatus,
  AgentMemoryType,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilters,
  SetMemoryInput,
  MemoryFilters,
} from '../types';

// ============================================
// Helpers
// ============================================

function generateId(): string {
  return crypto.randomUUID();
}

function formatTask(row: Record<string, unknown>): AgentTask {
  return {
    id: row.id as string,
    dashboardId: row.dashboard_id as string,
    sessionId: row.session_id as string | undefined,
    parentId: row.parent_id as string | undefined,
    subject: row.subject as string,
    description: row.description as string | undefined,
    status: row.status as AgentTaskStatus,
    priority: row.priority as number,
    blockedBy: JSON.parse((row.blocked_by as string) || '[]'),
    blocks: JSON.parse((row.blocks as string) || '[]'),
    ownerAgent: row.owner_agent as string | undefined,
    metadata: JSON.parse((row.metadata as string) || '{}'),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    startedAt: row.started_at as string | undefined,
    completedAt: row.completed_at as string | undefined,
  };
}

function formatMemory(row: Record<string, unknown>): AgentMemory {
  return {
    id: row.id as string,
    dashboardId: row.dashboard_id as string,
    sessionId: row.session_id as string | undefined,
    key: row.key as string,
    value: JSON.parse((row.value as string) || 'null'),
    memoryType: row.memory_type as AgentMemoryType,
    tags: JSON.parse((row.tags as string) || '[]'),
    expiresAt: row.expires_at as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

async function ensureDashboardAccess(
  env: Env,
  dashboardId: string,
  userId: string
): Promise<{ role: string } | null> {
  const access = await env.DB.prepare(
    `SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?`
  )
    .bind(dashboardId, userId)
    .first<{ role: string }>();
  return access;
}

// ============================================
// Broadcast Helpers (Real-time updates via DO)
// ============================================

async function broadcastTaskCreate(env: Env, dashboardId: string, task: AgentTask): Promise<void> {
  try {
    const doId = env.DASHBOARD.idFromName(dashboardId);
    const stub = env.DASHBOARD.get(doId);
    await stub.fetch(new Request('http://do/task', {
      method: 'POST',
      body: JSON.stringify(task),
    }));
  } catch (error) {
    console.error('[agent-state] Failed to broadcast task_create:', error);
  }
}

async function broadcastTaskUpdate(env: Env, dashboardId: string, task: AgentTask): Promise<void> {
  try {
    const doId = env.DASHBOARD.idFromName(dashboardId);
    const stub = env.DASHBOARD.get(doId);
    await stub.fetch(new Request('http://do/task', {
      method: 'PUT',
      body: JSON.stringify(task),
    }));
  } catch (error) {
    console.error('[agent-state] Failed to broadcast task_update:', error);
  }
}

async function broadcastTaskDelete(env: Env, dashboardId: string, taskId: string): Promise<void> {
  try {
    const doId = env.DASHBOARD.idFromName(dashboardId);
    const stub = env.DASHBOARD.get(doId);
    await stub.fetch(new Request('http://do/task', {
      method: 'DELETE',
      body: JSON.stringify({ taskId }),
    }));
  } catch (error) {
    console.error('[agent-state] Failed to broadcast task_delete:', error);
  }
}

async function broadcastMemoryUpdate(env: Env, dashboardId: string, key: string, memory: AgentMemory | null, sessionId?: string | null): Promise<void> {
  try {
    const doId = env.DASHBOARD.idFromName(dashboardId);
    const stub = env.DASHBOARD.get(doId);
    // Include sessionId to distinguish dashboard-wide vs session-scoped memories
    await stub.fetch(new Request('http://do/memory', {
      method: 'PUT',
      body: JSON.stringify({ key, memory, sessionId: sessionId ?? null }),
    }));
  } catch (error) {
    console.error('[agent-state] Failed to broadcast memory_update:', error);
  }
}

// ============================================
// Task CRUD
// ============================================

/**
 * List tasks for a dashboard with optional filters
 */
export async function listTasks(
  env: Env,
  dashboardId: string,
  userId: string,
  filters?: TaskFilters
): Promise<Response> {
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: 'E79010: Dashboard not found or access denied' }, { status: 404 });
  }

  // Validate sessionId belongs to this dashboard (security: prevent session enumeration)
  if (filters?.sessionId) {
    const sessionValid = await validateSessionBelongsToDashboard(env, dashboardId, filters.sessionId);
    if (!sessionValid) {
      return Response.json({ error: 'E79011: Invalid session for this dashboard' }, { status: 400 });
    }
  }

  let query = `SELECT * FROM agent_tasks WHERE dashboard_id = ?`;
  const params: unknown[] = [dashboardId];

  // Session scoping for "multiplayer by default":
  // - With sessionId: show dashboard-wide (null) + that session's tasks
  // - Without sessionId: show only dashboard-wide tasks
  if (filters?.sessionId) {
    query += ` AND (session_id IS NULL OR session_id = ?)`;
    params.push(filters.sessionId);
  } else {
    // No sessionId filter = only show dashboard-wide tasks
    query += ` AND session_id IS NULL`;
  }

  if (filters?.parentId) {
    query += ` AND parent_id = ?`;
    params.push(filters.parentId);
  }

  if (filters?.ownerAgent) {
    query += ` AND owner_agent = ?`;
    params.push(filters.ownerAgent);
  }

  if (filters?.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    query += ` AND status IN (${statuses.map(() => '?').join(', ')})`;
    params.push(...statuses);
  } else if (!filters?.includeCompleted) {
    // Default: exclude completed and cancelled
    query += ` AND status NOT IN ('completed', 'cancelled')`;
  }

  query += ` ORDER BY priority DESC, created_at ASC`;

  const result = await env.DB.prepare(query).bind(...params).all();
  const tasks = (result.results || []).map(formatTask);

  return Response.json({ tasks });
}

/**
 * Get a single task by ID
 *
 * Session scope security: Public API (no PTY token) can only access dashboard-wide tasks.
 * Session-scoped tasks require the gateway API with PTY token proof-of-possession.
 */
export async function getTask(
  env: Env,
  dashboardId: string,
  taskId: string,
  userId: string,
  sessionId?: string
): Promise<Response> {
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: 'E79012: Dashboard not found or access denied' }, { status: 404 });
  }

  // Validate sessionId if provided
  if (sessionId) {
    const sessionValid = await validateSessionBelongsToDashboard(env, dashboardId, sessionId);
    if (!sessionValid) {
      return Response.json({ error: 'E79013: Invalid session for this dashboard' }, { status: 400 });
    }
  }

  // Session scope security: restrict access based on sessionId context
  let query = `SELECT * FROM agent_tasks WHERE id = ? AND dashboard_id = ?`;
  const params: unknown[] = [taskId, dashboardId];

  if (sessionId) {
    // With session context: can access dashboard-wide + that session's tasks
    query += ` AND (session_id IS NULL OR session_id = ?)`;
    params.push(sessionId);
  } else {
    // Without session context: can only access dashboard-wide tasks
    query += ` AND session_id IS NULL`;
  }

  const row = await env.DB.prepare(query).bind(...params).first();

  if (!row) {
    return Response.json({ error: 'E79014: Task not found' }, { status: 404 });
  }

  return Response.json({ task: formatTask(row) });
}

/**
 * Create a new task
 */
export async function createTask(
  env: Env,
  dashboardId: string,
  userId: string,
  input: CreateTaskInput,
  options?: { allowSessionScope?: boolean }
): Promise<Response> {
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access || access.role === 'viewer') {
    return Response.json({ error: 'E79015: Access denied' }, { status: 403 });
  }

  // Validate required fields
  if (!input.subject || typeof input.subject !== 'string' || input.subject.trim() === '') {
    return Response.json({ error: 'E79016: subject is required and must be a non-empty string' }, { status: 400 });
  }

  // Session-scoped writes require PTY token (internal gateway only)
  // Public API (allowSessionScope=false or undefined) rejects sessionId
  if (input.sessionId && !options?.allowSessionScope) {
    return Response.json({ error: 'E79017: Session-scoped tasks can only be created via terminal (PTY token required)' }, { status: 403 });
  }

  // Validate sessionId belongs to this dashboard (security: prevent orphaned session-scoped tasks)
  if (input.sessionId) {
    const sessionValid = await validateSessionBelongsToDashboard(env, dashboardId, input.sessionId);
    if (!sessionValid) {
      return Response.json({ error: 'E79018: Invalid session for this dashboard' }, { status: 400 });
    }
  }

  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO agent_tasks (
      id, dashboard_id, session_id, parent_id, subject, description,
      status, priority, blocked_by, blocks, owner_agent, metadata,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, '[]', ?, ?, ?, ?)
  `).bind(
    id,
    dashboardId,
    input.sessionId || null,
    input.parentId || null,
    input.subject,
    input.description || null,
    input.priority || 0,
    JSON.stringify(input.blockedBy || []),
    input.ownerAgent || null,
    JSON.stringify(input.metadata || {}),
    now,
    now
  ).run();

  // If this task has blockers, update those tasks' "blocks" field
  if (input.blockedBy && input.blockedBy.length > 0) {
    for (const blockerId of input.blockedBy) {
      await addToBlocks(env, dashboardId, blockerId, id);
    }
  }

  const row = await env.DB.prepare(
    `SELECT * FROM agent_tasks WHERE id = ?`
  ).bind(id).first();

  const task = formatTask(row!);

  // Broadcast real-time update
  await broadcastTaskCreate(env, dashboardId, task);

  return Response.json({ task }, { status: 201 });
}

/**
 * Update an existing task
 *
 * Session scope security:
 * - sessionId parameter provides caller's session context
 * - Without sessionId: can only update dashboard-wide tasks
 * - With sessionId: can update dashboard-wide + that session's tasks
 * - allowSessionScope: bypasses session check (for internal gateway with PTY token)
 */
export async function updateTask(
  env: Env,
  dashboardId: string,
  taskId: string,
  userId: string,
  input: UpdateTaskInput,
  options?: { sessionId?: string; allowSessionScope?: boolean }
): Promise<Response> {
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access || access.role === 'viewer') {
    return Response.json({ error: 'E79019: Access denied' }, { status: 403 });
  }

  // Validate sessionId if provided
  if (options?.sessionId) {
    const sessionValid = await validateSessionBelongsToDashboard(env, dashboardId, options.sessionId);
    if (!sessionValid) {
      return Response.json({ error: 'E79020: Invalid session for this dashboard' }, { status: 400 });
    }
  }

  // Session scope security: restrict access based on sessionId context
  // If allowSessionScope is true (internal gateway), skip this check
  let query = `SELECT * FROM agent_tasks WHERE id = ? AND dashboard_id = ?`;
  const queryParams: unknown[] = [taskId, dashboardId];

  if (!options?.allowSessionScope) {
    if (options?.sessionId) {
      // With session context: can update dashboard-wide + that session's tasks
      query += ` AND (session_id IS NULL OR session_id = ?)`;
      queryParams.push(options.sessionId);
    } else {
      // Without session context: can only update dashboard-wide tasks
      query += ` AND session_id IS NULL`;
    }
  }

  const existing = await env.DB.prepare(query).bind(...queryParams).first();

  if (!existing) {
    return Response.json({ error: 'E79021: Task not found' }, { status: 404 });
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  const now = new Date().toISOString();

  if (input.subject !== undefined) {
    updates.push('subject = ?');
    params.push(input.subject);
  }

  if (input.description !== undefined) {
    updates.push('description = ?');
    params.push(input.description);
  }

  if (input.status !== undefined) {
    updates.push('status = ?');
    params.push(input.status);

    // Set started_at when moving to in_progress
    if (input.status === 'in_progress' && !existing.started_at) {
      updates.push('started_at = ?');
      params.push(now);
    }

    // Set completed_at when completing
    if (input.status === 'completed' || input.status === 'cancelled') {
      updates.push('completed_at = ?');
      params.push(now);
    } else {
      // Clear completed_at when reopening to any non-completed/non-cancelled status
      updates.push('completed_at = NULL');
    }

    // Clear started_at only when moving back to pending
    if (input.status === 'pending') {
      updates.push('started_at = NULL');
    }
  }

  if (input.priority !== undefined) {
    updates.push('priority = ?');
    params.push(input.priority);
  }

  if (input.ownerAgent !== undefined) {
    updates.push('owner_agent = ?');
    params.push(input.ownerAgent);
  }

  if (input.metadata !== undefined) {
    // Merge with existing metadata
    const existingMetadata = JSON.parse((existing.metadata as string) || '{}');
    const newMetadata = { ...existingMetadata, ...input.metadata };
    updates.push('metadata = ?');
    params.push(JSON.stringify(newMetadata));
  }

  // Handle blockedBy changes
  if (input.addBlockedBy || input.removeBlockedBy) {
    const currentBlockedBy: string[] = JSON.parse((existing.blocked_by as string) || '[]');
    let newBlockedBy = [...currentBlockedBy];

    if (input.removeBlockedBy) {
      newBlockedBy = newBlockedBy.filter(id => !input.removeBlockedBy!.includes(id));
      // Update the blocks field of removed blockers
      for (const blockerId of input.removeBlockedBy) {
        await removeFromBlocks(env, dashboardId, blockerId, taskId);
      }
    }

    if (input.addBlockedBy) {
      newBlockedBy = [...new Set([...newBlockedBy, ...input.addBlockedBy])];
      // Update the blocks field of new blockers
      for (const blockerId of input.addBlockedBy) {
        await addToBlocks(env, dashboardId, blockerId, taskId);
      }
    }

    updates.push('blocked_by = ?');
    params.push(JSON.stringify(newBlockedBy));
  }

  if (updates.length === 0) {
    return Response.json({ error: 'E79022: No updates provided' }, { status: 400 });
  }

  updates.push('updated_at = ?');
  params.push(now);
  params.push(taskId);
  params.push(dashboardId);

  await env.DB.prepare(`
    UPDATE agent_tasks SET ${updates.join(', ')}
    WHERE id = ? AND dashboard_id = ?
  `).bind(...params).run();

  const row = await env.DB.prepare(
    `SELECT * FROM agent_tasks WHERE id = ?`
  ).bind(taskId).first();

  const task = formatTask(row!);

  // Broadcast real-time update
  await broadcastTaskUpdate(env, dashboardId, task);

  return Response.json({ task });
}

/**
 * Delete a task
 *
 * Session scope security: Public API (no PTY token) can only delete dashboard-wide tasks.
 * Session-scoped tasks require the gateway API with PTY token proof-of-possession.
 */
export async function deleteTask(
  env: Env,
  dashboardId: string,
  taskId: string,
  userId: string,
  sessionId?: string
): Promise<Response> {
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access || access.role === 'viewer') {
    return Response.json({ error: 'E79023: Access denied' }, { status: 403 });
  }

  // Validate sessionId if provided
  if (sessionId) {
    const sessionValid = await validateSessionBelongsToDashboard(env, dashboardId, sessionId);
    if (!sessionValid) {
      return Response.json({ error: 'E79024: Invalid session for this dashboard' }, { status: 400 });
    }
  }

  // Session scope security: restrict access based on sessionId context
  let query = `SELECT * FROM agent_tasks WHERE id = ? AND dashboard_id = ?`;
  const params: unknown[] = [taskId, dashboardId];

  if (sessionId) {
    // With session context: can access dashboard-wide + that session's tasks
    query += ` AND (session_id IS NULL OR session_id = ?)`;
    params.push(sessionId);
  } else {
    // Without session context: can only access dashboard-wide tasks
    query += ` AND session_id IS NULL`;
  }

  const task = await env.DB.prepare(query).bind(...params).first();

  if (!task) {
    return Response.json({ error: 'E79025: Task not found' }, { status: 404 });
  }

  // Remove this task from blockedBy of other tasks
  const blocks: string[] = JSON.parse((task.blocks as string) || '[]');
  for (const blockedTaskId of blocks) {
    await removeFromBlockedBy(env, dashboardId, blockedTaskId, taskId);
  }

  // Remove this task from blocks of other tasks
  const blockedBy: string[] = JSON.parse((task.blocked_by as string) || '[]');
  for (const blockerId of blockedBy) {
    await removeFromBlocks(env, dashboardId, blockerId, taskId);
  }

  await env.DB.prepare(
    `DELETE FROM agent_tasks WHERE id = ? AND dashboard_id = ?`
  ).bind(taskId, dashboardId).run();

  // Broadcast real-time update
  await broadcastTaskDelete(env, dashboardId, taskId);

  return Response.json({ success: true });
}

// Helper functions for dependency management
// Security: All helpers require dashboardId to prevent cross-dashboard mutations
async function addToBlocks(env: Env, dashboardId: string, taskId: string, blockedTaskId: string): Promise<void> {
  const task = await env.DB.prepare(
    `SELECT blocks FROM agent_tasks WHERE id = ? AND dashboard_id = ?`
  ).bind(taskId, dashboardId).first();
  if (task) {
    const blocks: string[] = JSON.parse((task.blocks as string) || '[]');
    if (!blocks.includes(blockedTaskId)) {
      blocks.push(blockedTaskId);
      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE agent_tasks SET blocks = ?, updated_at = ? WHERE id = ? AND dashboard_id = ?`
      ).bind(JSON.stringify(blocks), now, taskId, dashboardId).run();
      // Broadcast update to keep UI in sync
      const updatedRow = await env.DB.prepare(
        `SELECT * FROM agent_tasks WHERE id = ? AND dashboard_id = ?`
      ).bind(taskId, dashboardId).first();
      if (updatedRow) {
        await broadcastTaskUpdate(env, dashboardId, formatTask(updatedRow));
      }
    }
  }
}

async function removeFromBlocks(env: Env, dashboardId: string, taskId: string, blockedTaskId: string): Promise<void> {
  const task = await env.DB.prepare(
    `SELECT blocks FROM agent_tasks WHERE id = ? AND dashboard_id = ?`
  ).bind(taskId, dashboardId).first();
  if (task) {
    const blocks: string[] = JSON.parse((task.blocks as string) || '[]');
    const newBlocks = blocks.filter(id => id !== blockedTaskId);
    if (newBlocks.length !== blocks.length) {
      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE agent_tasks SET blocks = ?, updated_at = ? WHERE id = ? AND dashboard_id = ?`
      ).bind(JSON.stringify(newBlocks), now, taskId, dashboardId).run();
      // Broadcast update to keep UI in sync
      const updatedRow = await env.DB.prepare(
        `SELECT * FROM agent_tasks WHERE id = ? AND dashboard_id = ?`
      ).bind(taskId, dashboardId).first();
      if (updatedRow) {
        await broadcastTaskUpdate(env, dashboardId, formatTask(updatedRow));
      }
    }
  }
}

async function removeFromBlockedBy(env: Env, dashboardId: string, taskId: string, blockerId: string): Promise<void> {
  const task = await env.DB.prepare(
    `SELECT blocked_by FROM agent_tasks WHERE id = ? AND dashboard_id = ?`
  ).bind(taskId, dashboardId).first();
  if (task) {
    const blockedBy: string[] = JSON.parse((task.blocked_by as string) || '[]');
    const newBlockedBy = blockedBy.filter(id => id !== blockerId);
    if (newBlockedBy.length !== blockedBy.length) {
      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE agent_tasks SET blocked_by = ?, updated_at = ? WHERE id = ? AND dashboard_id = ?`
      ).bind(JSON.stringify(newBlockedBy), now, taskId, dashboardId).run();
      // Broadcast update to keep UI in sync
      const updatedRow = await env.DB.prepare(
        `SELECT * FROM agent_tasks WHERE id = ? AND dashboard_id = ?`
      ).bind(taskId, dashboardId).first();
      if (updatedRow) {
        await broadcastTaskUpdate(env, dashboardId, formatTask(updatedRow));
      }
    }
  }
}

// ============================================
// Internal Helpers (for scheduler/system use)
// ============================================

/**
 * Create a task internally (no user access check).
 * Used by scheduler for automatic task creation.
 */
export async function createTaskInternal(
  env: Env,
  input: {
    dashboardId: string;
    sessionId?: string;
    subject: string;
    description?: string;
    ownerAgent?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<AgentTask> {
  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO agent_tasks (
      id, dashboard_id, session_id, parent_id, subject, description,
      status, priority, blocked_by, blocks, owner_agent, metadata,
      created_at, updated_at, started_at
    ) VALUES (?, ?, ?, NULL, ?, ?, 'in_progress', 0, '[]', '[]', ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.dashboardId,
    input.sessionId || null,
    input.subject,
    input.description || null,
    input.ownerAgent || 'scheduler',
    JSON.stringify(input.metadata || {}),
    now,
    now,
    now
  ).run();

  const row = await env.DB.prepare(
    `SELECT * FROM agent_tasks WHERE id = ?`
  ).bind(id).first();

  const task = formatTask(row!);

  // Broadcast real-time update
  await broadcastTaskCreate(env, input.dashboardId, task);

  return task;
}

/**
 * Update a task status internally (no user access check).
 * Used by scheduler for updating task progress.
 */
export async function updateTaskStatusInternal(
  env: Env,
  taskId: string,
  status: AgentTaskStatus,
  error?: string
): Promise<AgentTask | null> {
  const now = new Date().toISOString();

  // Prepare updates based on status
  let extraFields = '';
  if (status === 'completed' || status === 'cancelled') {
    extraFields = ', completed_at = ?';
  } else if (status === 'in_progress') {
    extraFields = ', started_at = COALESCE(started_at, ?)';
  }

  // Add error to metadata if provided
  let metadataUpdate = '';
  if (error) {
    metadataUpdate = `, metadata = json_set(metadata, '$.error', ?)`;
  }

  const query = `
    UPDATE agent_tasks
    SET status = ?, updated_at = ?${extraFields}${metadataUpdate}
    WHERE id = ?
  `;

  const params: unknown[] = [status, now];
  if (status === 'completed' || status === 'cancelled' || status === 'in_progress') {
    params.push(now);
  }
  if (error) {
    params.push(error);
  }
  params.push(taskId);

  await env.DB.prepare(query).bind(...params).run();

  const row = await env.DB.prepare(
    `SELECT * FROM agent_tasks WHERE id = ?`
  ).bind(taskId).first();

  if (!row) {
    return null;
  }

  const task = formatTask(row);

  // Broadcast real-time update
  await broadcastTaskUpdate(env, task.dashboardId, task);

  return task;
}

// ============================================
// Memory CRUD
// ============================================

/**
 * List memory entries for a dashboard with optional filters
 */
export async function listMemory(
  env: Env,
  dashboardId: string,
  userId: string,
  filters?: MemoryFilters
): Promise<Response> {
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: 'E79026: Dashboard not found or access denied' }, { status: 404 });
  }

  // Validate sessionId belongs to this dashboard (security: prevent session enumeration)
  if (filters?.sessionId) {
    const sessionValid = await validateSessionBelongsToDashboard(env, dashboardId, filters.sessionId);
    if (!sessionValid) {
      return Response.json({ error: 'E79027: Invalid session for this dashboard' }, { status: 400 });
    }
  }

  let query = `SELECT * FROM agent_memory WHERE dashboard_id = ?`;
  const params: unknown[] = [dashboardId];

  // Filter out expired memories
  query += ` AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`;

  // Session scoping for "multiplayer by default":
  // - With sessionId: show dashboard-wide (null) + that session's memories
  // - Without sessionId: show only dashboard-wide memories
  if (filters?.sessionId) {
    query += ` AND (session_id IS NULL OR session_id = ?)`;
    params.push(filters.sessionId);
  } else {
    // No sessionId filter = only show dashboard-wide memories
    query += ` AND session_id IS NULL`;
  }

  if (filters?.memoryType) {
    query += ` AND memory_type = ?`;
    params.push(filters.memoryType);
  }

  if (filters?.prefix) {
    query += ` AND key LIKE ?`;
    params.push(filters.prefix + '%');
  }

  if (filters?.tags && filters.tags.length > 0) {
    // Filter by tags (AND logic - all tags must be present)
    // Rebuild the query properly with json_each join
    const tagParams: unknown[] = [dashboardId];
    let tagQuery = `SELECT DISTINCT m.* FROM agent_memory m, json_each(m.tags) WHERE m.dashboard_id = ? AND (m.expires_at IS NULL OR datetime(m.expires_at) > datetime('now'))`;

    // Session scoping for tags query (same multiplayer-by-default logic)
    if (filters.sessionId) {
      tagQuery += ` AND (m.session_id IS NULL OR m.session_id = ?)`;
      tagParams.push(filters.sessionId);
    } else {
      // No sessionId filter = only show dashboard-wide memories
      tagQuery += ` AND m.session_id IS NULL`;
    }
    if (filters.memoryType) {
      tagQuery += ` AND m.memory_type = ?`;
      tagParams.push(filters.memoryType);
    }
    if (filters.prefix) {
      tagQuery += ` AND m.key LIKE ?`;
      tagParams.push(filters.prefix + '%');
    }
    tagQuery += ` AND json_each.value IN (${filters.tags.map(() => '?').join(', ')})`;
    tagParams.push(...filters.tags);
    tagQuery += ` GROUP BY m.id HAVING COUNT(DISTINCT json_each.value) = ?`;
    tagParams.push(filters.tags.length);
    tagQuery += ` ORDER BY m.updated_at DESC`;

    const result = await env.DB.prepare(tagQuery).bind(...tagParams).all();
    const memories = (result.results || []).map(formatMemory);
    return Response.json({ memories });
  }

  query += ` ORDER BY updated_at DESC`;

  const result = await env.DB.prepare(query).bind(...params).all();
  const memories = (result.results || []).map(formatMemory);

  return Response.json({ memories });
}

/**
 * Get a single memory entry by key
 *
 * When sessionId is provided:
 * - First looks for session-scoped entry matching the key
 * - Falls back to dashboard-wide entry if no session-scoped entry exists
 * This matches listMemory behavior (shows session + dashboard-wide entries)
 */
export async function getMemory(
  env: Env,
  dashboardId: string,
  key: string,
  userId: string,
  sessionId?: string
): Promise<Response> {
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: 'E79028: Dashboard not found or access denied' }, { status: 404 });
  }

  // Validate sessionId belongs to this dashboard (security: prevent session enumeration)
  if (sessionId) {
    const sessionValid = await validateSessionBelongsToDashboard(env, dashboardId, sessionId);
    if (!sessionValid) {
      return Response.json({ error: 'E79029: Invalid session for this dashboard' }, { status: 400 });
    }
  }

  const baseCondition = `dashboard_id = ? AND key = ? AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`;

  if (sessionId) {
    // With sessionId: first try session-scoped, then fall back to dashboard-wide
    // This matches listMemory behavior which returns both
    const sessionRow = await env.DB.prepare(
      `SELECT * FROM agent_memory WHERE ${baseCondition} AND session_id = ?`
    ).bind(dashboardId, key, sessionId).first();

    if (sessionRow) {
      return Response.json({ memory: formatMemory(sessionRow) });
    }

    // Fall back to dashboard-wide
    const dashboardRow = await env.DB.prepare(
      `SELECT * FROM agent_memory WHERE ${baseCondition} AND session_id IS NULL`
    ).bind(dashboardId, key).first();

    if (dashboardRow) {
      return Response.json({ memory: formatMemory(dashboardRow) });
    }
  } else {
    // Without sessionId: only look for dashboard-wide
    const row = await env.DB.prepare(
      `SELECT * FROM agent_memory WHERE ${baseCondition} AND session_id IS NULL`
    ).bind(dashboardId, key).first();

    if (row) {
      return Response.json({ memory: formatMemory(row) });
    }
  }

  return Response.json({ error: 'E79030: Memory not found' }, { status: 404 });
}

/**
 * Validate that a session (by PTY ID) belongs to a dashboard
 *
 * Session scoping uses PTY ID (terminal_id) as the identifier, not session record ID.
 * This matches:
 * - MCP tools which use terminal_id from PTY token
 * - UI which passes session.ptyId
 * - Internal gateway which extracts terminal_id from verified PTY token
 */
async function validateSessionBelongsToDashboard(
  env: Env,
  dashboardId: string,
  ptyId: string
): Promise<boolean> {
  // Check by pty_id (the PTY ID used by MCP tools and UI)
  const session = await env.DB.prepare(
    `SELECT id FROM sessions WHERE pty_id = ? AND dashboard_id = ?`
  ).bind(ptyId, dashboardId).first();
  return session !== null;
}

/**
 * Set a memory entry (upsert)
 *
 * Session scope security:
 * - allowSessionScope: if false (default), rejects sessionId (public API safety)
 * - Session-scoped memory can only be created via terminal (PTY token required)
 *
 * Uses INSERT ... ON CONFLICT for race-safe upserts.
 */
export async function setMemory(
  env: Env,
  dashboardId: string,
  userId: string,
  input: SetMemoryInput,
  options?: { allowSessionScope?: boolean }
): Promise<Response> {
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access || access.role === 'viewer') {
    return Response.json({ error: 'E79031: Access denied' }, { status: 403 });
  }

  // Validate required fields
  if (!input.key || typeof input.key !== 'string' || input.key.trim() === '') {
    return Response.json({ error: 'E79032: key is required and must be a non-empty string' }, { status: 400 });
  }
  if (input.value === undefined) {
    return Response.json({ error: 'E79033: value is required' }, { status: 400 });
  }

  // Session-scoped writes require PTY token (internal gateway only)
  // Public API (allowSessionScope=false or undefined) rejects sessionId
  if (input.sessionId && !options?.allowSessionScope) {
    return Response.json({ error: 'E79034: Session-scoped memory can only be created via terminal (PTY token required)' }, { status: 403 });
  }

  // Validate sessionId belongs to this dashboard (security: prevent cross-session injection)
  if (input.sessionId) {
    const sessionValid = await validateSessionBelongsToDashboard(env, dashboardId, input.sessionId);
    if (!sessionValid) {
      return Response.json({ error: 'E79035: Invalid session for this dashboard' }, { status: 400 });
    }
  }

  const now = new Date().toISOString();
  const id = generateId();

  // Compute expiresAt
  let expiresAt: string | null = null;
  if (input.expiresIn !== undefined && input.expiresIn) {
    const expireDate = new Date(Date.now() + input.expiresIn * 1000);
    expiresAt = expireDate.toISOString();
  }

  // Use INSERT ... ON CONFLICT for race-safe upsert
  // D1/SQLite supports this with unique constraints
  const valueJson = JSON.stringify(input.value);
  const sessionId = input.sessionId || null;

  // Track which fields were explicitly provided vs defaulted
  // For INSERT: use defaults; for UPDATE: preserve existing if not provided
  const memoryTypeProvided = input.memoryType !== undefined;
  const tagsProvided = input.tags !== undefined;
  const expiresInProvided = input.expiresIn !== undefined;

  // For INSERT, use provided values or defaults
  const insertMemoryType = input.memoryType ?? 'fact';
  const insertTagsJson = JSON.stringify(input.tags ?? []);

  // Use SELECT-then-UPDATE/INSERT pattern for D1 compatibility
  // This avoids partial unique index syntax which may not be supported
  let selectQuery = `SELECT id, memory_type, tags FROM agent_memory WHERE dashboard_id = ? AND key = ?`;
  const selectParams: unknown[] = [dashboardId, input.key];
  if (sessionId) {
    selectQuery += ` AND session_id = ?`;
    selectParams.push(sessionId);
  } else {
    selectQuery += ` AND session_id IS NULL`;
  }

  const existing = await env.DB.prepare(selectQuery).bind(...selectParams).first();

  if (existing) {
    // UPDATE existing row, preserving fields not explicitly provided
    const finalMemoryType = memoryTypeProvided ? insertMemoryType : existing.memory_type as string;
    const finalTags = tagsProvided ? insertTagsJson : existing.tags as string;
    const finalExpiresAt = expiresInProvided ? expiresAt : undefined; // undefined = keep existing

    if (finalExpiresAt !== undefined) {
      await env.DB.prepare(`
        UPDATE agent_memory SET
          value = ?,
          memory_type = ?,
          tags = ?,
          expires_at = ?,
          updated_at = ?
        WHERE id = ?
      `).bind(
        valueJson,
        finalMemoryType,
        finalTags,
        finalExpiresAt,
        now,
        existing.id as string
      ).run();
    } else {
      // Don't update expires_at if not provided
      await env.DB.prepare(`
        UPDATE agent_memory SET
          value = ?,
          memory_type = ?,
          tags = ?,
          updated_at = ?
        WHERE id = ?
      `).bind(
        valueJson,
        finalMemoryType,
        finalTags,
        now,
        existing.id as string
      ).run();
    }
  } else {
    // INSERT new row
    await env.DB.prepare(`
      INSERT INTO agent_memory (
        id, dashboard_id, session_id, key, value, memory_type, tags,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      dashboardId,
      sessionId,
      input.key,
      valueJson,
      insertMemoryType,
      insertTagsJson,
      expiresAt,
      now,
      now
    ).run();
  }

  // Fetch the final row (could be inserted or updated)
  let fetchQuery = `SELECT * FROM agent_memory WHERE dashboard_id = ? AND key = ?`;
  const fetchParams: unknown[] = [dashboardId, input.key];
  if (sessionId) {
    fetchQuery += ` AND session_id = ?`;
    fetchParams.push(sessionId);
  } else {
    fetchQuery += ` AND session_id IS NULL`;
  }

  const row = await env.DB.prepare(fetchQuery).bind(...fetchParams).first();
  if (!row) {
    return Response.json({ error: 'E79036: Failed to save memory' }, { status: 500 });
  }

  const memory = formatMemory(row);

  // Broadcast real-time update (include sessionId for scope disambiguation)
  await broadcastMemoryUpdate(env, dashboardId, input.key, memory, sessionId);

  return Response.json({ memory }, { status: 201 });
}

/**
 * Delete a memory entry
 */
export async function deleteMemory(
  env: Env,
  dashboardId: string,
  key: string,
  userId: string,
  sessionId?: string
): Promise<Response> {
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access || access.role === 'viewer') {
    return Response.json({ error: 'E79037: Access denied' }, { status: 403 });
  }

  // Validate sessionId belongs to this dashboard (security: prevent session enumeration)
  if (sessionId) {
    const sessionValid = await validateSessionBelongsToDashboard(env, dashboardId, sessionId);
    if (!sessionValid) {
      return Response.json({ error: 'E79038: Invalid session for this dashboard' }, { status: 400 });
    }
  }

  let query = `DELETE FROM agent_memory WHERE dashboard_id = ? AND key = ?`;
  const params: unknown[] = [dashboardId, key];

  if (sessionId) {
    query += ` AND session_id = ?`;
    params.push(sessionId);
  } else {
    query += ` AND session_id IS NULL`;
  }

  await env.DB.prepare(query).bind(...params).run();

  // Broadcast real-time update (null memory means deleted, include sessionId for scope)
  await broadcastMemoryUpdate(env, dashboardId, key, null, sessionId);

  return Response.json({ success: true });
}

/**
 * Clean up expired memory entries (called by cron)
 */
export async function cleanupExpiredMemory(env: Env): Promise<number> {
  // First, query expired memories to get their keys for broadcasting
  // Limit to 100 per run to prevent overload
  const expired = await env.DB.prepare(`
    SELECT id, dashboard_id, key, session_id FROM agent_memory
    WHERE expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')
    LIMIT 100
  `).all();

  if (!expired.results || expired.results.length === 0) {
    return 0;
  }

  // Delete the expired entries
  const ids = expired.results.map(r => r.id as string);
  const placeholders = ids.map(() => '?').join(', ');
  await env.DB.prepare(`DELETE FROM agent_memory WHERE id IN (${placeholders})`).bind(...ids).run();

  // Broadcast deletions to connected clients
  for (const row of expired.results) {
    try {
      await broadcastMemoryUpdate(
        env,
        row.dashboard_id as string,
        row.key as string,
        null, // null indicates deletion
        row.session_id as string | null
      );
    } catch (error) {
      console.error('[agent-state] Failed to broadcast expired memory deletion:', error);
    }
  }

  return expired.results.length;
}

// ============================================
// Batch Operations
// ============================================

interface BulkTaskUpdate {
  taskId: string;
  status?: AgentTaskStatus;
  subject?: string;
  description?: string;
  priority?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Bulk update multiple tasks at once
 * Returns the number of successfully updated tasks
 *
 * Session scope security (same as updateTask):
 * - sessionId: caller's session context
 * - Without sessionId: can only update dashboard-wide tasks
 * - With sessionId: can update dashboard-wide + that session's tasks
 * - allowSessionScope: bypasses session check (for internal gateway with PTY token)
 */
export async function bulkUpdateTasks(
  env: Env,
  dashboardId: string,
  userId: string,
  updates: BulkTaskUpdate[],
  options?: { sessionId?: string; allowSessionScope?: boolean }
): Promise<Response> {
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access || access.role === 'viewer') {
    return Response.json({ error: 'E79039: Access denied' }, { status: 403 });
  }

  // Validate sessionId if provided
  if (options?.sessionId) {
    const sessionValid = await validateSessionBelongsToDashboard(env, dashboardId, options.sessionId);
    if (!sessionValid) {
      return Response.json({ error: 'E79040: Invalid session for this dashboard' }, { status: 400 });
    }
  }

  if (!Array.isArray(updates) || updates.length === 0) {
    return Response.json({ error: 'E79041: updates array is required' }, { status: 400 });
  }

  if (updates.length > 100) {
    return Response.json({ error: 'E79042: Maximum 100 updates per batch' }, { status: 400 });
  }

  const now = new Date().toISOString();
  const results: { taskId: string; success: boolean; error?: string }[] = [];
  const updatedTasks: AgentTask[] = [];

  for (const update of updates) {
    try {
      if (!update.taskId) {
        results.push({ taskId: '', success: false, error: 'taskId is required' });
        continue;
      }

      // Session scope security: restrict access based on sessionId context
      let query = `SELECT * FROM agent_tasks WHERE id = ? AND dashboard_id = ?`;
      const queryParams: unknown[] = [update.taskId, dashboardId];

      if (!options?.allowSessionScope) {
        if (options?.sessionId) {
          query += ` AND (session_id IS NULL OR session_id = ?)`;
          queryParams.push(options.sessionId);
        } else {
          query += ` AND session_id IS NULL`;
        }
      }

      const existing = await env.DB.prepare(query).bind(...queryParams).first();

      if (!existing) {
        results.push({ taskId: update.taskId, success: false, error: 'Task not found' });
        continue;
      }

      const updateFields: string[] = [];
      const params: unknown[] = [];

      if (update.status !== undefined) {
        updateFields.push('status = ?');
        params.push(update.status);
        if (update.status === 'in_progress' && !existing.started_at) {
          updateFields.push('started_at = ?');
          params.push(now);
        }
        if (update.status === 'completed' || update.status === 'cancelled') {
          updateFields.push('completed_at = ?');
          params.push(now);
        } else {
          // Clear completed_at when reopening to any non-completed/non-cancelled status
          updateFields.push('completed_at = NULL');
        }
        // Clear started_at only when moving back to pending
        if (update.status === 'pending') {
          updateFields.push('started_at = NULL');
        }
      }

      if (update.subject !== undefined) {
        updateFields.push('subject = ?');
        params.push(update.subject);
      }

      if (update.description !== undefined) {
        updateFields.push('description = ?');
        params.push(update.description);
      }

      if (update.priority !== undefined) {
        updateFields.push('priority = ?');
        params.push(update.priority);
      }

      if (update.metadata !== undefined) {
        const existingMetadata = JSON.parse((existing.metadata as string) || '{}');
        const newMetadata = { ...existingMetadata, ...update.metadata };
        updateFields.push('metadata = ?');
        params.push(JSON.stringify(newMetadata));
      }

      if (updateFields.length === 0) {
        results.push({ taskId: update.taskId, success: true });
        continue;
      }

      updateFields.push('updated_at = ?');
      params.push(now);
      params.push(update.taskId);
      params.push(dashboardId);

      await env.DB.prepare(
        `UPDATE agent_tasks SET ${updateFields.join(', ')} WHERE id = ? AND dashboard_id = ?`
      ).bind(...params).run();

      const row = await env.DB.prepare(`SELECT * FROM agent_tasks WHERE id = ?`).bind(update.taskId).first();
      if (row) {
        updatedTasks.push(formatTask(row));
      }

      results.push({ taskId: update.taskId, success: true });
    } catch (error) {
      results.push({
        taskId: update.taskId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // Broadcast updates for all successfully updated tasks
  for (const task of updatedTasks) {
    await broadcastTaskUpdate(env, dashboardId, task);
  }

  const successCount = results.filter(r => r.success).length;
  return Response.json({
    success: true,
    updated: successCount,
    total: updates.length,
    results
  });
}

// ============================================
// Internal API (for sandbox gateway calls)
// ============================================

/**
 * Handle gateway execute request for tasks
 */
export async function executeTaskAction(
  env: Env,
  dashboardId: string,
  sessionId: string | null,
  action: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  switch (action) {
    case 'tasks.list': {
      const filters: TaskFilters = {
        sessionId: args.sessionId as string | undefined,
        status: args.status as AgentTaskStatus | undefined,
        includeCompleted: args.includeCompleted as boolean | undefined,
      };
      let query = `SELECT * FROM agent_tasks WHERE dashboard_id = ?`;
      const params: unknown[] = [dashboardId];

      // Session scoping security:
      // - With sessionId context (PTY token): show dashboard-wide (null) + that session's tasks
      // - Without sessionId context (dashboard token): show ONLY dashboard-wide tasks
      // This prevents dashboard-token clients from accessing per-terminal tasks
      if (sessionId) {
        query += ` AND (session_id IS NULL OR session_id = ?)`;
        params.push(sessionId);
      } else {
        // Dashboard token: restrict to dashboard-wide tasks only
        query += ` AND session_id IS NULL`;
      }

      if (filters.status) {
        query += ` AND status = ?`;
        params.push(filters.status);
      } else if (!filters.includeCompleted) {
        // Default: exclude completed and cancelled unless includeCompleted is true
        query += ` AND status NOT IN ('completed', 'cancelled')`;
      }

      query += ` ORDER BY priority DESC, created_at ASC`;
      const result = await env.DB.prepare(query).bind(...params).all();
      return { success: true, data: { tasks: (result.results || []).map(formatTask) } };
    }

    case 'tasks.get': {
      const taskId = args.taskId as string;
      if (!taskId) {
        return { success: false, error: 'taskId is required' };
      }

      // Session scope security: build query based on access level
      let query = `SELECT * FROM agent_tasks WHERE id = ? AND dashboard_id = ?`;
      const params: unknown[] = [taskId, dashboardId];

      if (sessionId) {
        // PTY token: can access dashboard-wide + own session tasks
        query += ` AND (session_id IS NULL OR session_id = ?)`;
        params.push(sessionId);
      } else {
        // Dashboard token: can only access dashboard-wide tasks
        query += ` AND session_id IS NULL`;
      }

      const row = await env.DB.prepare(query).bind(...params).first();
      if (!row) {
        return { success: false, error: 'Task not found' };
      }
      return { success: true, data: { task: formatTask(row) } };
    }

    case 'tasks.create': {
      // Validate required fields
      if (!args.subject || typeof args.subject !== 'string' || args.subject.trim() === '') {
        return { success: false, error: 'subject is required and must be a non-empty string' };
      }

      const id = generateId();
      const now = new Date().toISOString();
      const blockedBy = (args.blockedBy as string[]) || [];

      // Tasks are dashboard-wide by default for multiplayer collaboration
      // Use args.sessionScoped to explicitly create session-scoped tasks
      const useSessionScope = args.sessionScoped === true && sessionId;
      const effectiveSessionId = useSessionScope ? sessionId : null;

      await env.DB.prepare(`
        INSERT INTO agent_tasks (
          id, dashboard_id, session_id, parent_id, subject, description,
          status, priority, blocked_by, blocks, owner_agent, metadata,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, '[]', ?, ?, ?, ?)
      `).bind(
        id,
        dashboardId,
        effectiveSessionId,
        (args.parentId as string) || null,
        args.subject as string,
        (args.description as string) || null,
        (args.priority as number) || 0,
        JSON.stringify(blockedBy),
        (args.ownerAgent as string) || null,
        JSON.stringify((args.metadata as Record<string, unknown>) || {}),
        now,
        now
      ).run();

      // If this task has blockers, update those tasks' "blocks" field
      if (blockedBy.length > 0) {
        for (const blockerId of blockedBy) {
          await addToBlocks(env, dashboardId, blockerId, id);
        }
      }

      const row = await env.DB.prepare(`SELECT * FROM agent_tasks WHERE id = ?`).bind(id).first();
      const task = formatTask(row!);

      // Broadcast real-time update
      await broadcastTaskCreate(env, dashboardId, task);

      return { success: true, data: { task } };
    }

    case 'tasks.update': {
      const taskId = args.taskId as string;
      if (!taskId) {
        return { success: false, error: 'taskId is required' };
      }

      // Session scope security: build query based on access level
      let existingQuery = `SELECT * FROM agent_tasks WHERE id = ? AND dashboard_id = ?`;
      const existingParams: unknown[] = [taskId, dashboardId];

      if (sessionId) {
        // PTY token: can access dashboard-wide + own session tasks
        existingQuery += ` AND (session_id IS NULL OR session_id = ?)`;
        existingParams.push(sessionId);
      } else {
        // Dashboard token: can only access dashboard-wide tasks
        existingQuery += ` AND session_id IS NULL`;
      }

      const existing = await env.DB.prepare(existingQuery).bind(...existingParams).first();
      if (!existing) {
        return { success: false, error: 'Task not found' };
      }

      const updates: string[] = [];
      const params: unknown[] = [];
      const now = new Date().toISOString();

      if (args.subject !== undefined) {
        updates.push('subject = ?');
        params.push(args.subject);
      }
      if (args.description !== undefined) {
        updates.push('description = ?');
        params.push(args.description);
      }
      if (args.status !== undefined) {
        updates.push('status = ?');
        params.push(args.status);
        if (args.status === 'in_progress' && !existing.started_at) {
          updates.push('started_at = ?');
          params.push(now);
        }
        if (args.status === 'completed' || args.status === 'cancelled') {
          updates.push('completed_at = ?');
          params.push(now);
        } else {
          // Clear completed_at when reopening to any non-completed/non-cancelled status
          updates.push('completed_at = NULL');
        }
        // Clear started_at only when moving back to pending
        if (args.status === 'pending') {
          updates.push('started_at = NULL');
        }
      }
      if (args.priority !== undefined) {
        updates.push('priority = ?');
        params.push(args.priority);
      }
      if (args.ownerAgent !== undefined) {
        updates.push('owner_agent = ?');
        params.push(args.ownerAgent);
      }
      if (args.metadata !== undefined) {
        // Merge with existing metadata
        const existingMetadata = JSON.parse((existing.metadata as string) || '{}');
        const newMetadata = { ...existingMetadata, ...(args.metadata as Record<string, unknown>) };
        updates.push('metadata = ?');
        params.push(JSON.stringify(newMetadata));
      }

      // Handle blockedBy changes
      if (args.addBlockedBy || args.removeBlockedBy) {
        const currentBlockedBy: string[] = JSON.parse((existing.blocked_by as string) || '[]');
        let newBlockedBy = [...currentBlockedBy];

        if (args.removeBlockedBy) {
          const toRemove = args.removeBlockedBy as string[];
          newBlockedBy = newBlockedBy.filter(id => !toRemove.includes(id));
          // Update the blocks field of removed blockers
          for (const blockerId of toRemove) {
            await removeFromBlocks(env, dashboardId, blockerId, taskId);
          }
        }

        if (args.addBlockedBy) {
          const toAdd = args.addBlockedBy as string[];
          newBlockedBy = [...new Set([...newBlockedBy, ...toAdd])];
          // Update the blocks field of new blockers
          for (const blockerId of toAdd) {
            await addToBlocks(env, dashboardId, blockerId, taskId);
          }
        }

        updates.push('blocked_by = ?');
        params.push(JSON.stringify(newBlockedBy));
      }

      if (updates.length === 0) {
        return { success: false, error: 'No updates provided' };
      }

      updates.push('updated_at = ?');
      params.push(now);
      params.push(taskId);
      params.push(dashboardId);

      // SECURITY: Use both id AND dashboard_id to prevent cross-dashboard writes
      await env.DB.prepare(`UPDATE agent_tasks SET ${updates.join(', ')} WHERE id = ? AND dashboard_id = ?`)
        .bind(...params).run();
      const row = await env.DB.prepare(`SELECT * FROM agent_tasks WHERE id = ? AND dashboard_id = ?`).bind(taskId, dashboardId).first();
      const task = formatTask(row!);

      // Broadcast real-time update
      await broadcastTaskUpdate(env, dashboardId, task);

      return { success: true, data: { task } };
    }

    case 'tasks.delete': {
      const taskId = args.taskId as string;
      if (!taskId) {
        return { success: false, error: 'taskId is required' };
      }

      // Session scope security: build query based on access level
      let existingQuery = `SELECT * FROM agent_tasks WHERE id = ? AND dashboard_id = ?`;
      const existingParams: unknown[] = [taskId, dashboardId];

      if (sessionId) {
        // PTY token: can access dashboard-wide + own session tasks
        existingQuery += ` AND (session_id IS NULL OR session_id = ?)`;
        existingParams.push(sessionId);
      } else {
        // Dashboard token: can only access dashboard-wide tasks
        existingQuery += ` AND session_id IS NULL`;
      }

      // Check if task exists and is accessible
      const existing = await env.DB.prepare(existingQuery).bind(...existingParams).first();
      if (!existing) {
        return { success: false, error: 'Task not found' };
      }

      // Remove this task from blockedBy of other tasks
      const blocks: string[] = JSON.parse((existing.blocks as string) || '[]');
      for (const blockedTaskId of blocks) {
        await removeFromBlockedBy(env, dashboardId, blockedTaskId, taskId);
      }

      // Remove this task from blocks of other tasks
      const blockedBy: string[] = JSON.parse((existing.blocked_by as string) || '[]');
      for (const blockerId of blockedBy) {
        await removeFromBlocks(env, dashboardId, blockerId, taskId);
      }

      await env.DB.prepare(
        `DELETE FROM agent_tasks WHERE id = ? AND dashboard_id = ?`
      ).bind(taskId, dashboardId).run();

      // Broadcast real-time update
      await broadcastTaskDelete(env, dashboardId, taskId);

      return { success: true, data: { deleted: true } };
    }

    case 'tasks.bulkUpdate': {
      const updates = args.updates as Array<{
        taskId: string;
        status?: string;
        subject?: string;
        description?: string;
        priority?: number;
        ownerAgent?: string;
        metadata?: Record<string, unknown>;
      }>;

      if (!Array.isArray(updates) || updates.length === 0) {
        return { success: false, error: 'updates array is required' };
      }

      if (updates.length > 100) {
        return { success: false, error: 'Maximum 100 updates per batch' };
      }

      const now = new Date().toISOString();
      const results: { taskId: string; success: boolean; error?: string }[] = [];
      const updatedTasks: AgentTask[] = [];

      for (const update of updates) {
        try {
          if (!update.taskId) {
            results.push({ taskId: '', success: false, error: 'taskId is required' });
            continue;
          }

          // Session scope security: build query based on access level
          let existingQuery = `SELECT * FROM agent_tasks WHERE id = ? AND dashboard_id = ?`;
          const existingParams: unknown[] = [update.taskId, dashboardId];

          if (sessionId) {
            existingQuery += ` AND (session_id IS NULL OR session_id = ?)`;
            existingParams.push(sessionId);
          } else {
            existingQuery += ` AND session_id IS NULL`;
          }

          const existing = await env.DB.prepare(existingQuery).bind(...existingParams).first();
          if (!existing) {
            results.push({ taskId: update.taskId, success: false, error: 'Task not found' });
            continue;
          }

          const updateFields: string[] = [];
          const params: unknown[] = [];

          if (update.status !== undefined) {
            updateFields.push('status = ?');
            params.push(update.status);
            if (update.status === 'in_progress' && !existing.started_at) {
              updateFields.push('started_at = ?');
              params.push(now);
            }
            if (update.status === 'completed' || update.status === 'cancelled') {
              updateFields.push('completed_at = ?');
              params.push(now);
            } else {
              // Clear completed_at when reopening to any non-completed/non-cancelled status
              updateFields.push('completed_at = NULL');
            }
            // Clear started_at only when moving back to pending
            if (update.status === 'pending') {
              updateFields.push('started_at = NULL');
            }
          }
          if (update.subject !== undefined) {
            updateFields.push('subject = ?');
            params.push(update.subject);
          }
          if (update.description !== undefined) {
            updateFields.push('description = ?');
            params.push(update.description);
          }
          if (update.priority !== undefined) {
            updateFields.push('priority = ?');
            params.push(update.priority);
          }
          if (update.ownerAgent !== undefined) {
            updateFields.push('owner_agent = ?');
            params.push(update.ownerAgent);
          }
          if (update.metadata !== undefined) {
            const existingMetadata = JSON.parse((existing.metadata as string) || '{}');
            const newMetadata = { ...existingMetadata, ...update.metadata };
            updateFields.push('metadata = ?');
            params.push(JSON.stringify(newMetadata));
          }

          if (updateFields.length === 0) {
            results.push({ taskId: update.taskId, success: false, error: 'No updates provided' });
            continue;
          }

          updateFields.push('updated_at = ?');
          params.push(now);
          params.push(update.taskId);
          params.push(dashboardId);

          await env.DB.prepare(`UPDATE agent_tasks SET ${updateFields.join(', ')} WHERE id = ? AND dashboard_id = ?`)
            .bind(...params).run();

          const row = await env.DB.prepare(`SELECT * FROM agent_tasks WHERE id = ? AND dashboard_id = ?`).bind(update.taskId, dashboardId).first();
          const task = formatTask(row!);
          updatedTasks.push(task);
          results.push({ taskId: update.taskId, success: true });
        } catch (e) {
          results.push({ taskId: update.taskId, success: false, error: e instanceof Error ? e.message : 'Unknown error' });
        }
      }

      // Broadcast real-time updates for all updated tasks
      for (const task of updatedTasks) {
        await broadcastTaskUpdate(env, dashboardId, task);
      }

      return { success: true, data: { results, tasks: updatedTasks } };
    }

    default:
      return { success: false, error: `Unknown task action: ${action}` };
  }
}

/**
 * Handle gateway execute request for memory
 */
export async function executeMemoryAction(
  env: Env,
  dashboardId: string,
  sessionId: string | null,
  action: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  switch (action) {
    case 'memory.list': {
      // Session scoping: show dashboard-wide memories (session_id IS NULL)
      // plus only this session's session-scoped memories
      let query = `SELECT * FROM agent_memory WHERE dashboard_id = ? AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`;
      const params: unknown[] = [dashboardId];

      // Filter by session scope: show dashboard-wide + current session's memories
      if (sessionId) {
        query += ` AND (session_id IS NULL OR session_id = ?)`;
        params.push(sessionId);
      } else {
        // No session context - only show dashboard-wide memories
        query += ` AND session_id IS NULL`;
      }

      if (args.memoryType) {
        query += ` AND memory_type = ?`;
        params.push(args.memoryType);
      }
      if (args.prefix) {
        query += ` AND key LIKE ?`;
        params.push((args.prefix as string) + '%');
      }

      // Handle tags filtering
      if (args.tags && Array.isArray(args.tags) && args.tags.length > 0) {
        const tags = args.tags as string[];
        let tagQuery = `SELECT DISTINCT m.* FROM agent_memory m, json_each(m.tags) WHERE m.dashboard_id = ? AND (m.expires_at IS NULL OR datetime(m.expires_at) > datetime('now'))`;
        const tagParams: unknown[] = [dashboardId];

        // Session scoping for tags query
        if (sessionId) {
          tagQuery += ` AND (m.session_id IS NULL OR m.session_id = ?)`;
          tagParams.push(sessionId);
        } else {
          tagQuery += ` AND m.session_id IS NULL`;
        }

        if (args.memoryType) {
          tagQuery += ` AND m.memory_type = ?`;
          tagParams.push(args.memoryType);
        }
        if (args.prefix) {
          tagQuery += ` AND m.key LIKE ?`;
          tagParams.push((args.prefix as string) + '%');
        }
        tagQuery += ` AND json_each.value IN (${tags.map(() => '?').join(', ')})`;
        tagParams.push(...tags);
        tagQuery += ` GROUP BY m.id HAVING COUNT(DISTINCT json_each.value) = ?`;
        tagParams.push(tags.length);
        tagQuery += ` ORDER BY m.updated_at DESC`;

        const result = await env.DB.prepare(tagQuery).bind(...tagParams).all();
        return { success: true, data: { memories: (result.results || []).map(formatMemory) } };
      }

      query += ` ORDER BY updated_at DESC`;
      const result = await env.DB.prepare(query).bind(...params).all();
      return { success: true, data: { memories: (result.results || []).map(formatMemory) } };
    }

    case 'memory.get': {
      const key = args.key as string;
      if (!key) {
        return { success: false, error: 'key is required' };
      }
      // Memory is dashboard-scoped by default
      // Use args.sessionScoped to explicitly request session-scoped memory
      const useSessionScope = args.sessionScoped === true && sessionId;
      let query = `SELECT * FROM agent_memory WHERE dashboard_id = ? AND key = ? AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`;
      const params: unknown[] = [dashboardId, key];

      if (useSessionScope) {
        query += ` AND session_id = ?`;
        params.push(sessionId);
      } else {
        query += ` AND session_id IS NULL`;
      }

      const row = await env.DB.prepare(query).bind(...params).first();
      if (!row) {
        return { success: false, error: 'Memory not found' };
      }
      return { success: true, data: { memory: formatMemory(row) } };
    }

    case 'memory.set': {
      const key = args.key as string;
      if (!key || typeof key !== 'string' || key.trim() === '') {
        return { success: false, error: 'key is required and must be a non-empty string' };
      }
      if (args.value === undefined) {
        return { success: false, error: 'value is required' };
      }

      const now = new Date().toISOString();

      // Memory is dashboard-scoped by default
      // Use args.sessionScoped to explicitly request session-scoped memory
      const useSessionScope = args.sessionScoped === true && sessionId;
      const effectiveSessionId = useSessionScope ? sessionId : null;

      // Check for existing (include memory_type, tags, and expires_at to preserve on partial update)
      let query = `SELECT id, memory_type, tags, expires_at FROM agent_memory WHERE dashboard_id = ? AND key = ?`;
      const checkParams: unknown[] = [dashboardId, key];
      if (effectiveSessionId) {
        query += ` AND session_id = ?`;
        checkParams.push(effectiveSessionId);
      } else {
        query += ` AND session_id IS NULL`;
      }

      const existing = await env.DB.prepare(query).bind(...checkParams).first();

      if (existing) {
        // Preserve existing metadata if not provided
        const existingMemoryType = existing.memory_type as string;
        const existingTags = JSON.parse((existing.tags as string) || '[]') as string[];
        const existingExpiresAt = existing.expires_at as string | null;

        // Only update expires_at if expiresIn is explicitly provided
        let expiresAt: string | null;
        if (args.expiresIn !== undefined) {
          if (args.expiresIn) {
            const expireDate = new Date(Date.now() + (args.expiresIn as number) * 1000);
            expiresAt = expireDate.toISOString();
          } else {
            expiresAt = null; // Explicitly clear TTL
          }
        } else {
          expiresAt = existingExpiresAt; // Preserve existing TTL
        }

        await env.DB.prepare(`
          UPDATE agent_memory SET value = ?, memory_type = ?, tags = ?, expires_at = ?, updated_at = ?
          WHERE id = ?
        `).bind(
          JSON.stringify(args.value),
          (args.memoryType as string) ?? existingMemoryType,
          JSON.stringify((args.tags as string[]) ?? existingTags),
          expiresAt,
          now,
          existing.id as string
        ).run();
        const row = await env.DB.prepare(`SELECT * FROM agent_memory WHERE id = ?`)
          .bind(existing.id as string).first();
        const memory = formatMemory(row!);

        // Broadcast real-time update (include sessionId for scope disambiguation)
        await broadcastMemoryUpdate(env, dashboardId, key, memory, effectiveSessionId);

        return { success: true, data: { memory } };
      } else {
        // Insert - compute expiresAt for new entries
        // Use same pattern as update for consistency: expiresIn: 0 explicitly means no expiry
        let expiresAt: string | null = null;
        if (args.expiresIn !== undefined && args.expiresIn) {
          const expireDate = new Date(Date.now() + (args.expiresIn as number) * 1000);
          expiresAt = expireDate.toISOString();
        }
        // expiresIn: 0 or undefined → no expiry (null)

        const id = generateId();
        await env.DB.prepare(`
          INSERT INTO agent_memory (id, dashboard_id, session_id, key, value, memory_type, tags, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          id, dashboardId, effectiveSessionId, key,
          JSON.stringify(args.value),
          (args.memoryType as string) || 'fact',
          JSON.stringify((args.tags as string[]) || []),
          expiresAt, now, now
        ).run();
        const row = await env.DB.prepare(`SELECT * FROM agent_memory WHERE id = ?`).bind(id).first();
        const memory = formatMemory(row!);

        // Broadcast real-time update (include sessionId for scope disambiguation)
        await broadcastMemoryUpdate(env, dashboardId, key, memory, effectiveSessionId);

        return { success: true, data: { memory } };
      }
    }

    case 'memory.delete': {
      const key = args.key as string;
      if (!key) {
        return { success: false, error: 'key is required' };
      }
      // Memory is dashboard-scoped by default
      // Use args.sessionScoped to explicitly delete session-scoped memory
      const useSessionScope = args.sessionScoped === true && sessionId;
      const effectiveDeleteSessionId = useSessionScope ? sessionId : null;
      let query = `DELETE FROM agent_memory WHERE dashboard_id = ? AND key = ?`;
      const params: unknown[] = [dashboardId, key];
      if (useSessionScope) {
        query += ` AND session_id = ?`;
        params.push(sessionId);
      } else {
        query += ` AND session_id IS NULL`;
      }
      await env.DB.prepare(query).bind(...params).run();

      // Broadcast real-time update (null memory means deleted, include sessionId for scope)
      await broadcastMemoryUpdate(env, dashboardId, key, null, effectiveDeleteSessionId);

      return { success: true, data: { deleted: true } };
    }

    default:
      return { success: false, error: `Unknown memory action: ${action}` };
  }
}
