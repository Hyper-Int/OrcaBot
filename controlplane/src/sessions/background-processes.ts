// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: background-processes-v1-restart-choice
const backgroundProcessesRevision = "background-processes-v1-restart-choice";
console.log(`[background-processes] REVISION: ${backgroundProcessesRevision} loaded at ${new Date().toISOString()}`);

/**
 * A terminal's leftover background processes, for the restart dialog.
 *
 * Restarting a terminal kills its PTY's process group; a process that detached from it
 * (a daemon, setsid) keeps running with that terminal's old environment. From the
 * 2026-11-22 PokerBench game: Codex's shared app-server daemon, started by an earlier
 * run of the Codex terminal, kept that run's ORCABOT_PTY_ID, so after a restart every
 * command Codex ran looked up a terminal that no longer existed.
 *
 * Before a user restarts a terminal, the frontend lists these and the user chooses which
 * to stop. The sandbox finds them by ORCABOT_PTY_ID; this layer decides who may ask
 * (owners and editors, as for restarting) and supplies the terminal's PTY ids — every
 * PTY its sessions ever had, from D1 — so a process left by an earlier run counts too.
 *
 *   GET  /sessions/:id/background-processes          → { processes, revision }
 *   POST /sessions/:id/background-processes/stop     { processes: [{ pid, startTicks }] }
 */

import type { Env } from '../types';
import { SandboxClient } from '../sandbox/client';

const MAX_PTY_IDS = 200;
const MAX_TARGETS = 200;

interface TerminalContext {
  dashboardId: string;
  itemId: string;
  sandboxSessionId: string;
  machineId: string;
  ptyIds: string[];
  currentPtyId: string;
}

async function loadTerminal(
  env: Env,
  sessionId: string,
  userId: string,
): Promise<TerminalContext | Response> {
  const session = await env.DB.prepare(
    `SELECT dashboard_id, item_id, pty_id FROM sessions WHERE id = ?`,
  ).bind(sessionId).first<{ dashboard_id: string; item_id: string; pty_id: string }>();
  // Owners and editors, as for restarting the terminal.
  const member = session && await env.DB.prepare(
    `SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?`,
  ).bind(session.dashboard_id, userId).first<{ role: string }>();
  if (!session || !member || (member.role !== 'owner' && member.role !== 'editor')) {
    return Response.json({ error: 'E79203: Session not found or no access' }, { status: 404 });
  }
  // The dashboard's current VM, not the session row's: a reprovision moves the
  // dashboard to a new VM, and that is where anything still running is.
  const sandbox = await env.DB.prepare(
    `SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?`,
  ).bind(session.dashboard_id).first<{ sandbox_session_id: string; sandbox_machine_id: string | null }>();
  const rows = await env.DB.prepare(
    `SELECT pty_id FROM sessions WHERE dashboard_id = ? AND item_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).bind(session.dashboard_id, session.item_id, MAX_PTY_IDS * 2).all<{ pty_id: string }>();
  const ptyIds = [...new Set((rows.results || []).map((r) => r.pty_id).filter(Boolean))].slice(0, MAX_PTY_IDS);
  return {
    dashboardId: session.dashboard_id,
    itemId: session.item_id,
    sandboxSessionId: sandbox?.sandbox_session_id || '',
    machineId: sandbox?.sandbox_machine_id || '',
    ptyIds,
    currentPtyId: session.pty_id || '',
  };
}

function sandboxClient(env: Env): SandboxClient {
  return new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN, env.SANDBOX_AUTH_SIGNING_KEY);
}

export async function listBackgroundProcesses(
  env: Env,
  sessionId: string,
  userId: string,
): Promise<Response> {
  const t = await loadTerminal(env, sessionId, userId);
  if (t instanceof Response) return t;
  if (!t.sandboxSessionId || t.ptyIds.length === 0) {
    return Response.json({ processes: [], revision: backgroundProcessesRevision });
  }
  try {
    const processes = await sandboxClient(env).listBackgroundProcesses(t.sandboxSessionId, t.ptyIds, t.machineId || undefined);
    return Response.json({
      processes: processes.map((p) => ({
        pid: p.pid,
        ppid: p.ppid,
        uid: p.uid,
        name: p.name,
        command: p.command,
        startTicks: p.start_ticks,
        startedAt: p.started_at,
        // false: left by an earlier run of this terminal (it has outlived a restart before)
        fromCurrentRun: !!t.currentPtyId && p.pty_id === t.currentPtyId,
      })),
      revision: backgroundProcessesRevision,
    });
  } catch (e) {
    // The restart must still work: the frontend restarts without asking.
    console.warn(`[background-processes] E79784: list failed for session ${sessionId}:`, e);
    return Response.json({ processes: [], unavailable: true, revision: backgroundProcessesRevision });
  }
}

export async function stopBackgroundProcesses(
  env: Env,
  request: Request,
  sessionId: string,
  userId: string,
): Promise<Response> {
  let body: { processes?: Array<{ pid?: unknown; startTicks?: unknown }> };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'E79783: invalid JSON body' }, { status: 400 });
  }
  const targets = (Array.isArray(body.processes) ? body.processes : [])
    .filter((p) => Number.isSafeInteger(p?.pid) && (p.pid as number) > 1
      && Number.isSafeInteger(p?.startTicks) && (p.startTicks as number) >= 0)
    .map((p) => ({ pid: p.pid as number, start_ticks: p.startTicks as number }));
  if (targets.length === 0 || targets.length > MAX_TARGETS) {
    return Response.json({ error: 'E79783: processes must list 1-200 { pid, startTicks }' }, { status: 400 });
  }
  const t = await loadTerminal(env, sessionId, userId);
  if (t instanceof Response) return t;
  if (!t.sandboxSessionId || t.ptyIds.length === 0) {
    return Response.json({ error: 'E79785: this terminal has no sandbox to stop processes in' }, { status: 409 });
  }
  console.log(`[background-processes] user ${userId} stopping ${targets.length} process(es) left by item ${t.itemId} on dashboard ${t.dashboardId}`);
  try {
    const results = await sandboxClient(env).stopBackgroundProcesses(t.sandboxSessionId, t.ptyIds, targets, t.machineId || undefined);
    return Response.json({ results, revision: backgroundProcessesRevision });
  } catch (e) {
    console.warn(`[background-processes] E79786: stop failed for session ${sessionId}:`, e);
    return Response.json({ error: 'E79786: could not reach the sandbox to stop the processes' }, { status: 502 });
  }
}
