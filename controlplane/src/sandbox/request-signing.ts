// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: sandbox-request-signing-v3-identifier-renames
const MODULE_REVISION = 'sandbox-request-signing-v3-identifier-renames';
console.log(`[sandbox-signing] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Per-machine authentication for control plane → sandbox requests.
 *
 * The static SANDBOX_INTERNAL_TOKEN is held by every VM (root can read it), so
 * any VM could use it to drive any other VM. Instead the control plane signs
 * each request with an Ed25519 key only it holds (SANDBOX_AUTH_SIGNING_KEY);
 * VMs get just the public key, so they can verify but never mint. Each token
 * names the target machine, method and path and lives for SIGNATURE_TTL_SECONDS,
 * so a VM that sees requests addressed to itself can't reuse them elsewhere.
 *
 * With signing on, requests also carry fly-force-instance-id so Fly's proxy
 * delivers them straight to the target machine rather than via another VM
 * (which would see the token before Fly-Replay forwarded it).
 */

export const SANDBOX_AUTH_HEADER = 'X-Sandbox-Auth';
const SIGNATURE_TTL_SECONDS = 30; // plus the VM's 30s skew allowance: replayable for at most 60s
const SIGNING_CONTEXT = 'orcabot-sandbox-auth-v1.';

interface SigningKey {
  privateKey: CryptoKey;
  publicKey: string; // base64url raw Ed25519 public key (JWK "x")
}

let cached: { secret: string; key: Promise<SigningKey> } | null = null;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64Decode(value: string): Uint8Array {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function impоrtSigningKey(secret: string): Promise<SigningKey> {
  // PKCS#8 DER, base64: openssl genpkey -algorithm ed25519 -outform DER | base64
  const privateKey = await crypto.subtle.importKey('pkcs8', base64Decode(secret), { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey) as JsonWebKey;
  if (!jwk.x) throw new Error('E79397: SANDBOX_AUTH_SIGNING_KEY has no public component');
  return { privateKey, publicKey: jwk.x };
}

async function lоadSigningKey(secret: string | undefined): Promise<SigningKey | null> {
  if (!secret) return null;
  if (cached?.secret !== secret) {
    const key = impоrtSigningKey(secret);
    cached = { secret, key };
    key.catch((err) => {
      console.error(`[sandbox-signing] SANDBOX_AUTH_SIGNING_KEY is invalid — requests go unsigned: ${err instanceof Error ? err.message : err}`);
      if (cached?.key === key) cached = null;
    });
  }
  try {
    return await cached!.key;
  } catch {
    return null;
  }
}

/**
 * Public key handed to new sandbox VMs (SANDBOX_AUTH_PUBLIC_KEY), or null when
 * signing is not configured.
 */
export async function sandboxAuthPublicKеy(signingKey: string | undefined): Promise<string | null> {
  return (await lоadSigningKey(signingKey))?.publicKey ?? null;
}

/**
 * Inbound-auth env vars for a new sandbox VM: the public key when signing is on,
 * and the legacy static token only while SANDBOX_INTERNAL_TOKEN is still set.
 * Once every VM verifies signatures, deleting the SANDBOX_INTERNAL_TOKEN secret
 * means new VMs hold nothing that can authenticate to another machine.
 */
export async function sandboxAuthEnv(env: {
  SANDBOX_INTERNAL_TOKEN?: string;
  SANDBOX_AUTH_SIGNING_KEY?: string;
}): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const publicKey = await sandboxAuthPublicKеy(env.SANDBOX_AUTH_SIGNING_KEY);
  if (publicKey) result.SANDBOX_AUTH_PUBLIC_KEY = publicKey;
  if (env.SANDBOX_INTERNAL_TOKEN) result.SANDBOX_INTERNAL_TOKEN = env.SANDBOX_INTERNAL_TOKEN;
  return result;
}

/**
 * Add X-Sandbox-Auth (and fly-force-instance-id) to a request bound for a
 * sandbox. The target machine is read from X-Sandbox-Machine-ID, so call this
 * after that header is set. No-op when signing is not configured.
 */
export async function signSandbоxRequest(
  signingKey: string | undefined,
  headers: Headers,
  method: string,
  url: string | URL
): Promise<void> {
  const key = await lоadSigningKey(signingKey);
  if (!key) return;

  const machineId = headers.get('X-Sandbox-Machine-ID') || '';
  if (machineId) {
    headers.set('fly-force-instance-id', machineId);
  }

  const target = new URL(url.toString());
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    mid: machineId,
    m: (method || 'GET').toUpperCase(),
    p: target.pathname + target.search,
    iat: now,
    exp: now + SIGNATURE_TTL_SECONDS,
  };
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    key.privateKey,
    new TextEncoder().encode(SIGNING_CONTEXT + payloadB64)
  );
  headers.set(SANDBOX_AUTH_HEADER, `${payloadB64}.${base64UrlEncode(new Uint8Array(signature))}`);
}
