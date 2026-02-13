// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Env } from '../types';
import { buildSessionCookie, createUserSession } from './sessions';
import { processPendingInvitations } from '../members/handler';

const GOOGLE_LOGIN_SCOPE = [
  'openid',
  'email',
  'profile',
];

function getRedirectBase(request: Request, env: Env): string {
  if (env.OAUTH_REDIRECT_BASE) {
    return env.OAUTH_REDIRECT_BASE.replace(/\/$/, '');
  }
  return new URL(request.url).origin;
}

function getAllowedRedirects(env: Env): Set<string> | null {
  if (!env.ALLOWED_ORIGINS) {
    return null;
  }
  return new Set(
    env.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

function resolvePostLoginRedirect(request: Request, env: Env): string {
  const url = new URL(request.url);
  const redirectParam = url.searchParams.get('redirect');
  const fallback =
    env.FRONTEND_URL ||
    request.headers.get('Origin') ||
    url.origin;

  if (!redirectParam) {
    return fallback;
  }

  let redirectUrl: URL | null = null;
  try {
    redirectUrl = new URL(redirectParam);
  } catch {
    redirectUrl = null;
  }

  if (!redirectUrl || (redirectUrl.protocol !== 'https:' && redirectUrl.protocol !== 'http:')) {
    return fallback;
  }

  const allowed = getAllowedRedirects(env);
  if (allowed === null) {
    return redirectUrl.toString();
  }

  return allowed.has(redirectUrl.origin) ? redirectUrl.toString() : fallback;
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderErrorPage(message: string): Response {
  const safeMessage = escapeHtml(message);
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Sign-in failed</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      .card { max-width: 520px; margin: 0 auto; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #b91c1c; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Sign-in failed</h1>
      <p>${safeMessage}</p>
    </div>
  </body>
</html>`,
    {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }
  );
}

async function createAuthState(env: Env, state: string, redirectUrl: string) {
  await env.DB.prepare(`
    INSERT INTO auth_states (state, redirect_url)
    VALUES (?, ?)
  `).bind(state, redirectUrl).run();
}

async function consumeAuthState(env: Env, state: string): Promise<string | null> {
  const record = await env.DB.prepare(`
    SELECT redirect_url as redirectUrl FROM auth_states WHERE state = ?
  `).bind(state).first<{ redirectUrl: string }>();

  if (!record) {
    return null;
  }

  await env.DB.prepare(`
    DELETE FROM auth_states WHERE state = ?
  `).bind(state).run();

  return record.redirectUrl;
}

async function findOrCreateUser(env: Env, profile: { sub: string; email: string; name?: string }) {
  interface DbUser {
    id: string;
    email: string;
    name: string;
    created_at: string;
    trial_started_at: string | null;
  }

  const existing = await env.DB.prepare(`
    SELECT id, email, name, created_at, trial_started_at FROM users WHERE email = ?
  `).bind(profile.email).first<DbUser>();

  if (existing) {
    // Stamp trial_started_at on first login after subscription system deployment.
    // This gives existing users a fresh 3-day trial instead of treating them as expired.
    if (!existing.trial_started_at) {
      const now = new Date().toISOString();
      await env.DB.prepare(`
        UPDATE users SET trial_started_at = ? WHERE id = ?
      `).bind(now, existing.id).run();
    }
    return existing.id;
  }

  const userId = `google:${profile.sub}`;
  const now = new Date().toISOString();
  const name = profile.name || profile.email.split('@')[0];

  await env.DB.prepare(`
    INSERT INTO users (id, email, name, created_at, trial_started_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(userId, profile.email, name, now, now).run();

  return userId;
}

async function verifyTurnstileToken(
  token: string,
  secretKey: string,
  request: Request
): Promise<boolean> {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const response = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: secretKey,
        response: token,
        remoteip: ip,
      }),
    }
  );
  const result = (await response.json()) as {
    success: boolean;
    'error-codes'?: string[];
    hostname?: string;
  };
  if (!result.success) {
    console.error(
      `[turnstile] verification failed: errors=${JSON.stringify(result['error-codes'] || [])}, hostname=${result.hostname || 'unknown'}`
    );
  }
  return result.success;
}

export async function loginWithGoogle(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return renderErrorPage('Google OAuth is not configured.');
  }

  // Validate Turnstile bot verification token (skip if not configured, e.g. dev)
  if (env.TURNSTILE_SECRET_KEY) {
    const turnstileToken = new URL(request.url).searchParams.get(
      'turnstile_token'
    );
    if (!turnstileToken) {
      return renderErrorPage('Bot verification required. Please try again.');
    }
    const valid = await verifyTurnstileToken(
      turnstileToken,
      env.TURNSTILE_SECRET_KEY,
      request
    );
    if (!valid) {
      return renderErrorPage('Bot verification failed. Please try again.');
    }
  }

  const state = crypto.randomUUID();
  const redirectUri = `${getRedirectBase(request, env)}/auth/google/callback`;
  const postLoginRedirect = resolvePostLoginRedirect(request, env);

  await createAuthState(env, state, postLoginRedirect);

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_LOGIN_SCOPE.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');

  return Response.redirect(url.toString(), 302);
}

export async function callbackGoogle(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return renderErrorPage('Google OAuth is not configured.');
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return renderErrorPage('Missing authorization code.');
  }

  const postLoginRedirect = await consumeAuthState(env, state);
  if (!postLoginRedirect) {
    return renderErrorPage('Invalid or expired state.');
  }

  const redirectUri = `${getRedirectBase(request, env)}/auth/google/callback`;

  const body = new URLSearchParams();
  body.set('client_id', env.GOOGLE_CLIENT_ID);
  body.set('client_secret', env.GOOGLE_CLIENT_SECRET);
  body.set('code', code);
  body.set('grant_type', 'authorization_code');
  body.set('redirect_uri', redirectUri);

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!tokenResponse.ok) {
    return renderErrorPage('Failed to exchange token.');
  }

  const tokenData = await tokenResponse.json() as {
    access_token: string;
  };

  const userInfoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userInfoResponse.ok) {
    return renderErrorPage('Failed to fetch Google profile.');
  }

  const userInfo = await userInfoResponse.json() as {
    sub: string;
    email: string;
    name?: string;
    email_verified?: boolean;
  };

  if (!userInfo.email || !userInfo.sub) {
    return renderErrorPage('Google profile missing required fields.');
  }

  if (userInfo.email_verified !== true) {
    return renderErrorPage('Google account email is not verified.');
  }

  // When login is restricted, only emails in AUTH_ALLOWED_EMAILS may sign in.
  // Fail closed: if the allowlist is missing or empty, reject all logins.
  if (env.AUTH_LOGIN_RESTRICTED === 'true') {
    const allowed = new Set(
      (env.AUTH_ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
    );
    if (!allowed.has(userInfo.email.trim().toLowerCase())) {
      return renderErrorPage('Your email is not authorised to access this deployment.');
    }
  }

  const userId = await findOrCreateUser(env, userInfo);

  // Process any pending dashboard invitations for this email
  await processPendingInvitations(env, userId, userInfo.email);

  const session = await createUserSession(env, userId);
  const cookie = buildSessionCookie(request, session.id, session.expiresAt);

  return new Response(null, {
    status: 302,
    headers: {
      Location: postLoginRedirect,
      'Set-Cookie': cookie,
    },
  });
}
