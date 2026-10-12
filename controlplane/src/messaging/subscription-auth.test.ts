// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestContext, seedUser, seedDashboard, type TestContext } from '../../tests/helpers';
import { createSubscription } from './webhook-handler';
import { handleMessagingSend } from './send';

const owner = { id: 'owner-1', email: 'o@x.test', name: 'Owner' };
const viewer = { id: 'viewer-1', email: 'v@x.test', name: 'Viewer' };

async function seedItem(ctx: TestContext, dashboardId: string, type: string) {
  const id = `item-${type}`;
  const now = new Date().toISOString();
  await ctx.db.prepare(
    `INSERT INTO dashboard_items (id, dashboard_id, type, content, position_x, position_y, width, height, created_at, updated_at) VALUES (?, ?, ?, '', 0, 0, 200, 150, ?, ?)`
  ).bind(id, dashboardId, type, now, now).run();
  return id;
}

async function seedIntegration(ctx: TestContext, userId: string, provider: string, metadata: Record<string, unknown>) {
  await ctx.db.prepare(
    `INSERT INTO user_integrations (id, user_id, provider, access_token, metadata) VALUES (?, ?, ?, ?, ?)`
  ).bind(`int-${provider}-${userId}`, userId, provider, `tok-${provider}`, JSON.stringify(metadata)).run();
}

describe('messaging subscriptions are scoped to the caller\'s own workspace', () => {
  let ctx: TestContext;
  let dashboardId: string;
  let fetchMock: ReturnType<typeof vi.fn<[RequestInfo | URL], Promise<Response>>>;

  beforeEach(async () => {
    ctx = await createTestContext();
    await seedUser(ctx.db, owner);
    dashboardId = (await seedDashboard(ctx.db, owner.id, { id: 'dash-1' })).id;
    fetchMock = vi.fn<[RequestInfo | URL], Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a Slack teamId that is not one of the caller\'s workspaces', async () => {
    const itemId = await seedItem(ctx, dashboardId, 'slack');
    await seedIntegration(ctx, owner.id, 'slack', { team_id: 'T_MINE' });
    await expect(
      createSubscription(ctx.env, dashboardId, itemId, owner.id, 'slack', { channelId: 'C_THEIRS', teamId: 'T_OTHER' }, 'https://api.test')
    ).rejects.toMatchObject({ code: 'SLACK_WORKSPACE_MISMATCH' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a Slack channel that does not exist in the caller\'s workspace', async () => {
    const itemId = await seedItem(ctx, dashboardId, 'slack');
    await seedIntegration(ctx, owner.id, 'slack', { team_id: 'T_MINE' });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'channel_not_found' })));
    await expect(
      createSubscription(ctx.env, dashboardId, itemId, owner.id, 'slack', { channelId: 'C_THEIRS' }, 'https://api.test')
    ).rejects.toMatchObject({ code: 'SLACK_CHANNEL_NOT_FOUND' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('conversations.info?channel=C_THEIRS');
  });

  it('accepts a Slack channel in the caller\'s workspace', async () => {
    const itemId = await seedItem(ctx, dashboardId, 'slack');
    await seedIntegration(ctx, owner.id, 'slack', { team_id: 'T_MINE' });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, channel: { id: 'C_MINE' } })));
    const sub = await createSubscription(ctx.env, dashboardId, itemId, owner.id, 'slack', { channelId: 'C_MINE', teamId: 'T_MINE' }, 'https://api.test');
    expect(sub.id).toBeTruthy();
  });

  it('rejects a Discord channel in another guild (shared bot can see it)', async () => {
    const itemId = await seedItem(ctx, dashboardId, 'discord');
    await seedIntegration(ctx, owner.id, 'discord', { guild_id: 'G_MINE' });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: '555', guild_id: 'G_OTHER' })));
    await expect(
      createSubscription(ctx.env, dashboardId, itemId, owner.id, 'discord', { channelId: '555' }, 'https://api.test')
    ).rejects.toMatchObject({ code: 'DISCORD_CHANNEL_NOT_FOUND' });
  });

  it('rejects Discord when the integration has no recorded guild', async () => {
    const itemId = await seedItem(ctx, dashboardId, 'discord');
    await seedIntegration(ctx, owner.id, 'discord', {});
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: '555', guild_id: 'G_ANY' })));
    await expect(
      createSubscription(ctx.env, dashboardId, itemId, owner.id, 'discord', { channelId: '555' }, 'https://api.test')
    ).rejects.toMatchObject({ code: 'DISCORD_CHANNEL_NOT_FOUND' });
  });

  it('accepts a Discord channel in the caller\'s guild', async () => {
    const itemId = await seedItem(ctx, dashboardId, 'discord');
    await seedIntegration(ctx, owner.id, 'discord', { guild_id: 'G_MINE' });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: '555', guild_id: 'G_MINE' })));
    const sub = await createSubscription(ctx.env, dashboardId, itemId, owner.id, 'discord', { channelId: '555' }, 'https://api.test');
    expect(sub.id).toBeTruthy();
  });
});

describe('messaging send requires editor', () => {
  it('rejects a viewer', async () => {
    const ctx = await createTestContext();
    await seedUser(ctx.db, owner);
    await seedUser(ctx.db, viewer);
    const { id: dashboardId } = await seedDashboard(ctx.db, owner.id, { id: 'dash-2' });
    await ctx.db.prepare(
      `INSERT INTO dashboard_members (dashboard_id, user_id, role, added_at) VALUES (?, ?, 'viewer', ?)`
    ).bind(dashboardId, viewer.id, new Date().toISOString()).run();
    const itemId = await seedItem(ctx, dashboardId, 'slack');
    const res = await handleMessagingSend(ctx.env, viewer.id, { dashboardId, itemId, text: 'hi' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('E79617') });
  });
});
