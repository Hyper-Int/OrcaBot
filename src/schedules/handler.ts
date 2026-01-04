/**
 * Schedule Handlers
 *
 * Manages cron and event-based triggers for recipes.
 * Schedules are durable - they survive restarts.
 */

import type { Env, Schedule } from '../types';
import * as recipes from '../recipes/handler';

function generateId(): string {
  return crypto.randomUUID();
}

// Parse cron expression and compute next run time
function computeNextRun(cron: string, from: Date = new Date()): Date | null {
  // Simple cron parser for basic expressions
  // Format: minute hour day month weekday
  // Supports: *, specific numbers, */n
  try {
    const parts = cron.split(' ');
    if (parts.length !== 5) return null;

    const [minute, hour, day, month, weekday] = parts;
    const next = new Date(from);
    next.setSeconds(0);
    next.setMilliseconds(0);

    // Simple implementation: just add 1 minute and check
    // A full implementation would properly parse cron expressions
    next.setMinutes(next.getMinutes() + 1);

    return next;
  } catch {
    return null;
  }
}

// List schedules
export async function listSchedules(
  env: Env,
  recipeId?: string
): Promise<Response> {
  let query = 'SELECT * FROM schedules';
  const params: string[] = [];

  if (recipeId) {
    query += ' WHERE recipe_id = ?';
    params.push(recipeId);
  }

  query += ' ORDER BY created_at DESC';

  const result = await env.DB.prepare(query).bind(...params).all();

  const schedules = result.results.map(s => ({
    id: s.id,
    recipeId: s.recipe_id,
    name: s.name,
    cron: s.cron,
    eventTrigger: s.event_trigger,
    enabled: Boolean(s.enabled),
    lastRunAt: s.last_run_at,
    nextRunAt: s.next_run_at,
    createdAt: s.created_at,
  }));

  return Response.json({ schedules });
}

// Get a single schedule
export async function getSchedule(
  env: Env,
  scheduleId: string
): Promise<Response> {
  const schedule = await env.DB.prepare(`
    SELECT * FROM schedules WHERE id = ?
  `).bind(scheduleId).first();

  if (!schedule) {
    return Response.json({ error: 'Schedule not found' }, { status: 404 });
  }

  return Response.json({
    schedule: {
      id: schedule.id,
      recipeId: schedule.recipe_id,
      name: schedule.name,
      cron: schedule.cron,
      eventTrigger: schedule.event_trigger,
      enabled: Boolean(schedule.enabled),
      lastRunAt: schedule.last_run_at,
      nextRunAt: schedule.next_run_at,
      createdAt: schedule.created_at,
    }
  });
}

// Create a schedule
export async function createSchedule(
  env: Env,
  data: {
    recipeId: string;
    name: string;
    cron?: string;
    eventTrigger?: string;
    enabled?: boolean;
  }
): Promise<Response> {
  // Verify recipe exists
  const recipe = await env.DB.prepare(`
    SELECT id FROM recipes WHERE id = ?
  `).bind(data.recipeId).first();

  if (!recipe) {
    return Response.json({ error: 'Recipe not found' }, { status: 404 });
  }

  if (!data.cron && !data.eventTrigger) {
    return Response.json({ error: 'Either cron or eventTrigger required' }, { status: 400 });
  }

  const id = generateId();
  const now = new Date().toISOString();
  const enabled = data.enabled !== false;

  let nextRunAt: string | null = null;
  if (data.cron && enabled) {
    const next = computeNextRun(data.cron);
    nextRunAt = next ? next.toISOString() : null;
  }

  await env.DB.prepare(`
    INSERT INTO schedules (id, recipe_id, name, cron, event_trigger, enabled, next_run_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    data.recipeId,
    data.name,
    data.cron || null,
    data.eventTrigger || null,
    enabled ? 1 : 0,
    nextRunAt,
    now
  ).run();

  const schedule: Schedule = {
    id,
    recipeId: data.recipeId,
    name: data.name,
    cron: data.cron || null,
    eventTrigger: data.eventTrigger || null,
    enabled,
    lastRunAt: null,
    nextRunAt,
    createdAt: now,
  };

  return Response.json({ schedule }, { status: 201 });
}

// Update a schedule
export async function updateSchedule(
  env: Env,
  scheduleId: string,
  data: {
    name?: string;
    cron?: string;
    eventTrigger?: string;
    enabled?: boolean;
  }
): Promise<Response> {
  const existing = await env.DB.prepare(`
    SELECT * FROM schedules WHERE id = ?
  `).bind(scheduleId).first();

  if (!existing) {
    return Response.json({ error: 'Schedule not found' }, { status: 404 });
  }

  const enabled = data.enabled !== undefined ? data.enabled : Boolean(existing.enabled);
  const cron = data.cron !== undefined ? data.cron : existing.cron as string | null;

  let nextRunAt = existing.next_run_at as string | null;
  if (cron && enabled) {
    const next = computeNextRun(cron);
    nextRunAt = next ? next.toISOString() : null;
  } else if (!enabled) {
    nextRunAt = null;
  }

  await env.DB.prepare(`
    UPDATE schedules SET
      name = COALESCE(?, name),
      cron = ?,
      event_trigger = ?,
      enabled = ?,
      next_run_at = ?
    WHERE id = ?
  `).bind(
    data.name || null,
    data.cron !== undefined ? data.cron : existing.cron,
    data.eventTrigger !== undefined ? data.eventTrigger : existing.event_trigger,
    enabled ? 1 : 0,
    nextRunAt,
    scheduleId
  ).run();

  const updated = await env.DB.prepare(`
    SELECT * FROM schedules WHERE id = ?
  `).bind(scheduleId).first();

  return Response.json({
    schedule: {
      id: updated!.id,
      recipeId: updated!.recipe_id,
      name: updated!.name,
      cron: updated!.cron,
      eventTrigger: updated!.event_trigger,
      enabled: Boolean(updated!.enabled),
      lastRunAt: updated!.last_run_at,
      nextRunAt: updated!.next_run_at,
      createdAt: updated!.created_at,
    }
  });
}

// Delete a schedule
export async function deleteSchedule(
  env: Env,
  scheduleId: string
): Promise<Response> {
  await env.DB.prepare(`DELETE FROM schedules WHERE id = ?`).bind(scheduleId).run();
  return new Response(null, { status: 204 });
}

// Enable a schedule
export async function enableSchedule(
  env: Env,
  scheduleId: string
): Promise<Response> {
  return updateSchedule(env, scheduleId, { enabled: true });
}

// Disable a schedule
export async function disableSchedule(
  env: Env,
  scheduleId: string
): Promise<Response> {
  return updateSchedule(env, scheduleId, { enabled: false });
}

// Trigger a schedule manually
export async function triggerSchedule(
  env: Env,
  scheduleId: string
): Promise<Response> {
  const schedule = await env.DB.prepare(`
    SELECT * FROM schedules WHERE id = ?
  `).bind(scheduleId).first();

  if (!schedule) {
    return Response.json({ error: 'Schedule not found' }, { status: 404 });
  }

  // Start execution
  const executionResponse = await recipes.startExecution(
    env,
    schedule.recipe_id as string,
    { triggeredBy: 'manual', scheduleId }
  );

  // Update last run
  const now = new Date().toISOString();
  let nextRunAt: string | null = null;
  if (schedule.cron && schedule.enabled) {
    const next = computeNextRun(schedule.cron as string);
    nextRunAt = next ? next.toISOString() : null;
  }

  await env.DB.prepare(`
    UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?
  `).bind(now, nextRunAt, scheduleId).run();

  const executionData = await executionResponse.json() as { execution: unknown };
  return Response.json({
    schedule: {
      id: schedule.id,
      recipeId: schedule.recipe_id,
      name: schedule.name,
      lastRunAt: now,
      nextRunAt,
    },
    execution: executionData.execution,
  });
}

// Process due schedules (called by cron trigger)
export async function processDueSchedules(env: Env): Promise<void> {
  const now = new Date().toISOString();

  // Find all enabled schedules with cron that are due
  const dueSchedules = await env.DB.prepare(`
    SELECT * FROM schedules
    WHERE enabled = 1 AND cron IS NOT NULL AND next_run_at <= ?
  `).bind(now).all();

  for (const schedule of dueSchedules.results) {
    try {
      // Start execution
      await recipes.startExecution(
        env,
        schedule.recipe_id as string,
        { triggeredBy: 'cron', scheduleId: schedule.id }
      );

      // Compute next run
      const next = computeNextRun(schedule.cron as string);
      const nextRunAt = next ? next.toISOString() : null;

      // Update last run and next run
      await env.DB.prepare(`
        UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?
      `).bind(now, nextRunAt, schedule.id).run();
    } catch (error) {
      console.error(`Failed to process schedule ${schedule.id}:`, error);
    }
  }
}

// Emit an event (triggers event-based schedules)
export async function emitEvent(
  env: Env,
  eventName: string,
  payload?: Record<string, unknown>
): Promise<Response> {
  // Find all enabled schedules with matching event trigger
  const schedules = await env.DB.prepare(`
    SELECT * FROM schedules
    WHERE enabled = 1 AND event_trigger = ?
  `).bind(eventName).all();

  const executions: unknown[] = [];
  const now = new Date().toISOString();

  for (const schedule of schedules.results) {
    try {
      const executionResponse = await recipes.startExecution(
        env,
        schedule.recipe_id as string,
        { triggeredBy: 'event', eventName, payload, scheduleId: schedule.id }
      );

      const executionData = await executionResponse.json() as { execution: unknown };
      executions.push(executionData.execution);

      // Update last run
      await env.DB.prepare(`
        UPDATE schedules SET last_run_at = ? WHERE id = ?
      `).bind(now, schedule.id).run();
    } catch (error) {
      console.error(`Failed to trigger schedule ${schedule.id} for event ${eventName}:`, error);
    }
  }

  return Response.json({
    event: eventName,
    schedulesTriggered: schedules.results.length,
    executions,
  });
}
