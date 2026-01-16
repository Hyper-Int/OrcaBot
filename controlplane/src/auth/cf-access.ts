// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Cloudflare Access JWT Validation
 *
 * Validates JWT tokens from Cloudflare Access for production authentication.
 * CF Access adds the `CF-Access-JWT-Assertion` header to all authenticated requests.
 *
 * Required env vars:
 * - CF_ACCESS_TEAM_DOMAIN: Your team domain (e.g., "myteam" for myteam.cloudflareaccess.com)
 * - CF_ACCESS_AUD: The Application Audience (AUD) tag from CF Access dashboard
 */

import type { Env, User } from '../types';

interface CfAccessPayload {
  aud: string[];
  email: string;
  sub: string;
  iat: number;
  exp: number;
  type: string;
  identity_nonce: string;
  name?: string;
}

interface CfAccessKeys {
  keys: JsonWebKey[];
  public_certs: { kid: string; cert: string }[];
}

// Cache for CF Access public keys (refreshed every 24h)
let cachedKeys: CfAccessKeys | null = null;
let keysCachedAt = 0;
const KEYS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch Cloudflare Access public keys for JWT verification
 */
async function getAccessKeys(teamDomain: string): Promise<CfAccessKeys> {
  const now = Date.now();

  if (cachedKeys && now - keysCachedAt < KEYS_CACHE_TTL) {
    return cachedKeys;
  }

  const certsUrl = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const response = await fetch(certsUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch CF Access keys: ${response.status}`);
  }

  cachedKeys = await response.json() as CfAccessKeys;
  keysCachedAt = now;
  return cachedKeys;
}

/**
 * Decode a base64url string to Uint8Array
 */
function base64UrlDecode(str: string): Uint8Array {
  // Convert base64url to base64
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // Pad if necessary
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Parse JWT without verification (to get header/payload)
 */
function parseJwt(token: string): { header: { kid: string; alg: string }; payload: CfAccessPayload } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const headerJson = new TextDecoder().decode(base64UrlDecode(parts[0]));
  const payloadJson = new TextDecoder().decode(base64UrlDecode(parts[1]));

  return {
    header: JSON.parse(headerJson),
    payload: JSON.parse(payloadJson),
  };
}

/**
 * Verify JWT signature using Web Crypto API
 */
async function verifyJwtSignature(
  token: string,
  keys: CfAccessKeys
): Promise<CfAccessPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const { header, payload } = parseJwt(token);

  // Find the matching key
  const jwk = keys.keys.find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) {
    throw new Error(`No matching key found for kid: ${header.kid}`);
  }

  // Import the key
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  // Verify signature
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlDecode(parts[2]);

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signature,
    signedData
  );

  if (!valid) {
    throw new Error('Invalid JWT signature');
  }

  return payload;
}

/**
 * Validate Cloudflare Access JWT and extract user identity
 */
export async function validateCfAccessTоken(
  request: Request,
  env: Env
): Promise<{ email: string; sub: string; name?: string } | null> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const expectedAud = env.CF_ACCESS_AUD;

  if (!teamDomain || !expectedAud) {
    console.error('CF Access not configured: missing CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD');
    return null;
  }

  // Get the JWT from CF Access header
  const jwt = request.headers.get('CF-Access-JWT-Assertion');
  if (!jwt) {
    return null;
  }

  try {
    // Get public keys
    const keys = await getAccessKeys(teamDomain);

    // Verify and decode JWT
    const payload = await verifyJwtSignature(jwt, keys);

    // Verify audience
    if (!payload.aud.includes(expectedAud)) {
      console.error('JWT audience mismatch');
      return null;
    }

    // Verify expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      console.error('JWT expired');
      return null;
    }

    return {
      email: payload.email,
      sub: payload.sub,
      name: payload.name,
    };
  } catch (error) {
    console.error('CF Access JWT validation failed:', error);
    return null;
  }
}

/**
 * Generate a stable user ID from CF Access subject
 */
export function cfAccessUserIdFrоmSub(sub: string): string {
  // CF Access sub is already unique per user, prefix it
  return `cfa-${sub}`;
}
