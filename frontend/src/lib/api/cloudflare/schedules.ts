// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: server-side-cron-v1-schedule-api-client

const MODULE_REVISION = 'server-side-cron-v1-schedule-api-client';
console.log(`[schedules-api] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import { API } from "@/config/env";
import { apiGet, apiPost, apiPut, apiDelete } from "../client";

export interface Schedule {
  id: string;
  recipeId: string | null;
  dashboardId: string | null;
  dashboardItemId: string | null;
  command: string | null;
  name: string;
  cron: string | null;
  eventTrigger: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface ScheduleExecutionTerminal {
  itemId: string;
  ptyId: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timed_out';
  lastMessage: string | null;
  error: string | null;
}

export interface ScheduleExecution {
  id: string;
  scheduleId: string;
  status: 'running' | 'completed' | 'failed' | 'timed_out';
  triggeredBy: 'cron' | 'manual' | 'event';
  terminals: ScheduleExecutionTerminal[];
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

interface SchedulesResponse {
  schedules: Schedule[];
}

interface ScheduleResponse {
  schedule: Schedule;
}

interface TriggerResponse {
  schedule: Schedule;
  execution: ScheduleExecution | null;
}

interface ExecutionsResponse {
  executions: ScheduleExecution[];
}

/**
 * Get the schedule for a specific dashboard item (schedule block).
 */
export async function getScheduleByItem(dashboardId: string, itemId: string): Promise<Schedule | null> {
  const url = `${API.cloudflare.schedules}?dashboard_id=${encodeURIComponent(dashboardId)}&dashboard_item_id=${encodeURIComponent(itemId)}`;
  const response = await apiGet<SchedulesResponse>(url);
  return response.schedules?.[0] || null;
}

/**
 * Create a new edge-based schedule for a dashboard item.
 */
export async function createSchedule(data: {
  dashboardId: string;
  dashboardItemId: string;
  name: string;
  cron: string;
  command?: string;
  enabled?: boolean;
}): Promise<Schedule> {
  const response = await apiPost<ScheduleResponse>(API.cloudflare.schedules, data);
  return response.schedule;
}

/**
 * Update an existing schedule.
 */
export async function updateSchedule(id: string, data: {
  name?: string;
  cron?: string;
  command?: string;
  enabled?: boolean;
}): Promise<Schedule> {
  const response = await apiPut<ScheduleResponse>(`${API.cloudflare.schedules}/${id}`, data);
  return response.schedule;
}

/**
 * Delete a schedule.
 */
export async function deleteSchedule(id: string): Promise<void> {
  await apiDelete<void>(`${API.cloudflare.schedules}/${id}`);
}

/**
 * Enable a schedule.
 */
export async function enableSchedule(id: string): Promise<Schedule> {
  const response = await apiPost<ScheduleResponse>(`${API.cloudflare.schedules}/${id}/enable`);
  return response.schedule;
}

/**
 * Disable a schedule.
 */
export async function disableSchedule(id: string): Promise<Schedule> {
  const response = await apiPost<ScheduleResponse>(`${API.cloudflare.schedules}/${id}/disable`);
  return response.schedule;
}

/**
 * Trigger a schedule manually (Run Now).
 */
export async function triggerSchedule(id: string): Promise<TriggerResponse> {
  return apiPost<TriggerResponse>(`${API.cloudflare.schedules}/${id}/trigger`);
}

/**
 * List recent executions for a schedule.
 */
export async function listScheduleExecutions(scheduleId: string): Promise<ScheduleExecution[]> {
  const response = await apiGet<ExecutionsResponse>(`${API.cloudflare.schedules}/${scheduleId}/executions`);
  return response.executions || [];
}
