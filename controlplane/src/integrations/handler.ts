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

const BOX_SCOPE = [
  'root_readonly',
];

const ONEDRIVE_SCOPE = [
  'offline_access',
  'Files.Read',
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

function mirrorManifestKey(provider: string, dashboardId: string): string {
  return `mirror/${provider}/${dashboardId}/manifest.json`;
}

function mirrorFileKey(provider: string, dashboardId: string, fileId: string): string {
  return `mirror/${provider}/${dashboardId}/files/${fileId}`;
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

async function refreshBoxAccessToken(env: Env, userId: string): Promise<string> {
  if (!env.BOX_CLIENT_ID || !env.BOX_CLIENT_SECRET) {
    throw new Error('Box OAuth is not configured.');
  }

  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'box'
  `).bind(userId).first<{ access_token: string; refresh_token: string | null }>();

  if (!record?.refresh_token) {
    throw new Error('Box must be connected again.');
  }

  const body = new URLSearchParams();
  body.set('client_id', env.BOX_CLIENT_ID);
  body.set('client_secret', env.BOX_CLIENT_SECRET);
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', record.refresh_token);

  const tokenResponse = await fetch('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!tokenResponse.ok) {
    throw new Error('Failed to refresh Box access token.');
  }

  const tokenData = await tokenResponse.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  const now = new Date();
  const expiresAt = tokenData.expires_in
    ? new Date(now.getTime() + tokenData.expires_in * 1000).toISOString()
    : null;

  await env.DB.prepare(`
    UPDATE user_integrations
    SET access_token = ?, refresh_token = ?, token_type = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'box'
  `).bind(
    tokenData.access_token,
    tokenData.refresh_token || record.refresh_token,
    tokenData.token_type || null,
    expiresAt,
    userId
  ).run();

  return tokenData.access_token;
}

async function refreshOnedriveAccessToken(env: Env, userId: string): Promise<string> {
  if (!env.ONEDRIVE_CLIENT_ID || !env.ONEDRIVE_CLIENT_SECRET) {
    throw new Error('OneDrive OAuth is not configured.');
  }

  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'onedrive'
  `).bind(userId).first<{ access_token: string; refresh_token: string | null }>();

  if (!record?.refresh_token) {
    throw new Error('OneDrive must be connected again.');
  }

  const body = new URLSearchParams();
  body.set('client_id', env.ONEDRIVE_CLIENT_ID);
  body.set('client_secret', env.ONEDRIVE_CLIENT_SECRET);
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', record.refresh_token);
  body.set('scope', ONEDRIVE_SCOPE.join(' '));

  const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!tokenResponse.ok) {
    throw new Error('Failed to refresh OneDrive access token.');
  }

  const tokenData = await tokenResponse.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  const now = new Date();
  const expiresAt = tokenData.expires_in
    ? new Date(now.getTime() + tokenData.expires_in * 1000).toISOString()
    : null;

  await env.DB.prepare(`
    UPDATE user_integrations
    SET access_token = ?, refresh_token = ?, token_type = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'onedrive'
  `).bind(
    tokenData.access_token,
    tokenData.refresh_token || record.refresh_token,
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

function renderProviderAuthCompletePage(
  frontendUrl: string,
  providerLabel: string,
  messageType: string,
  dashboardId: string | null
): Response {
  const frontendOrigin = new URL(frontendUrl).origin;
  const payload = JSON.stringify({ type: messageType, dashboardId });
  const safeLabel = escapeHtml(providerLabel);
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${safeLabel} connected</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      .card { max-width: 520px; margin: 0 auto; text-align: center; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #4b5563; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${safeLabel} connected</h1>
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

// ============================================
// GitHub mirror
// ============================================

export async function getGithubIntegration(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  const integration = await env.DB.prepare(`
    SELECT 1 FROM user_integrations WHERE user_id = ? AND provider = 'github'
  `).bind(auth.user!.id).first();

  if (!integration) {
    return Response.json({ connected: false, linked: false, repo: null });
  }

  if (!dashboardId) {
    return Response.json({ connected: true, linked: false, repo: null });
  }

  const mirror = await env.DB.prepare(`
    SELECT repo_id, repo_owner, repo_name, repo_branch, updated_at
    FROM github_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{
    repo_id: string;
    repo_owner: string;
    repo_name: string;
    repo_branch: string;
    updated_at: string;
  }>();

  if (!mirror) {
    return Response.json({ connected: true, linked: false, repo: null });
  }

  return Response.json({
    connected: true,
    linked: true,
    repo: {
      id: mirror.repo_id,
      owner: mirror.repo_owner,
      name: mirror.repo_name,
      branch: mirror.repo_branch,
      linked_at: mirror.updated_at,
    },
  });
}

export async function getGithubRepos(
  _request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  try {
    const accessToken = await getGithubAccessToken(env, auth.user!.id);
    const repos = await listGithubRepos(accessToken);
    return Response.json({
      connected: true,
      repos: repos.map((repo) => ({
        id: repo.id,
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        branch: repo.default_branch,
        private: repo.private,
      })),
    });
  } catch {
    return Response.json({ connected: false, repos: [] });
  }
}

export async function setGithubRepo(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as {
    dashboardId?: string;
    repoId?: string | number;
    repoOwner?: string;
    repoName?: string;
    repoBranch?: string;
  };

  if (!data.dashboardId || !data.repoOwner || !data.repoName) {
    return Response.json({ error: 'E79840: dashboardId and repo are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first();

  if (!access) {
    return Response.json({ error: 'E79841: Not found or no access' }, { status: 404 });
  }

  const accessToken = await getGithubAccessToken(env, auth.user!.id);
  let branch = data.repoBranch;
  if (!branch) {
    const repoRes = await fetch(`https://api.github.com/repos/${data.repoOwner}/${data.repoName}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'OrcaBot',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!repoRes.ok) {
      return Response.json({ error: 'E79842: Failed to read repo metadata' }, { status: 400 });
    }
    const repoData = await repoRes.json() as { default_branch?: string };
    branch = repoData.default_branch || 'main';
  }

  await env.DB.prepare(`
    INSERT INTO github_mirrors (
      dashboard_id, user_id, repo_id, repo_owner, repo_name, repo_branch, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'idle', datetime('now'), datetime('now'))
    ON CONFLICT(dashboard_id) DO UPDATE SET
      user_id = excluded.user_id,
      repo_id = excluded.repo_id,
      repo_owner = excluded.repo_owner,
      repo_name = excluded.repo_name,
      repo_branch = excluded.repo_branch,
      status = 'idle',
      updated_at = datetime('now')
  `).bind(
    data.dashboardId,
    auth.user!.id,
    String(data.repoId || `${data.repoOwner}/${data.repoName}`),
    data.repoOwner,
    data.repoName,
    branch
  ).run();

  try {
    await runGithubSync(env, auth.user!.id, data.dashboardId);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'E79843: GitHub sync failed' }, { status: 500 });
  }

  return Response.json({ ok: true });
}

export async function unlinkGithubRepo(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'E79844: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user!.id).first();

  if (!access) {
    return Response.json({ error: 'E79845: Not found or no access' }, { status: 404 });
  }

  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('github', dashboardId));
  if (manifestObject) {
    const manifest = await manifestObject.json<DriveManifest>();
    await env.DRIVE_CACHE.delete(mirrorManifestKey('github', dashboardId));
    for (const entry of manifest.entries) {
      await env.DRIVE_CACHE.delete(mirrorFileKey('github', dashboardId, entry.id));
    }
  }

  await env.DB.prepare(`
    DELETE FROM github_mirrors WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).run();

  return Response.json({ ok: true });
}

async function updateGithubMirrorCacheProgress(
  env: Env,
  dashboardId: string,
  cacheSyncedFiles: number,
  cacheSyncedBytes: number
) {
  await env.DB.prepare(`
    UPDATE github_mirrors
    SET cache_synced_files = ?, cache_synced_bytes = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(cacheSyncedFiles, cacheSyncedBytes, dashboardId).run();
}

async function updateGithubMirrorWorkspaceProgress(
  env: Env,
  dashboardId: string,
  workspaceSyncedFiles: number,
  workspaceSyncedBytes: number
) {
  await env.DB.prepare(`
    UPDATE github_mirrors
    SET workspace_synced_files = ?, workspace_synced_bytes = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(workspaceSyncedFiles, workspaceSyncedBytes, dashboardId).run();
}

export async function getGithubSyncStatus(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'E79846: dashboardId is required' }, { status: 400 });
  }

  const record = await env.DB.prepare(`
    SELECT * FROM github_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<Record<string, unknown>>();

  if (!record) {
    return Response.json({ connected: false });
  }

  let largeFiles: Array<{ id: string; path: string; size: number }> = [];
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('github', dashboardId));
  if (manifestObject) {
    const manifest = await manifestObject.json<DriveManifest>();
    largeFiles = manifest.entries
      .filter((entry) => entry.cacheStatus === 'skipped_large')
      .map((entry) => ({ id: entry.id, path: entry.path, size: entry.size }))
      .sort((a, b) => b.size - a.size);
  }

  return Response.json({
    connected: true,
    repo: {
      id: record.repo_id,
      owner: record.repo_owner,
      name: record.repo_name,
      branch: record.repo_branch,
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

export async function syncGithubMirror(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string };
  if (!data.dashboardId) {
    return Response.json({ error: 'E79847: dashboardId is required' }, { status: 400 });
  }

  try {
    await runGithubSync(env, auth.user!.id, data.dashboardId);
    return Response.json({ ok: true });
  } catch (error) {
    await env.DB.prepare(`
      UPDATE github_mirrors
      SET status = 'error', sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      error instanceof Error ? error.message : 'GitHub sync failed',
      data.dashboardId
    ).run();
    return Response.json({ error: 'E79848: GitHub sync failed' }, { status: 500 });
  }
}

async function runGithubSync(env: Env, userId: string, dashboardId: string) {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first();

  if (!access) {
    throw new Error('E79849: Not found or no access');
  }

  const mirror = await env.DB.prepare(`
    SELECT repo_id, repo_owner, repo_name, repo_branch FROM github_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first<{
    repo_id: string;
    repo_owner: string;
    repo_name: string;
    repo_branch: string;
  }>();

  if (!mirror) {
    throw new Error('E79850: GitHub repo not linked');
  }

  await env.DB.prepare(`
    UPDATE github_mirrors
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

  const accessToken = await getGithubAccessToken(env, userId);
  const { manifest, entries } = await buildGithubManifest(
    accessToken,
    mirror.repo_owner,
    mirror.repo_name,
    mirror.repo_branch
  );

  const existingManifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('github', dashboardId));
  const existingEntries = new Map<string, DriveFileEntry>();
  if (existingManifestObject) {
    const existingManifest = await existingManifestObject.json<DriveManifest>();
    for (const entry of existingManifest.entries) {
      existingEntries.set(entry.id, entry);
    }
  }

  let totalFiles = 0;
  let totalBytes = 0;
  let cacheSyncedFiles = 0;
  let cacheSyncedBytes = 0;
  let largeFiles = 0;
  let largeBytes = 0;

  for (const entry of entries) {
    totalFiles += 1;
    totalBytes += entry.size;
    if (entry.size >= DRIVE_AUTO_SYNC_LIMIT_BYTES) {
      entry.cacheStatus = 'skipped_large';
      entry.placeholder = 'File exceeds sync limit. Click Sync to fetch it.';
      largeFiles += 1;
      largeBytes += entry.size;
      continue;
    }

    const previous = existingEntries.get(entry.id);
    if (previous && previous.md5Checksum && previous.md5Checksum === entry.md5Checksum) {
      entry.cacheStatus = previous.cacheStatus;
      if (entry.cacheStatus === 'cached') {
        cacheSyncedFiles += 1;
        cacheSyncedBytes += entry.size;
      }
      continue;
    }

    const fileRes = await fetch(`https://api.github.com/repos/${mirror.repo_owner}/${mirror.repo_name}/contents/${entry.path}?ref=${mirror.repo_branch}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'OrcaBot',
        Accept: 'application/vnd.github.raw',
      },
    });

    if (!fileRes.ok || !fileRes.body) {
      entry.cacheStatus = 'skipped_unsupported';
      entry.placeholder = 'Failed to download GitHub file.';
      continue;
    }

    await uploadDriveFileToCache(env, mirrorFileKey('github', dashboardId, entry.id), fileRes, entry.size);
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    entry.cacheStatus = 'cached';
    await updateGithubMirrorCacheProgress(env, dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }

  manifest.entries = entries;
  await env.DRIVE_CACHE.put(mirrorManifestKey('github', dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE github_mirrors
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
    await startSandboxMirrorSync(
      env,
      'github',
      dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || '',
      `${mirror.repo_owner}/${mirror.repo_name}`
    );
  } else {
    await env.DB.prepare(`
      UPDATE github_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(dashboardId).run();
  }
}

export async function syncGithubLargeFiles(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string; fileIds?: string[] };
  if (!data.dashboardId || !Array.isArray(data.fileIds) || data.fileIds.length === 0) {
    return Response.json({ error: 'E79851: dashboardId and fileIds are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first();

  if (!access) {
    return Response.json({ error: 'E79852: Not found or no access' }, { status: 404 });
  }

  const mirror = await env.DB.prepare(`
    SELECT repo_owner, repo_name, repo_branch FROM github_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(data.dashboardId, auth.user!.id).first<{ repo_owner: string; repo_name: string; repo_branch: string }>();

  if (!mirror) {
    return Response.json({ error: 'E79853: GitHub repo not linked' }, { status: 404 });
  }

  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('github', data.dashboardId));
  if (!manifestObject) {
    return Response.json({ error: 'E79854: GitHub manifest missing. Run sync first.' }, { status: 404 });
  }
  const manifest = await manifestObject.json<DriveManifest>();
  const entryMap = new Map(manifest.entries.map((entry) => [entry.id, entry]));

  const accessToken = await getGithubAccessToken(env, auth.user!.id);
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

    const fileRes = await fetch(`https://api.github.com/repos/${mirror.repo_owner}/${mirror.repo_name}/contents/${entry.path}?ref=${mirror.repo_branch}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'OrcaBot',
        Accept: 'application/vnd.github.raw',
      },
    });

    if (!fileRes.ok || !fileRes.body) {
      continue;
    }

    await uploadDriveFileToCache(env, mirrorFileKey('github', data.dashboardId, entry.id), fileRes, entry.size);

    entry.cacheStatus = 'cached';
    entry.placeholder = undefined;
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    await updateGithubMirrorCacheProgress(env, data.dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }

  await env.DRIVE_CACHE.put(mirrorManifestKey('github', data.dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE github_mirrors
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
    await startSandboxMirrorSync(
      env,
      'github',
      data.dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || '',
      `${mirror.repo_owner}/${mirror.repo_name}`
    );
  } else {
    await env.DB.prepare(`
      UPDATE github_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(data.dashboardId).run();
  }

  return Response.json({ ok: true });
}

export async function getGithubManifest(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'E79855: dashboardId is required' }, { status: 400 });
  }

  const mirror = await env.DB.prepare(`
    SELECT repo_owner, repo_name FROM github_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ repo_owner: string; repo_name: string }>();

  if (!mirror) {
    return Response.json({ connected: false });
  }

  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('github', dashboardId));
  if (!manifestObject) {
    return Response.json({
      connected: true,
      repo: { owner: mirror.repo_owner, name: mirror.repo_name },
      manifest: null,
    });
  }

  const manifest = await manifestObject.json<DriveManifest>();
  return Response.json({
    connected: true,
    repo: { owner: mirror.repo_owner, name: mirror.repo_name },
    manifest,
  });
}

// ============================================
// Box mirror
// ============================================

async function getBoxAccessToken(env: Env, userId: string): Promise<string> {
  const record = await env.DB.prepare(`
    SELECT access_token FROM user_integrations
    WHERE user_id = ? AND provider = 'box'
  `).bind(userId).first<{ access_token: string }>();

  if (!record?.access_token) {
    throw new Error('Box must be connected.');
  }
  return record.access_token;
}

export async function getBoxIntegration(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  const integration = await env.DB.prepare(`
    SELECT 1 FROM user_integrations WHERE user_id = ? AND provider = 'box'
  `).bind(auth.user!.id).first();

  if (!integration) {
    return Response.json({ connected: false, linked: false, folder: null });
  }

  if (!dashboardId) {
    return Response.json({ connected: true, linked: false, folder: null });
  }

  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name, updated_at
    FROM box_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ folder_id: string; folder_name: string; updated_at: string }>();

  if (!mirror) {
    return Response.json({ connected: true, linked: false, folder: null });
  }

  return Response.json({
    connected: true,
    linked: true,
    folder: {
      id: mirror.folder_id,
      name: mirror.folder_name,
      linked_at: mirror.updated_at,
    },
  });
}

export async function getBoxFolders(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const parentId = url.searchParams.get('parent_id') || '0';
  try {
    const accessToken = await getBoxAccessToken(env, auth.user!.id);
    const items = await listBoxFolderItems(accessToken, parentId);
    return Response.json({
      connected: true,
      parentId,
      folders: items
        .filter((item) => item.type === 'folder')
        .map((item) => ({ id: item.id, name: item.name })),
    });
  } catch {
    return Response.json({ connected: false, parentId, folders: [] });
  }
}

export async function setBoxFolder(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string; folderId?: string; folderName?: string };
  if (!data.dashboardId || !data.folderId || !data.folderName) {
    return Response.json({ error: 'E79860: dashboardId and folder are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first();

  if (!access) {
    return Response.json({ error: 'E79861: Not found or no access' }, { status: 404 });
  }

  await env.DB.prepare(`
    INSERT INTO box_mirrors (
      dashboard_id, user_id, folder_id, folder_name, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'idle', datetime('now'), datetime('now'))
    ON CONFLICT(dashboard_id) DO UPDATE SET
      user_id = excluded.user_id,
      folder_id = excluded.folder_id,
      folder_name = excluded.folder_name,
      status = 'idle',
      updated_at = datetime('now')
  `).bind(
    data.dashboardId,
    auth.user!.id,
    data.folderId,
    data.folderName
  ).run();

  try {
    await runBoxSync(env, auth.user!.id, data.dashboardId);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'E79862: Box sync failed' }, { status: 500 });
  }

  return Response.json({ ok: true });
}

export async function unlinkBoxFolder(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'E79863: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user!.id).first();

  if (!access) {
    return Response.json({ error: 'E79864: Not found or no access' }, { status: 404 });
  }

  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('box', dashboardId));
  if (manifestObject) {
    const manifest = await manifestObject.json<DriveManifest>();
    await env.DRIVE_CACHE.delete(mirrorManifestKey('box', dashboardId));
    for (const entry of manifest.entries) {
      await env.DRIVE_CACHE.delete(mirrorFileKey('box', dashboardId, entry.id));
    }
  }

  await env.DB.prepare(`
    DELETE FROM box_mirrors WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).run();

  return Response.json({ ok: true });
}

async function updateBoxMirrorCacheProgress(
  env: Env,
  dashboardId: string,
  cacheSyncedFiles: number,
  cacheSyncedBytes: number
) {
  await env.DB.prepare(`
    UPDATE box_mirrors
    SET cache_synced_files = ?, cache_synced_bytes = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(cacheSyncedFiles, cacheSyncedBytes, dashboardId).run();
}

async function updateBoxMirrorWorkspaceProgress(
  env: Env,
  dashboardId: string,
  workspaceSyncedFiles: number,
  workspaceSyncedBytes: number
) {
  await env.DB.prepare(`
    UPDATE box_mirrors
    SET workspace_synced_files = ?, workspace_synced_bytes = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(workspaceSyncedFiles, workspaceSyncedBytes, dashboardId).run();
}

export async function getBoxSyncStatus(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'E79865: dashboardId is required' }, { status: 400 });
  }

  const record = await env.DB.prepare(`
    SELECT * FROM box_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<Record<string, unknown>>();

  if (!record) {
    return Response.json({ connected: false });
  }

  let largeFiles: Array<{ id: string; path: string; size: number }> = [];
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('box', dashboardId));
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

export async function syncBoxMirror(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string };
  if (!data.dashboardId) {
    return Response.json({ error: 'E79866: dashboardId is required' }, { status: 400 });
  }

  try {
    await runBoxSync(env, auth.user!.id, data.dashboardId);
    return Response.json({ ok: true });
  } catch (error) {
    await env.DB.prepare(`
      UPDATE box_mirrors
      SET status = 'error', sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      error instanceof Error ? error.message : 'Box sync failed',
      data.dashboardId
    ).run();
    return Response.json({ error: 'E79867: Box sync failed' }, { status: 500 });
  }
}

async function runBoxSync(env: Env, userId: string, dashboardId: string) {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first();

  if (!access) {
    throw new Error('E79868: Not found or no access');
  }

  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name FROM box_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first<{ folder_id: string; folder_name: string }>();

  if (!mirror) {
    throw new Error('E79869: Box folder not linked');
  }

  await env.DB.prepare(`
    UPDATE box_mirrors
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

  const accessToken = await refreshBoxAccessToken(env, userId);
  const { manifest, entries } = await buildBoxManifest(accessToken, mirror.folder_id, mirror.folder_name);

  const existingManifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('box', dashboardId));
  const existingEntries = new Map<string, DriveFileEntry>();
  if (existingManifestObject) {
    const existingManifest = await existingManifestObject.json<DriveManifest>();
    for (const entry of existingManifest.entries) {
      existingEntries.set(entry.id, entry);
    }
  }

  let totalFiles = 0;
  let totalBytes = 0;
  let cacheSyncedFiles = 0;
  let cacheSyncedBytes = 0;
  let largeFiles = 0;
  let largeBytes = 0;

  for (const entry of entries) {
    totalFiles += 1;
    totalBytes += entry.size;
    if (entry.size >= DRIVE_AUTO_SYNC_LIMIT_BYTES) {
      entry.cacheStatus = 'skipped_large';
      entry.placeholder = 'File exceeds sync limit. Click Sync to fetch it.';
      largeFiles += 1;
      largeBytes += entry.size;
      continue;
    }

    const previous = existingEntries.get(entry.id);
    if (previous && previous.md5Checksum && previous.md5Checksum === entry.md5Checksum) {
      entry.cacheStatus = previous.cacheStatus;
      if (entry.cacheStatus === 'cached') {
        cacheSyncedFiles += 1;
        cacheSyncedBytes += entry.size;
      }
      continue;
    }

    const fileRes = await fetch(`https://api.box.com/2.0/files/${entry.id}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!fileRes.ok || !fileRes.body) {
      entry.cacheStatus = 'skipped_unsupported';
      entry.placeholder = 'Failed to download Box file.';
      continue;
    }

    await uploadDriveFileToCache(env, mirrorFileKey('box', dashboardId, entry.id), fileRes, entry.size);
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    entry.cacheStatus = 'cached';
    await updateBoxMirrorCacheProgress(env, dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }

  manifest.entries = entries;
  await env.DRIVE_CACHE.put(mirrorManifestKey('box', dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE box_mirrors
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
    await startSandboxMirrorSync(
      env,
      'box',
      dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || '',
      mirror.folder_name
    );
  } else {
    await env.DB.prepare(`
      UPDATE box_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(dashboardId).run();
  }
}

export async function syncBoxLargeFiles(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string; fileIds?: string[] };
  if (!data.dashboardId || !Array.isArray(data.fileIds) || data.fileIds.length === 0) {
    return Response.json({ error: 'E79870: dashboardId and fileIds are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first();

  if (!access) {
    return Response.json({ error: 'E79871: Not found or no access' }, { status: 404 });
  }

  const mirror = await env.DB.prepare(`
    SELECT folder_name FROM box_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(data.dashboardId, auth.user!.id).first<{ folder_name: string }>();

  if (!mirror) {
    return Response.json({ error: 'E79872: Box folder not linked' }, { status: 404 });
  }

  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('box', data.dashboardId));
  if (!manifestObject) {
    return Response.json({ error: 'E79873: Box manifest missing. Run sync first.' }, { status: 404 });
  }
  const manifest = await manifestObject.json<DriveManifest>();
  const entryMap = new Map(manifest.entries.map((entry) => [entry.id, entry]));

  const accessToken = await refreshBoxAccessToken(env, auth.user!.id);
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

    const fileRes = await fetch(`https://api.box.com/2.0/files/${entry.id}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!fileRes.ok || !fileRes.body) {
      continue;
    }

    await uploadDriveFileToCache(env, mirrorFileKey('box', data.dashboardId, entry.id), fileRes, entry.size);

    entry.cacheStatus = 'cached';
    entry.placeholder = undefined;
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    await updateBoxMirrorCacheProgress(env, data.dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }

  await env.DRIVE_CACHE.put(mirrorManifestKey('box', data.dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE box_mirrors
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
    await startSandboxMirrorSync(
      env,
      'box',
      data.dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || '',
      mirror.folder_name
    );
  } else {
    await env.DB.prepare(`
      UPDATE box_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(data.dashboardId).run();
  }

  return Response.json({ ok: true });
}

export async function getBoxManifest(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'E79874: dashboardId is required' }, { status: 400 });
  }

  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name FROM box_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ folder_id: string; folder_name: string }>();

  if (!mirror) {
    return Response.json({ connected: false });
  }

  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('box', dashboardId));
  if (!manifestObject) {
    return Response.json({
      connected: true,
      folder: { id: mirror.folder_id, name: mirror.folder_name },
      manifest: null,
    });
  }

  const manifest = await manifestObject.json<DriveManifest>();
  return Response.json({
    connected: true,
    folder: { id: mirror.folder_id, name: mirror.folder_name },
    manifest,
  });
}

// ============================================
// OneDrive mirror
// ============================================

async function getOnedriveAccessToken(env: Env, userId: string): Promise<string> {
  const record = await env.DB.prepare(`
    SELECT access_token FROM user_integrations
    WHERE user_id = ? AND provider = 'onedrive'
  `).bind(userId).first<{ access_token: string }>();

  if (!record?.access_token) {
    throw new Error('OneDrive must be connected.');
  }
  return record.access_token;
}

export async function getOnedriveIntegration(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  const integration = await env.DB.prepare(`
    SELECT 1 FROM user_integrations WHERE user_id = ? AND provider = 'onedrive'
  `).bind(auth.user!.id).first();

  if (!integration) {
    return Response.json({ connected: false, linked: false, folder: null });
  }

  if (!dashboardId) {
    return Response.json({ connected: true, linked: false, folder: null });
  }

  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name, updated_at
    FROM onedrive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ folder_id: string; folder_name: string; updated_at: string }>();

  if (!mirror) {
    return Response.json({ connected: true, linked: false, folder: null });
  }

  return Response.json({
    connected: true,
    linked: true,
    folder: {
      id: mirror.folder_id,
      name: mirror.folder_name,
      linked_at: mirror.updated_at,
    },
  });
}

export async function getOnedriveFolders(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const parentId = url.searchParams.get('parent_id') || 'root';
  try {
    const accessToken = await getOnedriveAccessToken(env, auth.user!.id);
    const items = await listOnedriveChildren(accessToken, parentId);
    return Response.json({
      connected: true,
      parentId,
      folders: items
        .filter((item) => item.folder)
        .map((item) => ({ id: item.id, name: item.name })),
    });
  } catch {
    return Response.json({ connected: false, parentId, folders: [] });
  }
}

export async function setOnedriveFolder(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string; folderId?: string; folderName?: string };
  if (!data.dashboardId || !data.folderId || !data.folderName) {
    return Response.json({ error: 'E79880: dashboardId and folder are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first();

  if (!access) {
    return Response.json({ error: 'E79881: Not found or no access' }, { status: 404 });
  }

  await env.DB.prepare(`
    INSERT INTO onedrive_mirrors (
      dashboard_id, user_id, folder_id, folder_name, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'idle', datetime('now'), datetime('now'))
    ON CONFLICT(dashboard_id) DO UPDATE SET
      user_id = excluded.user_id,
      folder_id = excluded.folder_id,
      folder_name = excluded.folder_name,
      status = 'idle',
      updated_at = datetime('now')
  `).bind(
    data.dashboardId,
    auth.user!.id,
    data.folderId,
    data.folderName
  ).run();

  try {
    await runOnedriveSync(env, auth.user!.id, data.dashboardId);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'E79882: OneDrive sync failed' }, { status: 500 });
  }

  return Response.json({ ok: true });
}

export async function unlinkOnedriveFolder(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'E79883: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user!.id).first();

  if (!access) {
    return Response.json({ error: 'E79884: Not found or no access' }, { status: 404 });
  }

  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('onedrive', dashboardId));
  if (manifestObject) {
    const manifest = await manifestObject.json<DriveManifest>();
    await env.DRIVE_CACHE.delete(mirrorManifestKey('onedrive', dashboardId));
    for (const entry of manifest.entries) {
      await env.DRIVE_CACHE.delete(mirrorFileKey('onedrive', dashboardId, entry.id));
    }
  }

  await env.DB.prepare(`
    DELETE FROM onedrive_mirrors WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).run();

  return Response.json({ ok: true });
}

async function updateOnedriveMirrorCacheProgress(
  env: Env,
  dashboardId: string,
  cacheSyncedFiles: number,
  cacheSyncedBytes: number
) {
  await env.DB.prepare(`
    UPDATE onedrive_mirrors
    SET cache_synced_files = ?, cache_synced_bytes = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(cacheSyncedFiles, cacheSyncedBytes, dashboardId).run();
}

async function updateOnedriveMirrorWorkspaceProgress(
  env: Env,
  dashboardId: string,
  workspaceSyncedFiles: number,
  workspaceSyncedBytes: number
) {
  await env.DB.prepare(`
    UPDATE onedrive_mirrors
    SET workspace_synced_files = ?, workspace_synced_bytes = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(workspaceSyncedFiles, workspaceSyncedBytes, dashboardId).run();
}

export async function getOnedriveSyncStatus(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'E79885: dashboardId is required' }, { status: 400 });
  }

  const record = await env.DB.prepare(`
    SELECT * FROM onedrive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<Record<string, unknown>>();

  if (!record) {
    return Response.json({ connected: false });
  }

  let largeFiles: Array<{ id: string; path: string; size: number }> = [];
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('onedrive', dashboardId));
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

export async function syncOnedriveMirror(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string };
  if (!data.dashboardId) {
    return Response.json({ error: 'E79886: dashboardId is required' }, { status: 400 });
  }

  try {
    await runOnedriveSync(env, auth.user!.id, data.dashboardId);
    return Response.json({ ok: true });
  } catch (error) {
    await env.DB.prepare(`
      UPDATE onedrive_mirrors
      SET status = 'error', sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      error instanceof Error ? error.message : 'OneDrive sync failed',
      data.dashboardId
    ).run();
    return Response.json({ error: 'E79887: OneDrive sync failed' }, { status: 500 });
  }
}

async function runOnedriveSync(env: Env, userId: string, dashboardId: string) {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first();

  if (!access) {
    throw new Error('E79888: Not found or no access');
  }

  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name FROM onedrive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first<{ folder_id: string; folder_name: string }>();

  if (!mirror) {
    throw new Error('E79889: OneDrive folder not linked');
  }

  await env.DB.prepare(`
    UPDATE onedrive_mirrors
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

  const accessToken = await refreshOnedriveAccessToken(env, userId);
  const { manifest, entries } = await buildOnedriveManifest(accessToken, mirror.folder_id, mirror.folder_name);

  const existingManifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('onedrive', dashboardId));
  const existingEntries = new Map<string, DriveFileEntry>();
  if (existingManifestObject) {
    const existingManifest = await existingManifestObject.json<DriveManifest>();
    for (const entry of existingManifest.entries) {
      existingEntries.set(entry.id, entry);
    }
  }

  let totalFiles = 0;
  let totalBytes = 0;
  let cacheSyncedFiles = 0;
  let cacheSyncedBytes = 0;
  let largeFiles = 0;
  let largeBytes = 0;

  for (const entry of entries) {
    totalFiles += 1;
    totalBytes += entry.size;
    if (entry.size >= DRIVE_AUTO_SYNC_LIMIT_BYTES) {
      entry.cacheStatus = 'skipped_large';
      entry.placeholder = 'File exceeds sync limit. Click Sync to fetch it.';
      largeFiles += 1;
      largeBytes += entry.size;
      continue;
    }

    const previous = existingEntries.get(entry.id);
    if (previous && previous.md5Checksum && previous.md5Checksum === entry.md5Checksum) {
      entry.cacheStatus = previous.cacheStatus;
      if (entry.cacheStatus === 'cached') {
        cacheSyncedFiles += 1;
        cacheSyncedBytes += entry.size;
      }
      continue;
    }

    const fileRes = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${entry.id}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!fileRes.ok || !fileRes.body) {
      entry.cacheStatus = 'skipped_unsupported';
      entry.placeholder = 'Failed to download OneDrive file.';
      continue;
    }

    await uploadDriveFileToCache(env, mirrorFileKey('onedrive', dashboardId, entry.id), fileRes, entry.size);
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    entry.cacheStatus = 'cached';
    await updateOnedriveMirrorCacheProgress(env, dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }

  manifest.entries = entries;
  await env.DRIVE_CACHE.put(mirrorManifestKey('onedrive', dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE onedrive_mirrors
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
    await startSandboxMirrorSync(
      env,
      'onedrive',
      dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || '',
      mirror.folder_name
    );
  } else {
    await env.DB.prepare(`
      UPDATE onedrive_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(dashboardId).run();
  }
}

export async function syncOnedriveLargeFiles(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string; fileIds?: string[] };
  if (!data.dashboardId || !Array.isArray(data.fileIds) || data.fileIds.length === 0) {
    return Response.json({ error: 'E79890: dashboardId and fileIds are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first();

  if (!access) {
    return Response.json({ error: 'E79891: Not found or no access' }, { status: 404 });
  }

  const mirror = await env.DB.prepare(`
    SELECT folder_name FROM onedrive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(data.dashboardId, auth.user!.id).first<{ folder_name: string }>();

  if (!mirror) {
    return Response.json({ error: 'E79892: OneDrive folder not linked' }, { status: 404 });
  }

  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('onedrive', data.dashboardId));
  if (!manifestObject) {
    return Response.json({ error: 'E79893: OneDrive manifest missing. Run sync first.' }, { status: 404 });
  }
  const manifest = await manifestObject.json<DriveManifest>();
  const entryMap = new Map(manifest.entries.map((entry) => [entry.id, entry]));

  const accessToken = await refreshOnedriveAccessToken(env, auth.user!.id);
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

    const fileRes = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${entry.id}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!fileRes.ok || !fileRes.body) {
      continue;
    }

    await uploadDriveFileToCache(env, mirrorFileKey('onedrive', data.dashboardId, entry.id), fileRes, entry.size);

    entry.cacheStatus = 'cached';
    entry.placeholder = undefined;
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    await updateOnedriveMirrorCacheProgress(env, data.dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }

  await env.DRIVE_CACHE.put(mirrorManifestKey('onedrive', data.dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });

  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE onedrive_mirrors
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
    await startSandboxMirrorSync(
      env,
      'onedrive',
      data.dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || '',
      mirror.folder_name
    );
  } else {
    await env.DB.prepare(`
      UPDATE onedrive_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(data.dashboardId).run();
  }

  return Response.json({ ok: true });
}

export async function getOnedriveManifest(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'E79894: dashboardId is required' }, { status: 400 });
  }

  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name FROM onedrive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ folder_id: string; folder_name: string }>();

  if (!mirror) {
    return Response.json({ connected: false });
  }

  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey('onedrive', dashboardId));
  if (!manifestObject) {
    return Response.json({
      connected: true,
      folder: { id: mirror.folder_id, name: mirror.folder_name },
      manifest: null,
    });
  }

  const manifest = await manifestObject.json<DriveManifest>();
  return Response.json({
    connected: true,
    folder: { id: mirror.folder_id, name: mirror.folder_name },
    manifest,
  });
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

async function startSandboxMirrorSync(
  env: Env,
  provider: string,
  dashboardId: string,
  sandboxSessionId: string,
  sandboxMachineId: string,
  folderName: string
) {
  try {
    const res = await fetch(`${env.SANDBOX_URL.replace(/\/$/, '')}/sessions/${sandboxSessionId}/mirror/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': env.SANDBOX_INTERNAL_TOKEN,
        ...(sandboxMachineId ? { 'X-Sandbox-Machine-ID': sandboxMachineId } : {}),
      },
      body: JSON.stringify({
        provider,
        dashboard_id: dashboardId,
        folder_name: folderName,
      }),
    });
    if (!res.ok) {
      throw new Error(`sandbox sync failed: ${res.status}`);
    }
  } catch {
    await env.DB.prepare(`
      UPDATE ${provider}_mirrors
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

export async function getGoogleDriveManifest(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'E79838: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor', 'viewer')
  `).bind(dashboardId, auth.user!.id).first();

  if (!access) {
    return Response.json({ error: 'E79839: Not found or no access' }, { status: 404 });
  }

  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name FROM drive_mirrors
    WHERE dashboard_id = ?
  `).bind(dashboardId).first<{ folder_id: string; folder_name: string }>();

  if (!mirror) {
    return Response.json({ connected: false });
  }

  const manifestObject = await env.DRIVE_CACHE.get(driveManifestKey(dashboardId));
  if (!manifestObject) {
    return Response.json({
      connected: true,
      folder: { id: mirror.folder_id, name: mirror.folder_name },
      manifest: null,
    });
  }

  const manifest = await manifestObject.json<DriveManifest>();
  return Response.json({
    connected: true,
    folder: { id: mirror.folder_id, name: mirror.folder_name },
    manifest,
  });
}

async function getGithubAccessToken(env: Env, userId: string): Promise<string> {
  const record = await env.DB.prepare(`
    SELECT access_token FROM user_integrations
    WHERE user_id = ? AND provider = 'github'
  `).bind(userId).first<{ access_token: string }>();

  if (!record?.access_token) {
    throw new Error('GitHub must be connected.');
  }
  return record.access_token;
}

async function listGithubRepos(accessToken: string) {
  const repos: Array<{
    id: number;
    name: string;
    full_name: string;
    owner: { login: string };
    default_branch: string;
    private: boolean;
  }> = [];

  let page = 1;
  while (page <= 5) {
    const url = new URL('https://api.github.com/user/repos');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('page', page.toString());
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'OrcaBot',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) {
      throw new Error('Failed to list GitHub repos.');
    }
    const data = await res.json() as typeof repos;
    repos.push(...data);
    if (data.length < 100) break;
    page += 1;
  }

  return repos;
}

async function buildGithubManifest(
  accessToken: string,
  repoOwner: string,
  repoName: string,
  repoBranch: string
): Promise<{ manifest: DriveManifest; entries: DriveFileEntry[] }> {
  const treeUrl = new URL(`https://api.github.com/repos/${repoOwner}/${repoName}/git/trees/${repoBranch}`);
  treeUrl.searchParams.set('recursive', '1');
  const treeRes = await fetch(treeUrl.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'OrcaBot',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!treeRes.ok) {
    throw new Error('Failed to load GitHub repository tree.');
  }

  const treeData = await treeRes.json() as {
    tree?: Array<{ path: string; type: 'blob' | 'tree'; size?: number }>;
  };

  const entries: DriveFileEntry[] = [];
  const directories: string[] = [];
  for (const node of treeData.tree ?? []) {
    if (node.type === 'tree') {
      directories.push(node.path);
      continue;
    }
    if (node.type !== 'blob') {
      continue;
    }
    const size = node.size ?? 0;
    entries.push({
      id: node.path,
      name: node.path.split('/').pop() || node.path,
      path: node.path,
      mimeType: 'application/octet-stream',
      size,
      modifiedTime: null,
      md5Checksum: null,
      cacheStatus: 'cached',
    });
  }

  const safeOwner = sanitizePathSegment(repoOwner);
  const safeRepo = sanitizePathSegment(repoName);
  const now = new Date().toISOString();
  const manifest: DriveManifest = {
    version: DRIVE_MANIFEST_VERSION,
    folderId: `${repoOwner}/${repoName}`,
    folderName: `${repoOwner}/${repoName}`,
    folderPath: `github/${safeOwner}/${safeRepo}`,
    updatedAt: now,
    directories,
    entries,
  };

  return { manifest, entries };
}

async function listBoxFolderItems(accessToken: string, folderId: string) {
  const items: Array<{
    id: string;
    name: string;
    type: 'file' | 'folder';
    size?: number;
    modified_at?: string;
    sha1?: string;
  }> = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const url = new URL(`https://api.box.com/2.0/folders/${folderId}/items`);
    url.searchParams.set('limit', limit.toString());
    url.searchParams.set('offset', offset.toString());
    url.searchParams.set('fields', 'id,name,type,size,modified_at,sha1');
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error('Failed to list Box folder.');
    }
    const data = await res.json() as { entries?: typeof items; total_count?: number };
    if (data.entries) {
      items.push(...data.entries);
    }
    if (!data.total_count || items.length >= data.total_count) {
      break;
    }
    offset += limit;
  }

  return items;
}

async function buildBoxManifest(
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
    const children = await listBoxFolderItems(accessToken, current.id);
    for (const child of children) {
      if (child.type === 'folder') {
        queue.push({ id: child.id, path: joinDrivePath(current.path, child.name) });
        continue;
      }
      if (child.type !== 'file') {
        continue;
      }
      entries.push({
        id: child.id,
        name: child.name,
        path: joinDrivePath(current.path, child.name),
        mimeType: 'application/octet-stream',
        size: child.size ?? 0,
        modifiedTime: child.modified_at || null,
        md5Checksum: child.sha1 || null,
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
    folderPath: `box/${safeFolderName}`,
    updatedAt: now,
    directories,
    entries,
  };

  return { manifest, entries };
}

async function listOnedriveChildren(accessToken: string, folderId: string) {
  const items: Array<{
    id: string;
    name: string;
    size?: number;
    lastModifiedDateTime?: string;
    folder?: Record<string, unknown>;
    file?: { hashes?: { sha1Hash?: string } };
  }> = [];
  let nextUrl: string | null = folderId === 'root'
    ? 'https://graph.microsoft.com/v1.0/me/drive/root/children'
    : `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}/children`;

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error('Failed to list OneDrive folder.');
    }
    const data = await res.json() as { value?: typeof items; '@odata.nextLink'?: string };
    if (data.value) {
      items.push(...data.value);
    }
    nextUrl = data['@odata.nextLink'] ?? null;
  }

  return items;
}

async function buildOnedriveManifest(
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
    const children = await listOnedriveChildren(accessToken, current.id);
    for (const child of children) {
      if (child.folder) {
        queue.push({ id: child.id, path: joinDrivePath(current.path, child.name) });
        continue;
      }
      entries.push({
        id: child.id,
        name: child.name,
        path: joinDrivePath(current.path, child.name),
        mimeType: 'application/octet-stream',
        size: child.size ?? 0,
        modifiedTime: child.lastModifiedDateTime || null,
        md5Checksum: child.file?.hashes?.sha1Hash || null,
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
    folderPath: `onedrive/${safeFolderName}`,
    updatedAt: now,
    directories,
    entries,
  };

  return { manifest, entries };
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

export async function getMirrorManifestInternal(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  const provider = url.searchParams.get('provider');
  if (!dashboardId || !provider) {
    return Response.json({ error: 'E79900: dashboardId and provider are required' }, { status: 400 });
  }
  if (!['github', 'box', 'onedrive'].includes(provider)) {
    return Response.json({ error: 'E79901: invalid provider' }, { status: 400 });
  }

  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey(provider, dashboardId));
  if (!manifestObject) {
    return Response.json({ error: 'E79902: Mirror manifest not found' }, { status: 404 });
  }

  return new Response(manifestObject.body, {
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

export async function getMirrorFileInternal(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  const fileId = url.searchParams.get('file_id');
  const provider = url.searchParams.get('provider');
  if (!dashboardId || !fileId || !provider) {
    return Response.json({ error: 'E79903: dashboardId, fileId, and provider are required' }, { status: 400 });
  }
  if (!['github', 'box', 'onedrive'].includes(provider)) {
    return Response.json({ error: 'E79904: invalid provider' }, { status: 400 });
  }

  const object = await env.DRIVE_CACHE.get(mirrorFileKey(provider, dashboardId, fileId));
  if (!object) {
    return Response.json({ error: 'E79905: Mirror file not found' }, { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', headers.get('Content-Type') || 'application/octet-stream');
  return new Response(object.body, { headers });
}

export async function updateMirrorSyncProgressInternal(
  request: Request,
  env: Env
): Promise<Response> {
  const data = await request.json() as {
    provider?: 'github' | 'box' | 'onedrive';
    dashboardId?: string;
    workspaceSyncedFiles?: number;
    workspaceSyncedBytes?: number;
    status?: 'syncing_workspace' | 'ready' | 'error';
    syncError?: string | null;
  };

  if (!data.provider || !data.dashboardId) {
    return Response.json({ error: 'E79906: provider and dashboardId are required' }, { status: 400 });
  }
  if (!['github', 'box', 'onedrive'].includes(data.provider)) {
    return Response.json({ error: 'E79907: invalid provider' }, { status: 400 });
  }

  const table = `${data.provider}_mirrors`;
  const status = data.status || 'syncing_workspace';
  const syncError = data.syncError ?? null;
  const files = data.workspaceSyncedFiles ?? 0;
  const bytes = data.workspaceSyncedBytes ?? 0;

  await env.DB.prepare(`
    UPDATE ${table}
    SET workspace_synced_files = ?, workspace_synced_bytes = ?, status = ?, sync_error = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(files, bytes, status, syncError, data.dashboardId).run();

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

  const requestUrl = new URL(request.url);
  const mode = requestUrl.searchParams.get('mode');
  const dashboardId = requestUrl.searchParams.get('dashboard_id');
  const state = buildState();
  await createState(env, auth.user!.id, 'github', state, {
    mode,
    dashboardId,
  });

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/github/callback`;

  const authUrl = new URL('https://github.com/login/oauth/authorize');
  authUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', GITHUB_SCOPE.join(' '));
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
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

  const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
  if (stateData.metadata?.mode === 'popup') {
    const dashboardId = typeof stateData.metadata?.dashboardId === 'string'
      ? stateData.metadata.dashboardId
      : null;
    return renderProviderAuthCompletePage(frontendUrl, 'GitHub', 'github-auth-complete', dashboardId);
  }

  return renderSuccessPage('GitHub');
}

export async function connectBox(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  if (!env.BOX_CLIENT_ID || !env.BOX_CLIENT_SECRET) {
    return renderErrorPage('Box OAuth is not configured.');
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get('mode');
  const dashboardId = url.searchParams.get('dashboard_id');
  const state = buildState();
  await createState(env, auth.user!.id, 'box', state, {
    mode,
    dashboardId,
  });

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/box/callback`;

  const authUrl = new URL('https://account.box.com/api/oauth2/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', env.BOX_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('scope', BOX_SCOPE.join(' '));

  return Response.redirect(authUrl.toString(), 302);
}

export async function callbackBox(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.BOX_CLIENT_ID || !env.BOX_CLIENT_SECRET) {
    return renderErrorPage('Box OAuth is not configured.');
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return renderErrorPage('Missing authorization code.');
  }

  const stateData = await consumeState(env, state, 'box');
  if (!stateData) {
    return renderErrorPage('Invalid or expired state.');
  }

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/box/callback`;

  const body = new URLSearchParams();
  body.set('client_id', env.BOX_CLIENT_ID);
  body.set('client_secret', env.BOX_CLIENT_SECRET);
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', redirectUri);

  const tokenResponse = await fetch('https://api.box.com/oauth2/token', {
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
    token_type?: string;
  };

  const now = new Date();
  const expiresAt = tokenData.expires_in
    ? new Date(now.getTime() + tokenData.expires_in * 1000).toISOString()
    : null;

  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'box', ?, ?, ?, ?, ?, ?)
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
    BOX_SCOPE.join(' '),
    tokenData.token_type || null,
    expiresAt,
    JSON.stringify({ provider: 'box' })
  ).run();

  const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
  if (stateData.metadata?.mode === 'popup') {
    const dashboardId = typeof stateData.metadata?.dashboardId === 'string'
      ? stateData.metadata.dashboardId
      : null;
    return renderProviderAuthCompletePage(frontendUrl, 'Box', 'box-auth-complete', dashboardId);
  }

  return renderSuccessPage('Box');
}

export async function connectOnedrive(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  if (!env.ONEDRIVE_CLIENT_ID || !env.ONEDRIVE_CLIENT_SECRET) {
    return renderErrorPage('OneDrive OAuth is not configured.');
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get('mode');
  const dashboardId = url.searchParams.get('dashboard_id');
  const state = buildState();
  await createState(env, auth.user!.id, 'onedrive', state, {
    mode,
    dashboardId,
  });

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/onedrive/callback`;

  const authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  authUrl.searchParams.set('client_id', env.ONEDRIVE_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('scope', ONEDRIVE_SCOPE.join(' '));
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

export async function callbackOnedrive(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.ONEDRIVE_CLIENT_ID || !env.ONEDRIVE_CLIENT_SECRET) {
    return renderErrorPage('OneDrive OAuth is not configured.');
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return renderErrorPage('Missing authorization code.');
  }

  const stateData = await consumeState(env, state, 'onedrive');
  if (!stateData) {
    return renderErrorPage('Invalid or expired state.');
  }

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/onedrive/callback`;

  const body = new URLSearchParams();
  body.set('client_id', env.ONEDRIVE_CLIENT_ID);
  body.set('client_secret', env.ONEDRIVE_CLIENT_SECRET);
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', redirectUri);
  body.set('scope', ONEDRIVE_SCOPE.join(' '));

  const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
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
    token_type?: string;
  };

  const now = new Date();
  const expiresAt = tokenData.expires_in
    ? new Date(now.getTime() + tokenData.expires_in * 1000).toISOString()
    : null;

  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'onedrive', ?, ?, ?, ?, ?, ?)
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
    ONEDRIVE_SCOPE.join(' '),
    tokenData.token_type || null,
    expiresAt,
    JSON.stringify({ provider: 'onedrive' })
  ).run();

  const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
  if (stateData.metadata?.mode === 'popup') {
    const dashboardId = typeof stateData.metadata?.dashboardId === 'string'
      ? stateData.metadata.dashboardId
      : null;
    return renderProviderAuthCompletePage(frontendUrl, 'OneDrive', 'onedrive-auth-complete', dashboardId);
  }

  return renderSuccessPage('OneDrive');
}
