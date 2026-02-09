// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: server-side-cron-v7-task-tracking

/**
 * Edge-Based Schedule Executor
 *
 * When an edge-based schedule fires, this module:
 * 1. Resolves dashboard edges from the schedule block to find connected terminal blocks
 * 2. Ensures the sandbox is running (wakes it if stopped)
 * 3. For each connected terminal: creates a PTY or writes to an existing one
 * 4. Tracks execution progress in schedule_executions table
 * 5. Creates agent tasks for visibility in the Tasks panel
 *
 * The sandbox reports completion via POST /internal/schedule-executions/:id/pty-completed
 */

const MODULE_REVISION = 'server-side-cron-v7-task-tracking';
console.log(`[executor] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import type { Env, Schedule, ScheduleExecution, ScheduleExecutionTerminal } from '../types';
import type { EnvWithDriveCache } from '../storage/drive-cache';
import { ensureDashbоardSandbоx } from '../sessions/handler';
import { SandboxClient } from '../sandbox/client';
import { createPtyToken } from '../auth/pty-token';
import { createTaskInternal, updateTaskStatusInternal } from '../agent-state/handler';

function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Execute an edge-based schedule by resolving dashboard edges and triggering connected terminals.
 * Returns the created ScheduleExecution record.
 */
export async function executeScheduleByEdges(
  env: Env,
  schedule: Schedule,
  triggeredBy: 'cron' | 'manual' | 'event',
  actorUserId?: string,
): Promise<ScheduleExecution> {
  const dashboardId = schedule.dashboardId;
  const itemId = schedule.dashboardItemId;

  if (!dashboardId || !itemId) {
    throw new Error('Edge-based schedule requires dashboardId and dashboardItemId');
  }

  // 1. Resolve edges from schedule block to find connected terminal blocks
  const edges = await env.DB.prepare(`
    SELECT e.target_item_id, i.type
    FROM dashboard_edges e
    INNER JOIN dashboard_items i ON e.target_item_id = i.id
    WHERE e.source_item_id = ?
      AND i.type = 'terminal'
  `).bind(itemId).all();

  const terminalItemIds = edges.results.map(e => e.target_item_id as string);

  // Build initial terminals list for execution tracking
  const terminals: ScheduleExecutionTerminal[] = terminalItemIds.map(id => ({
    itemId: id,
    ptyId: null,
    status: 'pending',
    lastMessage: null,
    error: null,
  }));

  // Create execution record
  const executionId = generateId();
  const now = new Date().toISOString();

  const executionStatus = terminals.length === 0 ? 'completed' : 'running';

  await env.DB.prepare(`
    INSERT INTO schedule_executions (id, schedule_id, status, triggered_by, terminals_json, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    executionId,
    schedule.id,
    executionStatus,
    triggeredBy,
    JSON.stringify(terminals),
    now,
    terminals.length === 0 ? now : null,
  ).run();

  if (terminals.length === 0) {
    console.log(`[executor] Schedule ${schedule.id} has no connected terminals — marked complete`);
    return {
      id: executionId,
      scheduleId: schedule.id,
      status: 'completed',
      triggeredBy,
      terminals: [],
      startedAt: now,
      completedAt: now,
      error: null,
    };
  }

  // Create an agent task to track this scheduled execution
  let agentTaskId: string | undefined;
  try {
    const scheduleName = schedule.name || `Schedule ${schedule.id.slice(0, 8)}`;
    const agentTask = await createTaskInternal(env, {
      dashboardId,
      subject: `[Scheduled] ${scheduleName}`,
      description: schedule.command
        ? `Executing: ${schedule.command}`
        : `Running scheduled task on ${terminals.length} terminal(s)`,
      ownerAgent: 'scheduler',
      metadata: {
        scheduleId: schedule.id,
        executionId,
        triggeredBy,
        terminalCount: terminals.length,
      },
    });
    agentTaskId = agentTask.id;
    console.log(`[executor] Created agent task ${agentTaskId} for schedule ${schedule.id}`);
  } catch (error) {
    console.error('[executor] Failed to create agent task:', error);
    // Non-fatal: continue with execution even if task creation fails
  }

  // 2. Ensure sandbox is running
  // For manual triggers, use the triggering user's identity (prevents privilege escalation).
  // For cron/event triggers, fall back to the dashboard owner.
  let effectiveUserId = actorUserId;
  if (!effectiveUserId) {
    const owner = await env.DB.prepare(`
      SELECT user_id FROM dashboard_members
      WHERE dashboard_id = ? AND role = 'owner'
      LIMIT 1
    `).bind(dashboardId).first<{ user_id: string }>();

    if (!owner) {
      await markExecutionFailed(env, executionId, 'Dashboard has no owner');
      throw new Error(`Dashboard ${dashboardId} has no owner`);
    }
    effectiveUserId = owner.user_id;
  }

  const envWithCache = env as EnvWithDriveCache;
  const sandboxResult = await ensureDashbоardSandbоx(envWithCache, dashboardId, effectiveUserId);

  if (sandboxResult instanceof Response) {
    await markExecutionFailed(env, executionId, 'Failed to ensure sandbox');
    throw new Error('Failed to ensure sandbox for dashboard');
  }

  const { sandboxSessionId, sandboxMachineId } = sandboxResult;
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);

  // 3. For each connected terminal, trigger execution
  for (let i = 0; i < terminals.length; i++) {
    const terminal = terminals[i];

    try {
      // Check if terminal has an active session with a PTY
      const activeSession = await env.DB.prepare(`
        SELECT id, pty_id, sandbox_session_id, sandbox_machine_id
        FROM sessions
        WHERE item_id = ? AND status = 'active'
        ORDER BY created_at DESC LIMIT 1
      `).bind(terminal.itemId).first();

      if (activeSession?.pty_id) {
        // Terminal has an active PTY — write command to it
        const command = (schedule.command || '').trim();
        terminal.ptyId = activeSession.pty_id as string;

        if (!command) {
          // No command to run — mark terminal completed immediately (no-op)
          terminal.status = 'completed';
          console.log(`[executor] No command for existing PTY ${terminal.ptyId} — marked completed`);
        } else {
          // Fire-and-forget: dispatch command to existing PTY and mark completed immediately.
          // A long-running shell PTY won't exit after a single command, so we can't rely on
          // process-exit callbacks. The command was successfully dispatched — that's success.
          await sandbox.writePty(
            activeSession.sandbox_session_id as string,
            activeSession.pty_id as string,
            command,
            activeSession.sandbox_machine_id as string || sandboxMachineId,
            // No executionId — fire-and-forget, no callback needed
          );

          terminal.status = 'completed';
          console.log(`[executor] Wrote command to existing PTY ${terminal.ptyId} for terminal ${terminal.itemId} — marked completed (fire-and-forget)`);
        }
      } else {
        // No active PTY — need a command to justify creating one
        const command = (schedule.command || '').trim();
        if (!command) {
          // No command and no existing PTY — nothing to do, mark completed
          terminal.status = 'completed';
          console.log(`[executor] No command and no active PTY for terminal ${terminal.itemId} — marked completed`);
        } else {
          // Create a new PTY with the command as boot command
          const ptyId = generateId();
          const integrationToken = await createPtyToken(
            ptyId,
            sandboxSessionId,
            dashboardId,
            effectiveUserId,
            env.INTERNAL_API_TOKEN
          );

          terminal.ptyId = ptyId;
          terminal.status = 'running';

          // Persist ptyId to DB BEFORE creating PTY so the sandbox callback
          // (which may fire immediately) can find this terminal by ptyId.
          await env.DB.prepare(`
            UPDATE schedule_executions SET terminals_json = ? WHERE id = ?
          `).bind(JSON.stringify(terminals), executionId).run();

          await sandbox.createPty(
            sandboxSessionId,
            'system', // creatorId
            command,
            sandboxMachineId,
            {
              ptyId,
              integrationToken,
              executionId, // Set at creation time so callback is registered before process starts
            }
          );

          // Create a session record for tracking
          const sessionId = generateId();
          await env.DB.prepare(`
            INSERT INTO sessions (id, dashboard_id, item_id, owner_user_id, owner_name, sandbox_session_id, sandbox_machine_id, pty_id, status, created_at)
            VALUES (?, ?, ?, ?, 'system', ?, ?, ?, 'active', ?)
          `).bind(
            sessionId,
            dashboardId,
            terminal.itemId,
            effectiveUserId,
            sandboxSessionId,
            sandboxMachineId,
            ptyId,
            now,
          ).run();

          console.log(`[executor] Created PTY ${ptyId} for terminal ${terminal.itemId}`);
        }
      }
    } catch (error) {
      console.error(`[executor] Failed to trigger terminal ${terminal.itemId}:`, error);
      terminal.status = 'failed';
      terminal.error = error instanceof Error ? error.message : 'Unknown error';
    }
  }

  // Re-read the execution to merge any callback-driven updates that arrived
  // while we were iterating. Callbacks (handlePtyCompleted) may have already
  // marked terminals completed/failed and even finalized the execution.
  const latest = await env.DB.prepare(`
    SELECT status, terminals_json FROM schedule_executions WHERE id = ?
  `).bind(executionId).first<{ status: string; terminals_json: string }>();

  if (!latest || latest.status !== 'running') {
    // Execution was already finalized by callbacks — don't overwrite
    const finalTerminals = latest ? JSON.parse(latest.terminals_json) : terminals;
    const execStatus = (latest?.status || 'completed') as ScheduleExecution['status'];

    // Update agent task since execution is done
    if (agentTaskId) {
      try {
        const taskStatus = execStatus === 'failed' ? 'cancelled' : 'completed';
        await updateTaskStatusInternal(env, agentTaskId, taskStatus);
        console.log(`[executor] Updated agent task ${agentTaskId} to ${taskStatus} (callback-finalized)`);
      } catch (error) {
        console.error('[executor] Failed to update agent task:', error);
      }
    }

    return {
      id: executionId,
      scheduleId: schedule.id,
      status: execStatus,
      triggeredBy,
      terminals: finalTerminals,
      startedAt: now,
      completedAt: new Date().toISOString(),
      error: null,
    };
  }

  // Merge: for each terminal, prefer the DB state if a callback already updated it
  const dbTerminals: ScheduleExecutionTerminal[] = JSON.parse(latest.terminals_json);
  const isDone = (s: string) => s === 'completed' || s === 'failed' || s === 'timed_out';
  const mergedTerminals: ScheduleExecutionTerminal[] = terminals.map(local => {
    const dbEntry = dbTerminals.find(d => d.itemId === local.itemId);
    // If the DB entry was updated by a callback (done state), keep it
    if (dbEntry && isDone(dbEntry.status)) {
      return dbEntry;
    }
    // Otherwise use local state (which has our latest knowledge)
    return local;
  });

  const allDone = mergedTerminals.every(t => isDone(t.status));
  const allFailed = mergedTerminals.every(t => t.status === 'failed');
  const anyFailed = mergedTerminals.some(t => t.status === 'failed');

  let finalStatus: 'running' | 'completed' | 'failed';
  let finalError: string | null = null;
  if (allFailed) {
    finalStatus = 'failed';
    finalError = 'All terminals failed to trigger';
  } else if (allDone && anyFailed) {
    finalStatus = 'failed';
    finalError = 'One or more terminals failed';
  } else if (allDone) {
    finalStatus = 'completed';
  } else {
    finalStatus = 'running';
  }

  const completedAt = allDone ? new Date().toISOString() : null;

  // Only update if execution is still running (guard against late callbacks finalizing first)
  await env.DB.prepare(`
    UPDATE schedule_executions SET terminals_json = ?, status = ?, completed_at = COALESCE(?, completed_at), error = ?
    WHERE id = ? AND status = 'running'
  `).bind(JSON.stringify(mergedTerminals), finalStatus, completedAt, finalError, executionId).run();

  // Update agent task if execution is done
  if (agentTaskId && allDone) {
    try {
      const taskStatus = finalStatus === 'failed' ? 'cancelled' : 'completed';
      await updateTaskStatusInternal(env, agentTaskId, taskStatus, finalError || undefined);
      console.log(`[executor] Updated agent task ${agentTaskId} to ${taskStatus}`);
    } catch (error) {
      console.error('[executor] Failed to update agent task:', error);
    }
  }

  return {
    id: executionId,
    scheduleId: schedule.id,
    status: finalStatus,
    triggeredBy,
    terminals: mergedTerminals,
    startedAt: now,
    completedAt,
    error: finalError,
  };
}

async function markExecutionFailed(env: Env, executionId: string, error: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE schedule_executions SET status = 'failed', completed_at = datetime('now'), error = ? WHERE id = ?
  `).bind(error, executionId).run();
}
