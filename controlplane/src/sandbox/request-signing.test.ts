import { describe, it, expect, beforeAll } from 'vitest';
import { signSandboxRequest, sandboxAuthEnv, sandboxAuthPublicKey, SANDBOX_AUTH_HEADER } from './request-signing';
import { sandboxHeaders } from './fetch';
import type { Env } from '../types';

function b64(bytes: ArrayBuffer): string {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64urlDecode(s: string): Uint8Array {
  const n = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(n + '='.repeat((4 - (n.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

describe('sandbox request signing', () => {
  let signingKey: string;
  let publicKey: CryptoKey;

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    signingKey = b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
    publicKey = pair.publicKey;
  });

  async function verify(token: string): Promise<Record<string, unknown> | null> {
    const [payload, sig] = token.split('.');
    const ok = await crypto.subtle.verify(
      { name: 'Ed25519' }, publicKey, b64urlDecode(sig),
      new TextEncoder().encode('orcabot-sandbox-auth-v1.' + payload)
    );
    return ok ? JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) : null;
  }

  it('signs the target machine, method and request target', async () => {
    const headers = new Headers({ 'X-Sandbox-Machine-ID': 'machine-b' });
    await signSandboxRequest(signingKey, headers, 'post', 'https://sandbox.fly.dev/sessions/s1/file?path=/workspace/lost%2Bfound');
    const claims = await verify(headers.get(SANDBOX_AUTH_HEADER)!);
    expect(claims).toMatchObject({ mid: 'machine-b', m: 'POST', p: '/sessions/s1/file?path=/workspace/lost%2Bfound' });
    expect((claims!.exp as number) - (claims!.iat as number)).toBe(30);
    expect(headers.get('fly-force-instance-id')).toBe('machine-b');
  });

  it('does nothing when signing is not configured', async () => {
    const headers = new Headers({ 'X-Sandbox-Machine-ID': 'machine-b' });
    await signSandboxRequest(undefined, headers, 'GET', 'https://sandbox.fly.dev/health');
    expect(headers.get(SANDBOX_AUTH_HEADER)).toBeNull();
    expect(headers.get('fly-force-instance-id')).toBeNull();
  });

  it('leaves requests unsigned (not broken) when the key is invalid', async () => {
    const headers = new Headers();
    await signSandboxRequest('not-a-key', headers, 'GET', 'https://sandbox.fly.dev/health');
    expect(headers.get(SANDBOX_AUTH_HEADER)).toBeNull();
  });

  it('derives the public key handed to VMs', async () => {
    const raw = b64urlDecode((await sandboxAuthPublicKey(signingKey))!);
    const exported = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey) as ArrayBuffer);
    expect(Array.from(raw)).toEqual(Array.from(exported));
  });

  it('gives new VMs the public key, and the static token only while it is configured', async () => {
    const both = await sandboxAuthEnv({ SANDBOX_AUTH_SIGNING_KEY: signingKey, SANDBOX_INTERNAL_TOKEN: 'shared' });
    expect(Object.keys(both).sort()).toEqual(['SANDBOX_AUTH_PUBLIC_KEY', 'SANDBOX_INTERNAL_TOKEN']);
    const signedOnly = await sandboxAuthEnv({ SANDBOX_AUTH_SIGNING_KEY: signingKey });
    expect(Object.keys(signedOnly)).toEqual(['SANDBOX_AUTH_PUBLIC_KEY']);
  });

  it('sandboxHeaders overwrites any client-supplied auth/routing headers', async () => {
    const env = { SANDBOX_AUTH_SIGNING_KEY: signingKey, SANDBOX_INTERNAL_TOKEN: '' } as unknown as Env;
    const incoming = new Headers({
      'X-Sandbox-Auth': 'forged', 'X-Internal-Token': 'forged',
      'X-Sandbox-Machine-ID': 'machine-z', 'fly-force-instance-id': 'machine-z',
    });
    const headers = await sandboxHeaders(env, incoming, 'machine-b', 'GET', 'https://sandbox.fly.dev/sessions/s1/ptys/p1/ws');
    expect(headers.get('X-Internal-Token')).toBeNull();
    expect(headers.get('X-Sandbox-Machine-ID')).toBe('machine-b');
    expect(headers.get('fly-force-instance-id')).toBe('machine-b');
    expect(await verify(headers.get(SANDBOX_AUTH_HEADER)!)).toMatchObject({ mid: 'machine-b', p: '/sessions/s1/ptys/p1/ws' });
  });
});
