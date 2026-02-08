// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Dashboard-scoped tokens for MCP proxy
 *
 * These tokens are used by the sandbox MCP proxy to call control plane
 * internal MCP endpoints. They are scoped to a specific dashboard and
 * cannot be used to access other dashboards.
 *
 * Format: base64url(header).base64url(payload).base64url(signature)
 * - header: { alg: "HS256", typ: "JWT" }
 * - payload: { dashboard_id, session_id, aud: "mcp-ui", exp, iat }
 * - signature: HMAC-SHA256(header.payload, secret)
 */

export interface DashboardTokenClaims {
  dashboard_id: string;
  session_id?: string; // Optional - for auditing only, not enforced
  aud: string; // "mcp-ui"
  exp: number; // Unix timestamp
  iat: number; // Unix timestamp
}

const ALGORITHM = 'HS256';
const TOKEN_AUDIENCE = 'mcp-ui';
const TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

function base64UrlEncode(data: Uint8Array | string): string {
  let str: string;
  if (typeof data === 'string') {
    str = data;
  } else {
    // Convert Uint8Array to binary string (each byte as a char code)
    // This is necessary because btoa() only works with Latin1 characters
    let binary = '';
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    str = binary;
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  return atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, messageData);
  return base64UrlEncode(new Uint8Array(signature));
}

async function hmacVerify(data: string, signature: string, secret: string): Promise<boolean> {
  const expectedSignature = await hmacSign(data, secret);
  // Constant-time comparison
  if (signature.length !== expectedSignature.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Create a dashboard-scoped token for MCP proxy
 * @param dashboardId - Required dashboard to scope the token to
 * @param secret - Signing secret (INTERNAL_API_TOKEN)
 * @param sessionId - Optional session ID for auditing (not enforced)
 */
export async function createDashboardToken(
  dashboardId: string,
  secret: string,
  sessionId?: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: ALGORITHM, typ: 'JWT' };
  const payload: DashboardTokenClaims = {
    dashboard_id: dashboardId,
    aud: TOKEN_AUDIENCE,
    exp: now + TOKEN_EXPIRY_SECONDS,
    iat: now,
    ...(sessionId && { session_id: sessionId }),
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const dataToSign = `${headerB64}.${payloadB64}`;
  const signature = await hmacSign(dataToSign, secret);

  return `${dataToSign}.${signature}`;
}

/**
 * Verify and decode a dashboard-scoped token
 * Returns the claims if valid, null if invalid
 */
export async function verifyDashboardToken(
  token: string,
  secret: string
): Promise<DashboardTokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [headerB64, payloadB64, signature] = parts;
  const dataToVerify = `${headerB64}.${payloadB64}`;

  // Verify signature
  const valid = await hmacVerify(dataToVerify, signature, secret);
  if (!valid) {
    return null;
  }

  // Decode and validate header
  try {
    const header = JSON.parse(base64UrlDecode(headerB64));
    if (header.alg !== ALGORITHM || header.typ !== 'JWT') {
      return null;
    }
  } catch {
    return null;
  }

  // Decode and validate payload
  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as DashboardTokenClaims;

    // Check required fields (session_id is optional)
    if (!payload.dashboard_id || !payload.aud || !payload.exp) {
      return null;
    }

    // Check audience
    if (payload.aud !== TOKEN_AUDIENCE) {
      return null;
    }

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
