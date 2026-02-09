// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: tasks-api-v8-session-scope-mutations

const MODULE_REVISION = 'tasks-api-v8-session-scope-mutations';
console.log(`[tasks-api] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import { API } from "@/config/env";
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from "../client";

export type AgentTaskStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
export type AgentMemoryType = 'fact' | 'context' | 'preference' | 'summary' | 'checkpoint';

export interface AgentTask {
  id: string;
  dashboardId: string;
  sessionId?: string;
  parentId?: string;
  subject: string;
  description?: string;
  status: AgentTaskStatus;
  priority: number;
  blockedBy: string[];
  blocks: string[];
  ownerAgent?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AgentMemory {
  id: string;
  dashboardId: string;
  sessionId?: string;
  key: string;
  value: unknown;
  memoryType: AgentMemoryType;
  tags: string[];
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface TasksResponse {
  tasks: AgentTask[];
}

interface TaskResponse {
  task: AgentTask;
}

interface MemoryListResponse {
  memories: AgentMemory[];
}

interface MemoryResponse {
  memory: AgentMemory;
}

// ===== Tasks API =====

/**
 * List all tasks for a dashboard
 *
 * When sessionId is provided, the server returns both dashboard-wide tasks
 * (session_id IS NULL) and tasks for that specific session.
 */
export async function listTasks(
  dashboardId: string,
  options?: {
    status?: AgentTaskStatus | AgentTaskStatus[];
    sessionId?: string;
    includeCompleted?: boolean;
  }
): Promise<AgentTask[]> {
  console.log(`[tasks-api] listTasks called at ${new Date().toISOString()}`, { dashboardId, options });
  const params = new URLSearchParams();
  if (options?.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    statuses.forEach(s => params.append('status', s));
  }
  if (options?.sessionId) params.set('session_id', options.sessionId);
  if (options?.includeCompleted) params.set('include_completed', 'true');

  const queryString = params.toString();
  const url = queryString
    ? `${API.cloudflare.dashboardTasks(dashboardId)}?${queryString}`
    : API.cloudflare.dashboardTasks(dashboardId);

  const tasks = (await apiGet<TasksResponse>(url)).tasks || [];
  return tasks;
}

/**
 * Get a specific task
 */
export async function getTask(dashboardId: string, taskId: string): Promise<AgentTask> {
  console.log(`[tasks-api] getTask called at ${new Date().toISOString()}`, { dashboardId, taskId });
  const response = await apiGet<TaskResponse>(
    `${API.cloudflare.dashboardTasks(dashboardId)}/${taskId}`
  );
  return response.task;
}

/**
 * Create a new task
 */
export async function createTask(
  dashboardId: string,
  data: {
    subject: string;
    description?: string;
    sessionId?: string;
    parentId?: string;
    priority?: number;
    blockedBy?: string[];
    ownerAgent?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<AgentTask> {
  console.log(`[tasks-api] createTask called at ${new Date().toISOString()}`, { dashboardId, subject: data.subject });
  const response = await apiPost<TaskResponse>(
    API.cloudflare.dashboardTasks(dashboardId),
    data
  );
  return response.task;
}

/**
 * Update a task
 *
 * When updating session-scoped tasks, pass sessionId to access them.
 * Without sessionId, only dashboard-wide tasks can be updated.
 */
export async function updateTask(
  dashboardId: string,
  taskId: string,
  data: {
    subject?: string;
    description?: string;
    status?: AgentTaskStatus;
    priority?: number;
    addBlockedBy?: string[];
    removeBlockedBy?: string[];
    ownerAgent?: string;
    metadata?: Record<string, unknown>;
  },
  options?: { sessionId?: string }
): Promise<AgentTask> {
  console.log(`[tasks-api] updateTask called at ${new Date().toISOString()}`, { dashboardId, taskId, data, sessionId: options?.sessionId });
  const url = options?.sessionId
    ? `${API.cloudflare.dashboardTasks(dashboardId)}/${taskId}?session_id=${encodeURIComponent(options.sessionId)}`
    : `${API.cloudflare.dashboardTasks(dashboardId)}/${taskId}`;
  const response = await apiPatch<TaskResponse>(url, data);
  return response.task;
}

/**
 * Delete a task
 *
 * When deleting session-scoped tasks, pass sessionId to access them.
 * Without sessionId, only dashboard-wide tasks can be deleted.
 */
export async function deleteTask(
  dashboardId: string,
  taskId: string,
  options?: { sessionId?: string }
): Promise<void> {
  console.log(`[tasks-api] deleteTask called at ${new Date().toISOString()}`, { dashboardId, taskId, sessionId: options?.sessionId });
  const url = options?.sessionId
    ? `${API.cloudflare.dashboardTasks(dashboardId)}/${taskId}?session_id=${encodeURIComponent(options.sessionId)}`
    : `${API.cloudflare.dashboardTasks(dashboardId)}/${taskId}`;
  await apiDelete<void>(url);
}

// ===== Memory API =====

/**
 * List all memory entries for a dashboard
 */
export async function listMemory(
  dashboardId: string,
  options?: {
    sessionId?: string;
    memoryType?: AgentMemoryType;
    prefix?: string;
    tags?: string[];
  }
): Promise<AgentMemory[]> {
  console.log(`[tasks-api] listMemory called at ${new Date().toISOString()}`, { dashboardId, options });
  const params = new URLSearchParams();
  if (options?.sessionId) params.set('session_id', options.sessionId);
  if (options?.memoryType) params.set('memory_type', options.memoryType);
  if (options?.prefix) params.set('prefix', options.prefix);
  if (options?.tags && options.tags.length > 0) params.set('tags', options.tags.join(','));

  const queryString = params.toString();
  const url = queryString
    ? `${API.cloudflare.dashboardMemory(dashboardId)}?${queryString}`
    : API.cloudflare.dashboardMemory(dashboardId);

  const response = await apiGet<MemoryListResponse>(url);
  return response.memories || [];
}

/**
 * Get a memory entry by key
 */
export async function getMemory(dashboardId: string, key: string): Promise<AgentMemory | null> {
  console.log(`[tasks-api] getMemory called at ${new Date().toISOString()}`, { dashboardId, key });
  try {
    const response = await apiGet<MemoryResponse>(
      `${API.cloudflare.dashboardMemory(dashboardId)}/${encodeURIComponent(key)}`
    );
    return response.memory;
  } catch (error) {
    // 404 means no memory found
    if (error instanceof Error && 'status' in error && (error as { status: number }).status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Set a memory entry (upsert)
 */
export async function setMemory(
  dashboardId: string,
  data: {
    key: string;
    value: unknown;
    sessionId?: string;
    memoryType?: AgentMemoryType;
    tags?: string[];
    expiresIn?: number; // Expiration in seconds
  }
): Promise<AgentMemory> {
  console.log(`[tasks-api] setMemory called at ${new Date().toISOString()}`, { dashboardId, key: data.key });
  const { key, ...body } = data;
  const response = await apiPut<MemoryResponse>(
    `${API.cloudflare.dashboardMemory(dashboardId)}/${encodeURIComponent(key)}`,
    body
  );
  return response.memory;
}

/**
 * Delete a memory entry by key
 */
export async function deleteMemory(dashboardId: string, key: string): Promise<void> {
  console.log(`[tasks-api] deleteMemory called at ${new Date().toISOString()}`, { dashboardId, key });
  await apiDelete<void>(
    `${API.cloudflare.dashboardMemory(dashboardId)}/${encodeURIComponent(key)}`
  );
}
