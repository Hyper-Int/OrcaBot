// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: sandbox-fetch-tests-v1-strip-client-credentials
import { describe, it, expect } from 'vitest';
import { sandboxHeaders } from './fetch';
import type { Env } from '../types';

// Proxy routes pass the browser's headers through; the shared VM must never
// receive a member's session cookie, PAT or dev-auth identity.
describe('sandboxHeaders', () => {
  it('strips client credentials and keeps ordinary headers', async () => {
    const env = { SANDBOX_INTERNAL_TOKEN: 'static' } as unknown as Env;
    const browser = new Headers({
      Cookie: 'orcabot_session=secret',
      Authorization: 'Bearer orca_pat_abc',
      'Proxy-Authorization': 'Basic x',
      'X-Dashboard-Token': 'forged',
      'Cf-Access-Jwt-Assertion': 'jwt',
      'X-User-ID': 'alice',
      'X-User-Email': 'a@x.com',
      'X-User-Name': 'Alice',
      'X-Orcabot-Surface': 'surface-token',
      'X-Internal-Token': 'client-supplied',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': 'k',
      Origin: 'https://app.test',
    });
    const out = await sandboxHeaders(env, browser, 'm1', 'GET', 'https://sbx.test/sessions/s/ptys/p/ws');
    for (const name of ['Cookie', 'Authorization', 'Proxy-Authorization', 'X-Dashboard-Token', 'Cf-Access-Jwt-Assertion',
      'X-User-ID', 'X-User-Email', 'X-User-Name', 'X-Orcabot-Surface']) {
      expect(out.get(name), name).toBeNull();
    }
    expect(out.get('X-Internal-Token')).toBe('static');
    expect(out.get('X-Sandbox-Machine-ID')).toBe('m1');
    expect(out.get('Upgrade')).toBe('websocket');
    expect(out.get('Sec-WebSocket-Key')).toBe('k');
    expect(out.get('Origin')).toBe('https://app.test');
  });
});
