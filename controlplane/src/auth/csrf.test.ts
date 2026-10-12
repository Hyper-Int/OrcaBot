import { describe, it, expect } from 'vitest';
import { checkCsrf } from '../index';

const allowed = new Set(['https://orcabot.com']);
const req = (method: string, headers: Record<string, string> = {}) =>
  new Request('https://api.orcabot.com/secrets', { method, headers });

describe('checkCsrf()', () => {
  it('allows cookie POST from an allowed origin', () => {
    expect(checkCsrf(req('POST', { Origin: 'https://orcabot.com' }), 'session', allowed)).toBeNull();
  });

  it('rejects cookie POST from a foreign origin', () => {
    expect(checkCsrf(req('POST', { Origin: 'https://evil.com' }), 'session', allowed)?.status).toBe(403);
  });

  it('rejects the opaque "null" origin', () => {
    expect(checkCsrf(req('DELETE', { Origin: 'null' }), 'session', allowed)?.status).toBe(403);
  });

  it('rejects origin-less requests the browser marks cross-site', () => {
    expect(checkCsrf(req('POST', { 'Sec-Fetch-Site': 'cross-site' }), 'cf-access', allowed)?.status).toBe(403);
  });

  it('allows origin-less non-browser clients', () => {
    expect(checkCsrf(req('POST'), 'session', allowed)).toBeNull();
  });

  it('ignores safe methods and bearer-style auth', () => {
    expect(checkCsrf(req('GET', { Origin: 'https://evil.com' }), 'session', allowed)).toBeNull();
    expect(checkCsrf(req('POST', { Origin: 'https://evil.com' }), 'pat', allowed)).toBeNull();
    expect(checkCsrf(req('POST', { Origin: 'https://evil.com' }), undefined, allowed)).toBeNull();
  });

  it('is disabled when all origins are allowed (dev mode)', () => {
    expect(checkCsrf(req('POST', { Origin: 'https://evil.com' }), 'session', null)).toBeNull();
  });
});
