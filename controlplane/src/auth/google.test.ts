/**
 * Google OAuth Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callbackGoogle } from './google';
import { createTestContext } from '../../tests/helpers';
import type { TestContext } from '../../tests/helpers';

describe('Google OAuth', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
    ctx.env.GOOGLE_CLIENT_ID = 'test-client-id';
    ctx.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects unverified Google emails', async () => {
    await ctx.db.prepare(`
      INSERT INTO auth_states (state, redirect_url, redirectUrl)
      VALUES (?, ?, ?)
    `).bind('state-1', 'https://orcabot.com/', 'https://orcabot.com/').run();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ access_token: 'token' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ sub: 'sub-1', email: 'user@example.com', email_verified: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ));

    vi.stubGlobal('fetch', fetchMock);

    const request = new Request('http://localhost/auth/google/callback?code=code-1&state=state-1');
    const response = await callbackGoogle(request, ctx.env);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('email is not verified');

    const usersTable = ctx.db._tables.get('users') || [];
    expect(usersTable.length).toBe(0);
  });

  it('rejects Google emails not on the allowlist', async () => {
    ctx.env.AUTH_ALLOWED_EMAILS = 'allowed@example.com';

    await ctx.db.prepare(`
      INSERT INTO auth_states (state, redirect_url, redirectUrl)
      VALUES (?, ?, ?)
    `).bind('state-2', 'https://orcabot.com/', 'https://orcabot.com/').run();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ access_token: 'token' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ sub: 'sub-2', email: 'blocked@example.com', email_verified: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ));

    vi.stubGlobal('fetch', fetchMock);

    const request = new Request('http://localhost/auth/google/callback?code=code-2&state=state-2');
    const response = await callbackGoogle(request, ctx.env);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('not allowed');

    const usersTable = ctx.db._tables.get('users') || [];
    expect(usersTable.length).toBe(0);
  });
});
