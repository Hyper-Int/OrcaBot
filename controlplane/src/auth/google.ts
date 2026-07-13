// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: desktop-login-v1-google-nonce-poll
const moduleRevision = "desktop-login-v1-google-nonce-poll";
console.log(`[auth/google] REVISION: ${moduleRevision} loaded at ${new Date().toISOString()}`);

import type { Env } from '../types';
import { buildSessionCookie, createUserSession } from './sessions';
import { createApiToken } from './api-token';
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

  const requestUrl = new URL(request.url);
  const mode = requestUrl.searchParams.get('mode');
  const isPopupMode = mode === 'popup';
  // Desktop login: the app opens this in the OS browser and polls for the result
  // by a nonce (the OS browser can't hand a session back to the Tauri webview).
  // The result is a PAT (full credential), so it's protected with PKCE: the app
  // sends the code_challenge here and the matching verifier when it polls. Works on
  // any deployment; web popup/redirect login is untouched.
  const isDesktopMode = mode === 'desktop';
  const desktopNonce = isDesktopMode ? requestUrl.searchParams.get('nonce') : null;
  const desktopChallenge = isDesktopMode ? requestUrl.searchParams.get('challenge') : null;

  // Validate Turnstile bot verification token (skip if not configured, e.g. dev)
  // Skip Turnstile in popup/desktop mode — Google's consent screen provides bot protection
  if (env.TURNSTILE_SECRET_KEY && !isPopupMode && !isDesktopMode) {
    const turnstileToken = requestUrl.searchParams.get('turnstile_token');
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

  if (isDesktopMode && (!desktopNonce || !desktopChallenge)) {
    return renderErrorPage('Desktop sign-in is missing its nonce/challenge.');
  }

  const state = crypto.randomUUID();
  const redirectUri = `${getRedirectBase(request, env)}/auth/google/callback`;
  // Sentinel in the state's redirect slot tells the callback how to finish:
  //  - "popup"                     → postMessage completion page (web popup login)
  //  - "desktop:<nonce>:<challenge>" → mint a PAT, stash it for the desktop app to
  //                                    poll (PKCE-guarded), show a "return" page
  //  - a URL                       → normal 302 redirect + session cookie
  // nonce is a UUID and challenge is base64url — neither contains ':'.
  const postLoginRedirect = isPopupMode
    ? 'popup'
    : isDesktopMode
      ? `desktop:${desktopNonce}:${desktopChallenge}`
      : resolvePostLoginRedirect(request, env);

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

  // Desktop login: mint a PAT so the desktop app gets a real cloud credential
  // (for listing + syncing the user's cloud dashboards), and stash it — with the
  // PKCE challenge — keyed by the app's nonce for it to poll. No browser session
  // is useful (the app authenticates to its LOCAL control plane via dev-auth).
  if (postLoginRedirect.startsWith('desktop:')) {
    const [, nonce, challenge] = postLoginRedirect.split(':');
    const name = userInfo.name || userInfo.email.split('@')[0];
    const { token } = await createApiToken(env, userId, 'Orcabot Desktop');
    await createAuthState(
      env,
      `desktopresult:${nonce}`,
      JSON.stringify({ token, email: userInfo.email, name, challenge })
    );
    return renderDesktopReturnPage();
  }

  const session = await createUserSession(env, userId);
  const cookie = buildSessionCookie(request, session.id, session.expiresAt);

  // Popup mode: render completion page with postMessage instead of redirect
  if (postLoginRedirect === 'popup') {
    const frontendOrigin = env.FRONTEND_URL
      ? new URL(env.FRONTEND_URL).origin
      : new URL(request.url).origin;
    return renderLoginCompletePage(frontendOrigin, cookie, {
      id: userId,
      email: userInfo.email,
      name: userInfo.name || userInfo.email.split('@')[0],
    });
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: postLoginRedirect,
      'Set-Cookie': cookie,
    },
  });
}

function renderDesktopReturnPage(): Response {
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Signed in</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; background:#0d1117; color:#eef2f8; }
      .card { max-width: 520px; margin: 40px auto 0; text-align: center; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #9aa4b2; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Signed in to Orcabot</h1>
      <p>You can close this tab and return to the Orcabot app.</p>
    </div>
  </body>
</html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

/** base64url(SHA-256(input)) — PKCE S256 code_challenge computation. */
async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Desktop app polls this (by the nonce it started the browser flow with, plus the
 * PKCE verifier) to collect its cloud PAT + identity — the OS browser can't hand a
 * session back to the Tauri webview. Protected by PKCE: the result is only returned
 * to whoever holds the verifier whose SHA-256 matches the challenge sent at login,
 * so knowing the (browser-visible) nonce alone can't harvest the PAT.
 */
export async function getDesktopGoogleResult(request: Request, env: Env): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

  const url = new URL(request.url);
  const nonce = url.searchParams.get('nonce');
  const verifier = url.searchParams.get('verifier');
  if (!nonce || !verifier) {
    return json({ error: 'missing_nonce_or_verifier' }, 400);
  }

  const key = `desktopresult:${nonce}`;
  // Peek (don't consume): a wrong verifier must NOT delete the result, or an
  // attacker who guessed the nonce could deny the legit app its PAT.
  const rec = await env.DB
    .prepare('SELECT redirect_url as v FROM auth_states WHERE state = ?')
    .bind(key)
    .first<{ v: string }>();
  if (!rec) {
    return json({ pending: true });
  }
  let parsed: { token: string; email: string; name: string; challenge: string };
  try {
    parsed = JSON.parse(rec.v);
  } catch {
    return json({ error: 'corrupt' }, 500);
  }
  if ((await sha256Base64Url(verifier)) !== parsed.challenge) {
    return json({ error: 'forbidden' }, 403);
  }
  // Verified — consume it and hand back the PAT + identity.
  await env.DB.prepare('DELETE FROM auth_states WHERE state = ?').bind(key).run();
  return json({ token: parsed.token, email: parsed.email, name: parsed.name });
}

function renderLoginCompletePage(
  frontendOrigin: string,
  cookie: string,
  user: { id: string; email: string; name: string }
): Response {
  const payload = JSON.stringify({
    type: 'login-auth-complete',
    user: { id: user.id, email: user.email, name: user.name },
  });
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Signed in</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      .card { max-width: 520px; margin: 0 auto; text-align: center; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #4b5563; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Signed in</h1>
      <p>You can return to OrcaBot.</p>
    </div>
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage(${payload}, ${JSON.stringify(frontendOrigin)});
        }
      } catch {}
      try {
        var bc = new BroadcastChannel('orcabot-oauth');
        bc.postMessage(${payload});
        bc.close();
      } catch {}
      setTimeout(function() { window.close(); }, 200);
    </script>
  </body>
</html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `frame-ancestors ${frontendOrigin}`,
        'Set-Cookie': cookie,
      },
    }
  );
}
