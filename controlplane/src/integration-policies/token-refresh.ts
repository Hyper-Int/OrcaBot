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
      console.error(`[token-refresh] Google OAuth not configured for token refresh (userIntegrationId=${userIntegrationId}, provider=${provider})`);
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
      console.error(`[token-refresh] GitHub OAuth not configured for token refresh (userIntegrationId=${userIntegrationId}, provider=${provider})`);
      return null;
    }
    tokenUrl = 'https://github.com/login/oauth/access_token';
    body = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  } else if (provider === 'twitter') {
    // Twitter OAuth 2.0 refresh — uses Basic auth header (client_id:client_secret base64)
    if (!env.TWITTER_CLIENT_ID || !env.TWITTER_CLIENT_SECRET) {
      console.error('[token-refresh] Twitter OAuth not configured for token refresh');
      return null;
    }
    tokenUrl = 'https://api.twitter.com/2/oauth2/token';
    body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.TWITTER_CLIENT_ID,
    });
    // Twitter uses Basic auth for token refresh
    const basicAuth = btoa(`${env.TWITTER_CLIENT_ID}:${env.TWITTER_CLIENT_SECRET}`);
    try {
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'Authorization': `Basic ${basicAuth}`,
        },
        body,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        console.error(`[token-refresh] Twitter refresh failed:`, response.status, errBody);
        return null;
      }

      const tokenData = await response.json() as {
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
      };

      if (!tokenData.access_token) {
        console.error(`[token-refresh] Twitter refresh returned no access_token`);
        return null;
      }

      const expiresIn = tokenData.expires_in || 7200;
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

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

      console.log(`[token-refresh] Twitter token refreshed successfully`);
      return tokenData.access_token;
    } catch (err) {
      console.error(`[token-refresh] Twitter refresh error:`, err);
      return null;
    }
  } else if (provider === 'teams' || provider === 'outlook' || provider === 'onedrive') {
    const clientId = env.MICROSOFT_CLIENT_ID || env.ONEDRIVE_CLIENT_ID;
    const clientSecret = env.MICROSOFT_CLIENT_SECRET || env.ONEDRIVE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.error(`[token-refresh] Microsoft OAuth not configured for ${provider} refresh (userIntegrationId=${userIntegrationId})`);
      return null;
    }
    tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
    body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
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
      console.error(`[token-refresh] OAuth refresh failed for ${provider} (userIntegrationId=${userIntegrationId}):`, response.status, errBody);

      // Check for invalid_grant (revoked/expired refresh token)
      const isInvalidGrant = errBody.includes('invalid_grant') ||
        errBody.includes('bad_refresh_token') ||
        errBody.includes('The refresh token is invalid');

      if (isInvalidGrant) {
        // Mark the integration as needing reconnection
        console.warn(`[token-refresh] Refresh token invalid for ${provider} (userIntegrationId=${userIntegrationId}), user needs to reconnect`);
      }
      return null;
    }

    const tokenData = await response.json() as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };

    if (!tokenData.access_token) {
      console.error(`[token-refresh] OAuth refresh returned no access_token for ${provider} (userIntegrationId=${userIntegrationId})`);
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

    console.log(`[token-refresh] OAuth token refreshed successfully for ${provider} (userIntegrationId=${userIntegrationId})`);
    return tokenData.access_token;
  } catch (err) {
    console.error(`[token-refresh] OAuth refresh error for ${provider} (userIntegrationId=${userIntegrationId}):`, err);
    return null;
  }
}
