// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: agent-link-v1-hub-owner
const MODULE_REVISION = 'agent-link-v1-hub-owner';
console.log(`[agents] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Agent blocks: outside AI agents (Grok Bot, Muse, Dots, Claude Code, Codex, ...)
 * that run on their own computers and connect to an agent hub with a small
 * connector. Their messages are end-to-end encrypted (MLS); the hub only relays
 * ciphertext.
 *
 * Who holds what:
 * - The hub issues each Orcabot user an **owner** identity ("orca:<hash>"),
 *   server to server with AGENT_HUB_PARTNER_SECRET. Its token stays here,
 *   encrypted in agent_hub_owners, and is used only to approve pairing codes and
 *   list or remove agents. It never goes to a VM (unlike user_secrets, which are
 *   pushed into the dashboard VM's environment).
 * - A user links an agent by typing the code its connector printed: we approve it
 *   with the owner token, and the agent becomes "orca:<hash>/agent:<name>".
 * - Each dashboard VM is a **linked device** of the dashboard owner
 *   ("orca:<hash>/device:dash-..."). The VM's client generates its own keys and
 *   asks us (dashboard-scoped token) to approve its device code; the device token
 *   goes straight from the hub to the VM. A device can message its owner's agents
 *   (to them it *is* the owner, so it wakes them) but can't approve new ones.
 * - A terminal can use an agent only if its canvas item has an edge to an Agent
 *   block holding that agent (terminalAgents, from D1 edges: works with no browser
 *   open and for dashboards made from templates).
 */

import type { Env } from '../types';
import type { AuthContext } from '../auth/middleware';
import { decryptSecret, encryptSecret, getEncryptionKey } from '../crypto/secrets';
import { dashboardSecretsOwner } from '../secrets/handler';
import { sandboxHeaders, sandboxUrl } from '../sandbox/fetch';

export interface LinkedAgent {
  identity: string;
  name: string;
  mode?: string;
}

export function hubConfigured(env: Env): boolean {
  return Boolean(env.AGENT_HUB_URL && env.AGENT_HUB_PARTNER_SECRET);
}

function hubUrl(env: Env): string {
  return (env.AGENT_HUB_URL || '').replace(/\/+$/, '');
}

/** The hub user id for an Orcabot user: a hash, so the hub never sees our user ids. */
export async function hubUserId(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`orcabot-agent-owner:${userId}`));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A dashboard VM's device name on the hub ([a-z0-9-], at most 32). */
export function deviceName(dashboardId: string): string {
  const clean = dashboardId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 27);
  return `dash-${clean || 'x'}`;
}

class HubError extends Error {
  constructor(public status: number, public code: string) {
    super(`hub ${status}: ${code}`);
  }
}

async function hubFetch(env: Env, path: string, init: { method: string; token: string; body?: unknown }): Promise<unknown> {
  const res = await fetch(`${hubUrl(env)}${path}`, {
    method: init.method,
    headers: { authorization: `Bearer ${init.token}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new HubError(res.status, typeof data.error === 'string' ? data.error : `http_${res.status}`);
  return data;
}

/** The user's hub owner, created on first use. Returns null when no hub is configured. */
export async function ensureOwner(env: Env, userId: string): Promise<{ identity: string; token: string } | null> {
  if (!hubConfigured(env)) return null;
  const key = await getEncryptionKey(env);
  const row = await env.DB.prepare('SELECT identity, token_enc FROM agent_hub_owners WHERE user_id = ?')
    .bind(userId).first<{ identity: string; token_enc: string }>();
  if (row) return { identity: row.identity, token: await decryptSecret(row.token_enc, key) };

  const user = await hubUserId(userId);
  let issued: { identity: string; token: string };
  try {
    issued = (await hubFetch(env, '/partner/owners', {
      method: 'POST', token: env.AGENT_HUB_PARTNER_SECRET!, body: { user },
    })) as { identity: string; token: string };
  } catch (e) {
    // Issued before but our row is gone (e.g. a restored database): take a new token.
    if (!(e instanceof HubError && e.status === 409)) throw e;
    issued = (await hubFetch(env, '/partner/owners', {
      method: 'POST', token: env.AGENT_HUB_PARTNER_SECRET!, body: { user, rotate: true },
    })) as { identity: string; token: string };
  }
  await env.DB.prepare(`
    INSERT INTO agent_hub_owners (user_id, identity, token_enc, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET identity = excluded.identity, token_enc = excluded.token_enc
  `).bind(userId, issued.identity, await encryptSecret(issued.token, key), new Date().toISOString()).run();
  return issued;
}

async function existingOwner(env: Env, userId: string): Promise<{ identity: string; token: string } | null> {
  if (!hubConfigured(env)) return null;
  const row = await env.DB.prepare('SELECT identity, token_enc FROM agent_hub_owners WHERE user_id = ?')
    .bind(userId).first<{ identity: string; token_enc: string }>();
  if (!row) return null;
  return { identity: row.identity, token: await decryptSecret(row.token_enc, await getEncryptionKey(env)) };
}

const PAIRING_CODE = /^[A-Z0-9]{8}$/;

function cleanCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return PAIRING_CODE.test(code) ? code : null;
}

function hubErrorResponse(e: unknown, fallback: string): Response {
  if (e instanceof HubError) {
    const code = e.code === 'unknown_code' ? 'E79950: unknown_code'
      : e.code.startsWith('too_many') ? `E79951: ${e.code}`
      : `E79952: ${e.code}`;
    return Response.json({ error: code }, { status: e.status === 404 ? 404 : e.status === 400 ? 400 : 502 });
  }
  console.error(`[agents] ${fallback}:`, e);
  return Response.json({ error: `E79953: ${fallback}` }, { status: 502 });
}

// --- user routes ---------------------------------------------------------------------

/** GET /agents: the user's linked agents, and the hub URL for setup instructions. */
export async function handleListAgents(env: Env, auth: AuthContext): Promise<Response> {
  if (!hubConfigured(env)) return Response.json({ enabled: false, hubUrl: '', agents: [] });
  const owner = await existingOwner(env, auth.user!.id);
  if (!owner) return Response.json({ enabled: true, hubUrl: hubUrl(env), agents: [] });
  try {
    const data = (await hubFetch(env, '/agents', { method: 'GET', token: owner.token })) as { agents?: LinkedAgent[] };
    const agents = (data.agents ?? []).map((a) => ({ identity: a.identity, name: a.name, mode: a.mode }));
    return Response.json({ enabled: true, hubUrl: hubUrl(env), agents });
  } catch (e) {
    return hubErrorResponse(e, 'could not list agents');
  }
}

/** POST /agents/link {code}: approve the pairing code an agent's connector printed. */
export async function handleLinkAgent(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  if (!hubConfigured(env)) return Response.json({ error: 'E79954: agent hub not configured' }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  const code = cleanCode(body?.code);
  if (!code) return Response.json({ error: 'E79955: bad_code' }, { status: 400 });
  try {
    const owner = await ensureOwner(env, auth.user!.id);
    const r = (await hubFetch(env, '/agents/pair/approve', {
      method: 'POST', token: owner!.token, body: { code, kind: 'agent' },
    })) as { identity: string; name: string; mode?: string };
    console.log(`[agents] user ${auth.user!.id} linked agent ${r.name}`);
    return Response.json({ agent: { identity: r.identity, name: r.name, mode: r.mode } });
  } catch (e) {
    return hubErrorResponse(e, 'could not link agent');
  }
}

/** DELETE /agents?identity=: disconnect one of the user's agents. */
export async function handleUnlinkAgent(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const identity = new URL(request.url).searchParams.get('identity') || '';
  const owner = await existingOwner(env, auth.user!.id);
  if (!owner || !identity.startsWith(`${owner.identity}/agent:`)) {
    return Response.json({ error: 'E79956: not found' }, { status: 404 });
  }
  try {
    await hubFetch(env, '/agents', { method: 'DELETE', token: owner.token, body: { identity } });
    return Response.json({ ok: true });
  } catch (e) {
    return hubErrorResponse(e, 'could not unlink agent');
  }
}

// --- chat with an agent, through the dashboard's VM ------------------------------------

type SandboxResolver = () => Promise<{ sandboxSessionId: string; sandboxMachineId: string } | Response>;

/**
 * GET/POST /dashboards/:id/agents/chat: the dashboard VM is the owner's device, so
 * chatting from it is chatting *as the owner*; only the dashboard owner may. (Other
 * members' terminals can still use agents connected to them by edges, as they use
 * the owner's secrets.) GET doesn't wake a sleeping VM; POST does.
 */
export async function handleAgentChat(
  request: Request, env: Env, auth: AuthContext, dashboardId: string, wake: SandboxResolver,
): Promise<Response> {
  const ownerId = await dashboardSecretsOwner(env, dashboardId);
  if (!ownerId || ownerId !== auth.user!.id) {
    return Response.json({ error: 'E79959: only the dashboard owner can chat with its agents' }, { status: 403 });
  }
  let target: { sandboxSessionId: string; sandboxMachineId: string };
  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?',
    ).bind(dashboardId).first<{ sandbox_session_id: string; sandbox_machine_id: string }>();
    if (!row?.sandbox_session_id) return Response.json({ status: 'no_sandbox', messages: [] }, { status: 409 });
    target = { sandboxSessionId: row.sandbox_session_id, sandboxMachineId: row.sandbox_machine_id };
  } else {
    const r = await wake();
    if (r instanceof Response) return r;
    target = r;
  }
  const url = sandboxUrl(env, `/sessions/${target.sandboxSessionId}/agent-link/chat`);
  url.search = new URL(request.url).search;
  url.searchParams.delete('surface');
  const headers = await sandboxHeaders(env, request.headers, target.sandboxMachineId, request.method, url);
  headers.delete('Host');
  try {
    return await fetch(new Request(url.toString(), {
      method: request.method, headers, redirect: 'manual',
      body: request.method === 'GET' ? undefined : request.body,
    }));
  } catch {
    return Response.json({ status: 'no_sandbox', messages: [] }, { status: 409 });
  }
}

// --- internal routes (the dashboard's VM, dashboard-scoped token) ---------------------

/** GET /internal/dashboards/:id/agent-link/config: where the VM's client connects, and as which device. */
export async function handleInternalAgentLinkConfig(env: Env, dashboardId: string): Promise<Response> {
  if (!hubConfigured(env)) return Response.json({ enabled: false });
  return Response.json({ enabled: true, hubUrl: hubUrl(env), device: deviceName(dashboardId) });
}

/**
 * POST /internal/dashboards/:id/agent-link/approve-device {code}: link the VM's
 * client as a device of the dashboard *owner* (whose agents its terminals use, as
 * with secrets). Only a device code, and only this dashboard's device name: a VM
 * can't use this to approve an agent, or a device for another dashboard.
 */
export async function handleInternalApproveDevice(request: Request, env: Env, dashboardId: string): Promise<Response> {
  if (!hubConfigured(env)) return Response.json({ error: 'E79954: agent hub not configured' }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  const code = cleanCode(body?.code);
  if (!code) return Response.json({ error: 'E79955: bad_code' }, { status: 400 });
  const ownerId = await dashboardSecretsOwner(env, dashboardId);
  if (!ownerId) return Response.json({ error: 'E79957: dashboard not found' }, { status: 404 });
  try {
    const owner = await ensureOwner(env, ownerId);
    // What the code is for, before approving it: only this dashboard's device.
    const info = (await hubFetch(env, `/agents/pair/info?code=${code}`, { method: 'GET', token: owner!.token })) as
      { kind?: string; name?: string };
    if (info.kind !== 'device' || info.name !== deviceName(dashboardId)) {
      console.warn(`[agents] refused a pairing code for dashboard ${dashboardId}: kind=${info.kind} name=${info.name}`);
      return Response.json({ error: 'E79958: not this dashboard\'s device' }, { status: 403 });
    }
    const r = (await hubFetch(env, '/agents/pair/approve', {
      method: 'POST', token: owner!.token, body: { code, kind: 'device' },
    })) as { identity: string };
    return Response.json({ ok: true, identity: r.identity });
  } catch (e) {
    return hubErrorResponse(e, 'could not approve device');
  }
}

/**
 * GET /internal/dashboards/:id/terminals/:ptyId/agents: the agents this terminal
 * may use, i.e. Agent blocks its canvas item has an edge to (either direction).
 * Only agents of the dashboard owner count, since the VM speaks as the owner's device.
 */
export async function handleInternalTerminalAgents(env: Env, dashboardId: string, ptyId: string): Promise<Response> {
  const session = await env.DB.prepare(
    `SELECT item_id FROM sessions WHERE dashboard_id = ? AND pty_id = ? AND pty_id != '' ORDER BY created_at DESC LIMIT 1`,
  ).bind(dashboardId, ptyId).first<{ item_id: string }>();
  if (!session) return Response.json({ agents: [] });
  const rows = await env.DB.prepare(`
    SELECT i.id, i.content FROM dashboard_edges e
    JOIN dashboard_items i ON i.id = CASE WHEN e.source_item_id = ? THEN e.target_item_id ELSE e.source_item_id END
    WHERE e.dashboard_id = ? AND (e.source_item_id = ? OR e.target_item_id = ?) AND i.type = 'agent'
  `).bind(session.item_id, dashboardId, session.item_id, session.item_id).all<{ id: string; content: string }>();
  const ownerId = await dashboardSecretsOwner(env, dashboardId);
  const owner = ownerId ? await existingOwner(env, ownerId) : null;
  const agents: { identity: string; name: string; itemId: string }[] = [];
  for (const row of rows.results ?? []) {
    try {
      const c = JSON.parse(row.content || '{}') as { agent?: { identity?: unknown; name?: unknown } };
      const identity = typeof c.agent?.identity === 'string' ? c.agent.identity : '';
      const name = typeof c.agent?.name === 'string' ? c.agent.name : '';
      if (owner && identity.startsWith(`${owner.identity}/agent:`) && !agents.some((a) => a.identity === identity)) {
        agents.push({ identity, name, itemId: row.id });
      }
    } catch { /* not linked yet */ }
  }
  return Response.json({ agents });
}
