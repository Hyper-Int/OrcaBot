// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: discord-guild-tests-v1-guild-pinning
import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleGatewayExecute } from './gateway';
import { createPtyToken } from '../auth/pty-token';
import type { Env } from '../types';

// Every Discord integration uses the shared platform bot, which sits in every
// customer's guild: the gateway must pin each action to the stored guild.
const SECRET = 'pty-secret';
const OWN_GUILD = '111111111111111111';
const OTHER_GUILD = '999999999999999999';
const OWN_CHANNEL = '222222222222222222';
const OTHER_CHANNEL = '888888888888888888';
const DM_CHANNEL = '777777777777777777';

const POLICY = {
  canReceive: true, canSend: true, canReadHistory: true, canReact: true,
  canEditMessages: true, canDeleteMessages: true,
};

function fakeEnv(metadata: Record<string, unknown> | null) {
  const audits: unknown[][] = [];
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    async first() {
      if (sql.includes('FROM terminal_integrations ti')) {
        return {
          id: 'ti-1', terminal_id: 'term-1', item_id: null, dashboard_id: 'dash-1', user_id: 'alice',
          provider: 'discord', user_integration_id: 'ui-1', active_policy_id: 'pol-1',
          policy: JSON.stringify(POLICY), security_level: 'restricted',
          policy_id: 'pol-1', policy_version: 1,
        };
      }
      if (sql.includes('high_risk_confirmations')) return { id: 'confirmed' };
      if (sql.includes('FROM user_integrations WHERE id')) {
        return { access_token: 'platform-bot-token', refresh_token: null, expires_at: null, metadata: metadata ? JSON.stringify(metadata) : null };
      }
      return null;
    },
    async all() { return { results: [] }; },
    async run() {
      if (sql.includes('integration_audit_log')) audits.push(args);
      return { success: true };
    },
  });
  const env = {
    DB: { prepare: (sql: string) => stmt(sql), batch: async () => [] },
    PTY_TOKEN_SECRET: SECRET,
    INTERNAL_API_TOKEN: 'internal',
  } as unknown as Env;
  return { env, audits };
}

/** Fake Discord API: channel lookups resolve to guilds; everything else is recorded. */
function stubDiscord(opts: { lookupFails?: boolean } = {}) {
  const calls: Array<{ method: string; path: string }> = [];
  const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace('/api/v10', '');
    const method = init?.method || 'GET';
    calls.push({ method, path });
    const lookup = path.match(/^\/channels\/(\d+)$/);
    if (lookup && method === 'GET') {
      if (opts.lookupFails) return new Response('{"message":"Unknown Channel"}', { status: 404 });
      const id = lookup[1];
      const guild = id === OWN_CHANNEL ? OWN_GUILD : id === OTHER_CHANNEL ? OTHER_GUILD : undefined;
      return Response.json({ id, type: guild ? 0 : 1, ...(guild ? { guild_id: guild } : {}) });
    }
    if (path.startsWith('/guilds/')) return Response.json([]);
    return Response.json({ id: 'm1', channel_id: OWN_CHANNEL });
  });
  vi.stubGlobal('fetch', upstream);
  return calls;
}

async function execute(action: string, args: Record<string, unknown>, metadata: Record<string, unknown> | null = { guild_id: OWN_GUILD }) {
  const { env, audits } = fakeEnv(metadata);
  const token = await createPtyToken('term-1', 'sbx-1', 'dash-1', 'alice', SECRET);
  const req = new Request('https://cp.test/internal/gateway/discord/execute', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args }),
  });
  const res = await handleGatewayExecute(req, env, 'discord');
  return { res, audits };
}

describe('gateway pins Discord to the stored guild', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('list_channels always uses the stored guild', async () => {
    const calls = stubDiscord();
    const { res } = await execute('discord.list_channels', {});
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.path)).toEqual([`/guilds/${OWN_GUILD}/channels`]);
  });

  it('denies an LLM-supplied foreign guild_id before any Discord call', async () => {
    const calls = stubDiscord();
    const { res, audits } = await execute('discord.list_channels', { guild_id: OTHER_GUILD });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ decision: 'denied', reason: expect.stringMatching(/^E79625/) });
    expect(calls).toEqual([]);
    expect(audits.length).toBe(1);
  });

  it('denies when the integration has no stored guild', async () => {
    const calls = stubDiscord();
    const { res } = await execute('discord.list_channels', {}, { guild_id: null });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: expect.stringMatching(/^E79624/) });
    expect(calls).toEqual([]);
  });

  const channelActions: Array<[string, Record<string, unknown>]> = [
    ['discord.read_messages', {}],
    ['discord.send_message', { text: 'hi' }],
    ['discord.reply_thread', { message_id: '5', text: 'hi' }],
    ['discord.react', { message_id: '5', emoji: 'x' }],
    ['discord.edit_message', { message_id: '5', text: 'hi' }],
    ['discord.delete_message', { message_id: '5' }],
  ];

  it.each(channelActions)('%s in another guild is denied after only the lookup', async (action, extra) => {
    const calls = stubDiscord();
    const { res } = await execute(action, { channel: OTHER_CHANNEL, ...extra });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: expect.stringMatching(/^E79628/) });
    expect(calls).toEqual([{ method: 'GET', path: `/channels/${OTHER_CHANNEL}` }]);
  });

  it.each(channelActions)('%s in a DM channel is denied', async (action, extra) => {
    const calls = stubDiscord();
    const { res } = await execute(action, { channel: DM_CHANNEL, ...extra });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: expect.stringMatching(/^E79628/) });
    expect(calls.length).toBe(1);
  });

  it.each(channelActions)('%s fails closed when the channel lookup fails', async (action, extra) => {
    const calls = stubDiscord({ lookupFails: true });
    const { res } = await execute(action, { channel: OWN_CHANNEL, ...extra });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: expect.stringMatching(/^E79627/) });
    expect(calls.length).toBe(1);
  });

  it.each(channelActions)('%s in the stored guild goes through', async (action, extra) => {
    const calls = stubDiscord();
    const { res } = await execute(action, { channel: OWN_CHANNEL, ...extra });
    expect(res.status).toBe(200);
    expect(calls[0]).toEqual({ method: 'GET', path: `/channels/${OWN_CHANNEL}` });
    expect(calls.length).toBe(2);
    expect(calls[1].path.startsWith(`/channels/${OWN_CHANNEL}/messages`)).toBe(true);
  });

  it('a channel action without a channel is denied', async () => {
    const calls = stubDiscord();
    const { res } = await execute('discord.send_message', { text: 'hi' });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('an empty channel is treated as omitted and denied', async () => {
    const calls = stubDiscord();
    const { res } = await execute('discord.send_message', { channel: '', text: 'hi' });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
});
