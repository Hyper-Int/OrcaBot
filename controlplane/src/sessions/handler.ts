// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

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

function parseBооtCоmmand(content: unknown): string {
  if (typeof content !== 'string') {
    return '';
  }
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) {
    return '';
  }
  try {
    const parsed = JSON.parse(trimmed) as { bootCommand?: string };
    return typeof parsed.bootCommand === 'string' ? parsed.bootCommand : '';
  } catch {
    return '';
  }
}

async function getDashbоardSandbоx(env: Env, dashboardId: string) {
  return env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?
  `).bind(dashboardId).first<{
    sandbox_session_id: string;
    sandbox_machine_id: string;
  }>();
}

function driveManifestKey(dashboardId: string): string {
  return `drive/${dashboardId}/manifest.json`;
}

async function triggerDriveMirrorSync(
  env: Env,
  dashboardId: string,
  sandboxSessionId: string,
  sandboxMachineId: string
) {
  const mirror = await env.DB.prepare(`
    SELECT folder_name FROM drive_mirrors
    WHERE dashboard_id = ?
  `).bind(dashboardId).first<{ folder_name: string }>();

  if (!mirror) {
    return;
  }

  const manifest = await env.DRIVE_CACHE.head(driveManifestKey(dashboardId));
  if (!manifest) {
    return;
  }

  await env.DB.prepare(`
    UPDATE drive_mirrors
    SET status = 'syncing_workspace', sync_error = null, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();

  await fetch(`${env.SANDBOX_URL.replace(/\/$/, '')}/sessions/${sandboxSessionId}/drive/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': env.SANDBOX_INTERNAL_TOKEN,
      ...(sandboxMachineId ? { 'X-Sandbox-Machine-ID': sandboxMachineId } : {}),
    },
    body: JSON.stringify({
      dashboard_id: dashboardId,
      folder_name: mirror.folder_name,
    }),
  });
}

// Create a session for a terminal item
export async function createSessiоn(
  env: Env,
  dashboardId: string,
  itemId: string,
  userId: string,
  userName: string
): Promise<Response> {
  // Check access
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79201: Not found or no access' }, { status: 404 });
  }

  // Check if item exists and is a terminal
  const item = await env.DB.prepare(`
    SELECT * FROM dashboard_items WHERE id = ? AND dashboard_id = ? AND type = 'terminal'
  `).bind(itemId, dashboardId).first();

  if (!item) {
    return Response.json({ error: 'E79202: Terminal item not found' }, { status: 404 });
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
        ownerUserId: existingSession.owner_user_id,
        ownerName: existingSession.owner_name,
        sandboxSessionId: existingSession.sandbox_session_id,
        sandboxMachineId: existingSession.sandbox_machine_id,
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
    INSERT INTO sessions (id, dashboard_id, item_id, owner_user_id, owner_name, sandbox_session_id, sandbox_machine_id, pty_id, status, region, created_at)
    VALUES (?, ?, ?, ?, ?, '', '', '', 'creating', 'local', ?)
  `).bind(id, dashboardId, itemId, userId, userName, now).run();

  // Create sandbox session and PTY
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);

  try {
    const bootCommand = parseBооtCоmmand(item.content);
    const existingSandbox = await getDashbоardSandbоx(env, dashboardId);
    let sandboxSessionId = existingSandbox?.sandbox_session_id || '';
    let sandboxMachineId = existingSandbox?.sandbox_machine_id || '';

    if (!sandboxSessionId) {
      const sandboxSession = await sandbox.createSessiоn();
      const insertResult = await env.DB.prepare(`
        INSERT OR IGNORE INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(dashboardId, sandboxSession.id, sandboxSession.machineId || '', now).run();

      if (insertResult.meta.changes === 0) {
        const reused = await getDashbоardSandbоx(env, dashboardId);
        if (reused?.sandbox_session_id) {
          sandboxSessionId = reused.sandbox_session_id;
          sandboxMachineId = reused.sandbox_machine_id || '';
        } else {
          sandboxSessionId = sandboxSession.id;
          sandboxMachineId = sandboxSession.machineId || '';
        }
        if (sandboxSessionId !== sandboxSession.id) {
          await sandbox.deleteSession(sandboxSession.id, sandboxSession.machineId);
        }
      } else {
        sandboxSessionId = sandboxSession.id;
        sandboxMachineId = sandboxSession.machineId || '';
      }
    }

    // Create PTY within the dashboard sandbox, assigning control to the creator
    const pty = await sandbox.createPty(sandboxSessionId, userId, bootCommand, sandboxMachineId);

    // Update with sandbox session ID and PTY ID
    await env.DB.prepare(`
      UPDATE sessions SET sandbox_session_id = ?, sandbox_machine_id = ?, pty_id = ?, status = 'active' WHERE id = ?
    `).bind(sandboxSessionId, sandboxMachineId, pty.id, id).run();

    const session: Session = {
      id,
      dashboardId,
      itemId,
      ownerUserId: userId,
      ownerName: userName,
      sandboxSessionId: sandboxSessionId,
      sandboxMachineId: sandboxMachineId,
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

    try {
      await triggerDriveMirrorSync(env, dashboardId, sandboxSessionId, sandboxMachineId);
    } catch {
      // Best-effort drive hydration.
    }

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
export async function getSessiоn(
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
    return Response.json({ error: 'E79203: Session not found or no access' }, { status: 404 });
  }

  return Response.json({
    session: {
      id: session.id,
      dashboardId: session.dashboard_id,
      itemId: session.item_id,
      ownerUserId: session.owner_user_id,
      ownerName: session.owner_name,
      sandboxSessionId: session.sandbox_session_id,
      sandboxMachineId: session.sandbox_machine_id,
      ptyId: session.pty_id,
      status: session.status,
      region: session.region,
      createdAt: session.created_at,
      stoppedAt: session.stopped_at,
    }
  });
}

// Stop a session
export async function stоpSessiоn(
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
    return Response.json({ error: 'E79203: Session not found or no access' }, { status: 404 });
  }

  if (session.status === 'stopped') {
    return Response.json({ error: 'E79204: Session already stopped' }, { status: 400 });
  }

  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);

  try {
    const otherSessions = await env.DB.prepare(`
      SELECT COUNT(1) as count FROM sessions
      WHERE dashboard_id = ? AND status IN ('creating', 'active') AND id != ?
    `).bind(session.dashboard_id, sessionId).first<{ count: number }>();

    if (!otherSessions || otherSessions.count === 0) {
      await sandbox.deleteSession(session.sandbox_session_id as string, session.sandbox_machine_id as string);
      await env.DB.prepare(`
        DELETE FROM dashboard_sandboxes WHERE dashboard_id = ?
      `).bind(session.dashboard_id).run();
    }
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
    ownerUserId: session.owner_user_id as string,
    ownerName: session.owner_name as string,
    sandboxSessionId: session.sandbox_session_id as string,
    sandboxMachineId: session.sandbox_machine_id as string,
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
