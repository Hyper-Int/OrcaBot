// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: discord-guild-binding-tests-v1-manage-guild
import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveDiscordGuildId, canManageDiscordGuild } from './handler';

// The callback's guild_id param is user-editable: binding the shared bot to a
// guild must need the bot scope and the right to manage that guild.
function stubGuilds(guilds: unknown, ok = true) {
  const upstream = vi.fn(async () => ok ? Response.json(guilds) : new Response('', { status: 500 }));
  vi.stubGlobal('fetch', upstream);
  return upstream;
}

describe('resolveDiscordGuildId', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('uses the token response guild when the bot scope was granted', async () => {
    const upstream = stubGuilds([]);
    expect(await resolveDiscordGuildId({ access_token: 't', scope: 'identify bot guilds', guild: { id: 'G1' } }, 'G2')).toBe('G1');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('binds nothing without the bot scope, even with a token guild', async () => {
    stubGuilds([{ id: 'G1', owner: true }]);
    expect(await resolveDiscordGuildId({ access_token: 't', scope: 'identify guilds', guild: { id: 'G1' } }, 'G1')).toBeNull();
    expect(await resolveDiscordGuildId({ access_token: 't', guild: { id: 'G1' } }, 'G1')).toBeNull();
    expect(await resolveDiscordGuildId({ access_token: 't', scope: 'robot identify' }, 'G1')).toBeNull();
  });

  it('rejects a query guild the user is merely a member of', async () => {
    stubGuilds([{ id: 'G2', owner: false, permissions: String(1024 + 2048) }]);
    expect(await resolveDiscordGuildId({ access_token: 't', scope: 'bot identify guilds' }, 'G2')).toBeNull();
  });

  it.each([
    [{ id: 'G2', owner: true, permissions: '0' }],
    [{ id: 'G2', owner: false, permissions: String(0x20) }],
    [{ id: 'G2', owner: false, permissions: String(0x8) }],
    [{ id: 'G2', owner: false, permissions: '1099511627775' }],
  ])('accepts a query guild the user can manage: %j', async (entry) => {
    stubGuilds([entry]);
    expect(await resolveDiscordGuildId({ access_token: 't', scope: 'bot identify guilds' }, 'G2')).toBe('G2');
  });

  it('fails closed when the guild list cannot be read or lacks the guild', async () => {
    stubGuilds([], false);
    expect(await resolveDiscordGuildId({ access_token: 't', scope: 'bot' }, 'G2')).toBeNull();
    stubGuilds([{ id: 'G3', owner: true }]);
    expect(await resolveDiscordGuildId({ access_token: 't', scope: 'bot' }, 'G2')).toBeNull();
    stubGuilds({ not: 'an array' });
    expect(await resolveDiscordGuildId({ access_token: 't', scope: 'bot' }, 'G2')).toBeNull();
  });
});

describe('canManageDiscordGuild', () => {
  it.each([
    [{ owner: 'true' }, false],
    [{ permissions: 'not-a-number' }, false],
    [{ permissions: { x: 1 } }, false],
    [{}, false],
    [{ permissions: 0x20 }, true],
  ])('%j -> %s', (entry, expected) => {
    expect(canManageDiscordGuild(entry as never)).toBe(expected);
  });
});
