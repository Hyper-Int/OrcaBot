// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Per-PTY tokens for integration policy gateway
 *
 * These tokens are used by the MCP server in the sandbox to call the integration
 * policy gateway. Each token is bound to a specific PTY (terminal) and cannot
 * be used to access other terminals' integrations.
 *
 * Security model:
 * - One sandbox per dashboard (multiple PTYs)
 * - Each PTY gets its own signed token containing terminal_id
 * - Gateway extracts terminal_id FROM the verified token (not from untrusted header)
 * - This prevents a compromised MCP server from impersonating other terminals
 *
 * Format: base64url(header).base64url(payload).base64url(signature)
 * - header: { alg: "HS256", typ: "JWT" }
 * - payload: { terminal_id, sandbox_id, dashboard_id, user_id, aud: "integration-gateway", exp, iat }
 * - signature: HMAC-SHA256(header.payload, secret)
 */

export interface PtyTokenClaims {
  terminal_id: string;        // PTY ID - the primary binding for integration policies
  sandbox_id: string;         // Sandbox session ID
  dashboard_id: string;       // Dashboard ID
  user_id: string;            // User who created the PTY
  aud: string;                // "integration-gateway"
  exp: number;                // Unix timestamp
  iat: number;                // Unix timestamp
}

const ALGORITHM = 'HS256';
const TOKEN_AUDIENCE = 'integration-gateway';
const TOKEN_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours (PTYs typically don't live longer)

function base64UrlEncode(data: Uint8Array | string): string {
  let str: string;
  if (typeof data === 'string') {
    str = data;
  } else {
    // Convert Uint8Array to binary string
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
 * Create a PTY-scoped token for integration gateway
 * @param terminalId - PTY ID (terminal_id) - REQUIRED
 * @param sandboxId - Sandbox session ID
 * @param dashboardId - Dashboard ID
 * @param userId - User ID who created the PTY
 * @param secret - Signing secret (INTERNAL_API_TOKEN)
 */
export async function createPtyToken(
  terminalId: string,
  sandboxId: string,
  dashboardId: string,
  userId: string,
  secret: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: ALGORITHM, typ: 'JWT' };
  const payload: PtyTokenClaims = {
    terminal_id: terminalId,
    sandbox_id: sandboxId,
    dashboard_id: dashboardId,
    user_id: userId,
    aud: TOKEN_AUDIENCE,
    exp: now + TOKEN_EXPIRY_SECONDS,
    iat: now,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const dataToSign = `${headerB64}.${payloadB64}`;
  const signature = await hmacSign(dataToSign, secret);

  return `${dataToSign}.${signature}`;
}

/**
 * Verify and decode a PTY-scoped token
 * Returns the claims if valid, null if invalid
 */
export async function verifyPtyToken(
  token: string,
  secret: string
): Promise<PtyTokenClaims | null> {
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
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as PtyTokenClaims;

    // Check required fields
    if (!payload.terminal_id || !payload.sandbox_id || !payload.dashboard_id ||
        !payload.user_id || !payload.aud || !payload.exp) {
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

    // Check iat (issued-at) with clock skew tolerance
    // Reject tokens issued too far in the future (clock skew attack prevention)
    const CLOCK_SKEW_TOLERANCE = 60; // 60 seconds
    if (payload.iat && payload.iat > now + CLOCK_SKEW_TOLERANCE) {
      console.warn(`[pty-token] Rejecting token with future iat: ${payload.iat} > ${now + CLOCK_SKEW_TOLERANCE}`);
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
