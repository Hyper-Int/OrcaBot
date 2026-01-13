import type { Env } from '../types';
import type { AuthContext } from '../auth/middleware';
import { requireAuth } from '../auth/middleware';

const GOOGLE_SCOPE = [
  'https://www.googleapis.com/auth/drive',
];

const GITHUB_SCOPE = [
  'repo',
  'read:user',
  'user:email',
];

function getRedirectBase(request: Request, env: Env): string {
  if (env.OAUTH_REDIRECT_BASE) {
    return env.OAUTH_REDIRECT_BASE.replace(/\/$/, '');
  }
  return new URL(request.url).origin;
}

function buildState(): string {
  return crypto.randomUUID();
}

async function createState(env: Env, userId: string, provider: string, state: string) {
  await env.DB.prepare(`
    INSERT INTO oauth_states (state, user_id, provider)
    VALUES (?, ?, ?)
  `).bind(state, userId, provider).run();
}

async function consumeState(env: Env, state: string, provider: string) {
  const record = await env.DB.prepare(`
    SELECT user_id as userId FROM oauth_states WHERE state = ? AND provider = ?
  `).bind(state, provider).first<{ userId: string }>();

  if (!record) {
    return null;
  }

  await env.DB.prepare(`
    DELETE FROM oauth_states WHERE state = ?
  `).bind(state).run();

  return record.userId;
}

function renderSuccessPage(providerLabel: string): Response {
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${providerLabel} connected</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      .card { max-width: 520px; margin: 0 auto; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #4b5563; }
      button { padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 6px; background: #111827; color: #fff; cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${providerLabel} connected</h1>
      <p>You can close this tab and return to Hyper.</p>
      <button onclick="window.close()">Close tab</button>
    </div>
  </body>
</html>`,
    {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }
  );
}

function renderErrorPage(message: string): Response {
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Connection failed</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      .card { max-width: 520px; margin: 0 auto; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #b91c1c; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Connection failed</h1>
      <p>${message}</p>
    </div>
  </body>
</html>`,
    {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }
  );
}

export async function connectGoogleDrive(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return renderErrorPage('Google OAuth is not configured.');
  }

  const state = buildState();
  await createState(env, auth.user!.id, 'google_drive', state);

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/drive/callback`;

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPE.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);

  return Response.redirect(url.toString(), 302);
}

export async function callbackGoogleDrive(
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

  const userId = await consumeState(env, state, 'google_drive');
  if (!userId) {
    return renderErrorPage('Invalid or expired state.');
  }

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/drive/callback`;

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
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  const now = new Date();
  const expiresAt = tokenData.expires_in
    ? new Date(now.getTime() + tokenData.expires_in * 1000).toISOString()
    : null;

  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
  });

  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'google_drive', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      scope = excluded.scope,
      token_type = excluded.token_type,
      expires_at = excluded.expires_at,
      metadata = excluded.metadata,
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(),
    userId,
    tokenData.access_token,
    tokenData.refresh_token || null,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    metadata
  ).run();

  return renderSuccessPage('Google Drive');
}

export async function connectGithub(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return renderErrorPage('GitHub OAuth is not configured.');
  }

  const state = buildState();
  await createState(env, auth.user!.id, 'github', state);

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/github/callback`;

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', GITHUB_SCOPE.join(' '));
  url.searchParams.set('state', state);

  return Response.redirect(url.toString(), 302);
}

export async function callbackGithub(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return renderErrorPage('GitHub OAuth is not configured.');
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return renderErrorPage('Missing authorization code.');
  }

  const userId = await consumeState(env, state, 'github');
  if (!userId) {
    return renderErrorPage('Invalid or expired state.');
  }

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/github/callback`;

  const body = new URLSearchParams();
  body.set('client_id', env.GITHUB_CLIENT_ID);
  body.set('client_secret', env.GITHUB_CLIENT_SECRET);
  body.set('code', code);
  body.set('redirect_uri', redirectUri);

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
  });

  if (!tokenResponse.ok) {
    return renderErrorPage('Failed to exchange token.');
  }

  const tokenData = await tokenResponse.json() as {
    access_token: string;
    scope?: string;
    token_type?: string;
  };

  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
  });

  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'github', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      scope = excluded.scope,
      token_type = excluded.token_type,
      expires_at = excluded.expires_at,
      metadata = excluded.metadata,
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(),
    userId,
    tokenData.access_token,
    null,
    tokenData.scope || null,
    tokenData.token_type || null,
    null,
    metadata
  ).run();

  return renderSuccessPage('GitHub');
}
