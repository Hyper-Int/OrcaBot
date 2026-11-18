// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: agent-link-tests-v1
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  deviceName, handleAgentChat, handleInternalAgentLinkConfig, handleInternalApproveDevice,
  handleInternalTerminalAgents, handleLinkAgent, handleListAgents, hubUserId,
} from './handler';
import type { Env } from '../types';
import type { AuthContext } from '../auth/middleware';

const HUB = 'http://hub.test';
const SECRET = 'partner-secret';

/** A fake D1 holding agent_hub_owners rows, plus fixed dashboards/sessions/edges. */
function fakeEnv(opts: { configured?: boolean; edges?: Array<{ id: string; content: string }>; sandbox?: boolean } = {}) {
  const owners = new Map<string, { identity: string; token_enc: string }>();
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    async first() {
      if (sql.includes('FROM agent_hub_owners')) return owners.get(String(args[0])) ?? null;
      if (sql.includes('SELECT owner_id FROM dashboards')) return args[0] === 'dash-1' ? { owner_id: 'owner' } : null;
      if (sql.includes('FROM sessions')) return args[1] === 'pty-1' ? { item_id: 'term-1' } : null;
      if (sql.includes('FROM dashboard_sandboxes')) {
        return opts.sandbox ? { sandbox_session_id: 'sbx-1', sandbox_machine_id: 'm-1' } : null;
      }
      return null;
    },
    async all() {
      if (sql.includes('FROM dashboard_edges')) return { results: opts.edges ?? [] };
      return { results: [] };
    },
    async run() {
      if (sql.includes('INSERT INTO agent_hub_owners')) {
        owners.set(String(args[0]), { identity: String(args[1]), token_enc: String(args[2]) });
      }
      return { success: true };
    },
  });
  const env = {
    DB: { prepare: (sql: string) => stmt(sql) },
    SECRETS_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    SANDBOX_URL: 'http://sandbox.test',
    SANDBOX_INTERNAL_TOKEN: 'tok',
    ...(opts.configured === false ? {} : { AGENT_HUB_URL: `${HUB}/`, AGENT_HUB_PARTNER_SECRET: SECRET }),
  } as unknown as Env;
  return { env, owners };
}

const auth = (id: string) => ({ user: { id }, isAuthenticated: true }) as unknown as AuthContext;

/** A fake hub: records calls; `route` answers them. */
function fakeHub(route: (path: string, method: string, body: any, token: string) => [number, unknown]) {
  const calls: Array<{ path: string; method: string; body: any; token: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
    const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace('Bearer ', '') ?? '';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname + url.search, method, body, token });
    const [status, data] = route(url.pathname, method, body, token);
    return new Response(JSON.stringify(data), { status });
  }));
  return calls;
}

const post = (body: unknown) => new Request('http://cp.test/x', { method: 'POST', body: JSON.stringify(body) });

describe('agent blocks: linking outside agents', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reports not set up when no hub is configured', async () => {
    const { env } = fakeEnv({ configured: false });
    const r = await (await handleListAgents(env, auth('u1'))).json() as { enabled: boolean };
    expect(r.enabled).toBe(false);
    expect((await handleLinkAgent(post({ code: 'ABCD-EFGH' }), env, auth('u1'))).status).toBe(503);
    expect((await (await handleInternalAgentLinkConfig(env, 'dash-1')).json() as { enabled: boolean }).enabled).toBe(false);
  });

  it('issues the user an owner once, keeps its token encrypted, and approves the code with it', async () => {
    const { env, owners } = fakeEnv();
    const hubUser = await hubUserId('u1');
    const calls = fakeHub((path, _m, body) => {
      if (path === '/partner/owners') return [200, { identity: `orca:${body.user}`, token: 'owner-token' }];
      if (path === '/agents/pair/approve') return [200, { identity: `orca:${hubUser}/agent:grok`, name: 'grok', mode: 'self' }];
      return [404, { error: 'not_found' }];
    });
    const res = await handleLinkAgent(post({ code: 'abcd efgh' }), env, auth('u1'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agent: { name: string } }).agent.name).toBe('grok');
    expect(calls[0]).toMatchObject({ path: '/partner/owners', token: SECRET, body: { user: hubUser } });
    expect(hubUser).not.toContain('u1'); // the hub never sees our user ids
    expect(calls[1]).toMatchObject({ path: '/agents/pair/approve', token: 'owner-token', body: { code: 'ABCDEFGH', kind: 'agent' } });
    const row = owners.get('u1')!;
    expect(row.identity).toBe(`orca:${hubUser}`);
    expect(row.token_enc).not.toContain('owner-token');

    await handleLinkAgent(post({ code: 'WXYZ2345' }), env, auth('u1'));
    expect(calls.filter((c) => c.path === '/partner/owners')).toHaveLength(1); // reused
  });

  it('takes a new token when the hub already issued this owner (row lost)', async () => {
    const { env } = fakeEnv();
    const calls = fakeHub((path, _m, body) => {
      if (path === '/partner/owners') return body.rotate ? [200, { identity: 'orca:x', token: 't2' }] : [409, { error: 'exists' }];
      return [200, { identity: 'orca:x/agent:muse', name: 'muse' }];
    });
    expect((await handleLinkAgent(post({ code: 'ABCDEFGH' }), env, auth('u1'))).status).toBe(200);
    expect(calls.filter((c) => c.path === '/partner/owners').map((c) => c.body.rotate ?? false)).toEqual([false, true]);
  });

  it('rejects malformed codes and passes on unknown ones', async () => {
    const { env } = fakeEnv();
    fakeHub((path) => path === '/partner/owners' ? [200, { identity: 'orca:x', token: 't' }] : [404, { error: 'unknown_code' }]);
    expect((await handleLinkAgent(post({ code: 'nope' }), env, auth('u1'))).status).toBe(400);
    const res = await handleLinkAgent(post({ code: 'ABCDEFGH' }), env, auth('u1'));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain('unknown_code');
  });
});

describe('agent blocks: the dashboard VM as the owner\'s device', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('gives the VM the hub URL and its own device name', async () => {
    const { env } = fakeEnv();
    const r = await (await handleInternalAgentLinkConfig(env, 'Dash_1')).json() as { hubUrl: string; device: string };
    expect(r.hubUrl).toBe(HUB);
    expect(r.device).toBe('dash-dash1');
    expect(deviceName('x'.repeat(80)).length).toBeLessThanOrEqual(32);
  });

  it.each([
    ['an agent code', { kind: 'agent', name: deviceName('dash-1') }],
    ['another dashboard\'s device', { kind: 'device', name: deviceName('dash-2') }],
  ])('refuses %s', async (_label, info) => {
    const { env } = fakeEnv();
    const calls = fakeHub((path) => {
      if (path === '/partner/owners') return [200, { identity: 'orca:o', token: 'ot' }];
      if (path === '/agents/pair/info') return [200, info];
      return [200, { identity: 'orca:o/device:x' }];
    });
    expect((await handleInternalApproveDevice(post({ code: 'ABCDEFGH' }), env, 'dash-1')).status).toBe(403);
    expect(calls.some((c) => c.path === '/agents/pair/approve')).toBe(false);
  });

  it('approves this dashboard\'s device as the dashboard owner', async () => {
    const { env, owners } = fakeEnv();
    const calls = fakeHub((path) => {
      if (path === '/partner/owners') return [200, { identity: 'orca:o', token: 'ot' }];
      if (path === '/agents/pair/info') return [200, { kind: 'device', name: deviceName('dash-1') }];
      return [200, { identity: `orca:o/device:${deviceName('dash-1')}` }];
    });
    expect((await handleInternalApproveDevice(post({ code: 'ABCDEFGH' }), env, 'dash-1')).status).toBe(200);
    expect(owners.has('owner')).toBe(true); // the dashboard owner, not whoever is using it
    expect(calls.at(-1)).toMatchObject({ path: '/agents/pair/approve', token: 'ot', body: { kind: 'device' } });
  });

  it('lets a terminal use only owner agents it is connected to by edges', async () => {
    const own = (name: string) => JSON.stringify({ kind: 'grok', agent: { identity: `orca:o/agent:${name}`, name } });
    const { env, owners } = fakeEnv({ edges: [
      { id: 'a1', content: own('grok') },
      { id: 'a2', content: JSON.stringify({ kind: 'muse', agent: { identity: 'orca:someone-else/agent:muse', name: 'muse' } }) },
      { id: 'a3', content: JSON.stringify({ kind: 'dots' }) }, // not linked yet
      { id: 'a4', content: own('grok') }, // a second block for the same agent
    ] });
    owners.set('owner', { identity: 'orca:o', token_enc: 'unused' });
    // existingOwner decrypts the token; give it a real one.
    fakeHub(() => [200, { identity: 'orca:o', token: 'ot' }]);
    const { encryptSecret, getEncryptionKey } = await import('../crypto/secrets');
    owners.set('owner', { identity: 'orca:o', token_enc: await encryptSecret('ot', await getEncryptionKey(env)) });
    const r = await (await handleInternalTerminalAgents(env, 'dash-1', 'pty-1')).json() as { agents: Array<{ name: string }> };
    expect(r.agents.map((a) => a.name)).toEqual(['grok']);
    const none = await (await handleInternalTerminalAgents(env, 'dash-1', 'pty-unknown')).json() as { agents: unknown[] };
    expect(none.agents).toEqual([]);
  });
});

describe('agent blocks: chat goes through the VM, owner only', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const wake = async () => ({ sandboxSessionId: 'sbx-1', sandboxMachineId: 'm-1' });

  it('refuses other members', async () => {
    const { env } = fakeEnv({ sandbox: true });
    const res = await handleAgentChat(new Request('http://cp.test/c?agent=a'), env, auth('member'), 'dash-1', wake);
    expect(res.status).toBe(403);
  });

  it('says so when the VM is asleep, without waking it', async () => {
    const { env } = fakeEnv({ sandbox: false });
    let woke = false;
    const res = await handleAgentChat(new Request('http://cp.test/c?agent=a'), env, auth('owner'), 'dash-1',
      async () => { woke = true; return wake(); });
    expect(res.status).toBe(409);
    expect(woke).toBe(false);
  });

  it('proxies to the VM\'s agent-link route', async () => {
    const { env } = fakeEnv({ sandbox: true });
    const calls = fakeHub(() => [200, { status: 'ready', messages: [] }]);
    const res = await handleAgentChat(new Request('http://cp.test/c?agent=orca%3Ao%2Fagent%3Agrok&after=3'), env,
      auth('owner'), 'dash-1', wake);
    expect(res.status).toBe(200);
    expect(calls[0].path).toBe('/sessions/sbx-1/agent-link/chat?agent=orca%3Ao%2Fagent%3Agrok&after=3');
  });
});
