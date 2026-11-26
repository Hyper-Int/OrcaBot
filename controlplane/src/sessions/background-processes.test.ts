// REVISION: background-processes-tests-v1
/**
 * A terminal's leftover background processes: who may list and stop them, and that the
 * sandbox is asked about every PTY the terminal ever had (a daemon left by an earlier
 * run counts), on the dashboard's current VM.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createTestContext, seedUser, seedDashboard, seedDashboardItem, seedSession, createTestUser } from '../../tests/helpers';
import { createMockSandboxServer } from '../../tests/mocks/sandbox';
import { listBackgroundProcesses, stopBackgroundProcesses } from './background-processes';
import type { TestContext } from '../../tests/helpers';

describe('background processes', () => {
  let ctx: TestContext;
  const owner = createTestUser({ id: 'user-1' });
  const viewer = createTestUser({ id: 'user-2', email: 'viewer@example.com' });
  const mockSandbox = createMockSandboxServer();
  let listQueries: string[];
  let stopBodies: Array<Record<string, unknown>>;

  beforeAll(() => mockSandbox.server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => { mockSandbox.reset(); mockSandbox.server.resetHandlers(); });
  afterAll(() => mockSandbox.server.close());

  async function setup() {
    const dashboard = await seedDashboard(ctx.db, owner.id);
    await ctx.db.prepare(`INSERT INTO dashboard_members (dashboard_id, user_id, role, added_at) VALUES (?, ?, 'viewer', ?)`)
      .bind(dashboard.id, viewer.id, new Date().toISOString()).run();
    const item = await seedDashboardItem(ctx.db, dashboard.id, { type: 'terminal' });
    const other = await seedDashboardItem(ctx.db, dashboard.id, { type: 'terminal' });
    // Two earlier runs of the terminal (one on an old VM), the current one, and another terminal.
    for (const [id, pty, item_, at] of [
      ['s-old1', 'pty-old1', item.id, '2026-11-22T17:00:00Z'],
      ['s-old2', 'pty-old2', item.id, '2026-11-22T17:24:00Z'],
      ['s-now', 'pty-now', item.id, '2026-11-22T23:46:00Z'],
      ['s-other', 'pty-other', other.id, '2026-11-22T23:46:00Z'],
    ] as const) {
      await seedSession(ctx.db, dashboard.id, item_, { id, sandboxSessionId: 'stale-sbx', ownerUserId: owner.id });
      await ctx.db.prepare(`UPDATE sessions SET pty_id = ?, created_at = ? WHERE id = ?`).bind(pty, at, id).run();
    }
    await ctx.db.prepare(`
      INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, applied_secret_names, created_at)
      VALUES (?, 'current-sbx', '', '[]', ?)
    `).bind(dashboard.id, new Date().toISOString()).run();
    return { dashboard, item };
  }

  beforeEach(async () => {
    ctx = await createTestContext();
    await seedUser(ctx.db, owner);
    await seedUser(ctx.db, viewer);
    listQueries = [];
    stopBodies = [];
    mockSandbox.server.use(
      http.get(`${ctx.env.SANDBOX_URL}/sessions/:id/background-processes`, ({ request, params }) => {
        listQueries.push(`${params.id}?${new URL(request.url).searchParams.get('pty_ids')}`);
        return HttpResponse.json({ processes: [
          { pid: 806, ppid: 1, uid: 0, name: 'codex', command: 'codex app-server', start_ticks: 5000, started_at: '2026-11-22T17:25:00Z', pty_id: 'pty-old2' },
          { pid: 900, ppid: 1, uid: 0, name: 'node', command: 'node server.js', start_ticks: 9000, started_at: '2026-11-22T23:50:00Z', pty_id: 'pty-now' },
        ] });
      }),
      http.post(`${ctx.env.SANDBOX_URL}/sessions/:id/background-processes/stop`, async ({ request, params }) => {
        stopBodies.push({ session: params.id, ...(await request.json() as Record<string, unknown>) });
        return HttpResponse.json({ results: [{ pid: 806, outcome: 'stopped' }] });
      }),
    );
  });

  it('asks the current VM about every PTY the terminal has had', async () => {
    await setup();
    const res = await listBackgroundProcesses(ctx.env, 's-now', owner.id);
    expect(res.status).toBe(200);
    const body = await res.json() as { processes: Array<{ pid: number; startTicks: number; fromCurrentRun: boolean }> };
    expect(listQueries).toHaveLength(1);
    const [session, ids] = listQueries[0].split('?');
    expect(session).toBe('current-sbx');
    expect(ids.split(',').sort()).toEqual(['pty-now', 'pty-old1', 'pty-old2']);
    expect(body.processes.map((p) => [p.pid, p.startTicks, p.fromCurrentRun])).toEqual([[806, 5000, false], [900, 9000, true]]);
  });

  it('stops only what was asked, with the terminal\'s PTY ids for the sandbox to re-check', async () => {
    await setup();
    const req = new Request('http://cp/sessions/s-now/background-processes/stop', {
      method: 'POST', body: JSON.stringify({ processes: [{ pid: 806, startTicks: 5000 }, { pid: 'x' }, { pid: 1, startTicks: 0 }] }),
    });
    const res = await stopBackgroundProcesses(ctx.env, req, 's-now', owner.id);
    expect(res.status).toBe(200);
    expect(stopBodies).toHaveLength(1);
    expect(stopBodies[0].session).toBe('current-sbx');
    expect(stopBodies[0].processes).toEqual([{ pid: 806, start_ticks: 5000 }]); // junk and pid 1 dropped
    expect((stopBodies[0].pty_ids as string[]).sort()).toEqual(['pty-now', 'pty-old1', 'pty-old2']);
  });

  it('is refused to viewers and to anyone outside the dashboard', async () => {
    await setup();
    expect((await listBackgroundProcesses(ctx.env, 's-now', viewer.id)).status).toBe(404);
    expect((await listBackgroundProcesses(ctx.env, 's-now', 'stranger')).status).toBe(404);
    const req = new Request('http://cp/x', { method: 'POST', body: JSON.stringify({ processes: [{ pid: 806, startTicks: 5000 }] }) });
    expect((await stopBackgroundProcesses(ctx.env, req, 's-now', viewer.id)).status).toBe(404);
    expect(listQueries).toHaveLength(0);
    expect(stopBodies).toHaveLength(0);
  });

  it('lets the restart go ahead when the sandbox can\'t be asked', async () => {
    await setup();
    mockSandbox.server.use(http.get(`${ctx.env.SANDBOX_URL}/sessions/:id/background-processes`, () => new HttpResponse(null, { status: 503 })));
    const res = await listBackgroundProcesses(ctx.env, 's-now', owner.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ processes: [], unavailable: true });
  });
});
