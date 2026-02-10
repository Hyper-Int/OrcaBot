// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: token-refresh-v1-extract-from-gateway
console.log(`[token-refresh] REVISION: token-refresh-v1-extract-from-gateway loaded at ${new Date().toISOString()}`);

/**
 * Shared OAuth token management: expiry check + automatic refresh.
 * Extracted from gateway.ts to avoid circular imports (gateway ↔ handler).
 */

import type { Env, IntegrationProvider } from '../types';

/**
 * Get a valid access token for a user integration, refreshing if expired.
 * Returns null if the token is expired and cannot be refreshed.
 */
export async function getAccessToken(
  env: Env,
  userIntegrationId: string,
  provider: IntegrationProvider
): Promise<string | null> {
  const userInt = await env.DB.prepare(`
    SELECT access_token, refresh_token, expires_at
    FROM user_integrations WHERE id = ?
  `).bind(userIntegrationId).first<{
    access_token: string;
    refresh_token: string | null;
    expires_at: string | null;
  }>();

  if (!userInt) {
    return null;
  }

  // Check if token is expired
  if (userInt.expires_at) {
    const expiresAt = new Date(userInt.expires_at);
    const now = new Date();
    const bufferMs = 5 * 60 * 1000; // 5 minute buffer

    if (expiresAt.getTime() - bufferMs < now.getTime()) {
      // Token is expired or about to expire - try to refresh
      if (userInt.refresh_token) {
        const newToken = await refreshOAuthToken(env, userIntegrationId, provider, userInt.refresh_token);
        if (newToken) {
          return newToken;
        }
      }
      return null; // Token expired and can't refresh
    }
  }

  return userInt.access_token;
}

async function refreshOAuthToken(
  env: Env,
  userIntegrationId: string,
  provider: IntegrationProvider,
  refreshToken: string
): Promise<string | null> {
  let tokenUrl: string;
  let body: URLSearchParams;

  // Determine the token endpoint and construct the refresh request
  if (provider === 'gmail' || provider === 'google_drive' || provider === 'google_calendar') {
    // Google OAuth refresh
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      console.error('[token-refresh] Google OAuth not configured for token refresh');
      return null;
    }
    tokenUrl = 'https://oauth2.googleapis.com/token';
    body = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  } else if (provider === 'github') {
    // GitHub OAuth refresh
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      console.error('[token-refresh] GitHub OAuth not configured for token refresh');
      return null;
    }
    tokenUrl = 'https://github.com/login/oauth/access_token';
    body = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  } else {
    // Browser and other providers don't use OAuth refresh
    console.warn(`[token-refresh] OAuth refresh not supported for provider: ${provider}`);
    return null;
  }

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error(`[token-refresh] OAuth refresh failed for ${provider}:`, response.status, errBody);

      // Check for invalid_grant (revoked/expired refresh token)
      const isInvalidGrant = errBody.includes('invalid_grant') ||
        errBody.includes('bad_refresh_token') ||
        errBody.includes('The refresh token is invalid');

      if (isInvalidGrant) {
        // Mark the integration as needing reconnection
        console.warn(`[token-refresh] Refresh token invalid for ${provider}, user needs to reconnect`);
      }
      return null;
    }

    const tokenData = await response.json() as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };

    if (!tokenData.access_token) {
      console.error(`[token-refresh] OAuth refresh returned no access_token for ${provider}`);
      return null;
    }

    // Calculate new expiration time (use 3600s/1h default if not specified)
    const expiresIn = tokenData.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // Update the stored token
    // Note: Some providers may also return a new refresh_token
    if (tokenData.refresh_token) {
      await env.DB.prepare(`
        UPDATE user_integrations
        SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(tokenData.access_token, tokenData.refresh_token, expiresAt, userIntegrationId).run();
    } else {
      await env.DB.prepare(`
        UPDATE user_integrations
        SET access_token = ?, expires_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(tokenData.access_token, expiresAt, userIntegrationId).run();
    }

    console.log(`[token-refresh] OAuth token refreshed successfully for ${provider}`);
    return tokenData.access_token;
  } catch (err) {
    console.error(`[token-refresh] OAuth refresh error for ${provider}:`, err);
    return null;
  }
}
