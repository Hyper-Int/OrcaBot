// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: session-liveness-v1-before-restart
export const sessionLivenessRevision = "session-liveness-v1-before-restart";
console.log(`[session-liveness] REVISION: ${sessionLivenessRevision} loaded at ${new Date().toISOString()}`);

/**
 * Is a terminal's process still running on the sandbox?
 *
 * The dashboard page used to replace a terminal whenever its WebSocket gave up (10
 * failed reconnects) or a reconnect showed no output for 8s. A backgrounded browser tab
 * (Safari suspends its sockets and timers) trips both while the terminal is fine, and
 * replacing it kills the running process: on 2026-11-24 a PokerBench game's engine
 * terminal was restarted four times and three agent terminals once each, all healthy.
 * Now the page asks here first and only replaces a terminal whose process is gone;
 * a live one it just reconnects to.
 *
 *   GET /sessions/:id/alive → { alive: true | false | null, reason, revision }
 *
 * The sandbox drops a PTY from its session's list when the process exits (the hub's
 * onStop), so "listed" means running. null = couldn't tell (sandbox unreachable or
 * erroring): the caller must not destroy anything on null.
 */

import type { Env } from '../types';
import { sandboxFetch } from '../sandbox/fetch';

type Liveness = { alive: boolean | null; reason: string };

function reply(l: Liveness): Response {
  return Response.json({ ...l, revision: sessionLivenessRevision });
}

export async function getSessionLiveness(env: Env, sessionId: string, userId: string): Promise<Response> {
  const session = await env.DB.prepare(
    `SELECT dashboard_id, pty_id, status, sandbox_session_id, sandbox_machine_id FROM sessions WHERE id = ?`,
  ).bind(sessionId).first<{
    dashboard_id: string; pty_id: string; status: string; sandbox_session_id: string; sandbox_machine_id: string;
  }>();
  // Anyone who can see the dashboard may ask; it reveals nothing but running or not.
  const member = session && await env.DB.prepare(
    `SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?`,
  ).bind(session.dashboard_id, userId).first<{ role: string }>();
  if (!session || !member) {
    return Response.json({ error: 'E79205: Session not found or no access' }, { status: 404 });
  }
  if (session.status === 'stopped' || session.status === 'error') return reply({ alive: false, reason: `session ${session.status}` });
  if (!session.pty_id) return reply({ alive: false, reason: 'no pty' });

  // The dashboard's current VM session. If the dashboard has moved on (VM replaced or its
  // session recreated), this terminal's PTY went with the old one.
  const sandbox = await env.DB.prepare(
    `SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?`,
  ).bind(session.dashboard_id).first<{ sandbox_session_id: string; sandbox_machine_id: string | null }>();
  if (!sandbox?.sandbox_session_id) return reply({ alive: false, reason: 'no sandbox' });
  if (sandbox.sandbox_session_id !== session.sandbox_session_id) return reply({ alive: false, reason: 'sandbox session replaced' });
  const machineId = sandbox.sandbox_machine_id || '';
  if (machineId && session.sandbox_machine_id && machineId !== session.sandbox_machine_id) {
    return reply({ alive: false, reason: 'machine replaced' });
  }

  let res: Response;
  try {
    res = await sandboxFetch(env, `/sessions/${session.sandbox_session_id}/ptys`, {
      machineId: machineId || undefined,
      timeoutMs: 5_000,
      retries: 0,
    });
  } catch (e) {
    console.warn(`[session-liveness] E79206: sandbox unreachable for session ${sessionId}:`, e);
    return reply({ alive: null, reason: 'sandbox unreachable' });
  }
  if (res.status === 404) return reply({ alive: false, reason: 'sandbox session gone' });
  if (!res.ok) return reply({ alive: null, reason: `sandbox ${res.status}` });
  let body: { ptys?: Array<{ id?: string }> };
  try {
    body = await res.json();
  } catch {
    return reply({ alive: null, reason: 'bad sandbox reply' });
  }
  const alive = (body.ptys || []).some((p) => p.id === session.pty_id);
  return reply({ alive, reason: alive ? 'running' : 'pty exited' });
}
