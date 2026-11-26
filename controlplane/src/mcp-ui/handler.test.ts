// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: mcp-ui-handler-v2-items-from-d1
import { describe, it, expect, beforeEach } from 'vitest';
import { getItems } from './handler';
import { createTestContext, seedUser, seedDashboard, seedDashboardItem, createTestUser } from '../../tests/helpers';
import type { TestContext } from '../../tests/helpers';

describe('list_items', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
    await seedUser(ctx.db, createTestUser({ id: 'user-1' }));
  });

  it("lists items written straight to D1 (a template's), not only the Durable Object's", async () => {
    // populateFromTemplate inserts into D1 without telling the dashboard's Durable Object;
    // the setup walkthrough's list_items then saw an empty dashboard and rebuilt it.
    await seedDashboard(ctx.db, 'user-1', { id: 'dash-1' });
    await seedDashboardItem(ctx.db, 'dash-1', { id: 'engine', type: 'terminal', content: '{"name":"PokerBench engine"}' });
    const res = await getItems(ctx.env, 'dash-1', 'user-1');
    const data = await res.json() as { items: Array<{ id: string; type: string }>; edges: unknown[] };
    expect(res.status).toBe(200);
    expect(data.items.map((i) => i.id)).toEqual(['engine']);
    expect(Array.isArray(data.edges)).toBe(true);
  });
});
