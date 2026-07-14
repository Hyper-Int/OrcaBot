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
  // Desktop login uses a LOOPBACK redirect (RFC 8252): the app runs a temporary
  // 127.0.0.1 listener and passes it as redirect_uri. After sign-in we redirect the
  // browser to that loopback with a one-time code — so the credential is delivered
  // only to a listener on the machine that started the flow. A phished victim's
  // browser hits THEIR own loopback, not the attacker's, which closes the earlier
  // pollable-rendezvous hole. `state` is the app's CSRF token for its listener.
  const isDesktopMode = mode === 'desktop';
  const desktopLoopback = isDesktopMode ? requestUrl.searchParams.get('redirect_uri') : null;
  const desktopState = isDesktopMode ? requestUrl.searchParams.get('state') : null;

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

  if (isDesktopMode && (!desktopLoopback || !desktopState || !isLoopbackRedirect(desktopLoopback))) {
    return renderErrorPage('Desktop sign-in requires a loopback redirect.');
  }

  const state = crypto.randomUUID();
  const redirectUri = `${getRedirectBase(request, env)}/auth/google/callback`;
  // Sentinel in the state's redirect slot tells the callback how to finish:
  //  - "popup"                       → postMessage completion page (web popup login)
  //  - "desktoplb:<base64 json>"     → mint a one-time code, redirect to the app's
  //                                    loopback so it can exchange the code for a PAT
  //  - a URL                         → normal 302 redirect + session cookie
  const postLoginRedirect = isPopupMode
    ? 'popup'
    : isDesktopMode
      ? `desktoplb:${btoa(JSON.stringify({ uri: desktopLoopback, st: desktopState }))}`
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

  // Desktop login (loopback): mint a one-time code, stash the identity (short
  // expiry), and redirect the browser to the app's 127.0.0.1 listener with the
  // code. The PAT is minted only when the app exchanges the code (exchangeDesktopCode)
  // — so an abandoned flow never creates a token, and the code reaches only a
  // listener on the machine that started the flow (not a global poll an attacker
  // could hit). Re-validate the loopback target before redirecting.
  if (postLoginRedirect.startsWith('desktoplb:')) {
    let uri: string;
    let st: string;
    try {
      const dec = JSON.parse(atob(postLoginRedirect.slice('desktoplb:'.length))) as {
        uri: string;
        st: string;
      };
      uri = dec.uri;
      st = dec.st;
    } catch {
      return renderErrorPage('Desktop sign-in state was corrupt.');
    }
    if (!isLoopbackRedirect(uri)) {
      return renderErrorPage('Invalid desktop redirect target.');
    }
    const name = userInfo.name || userInfo.email.split('@')[0];
    const code = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
    await createAuthState(
      env,
      `desktopcode:${code}`,
      JSON.stringify({
        userId,
        email: userInfo.email,
        name,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 min to exchange
      })
    );
    const dest = new URL(uri);
    dest.searchParams.set('code', code);
    dest.searchParams.set('state', st);
    return Response.redirect(dest.toString(), 302);
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


/** A redirect target usable by the desktop loopback flow: http on 127.0.0.1/::1/
 *  localhost only. Enforced at login AND before the callback redirect so a crafted
 *  redirect_uri can't send a signed-in victim's code anywhere but their own machine. */
function isLoopbackRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'http:') return false;
    return u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === 'localhost';
  } catch {
    return false;
  }
}

/**
 * Desktop app exchanges the one-time `code` it received on its 127.0.0.1 listener
 * (from the OAuth callback redirect) for its cloud PAT + identity. The code is the
 * only way to obtain the token and was delivered solely to a loopback listener on
 * the machine that ran the flow, so a remote attacker can't harvest it. Single-use
 * (consumed on lookup) and short-lived.
 */
export async function exchangeDesktopCode(request: Request, env: Env): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

  let body: { code?: string };
  try {
    body = (await request.json()) as { code?: string };
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const code = body.code;
  if (!code) {
    return json({ error: 'missing_code' }, 400);
  }

  const key = `desktopcode:${code}`;
  const rec = await env.DB
    .prepare('SELECT redirect_url as v FROM auth_states WHERE state = ?')
    .bind(key)
    .first<{ v: string }>();
  // Consume immediately (single-use) regardless of what happens next.
  await env.DB.prepare('DELETE FROM auth_states WHERE state = ?').bind(key).run();
  if (!rec) {
    return json({ error: 'not_found' }, 404);
  }
  let parsed: { userId: string; email: string; name: string; expiresAt?: number };
  try {
    parsed = JSON.parse(rec.v);
  } catch {
    return json({ error: 'corrupt' }, 500);
  }
  if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
    return json({ error: 'expired' }, 410);
  }
  const { token } = await createApiToken(env, parsed.userId, 'Orcabot Desktop');
  return json({ token, email: parsed.email, name: parsed.name });
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
