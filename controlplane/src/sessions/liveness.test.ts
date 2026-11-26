// REVISION: session-liveness-tests-v1
/**
 * GET /sessions/:id/alive: the page asks before replacing a terminal whose connection
 * dropped, and must only get `false` when the process is really gone.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createTestContext, seedUser, seedDashboard, seedDashboardItem, seedSession, createTestUser } from '../../tests/helpers';
import { createMockSandboxServer } from '../../tests/mocks/sandbox';
import { getSessionLiveness } from './liveness';
import type { TestContext } from '../../tests/helpers';

describe('session liveness', () => {
  let ctx: TestContext;
  const owner = createTestUser({ id: 'user-1' });
  const viewer = createTestUser({ id: 'user-2', email: 'viewer@example.com' });
  const stranger = createTestUser({ id: 'user-3', email: 'stranger@example.com' });
  const mockSandbox = createMockSandboxServer();
  let ptysReply: () => Response;
  let asked: string[];

  beforeAll(() => mockSandbox.server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => { mockSandbox.reset(); mockSandbox.server.resetHandlers(); });
  afterAll(() => mockSandbox.server.close());

  async function setup(opts: { status?: string; rowSandbox?: string; currentSandbox?: string } = {}) {
    const dashboard = await seedDashboard(ctx.db, owner.id);
    await ctx.db.prepare(`INSERT INTO dashboard_members (dashboard_id, user_id, role, added_at) VALUES (?, ?, 'viewer', ?)`)
      .bind(dashboard.id, viewer.id, new Date().toISOString()).run();
    const item = await seedDashboardItem(ctx.db, dashboard.id, { type: 'terminal' });
    await seedSession(ctx.db, dashboard.id, item.id, {
      id: 's-1', sandboxSessionId: opts.rowSandbox ?? 'sbx-1', ownerUserId: owner.id, status: opts.status ?? 'active',
    });
    await ctx.db.prepare(`UPDATE sessions SET pty_id = 'pty-1' WHERE id = 's-1'`).run();
    await ctx.db.prepare(`
      INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, applied_secret_names, created_at)
      VALUES (?, ?, '', '[]', ?)
    `).bind(dashboard.id, opts.currentSandbox ?? 'sbx-1', new Date().toISOString()).run();
  }

  async function check(userId = owner.id) {
    const res = await getSessionLiveness(ctx.env, 's-1', userId);
    return { status: res.status, body: await res.json() as { alive: boolean | null; reason: string; revision: string } };
  }

  beforeEach(async () => {
    ctx = await createTestContext();
    for (const u of [owner, viewer, stranger]) await seedUser(ctx.db, u);
    asked = [];
    ptysReply = () => HttpResponse.json({ ptys: [{ id: 'pty-other' }, { id: 'pty-1' }] });
    mockSandbox.server.use(
      http.get(`${ctx.env.SANDBOX_URL}/sessions/:id/ptys`, ({ params }) => {
        asked.push(String(params.id));
        return ptysReply();
      }),
    );
  });

  it('alive when the sandbox still lists the PTY', async () => {
    await setup();
    const { status, body } = await check();
    expect(status).toBe(200);
    expect(body.alive).toBe(true);
    expect(body.revision).toBe('session-liveness-v1-before-restart');
    expect(asked).toEqual(['sbx-1']);
  });

  it('any member may ask; others get 404', async () => {
    await setup();
    expect((await check(viewer.id)).body.alive).toBe(true);
    expect((await check(stranger.id)).status).toBe(404);
  });

  it('not alive once the PTY has exited', async () => {
    await setup();
    ptysReply = () => HttpResponse.json({ ptys: [{ id: 'pty-other' }] });
    expect((await check()).body).toMatchObject({ alive: false, reason: 'pty exited' });
  });

  it('not alive when the sandbox lost the session', async () => {
    await setup();
    ptysReply = () => new HttpResponse('no such session', { status: 404 });
    expect((await check()).body).toMatchObject({ alive: false, reason: 'sandbox session gone' });
  });

  it('not alive when the dashboard has moved to another sandbox session, without asking the old one', async () => {
    await setup({ rowSandbox: 'sbx-old', currentSandbox: 'sbx-new' });
    expect((await check()).body).toMatchObject({ alive: false, reason: 'sandbox session replaced' });
    expect(asked).toEqual([]);
  });

  it('not alive when the session was stopped', async () => {
    await setup({ status: 'stopped' });
    expect((await check()).body.alive).toBe(false);
    expect(asked).toEqual([]);
  });

  it("unknown (null), never false, when the sandbox can't answer", async () => {
    await setup();
    ptysReply = () => new HttpResponse('boom', { status: 500 });
    expect((await check()).body.alive).toBeNull();
    ptysReply = () => HttpResponse.error();
    expect((await check()).body.alive).toBeNull();
  });
});
