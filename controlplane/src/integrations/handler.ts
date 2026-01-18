// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

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

const DRIVE_AUTO_SYNC_LIMIT_BYTES = 1024 * 1024 * 1024;
const DRIVE_MANIFEST_VERSION = 1;
const DRIVE_UPLOAD_BUFFER_LIMIT_BYTES = 25 * 1024 * 1024;
const DRIVE_UPLOAD_PART_BYTES = 8 * 1024 * 1024;

interface DriveFileEntry {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  modifiedTime: string | null;
  md5Checksum: string | null;
  cacheStatus: 'cached' | 'skipped_large' | 'skipped_unsupported';
  placeholder?: string;
}

interface DriveManifest {
  version: number;
  folderId: string;
  folderName: string;
  folderPath: string;
  updatedAt: string;
  directories: string[];
  entries: DriveFileEntry[];
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const next = new Uint8Array(left.length + right.length);
  next.set(left);
  next.set(right, left.length);
  return next;
}

async function uploadDriveFileToCache(
  env: Env,
  key: string,
  response: Response,
  size: number
) {
  if (!response.body) {
    throw new Error('Drive download missing body');
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream';

  if (size <= DRIVE_UPLOAD_BUFFER_LIMIT_BYTES) {
    const buffer = await response.arrayBuffer();
    await env.DRIVE_CACHE.put(key, buffer, {
      httpMetadata: { contentType },
    });
    return;
  }

  const upload = await env.DRIVE_CACHE.createMultipartUpload(key, {
    httpMetadata: { contentType },
  });

  const parts: Array<{ partNumber: number; etag: string }> = [];
  const reader = response.body.getReader();
  let buffer = new Uint8Array(0);
  let partNumber = 1;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        buffer = concatBytes(buffer, value);
      }
      while (buffer.length >= DRIVE_UPLOAD_PART_BYTES) {
        const chunk = buffer.slice(0, DRIVE_UPLOAD_PART_BYTES);
        const uploaded = await upload.uploadPart(partNumber, chunk);
        parts.push({ partNumber, etag: uploaded.etag });
        buffer = buffer.slice(DRIVE_UPLOAD_PART_BYTES);
        partNumber += 1;
      }
    }

    if (buffer.length > 0) {
      const uploaded = await upload.uploadPart(partNumber, buffer);
      parts.push({ partNumber, etag: uploaded.etag });
    }

    await upload.complete(parts);
  } catch (error) {
    try {
      await upload.abort();
    } catch {
      // Ignore abort errors.
    }
    throw error;
  }
}

function getRedirectBase(request: Request, env: Env): string {
  if (env.OAUTH_REDIRECT_BASE) {
    return env.OAUTH_REDIRECT_BASE.replace(/\/$/, '');
  }
  return new URL(request.url).origin;
}

function sanitizePathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Drive';
  }
  return trimmed.replace(/[\\/]/g, '-');
}

function driveManifestKey(dashboardId: string): string {
  return `drive/${dashboardId}/manifest.json`;
}

function driveFileKey(dashboardId: string, fileId: string): string {
  return `drive/${dashboardId}/files/${fileId}`;
}

/**
 * Escape HTML special characters to prevent XSS attacks.
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildState(): string {
  return crypto.randomUUID();
}

async function createState(
  env: Env,
  userId: string,
  provider: string,
  state: string,
  metadata: Record<string, unknown> = {}
) {
  await env.DB.prepare(`
    INSERT INTO oauth_states (state, user_id, provider, metadata)
    VALUES (?, ?, ?, ?)
  `).bind(state, userId, provider, JSON.stringify(metadata)).run();
}

async function consumeState(env: Env, state: string, provider: string) {
  const record = await env.DB.prepare(`
    SELECT user_id as userId, metadata FROM oauth_states WHERE state = ? AND provider = ?
  `).bind(state, provider).first<{ userId: string; metadata: string }>();

  if (!record) {
    return null;
  }

  await env.DB.prepare(`
    DELETE FROM oauth_states WHERE state = ?
  `).bind(state).run();

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(record.metadata || '{}') as Record<string, unknown>;
  } catch {
    metadata = {};
  }

  return { userId: record.userId, metadata };
}

async function refreshGoogleAccessToken(env: Env, userId: string): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth is not configured.');
  }

  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'google_drive'
  `).bind(userId).first<{ access_token: string; refresh_token: string | null }>();

  if (!record?.refresh_token) {
    throw new Error('Google Drive must be connected again.');
  }

  const body = new URLSearchParams();
  body.set('client_id', env.GOOGLE_CLIENT_ID);
  body.set('client_secret', env.GOOGLE_CLIENT_SECRET);
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', record.refresh_token);

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!tokenResponse.ok) {
    throw new Error('Failed to refresh Google access token.');
  }

  const tokenData = await tokenResponse.json() as {
    access_token: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  const now = new Date();
  const expiresAt = tokenData.expires_in
    ? new Date(now.getTime() + tokenData.expires_in * 1000).toISOString()
    : null;

  await env.DB.prepare(`
    UPDATE user_integrations
    SET access_token = ?, scope = ?, token_type = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'google_drive'
  `).bind(
    tokenData.access_token,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    userId
  ).run();

  return tokenData.access_token;
}

function joinDrivePath(parent: string, name: string): string {
  if (!parent) return name;
  return `${parent}/${name}`;
}

async function listDriveChildren(
  accessToken: string,
  folderId: string
): Promise<Array<{
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
}>> {
  const files: Array<{
    id: string;
    name: string;
    mimeType: string;
    size?: string;
    modifiedTime?: string;
    md5Checksum?: string;
  }> = [];
  let pageToken: string | null = null;

  do {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', `'${folderId}' in parents and trashed = false`);
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      throw new Error('Failed to list Google Drive folder.');
    }

    const data = await res.json() as {
      files?: Array<{
        id: string;
        name: string;
        mimeType: string;
        size?: string;
        modifiedTime?: string;
        md5Checksum?: string;
      }>;
      nextPageToken?: string;
    };

    if (data.files) {
      files.push(...data.files);
    }
    pageToken = data.nextPageToken ?? null;
  } while (pageToken);

  return files;
}

async function buildDriveManifest(
  accessToken: string,
  folderId: string,
  folderName: string
): Promise<{ manifest: DriveManifest; entries: DriveFileEntry[] }> {
  const queue: Array<{ id: string; path: string }> = [{ id: folderId, path: '' }];
  const entries: DriveFileEntry[] = [];
  const directories: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.path) {
      directories.push(current.path);
    }
    const children = await listDriveChildren(accessToken, current.id);
    for (const child of children) {
      if (child.mimeType === 'application/vnd.google-apps.folder') {
        queue.push({ id: child.id, path: joinDrivePath(current.path, child.name) });
        continue;
      }
      const size = child.size ? Number(child.size) : 0;
      entries.push({
        id: child.id,
        name: child.name,
        path: joinDrivePath(current.path, child.name),
        mimeType: child.mimeType,
        size: Number.isNaN(size) ? 0 : size,
        modifiedTime: child.modifiedTime || null,
        md5Checksum: child.md5Checksum || null,
        cacheStatus: 'cached',
      });
    }
  }

  const safeFolderName = sanitizePathSegment(folderName);
  const now = new Date().toISOString();
  const manifest: DriveManifest = {
    version: DRIVE_MANIFEST_VERSION,
    folderId,
    folderName,
    folderPath: `drive/${safeFolderName}`,
    updatedAt: now,
    directories,
    entries,
  };

  return { manifest, entries };
}

function renderSuccessPage(providerLabel: string): Response {
  const safeLabel = escapeHtml(providerLabel);
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${safeLabel} connected</title>
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
      <h1>${safeLabel} connected</h1>
      <p>You can close this tab and return to OrcaBot.</p>
      <button onclick="window.close()">Close tab</button>
    </div>
  </body>
</html>`,
    {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }
  );
}

function renderDrivePickerPage(
  accessToken: string,
  apiKey: string,
  frontendUrl: string,
  dashboardId: string | null
): Response {
  const tokenJson = JSON.stringify(accessToken);
  const apiKeyJson = JSON.stringify(apiKey);
  const frontendJson = JSON.stringify(frontendUrl);
  const dashboardJson = JSON.stringify(dashboardId);
  const frontendOrigin = new URL(frontendUrl).origin;
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Google Drive connected</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      .card { max-width: 520px; margin: 0 auto; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #4b5563; }
      button { padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 6px; background: #111827; color: #fff; cursor: pointer; }
      .status { font-size: 12px; margin-top: 12px; color: #6b7280; }
    </style>
    <script src="https://apis.google.com/js/api.js"></script>
  </head>
  <body>
    <div class="card">
      <h1>Google Drive connected</h1>
      <p>Select a Drive folder to link to OrcaBot.</p>
      <button id="picker-button" type="button">Select Drive folder</button>
      <div class="status" id="status">Loading Google Picker...</div>
    </div>
    <script>
      const accessToken = ${tokenJson};
      const apiKey = ${apiKeyJson};
      const dashboardId = ${dashboardJson};
      const statusEl = document.getElementById('status');
      const frontendUrl = ${frontendJson};
      const frontendOrigin = ${JSON.stringify(frontendOrigin)};
      const buttonEl = document.getElementById('picker-button');
      let pickerLoaded = false;

      function setStatus(message) {
        if (statusEl) statusEl.textContent = message;
      }

      function onPickerReady() {
        pickerLoaded = true;
        openPicker();
      }

      function openPicker() {
        if (!pickerLoaded) {
          setStatus('Google Picker failed to load.');
          return;
        }
        const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
          .setIncludeFolders(true)
          .setSelectFolderEnabled(true);
        const picker = new google.picker.PickerBuilder()
          .addView(view)
          .setOAuthToken(accessToken)
          .setDeveloperKey(apiKey)
          .setOrigin(frontendOrigin)
          .setCallback(pickerCallback)
          .build();
        picker.setVisible(true);
      }

      function pickerCallback(data) {
        if (data.action !== google.picker.Action.PICKED) {
          if (data.action === google.picker.Action.CANCEL) {
            setStatus('Folder selection canceled.');
          }
          return;
        }

        const doc = data.docs && data.docs[0];
        if (!doc) {
          setStatus('No folder selected.');
          return;
        }

        const payload = {
          folderId: doc.id,
          folderName: doc.name || doc.title || 'Untitled folder',
          dashboardId: dashboardId,
        };

        setStatus('Saving folder selection...');
        fetch('/integrations/google/drive/folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        })
          .then(async (response) => {
            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(errorText || 'Failed to save selection.');
            }
            return response.json();
          })
          .then(() => {
            try {
              const targetWindow = window.opener || (window.parent !== window ? window.parent : null);
              if (targetWindow) {
                targetWindow.postMessage({ type: 'drive-linked', folder: payload }, frontendOrigin);
              }
            } catch {}
            setStatus('Folder linked. Returning to OrcaBot...');
            if (window.opener) {
              setTimeout(() => window.close(), 400);
            } else if (window.parent === window) {
              setTimeout(() => window.location.assign(frontendUrl), 600);
            }
          })
          .catch((error) => {
            setStatus(error.message || 'Failed to save selection.');
          });
      }

      function onApiLoad() {
        if (!window.gapi || !window.gapi.load) {
          setStatus('Failed to load Google Picker API.');
          return;
        }
        window.gapi.load('picker', { callback: onPickerReady });
      }

      if (window.gapi && window.gapi.load) {
        onApiLoad();
      } else {
        window.addEventListener('load', onApiLoad);
      }

      if (buttonEl) {
        buttonEl.addEventListener('click', () => {
          if (!pickerLoaded) {
            setStatus('Loading Google Picker...');
            return;
          }
          openPicker();
        });
      }
    </script>
  </body>
</html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `frame-ancestors ${frontendOrigin}`,
      },
    }
  );
}

function renderErrorPage(message: string): Response {
  const safeMessage = escapeHtml(message);
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
      <p>${safeMessage}</p>
    </div>
  </body>
</html>`,
    {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }
  );
}

function renderDriveAuthCompletePage(frontendUrl: string, dashboardId: string | null): Response {
  const frontendOrigin = new URL(frontendUrl).origin;
  const payload = JSON.stringify({ type: 'drive-auth-complete', dashboardId });
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Drive connected</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      .card { max-width: 520px; margin: 0 auto; text-align: center; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #4b5563; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Google Drive connected</h1>
      <p>You can return to OrcaBot.</p>
    </div>
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage(${payload}, ${JSON.stringify(frontendOrigin)});
        }
      } catch {}
      setTimeout(() => window.close(), 200);
    </script>
  </body>
</html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `frame-ancestors ${frontendOrigin}`,
      },
    }
  );
}

export async function cоnnectGoogleDrive(
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
  const requestUrl = new URL(request.url);
  const dashboardId = requestUrl.searchParams.get('dashboard_id');
  const mode = requestUrl.searchParams.get('mode');
  await createState(env, auth.user!.id, 'google_drive', state, {
    dashboard_id: dashboardId,
    popup: mode === 'popup',
  });

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/drive/callback`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GOOGLE_SCOPE.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

export async function callbackGооgleDrive(
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

  const stateData = await consumeState(env, state, 'google_drive');
  if (!stateData) {
    return renderErrorPage('Invalid or expired state.');
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === 'string'
    ? stateData.metadata.dashboard_id
    : null;
  const popup = stateData.metadata.popup === true;

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
    stateData.userId,
    tokenData.access_token,
    tokenData.refresh_token || null,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    metadata
  ).run();

  if (popup) {
    const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
    return renderDriveAuthCompletePage(frontendUrl, dashboardId);
  }

  if (!env.GOOGLE_API_KEY) {
    return renderErrorPage('Google API key is not configured.');
  }

  const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
  return renderDrivePickerPage(tokenData.access_token, env.GOOGLE_API_KEY, frontendUrl, dashboardId);
}

export async function setGoogleDriveFolder(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as {
    folderId?: string;
    folderName?: string;
    dashboardId?: string;
  };
  if (!data.folderId) {
    return Response.json({ error: 'E79821: folderId is required' }, { status: 400 });
  }
  if (!data.dashboardId) {
    return Response.json({ error: 'E79824: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79823: Not found or no access' }, { status: 404 });
  }

  const record = await env.DB.prepare(`
    SELECT metadata FROM user_integrations
    WHERE user_id = ? AND provider = 'google_drive'
  `).bind(auth.user!.id).first<{ metadata: string }>();

  if (!record) {
    return Response.json({ error: 'E79822: Google Drive not connected' }, { status: 404 });
  }

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(record.metadata || '{}') as Record<string, unknown>;
  } catch {
    metadata = {};
  }

  metadata.drive_folder = {
    id: data.folderId,
    name: data.folderName || '',
    linked_at: new Date().toISOString(),
  };

  await env.DB.prepare(`
    UPDATE user_integrations
    SET metadata = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'google_drive'
  `).bind(JSON.stringify(metadata), auth.user!.id).run();

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO drive_mirrors (
      dashboard_id, user_id, folder_id, folder_name, status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, 'idle', ?, ?)
    ON CONFLICT(dashboard_id) DO UPDATE SET
      user_id = excluded.user_id,
      folder_id = excluded.folder_id,
      folder_name = excluded.folder_name,
      status = 'idle',
      total_files = 0,
      total_bytes = 0,
      cache_synced_files = 0,
      cache_synced_bytes = 0,
      workspace_synced_files = 0,
      workspace_synced_bytes = 0,
      large_files = 0,
      large_bytes = 0,
      last_sync_at = null,
      sync_error = null,
      updated_at = excluded.updated_at
  `).bind(
    data.dashboardId,
    auth.user!.id,
    data.folderId,
    data.folderName || '',
    now,
    now
  ).run();

  try {
    await runDriveSync(env, auth.user!.id, data.dashboardId);
  } catch {
    // Best-effort sync on connect.
  }

  return Response.json({ ok: true });
}

export async function getGoogleDriveIntegration(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const record = await env.DB.prepare(`
    SELECT metadata FROM user_integrations
    WHERE user_id = ? AND provider = 'google_drive'
  `).bind(auth.user!.id).first<{ metadata: string }>();

  if (!record) {
    return Response.json({ connected: false, linked: false, folder: null });
  }

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  let folder: Record<string, unknown> | null = null;

  if (dashboardId) {
    const mirror = await env.DB.prepare(`
      SELECT folder_id, folder_name, updated_at FROM drive_mirrors
      WHERE dashboard_id = ? AND user_id = ?
    `).bind(dashboardId, auth.user!.id).first<{
      folder_id: string;
      folder_name: string;
      updated_at: string;
    }>();

    if (mirror) {
      folder = {
        id: mirror.folder_id,
        name: mirror.folder_name,
        linked_at: mirror.updated_at,
      };
    }
  }

  return Response.json({
    connected: true,
    linked: Boolean(folder),
    folder,
  });
}

export async function unlinkGoogleDriveFolder(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'E79839: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user!.id).first();

  if (!access) {
    return Response.json({ error: 'E79840: Not found or no access' }, { status: 404 });
  }

  const manifestObject = await env.DRIVE_CACHE.get(driveManifestKey(dashboardId));
  if (manifestObject) {
    const manifest = await manifestObject.json<DriveManifest>();
    await env.DRIVE_CACHE.delete(driveManifestKey(dashboardId));
    for (const entry of manifest.entries) {
      await env.DRIVE_CACHE.delete(driveFileKey(dashboardId, entry.id));
    }
  }

  await env.DB.prepare(`
    DELETE FROM drive_mirrors WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).run();

  return Response.json({ ok: true });
}

async function updateDriveMirrorCacheProgress(
  env: Env,
  dashboardId: string,
  cacheSyncedFiles: number,
  cacheSyncedBytes: number
) {
  await env.DB.prepare(`
    UPDATE drive_mirrors
    SET cache_synced_files = ?, cache_synced_bytes = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(cacheSyncedFiles, cacheSyncedBytes, dashboardId).run();
}

async function updateDriveMirrorWorkspaceProgress(
  env: Env,
  dashboardId: string,
  workspaceSyncedFiles: number,
  workspaceSyncedBytes: number
) {
  await env.DB.prepare(`
    UPDATE drive_mirrors
    SET workspace_synced_files = ?, workspace_synced_bytes = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(workspaceSyncedFiles, workspaceSyncedBytes, dashboardId).run();
}

async function startSandboxDriveSync(
  env: Env,
  dashboardId: string,
  sandboxSessionId: string,
  sandboxMachineId: string,
  folderName: string
) {
  try {
    const res = await fetch(`${env.SANDBOX_URL.replace(/\/$/, '')}/sessions/${sandboxSessionId}/drive/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': env.SANDBOX_INTERNAL_TOKEN,
        ...(sandboxMachineId ? { 'X-Sandbox-Machine-ID': sandboxMachineId } : {}),
      },
      body: JSON.stringify({
        dashboard_id: dashboardId,
        folder_name: folderName,
      }),
    });
    if (!res.ok) {
      throw new Error(`sandbox sync failed: ${res.status}`);
    }
  } catch {
    await env.DB.prepare(`
      UPDATE drive_mirrors
      SET sync_error = 'Failed to start sandbox sync', status = 'error', updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(dashboardId).run();
  }
}

export async function getGoogleDriveSyncStatus(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'E79825: dashboardId is required' }, { status: 400 });
  }

  const record = await env.DB.prepare(`
    SELECT * FROM drive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<Record<string, unknown>>();

  if (!record) {
    return Response.json({ connected: false });
  }

  let largeFiles: Array<{ id: string; path: string; size: number }> = [];
  const manifestObject = await env.DRIVE_CACHE.get(driveManifestKey(dashboardId));
  if (manifestObject) {
    const manifest = await manifestObject.json<DriveManifest>();
    largeFiles = manifest.entries
      .filter((entry) => entry.cacheStatus === 'skipped_large')
      .map((entry) => ({ id: entry.id, path: entry.path, size: entry.size }))
      .sort((a, b) => b.size - a.size);
  }

  return Response.json({
    connected: true,
    folder: {
      id: record.folder_id,
      name: record.folder_name,
    },
    status: record.status,
    totalFiles: record.total_files,
    totalBytes: record.total_bytes,
    cacheSyncedFiles: record.cache_synced_files,
    cacheSyncedBytes: record.cache_synced_bytes,
    workspaceSyncedFiles: record.workspace_synced_files,
    workspaceSyncedBytes: record.workspace_synced_bytes,
    largeFiles,
    lastSyncAt: record.last_sync_at,
    syncError: record.sync_error,
  });
}

export async function syncGoogleDriveMirror(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string };
  if (!data.dashboardId) {
    return Response.json({ error: 'E79826: dashboardId is required' }, { status: 400 });
  }

  try {
    await runDriveSync(env, auth.user!.id, data.dashboardId);

    return Response.json({ ok: true });
  } catch (error) {
    await env.DB.prepare(`
      UPDATE drive_mirrors
      SET status = 'error', sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      error instanceof Error ? error.message : 'Drive sync failed',
      data.dashboardId
    ).run();

    return Response.json({ error: 'E79829: Drive sync failed' }, { status: 500 });
  }
}

async function runDriveSync(env: Env, userId: string, dashboardId: string) {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first();

  if (!access) {
    throw new Error('E79827: Not found or no access');
  }

  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name FROM drive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first<{ folder_id: string; folder_name: string }>();

  if (!mirror) {
    throw new Error('E79828: Drive folder not linked');
  }

  await env.DB.prepare(`
    UPDATE drive_mirrors
    SET status = 'syncing_cache',
        sync_error = null,
        total_files = 0,
        total_bytes = 0,
        cache_synced_files = 0,
        cache_synced_bytes = 0,
        workspace_synced_files = 0,
        workspace_synced_bytes = 0,
        large_files = 0,
        large_bytes = 0,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();

  const accessToken = await refreshGoogleAccessToken(env, userId);
  const { manifest, entries } = await buildDriveManifest(accessToken, mirror.folder_id, mirror.folder_name);

  const existingManifestObject = await env.DRIVE_CACHE.get(driveManifestKey(dashboardId));
  const existingEntries = new Map<string, DriveFileEntry>();
  if (existingManifestObject) {
    const existingManifest = await existingManifestObject.json<DriveManifest>();
    for (const entry of existingManifest.entries) {
      existingEntries.set(entry.id, entry);
    }
  }

  let totalBytes = 0;
  let totalFiles = 0;
  let cacheSyncedFiles = 0;
  let cacheSyncedBytes = 0;
  let largeFiles = 0;
  let largeBytes = 0;

  for (const entry of entries) {
    totalFiles += 1;
    totalBytes += entry.size;

    if (entry.mimeType.startsWith('application/vnd.google-apps')) {
      entry.cacheStatus = 'skipped_unsupported';
      entry.placeholder = 'Google Docs files are not synced yet.';
      continue;
    }

    if (entry.size > DRIVE_AUTO_SYNC_LIMIT_BYTES) {
      entry.cacheStatus = 'skipped_large';
      entry.placeholder = 'File exceeds auto-sync limit (1GB).';
      largeFiles += 1;
      largeBytes += entry.size;
      continue;
    }

    const previous = existingEntries.get(entry.id);
    const unchanged = previous
      && previous.cacheStatus === 'cached'
      && previous.md5Checksum === entry.md5Checksum
      && previous.modifiedTime === entry.modifiedTime;

    const cacheKey = driveFileKey(dashboardId, entry.id);
    if (unchanged) {
      const head = await env.DRIVE_CACHE.head(cacheKey);
      if (head) {
        cacheSyncedFiles += 1;
        cacheSyncedBytes += entry.size;
        entry.cacheStatus = 'cached';
        await updateDriveMirrorCacheProgress(env, dashboardId, cacheSyncedFiles, cacheSyncedBytes);
        continue;
      }
    }

    const fileUrl = new URL(`https://www.googleapis.com/drive/v3/files/${entry.id}`);
    fileUrl.searchParams.set('alt', 'media');
    const fileResponse = await fetch(fileUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!fileResponse.ok || !fileResponse.body) {
      entry.cacheStatus = 'skipped_unsupported';
      entry.placeholder = 'Failed to download from Google Drive.';
      continue;
    }

    await uploadDriveFileToCache(env, cacheKey, fileResponse, entry.size);

    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    entry.cacheStatus = 'cached';
    await updateDriveMirrorCacheProgress(env, dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }

  manifest.entries = entries;
  await env.DRIVE_CACHE.put(driveManifestKey(dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE drive_mirrors
    SET status = 'syncing_workspace',
        total_files = ?,
        total_bytes = ?,
        cache_synced_files = ?,
        cache_synced_bytes = ?,
        large_files = ?,
        large_bytes = ?,
        last_sync_at = ?,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(
    totalFiles,
    totalBytes,
    cacheSyncedFiles,
    cacheSyncedBytes,
    largeFiles,
    largeBytes,
    now,
    dashboardId
  ).run();

  const sandboxRecord = await env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes
    WHERE dashboard_id = ?
  `).bind(dashboardId).first<{ sandbox_session_id: string; sandbox_machine_id: string }>();

  if (sandboxRecord?.sandbox_session_id) {
    await startSandboxDriveSync(
      env,
      dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || '',
      mirror.folder_name
    );
  } else {
    await env.DB.prepare(`
      UPDATE drive_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(dashboardId).run();
  }
}

export async function syncGoogleDriveLargeFiles(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string; fileIds?: string[] };
  if (!data.dashboardId || !Array.isArray(data.fileIds) || data.fileIds.length === 0) {
    return Response.json({ error: 'E79830: dashboardId and fileIds are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first();

  if (!access) {
    return Response.json({ error: 'E79831: Not found or no access' }, { status: 404 });
  }

  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name FROM drive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(data.dashboardId, auth.user!.id).first<{ folder_id: string; folder_name: string }>();

  if (!mirror) {
    return Response.json({ error: 'E79832: Drive folder not linked' }, { status: 404 });
  }

  const manifestObject = await env.DRIVE_CACHE.get(driveManifestKey(data.dashboardId));
  if (!manifestObject) {
    return Response.json({ error: 'E79833: Drive manifest missing. Run sync first.' }, { status: 404 });
  }
  const manifest = await manifestObject.json<DriveManifest>();
  const entryMap = new Map(manifest.entries.map((entry) => [entry.id, entry]));

  const accessToken = await refreshGoogleAccessToken(env, auth.user!.id);
  let cacheSyncedFiles = 0;
  let cacheSyncedBytes = 0;
  for (const entry of manifest.entries) {
    if (entry.cacheStatus === 'cached') {
      cacheSyncedFiles += 1;
      cacheSyncedBytes += entry.size;
    }
  }

  for (const fileId of data.fileIds) {
    const entry = entryMap.get(fileId);
    if (!entry || entry.cacheStatus !== 'skipped_large') {
      continue;
    }

    const fileUrl = new URL(`https://www.googleapis.com/drive/v3/files/${entry.id}`);
    fileUrl.searchParams.set('alt', 'media');
    const fileResponse = await fetch(fileUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!fileResponse.ok || !fileResponse.body) {
      continue;
    }

    await uploadDriveFileToCache(env, driveFileKey(data.dashboardId, entry.id), fileResponse, entry.size);

    entry.cacheStatus = 'cached';
    entry.placeholder = undefined;
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    await updateDriveMirrorCacheProgress(env, data.dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }

  await env.DRIVE_CACHE.put(driveManifestKey(data.dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE drive_mirrors
    SET status = 'syncing_workspace',
        sync_error = null,
        last_sync_at = ?,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(now, data.dashboardId).run();

  const sandboxRecord = await env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes
    WHERE dashboard_id = ?
  `).bind(data.dashboardId).first<{ sandbox_session_id: string; sandbox_machine_id: string }>();

  if (sandboxRecord?.sandbox_session_id) {
    await startSandboxDriveSync(
      env,
      data.dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || '',
      mirror.folder_name
    );
  } else {
    await env.DB.prepare(`
      UPDATE drive_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(data.dashboardId).run();
  }

  return Response.json({ ok: true });
}

export async function getDriveManifestInternal(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'E79834: dashboardId is required' }, { status: 400 });
  }

  const manifestObject = await env.DRIVE_CACHE.get(driveManifestKey(dashboardId));
  if (!manifestObject) {
    return Response.json({ error: 'E79835: Drive manifest not found' }, { status: 404 });
  }

  return new Response(manifestObject.body, {
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

export async function getDriveFileInternal(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  const fileId = url.searchParams.get('file_id');
  if (!dashboardId || !fileId) {
    return Response.json({ error: 'E79836: dashboardId and fileId are required' }, { status: 400 });
  }

  const object = await env.DRIVE_CACHE.get(driveFileKey(dashboardId, fileId));
  if (!object) {
    return Response.json({ error: 'E79837: Drive file not found' }, { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', headers.get('Content-Type') || 'application/octet-stream');
  return new Response(object.body, { headers });
}

export async function updateDriveSyncProgressInternal(
  request: Request,
  env: Env
): Promise<Response> {
  const data = await request.json() as {
    dashboardId?: string;
    workspaceSyncedFiles?: number;
    workspaceSyncedBytes?: number;
    status?: 'syncing_workspace' | 'ready' | 'error';
    syncError?: string | null;
  };

  if (!data.dashboardId) {
    return Response.json({ error: 'E79838: dashboardId is required' }, { status: 400 });
  }

  if (typeof data.workspaceSyncedFiles === 'number' && typeof data.workspaceSyncedBytes === 'number') {
    await updateDriveMirrorWorkspaceProgress(
      env,
      data.dashboardId,
      data.workspaceSyncedFiles,
      data.workspaceSyncedBytes
    );
  }

  if (data.status) {
    await env.DB.prepare(`
      UPDATE drive_mirrors
      SET status = ?, sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      data.status,
      data.syncError || null,
      data.dashboardId
    ).run();
  }

  return Response.json({ ok: true });
}

export async function renderGoogleDrivePicker(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_API_KEY) {
    return renderErrorPage('Google OAuth is not configured.');
  }

  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'google_drive'
  `).bind(auth.user!.id).first<{ access_token: string; refresh_token: string | null }>();

  if (!record?.refresh_token) {
    return renderErrorPage('Google Drive must be connected again to select a folder.');
  }

  const body = new URLSearchParams();
  body.set('client_id', env.GOOGLE_CLIENT_ID);
  body.set('client_secret', env.GOOGLE_CLIENT_SECRET);
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', record.refresh_token);

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!tokenResponse.ok) {
    return renderErrorPage('Failed to refresh Google access token.');
  }

  const tokenData = await tokenResponse.json() as {
    access_token: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  const now = new Date();
  const expiresAt = tokenData.expires_in
    ? new Date(now.getTime() + tokenData.expires_in * 1000).toISOString()
    : null;

  await env.DB.prepare(`
    UPDATE user_integrations
    SET access_token = ?, scope = ?, token_type = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'google_drive'
  `).bind(
    tokenData.access_token,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    auth.user!.id
  ).run();

  const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  return renderDrivePickerPage(tokenData.access_token, env.GOOGLE_API_KEY, frontendUrl, dashboardId);
}

export async function cоnnectGithub(
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

  const stateData = await consumeState(env, state, 'github');
  if (!stateData) {
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
    stateData.userId,
    tokenData.access_token,
    null,
    tokenData.scope || null,
    tokenData.token_type || null,
    null,
    metadata
  ).run();

  return renderSuccessPage('GitHub');
}
