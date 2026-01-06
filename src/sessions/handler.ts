/**
 * Session Coordination Handlers
 *
 * Maps dashboard terminal items to sandbox sessions.
 * This is the bridge between the control plane and execution plane.
 */

import type { Env, Session } from '../types';
import { SandboxClient } from '../sandbox/client';

function generateId(): string {
  return crypto.randomUUID();
}

// Create a session for a terminal item
export async function createSession(
  env: Env,
  dashboardId: string,
  itemId: string,
  userId: string
): Promise<Response> {
  // Check access
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'Not found or no access' }, { status: 404 });
  }

  // Check if item exists and is a terminal
  const item = await env.DB.prepare(`
    SELECT * FROM dashboard_items WHERE id = ? AND dashboard_id = ? AND type = 'terminal'
  `).bind(itemId, dashboardId).first();

  if (!item) {
    return Response.json({ error: 'Terminal item not found' }, { status: 404 });
  }

  // Check if session already exists for this item
  const existingSession = await env.DB.prepare(`
    SELECT * FROM sessions WHERE item_id = ? AND status IN ('creating', 'active')
  `).bind(itemId).first();

  if (existingSession) {
    return Response.json({
      session: {
        id: existingSession.id,
        dashboardId: existingSession.dashboard_id,
        itemId: existingSession.item_id,
        sandboxSessionId: existingSession.sandbox_session_id,
        ptyId: existingSession.pty_id,
        status: existingSession.status,
        region: existingSession.region,
        createdAt: existingSession.created_at,
        stoppedAt: existingSession.stopped_at,
      }
    });
  }

  const id = generateId();
  const now = new Date().toISOString();

  // Create session record first
  await env.DB.prepare(`
    INSERT INTO sessions (id, dashboard_id, item_id, sandbox_session_id, pty_id, status, region, created_at)
    VALUES (?, ?, ?, '', '', 'creating', 'local', ?)
  `).bind(id, dashboardId, itemId, now).run();

  // Create sandbox session and PTY
  const sandbox = new SandboxClient(env.SANDBOX_URL);

  try {
    // Create sandbox session
    const sandboxSession = await sandbox.createSession();

    // Create PTY within the session, assigning control to the creator
    const pty = await sandbox.createPty(sandboxSession.id, userId);

    // Update with sandbox session ID and PTY ID
    await env.DB.prepare(`
      UPDATE sessions SET sandbox_session_id = ?, pty_id = ?, status = 'active' WHERE id = ?
    `).bind(sandboxSession.id, pty.id, id).run();

    const session: Session = {
      id,
      dashboardId,
      itemId,
      sandboxSessionId: sandboxSession.id,
      ptyId: pty.id,
      status: 'active',
      region: 'local',
      createdAt: now,
      stoppedAt: null,
    };

    // Notify Durable Object
    const doId = env.DASHBOARD.idFromName(dashboardId);
    const stub = env.DASHBOARD.get(doId);
    await stub.fetch(new Request('http://do/session', {
      method: 'PUT',
      body: JSON.stringify(session),
    }));

    return Response.json({ session }, { status: 201 });
  } catch (error) {
    // Update status to error
    await env.DB.prepare(`
      UPDATE sessions SET status = 'error' WHERE id = ?
    `).bind(id).run();

    return Response.json({
      error: `Failed to create sandbox session: ${error instanceof Error ? error.message : 'Unknown error'}`
    }, { status: 500 });
  }
}

// Get session for an item
export async function getSession(
  env: Env,
  sessionId: string,
  userId: string
): Promise<Response> {
  const session = await env.DB.prepare(`
    SELECT s.*, dm.role FROM sessions s
    JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
    WHERE s.id = ? AND dm.user_id = ?
  `).bind(sessionId, userId).first();

  if (!session) {
    return Response.json({ error: 'Session not found or no access' }, { status: 404 });
  }

  return Response.json({
    session: {
      id: session.id,
      dashboardId: session.dashboard_id,
      itemId: session.item_id,
      sandboxSessionId: session.sandbox_session_id,
      ptyId: session.pty_id,
      status: session.status,
      region: session.region,
      createdAt: session.created_at,
      stoppedAt: session.stopped_at,
    }
  });
}

// Stop a session
export async function stopSession(
  env: Env,
  sessionId: string,
  userId: string
): Promise<Response> {
  const session = await env.DB.prepare(`
    SELECT s.*, dm.role FROM sessions s
    JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
    WHERE s.id = ? AND dm.user_id = ? AND dm.role IN ('owner', 'editor')
  `).bind(sessionId, userId).first();

  if (!session) {
    return Response.json({ error: 'Session not found or no access' }, { status: 404 });
  }

  if (session.status === 'stopped') {
    return Response.json({ error: 'Session already stopped' }, { status: 400 });
  }

  const sandbox = new SandboxClient(env.SANDBOX_URL);

  try {
    await sandbox.deleteSession(session.sandbox_session_id as string);
  } catch {
    // Ignore errors - sandbox might already be gone
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE sessions SET status = 'stopped', stopped_at = ? WHERE id = ?
  `).bind(now, sessionId).run();

  const updatedSession: Session = {
    id: session.id as string,
    dashboardId: session.dashboard_id as string,
    itemId: session.item_id as string,
    sandboxSessionId: session.sandbox_session_id as string,
    ptyId: session.pty_id as string,
    status: 'stopped',
    region: session.region as string,
    createdAt: session.created_at as string,
    stoppedAt: now,
  };

  // Notify Durable Object
  const doId = env.DASHBOARD.idFromName(session.dashboard_id as string);
  const stub = env.DASHBOARD.get(doId);
  await stub.fetch(new Request('http://do/session', {
    method: 'PUT',
    body: JSON.stringify(updatedSession),
  }));

  return new Response(null, { status: 204 });
}
