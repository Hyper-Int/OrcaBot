// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: integrations-v11-clarify-per-user-scope
const integrationsRevision = "integrations-v11-clarify-per-user-scope";
console.log(`[integrations] REVISION: ${integrationsRevision} loaded at ${new Date().toISOString()}`);

import type { EnvWithDriveCache } from '../storage/drive-cache';
import type { AuthContext } from '../auth/middleware';
import { requireAuth } from '../auth/middleware';
import { sandboxFetch } from '../sandbox/fetch';

const GOOGLE_SCOPE = [
  'https://www.googleapis.com/auth/drive',
];

const GMAIL_SCOPE = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'openid',
  'email',
];

const CALENDAR_SCOPE = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'openid',
  'email',
];

const CONTACTS_SCOPE = [
  'https://www.googleapis.com/auth/contacts.readonly',
  'openid',
  'email',
];

const SHEETS_SCOPE = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
  'openid',
  'email',
];

const FORMS_SCOPE = [
  'https://www.googleapis.com/auth/forms.body.readonly',
  'https://www.googleapis.com/auth/forms.responses.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'openid',
  'email',
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

const SLACK_SCOPE = [
  'channels:read',
  'channels:history',
  'groups:read',          // Private channels: list
  'groups:history',       // Private channels: read messages
  'im:read',             // DMs: list
  'im:history',          // DMs: read messages
  'mpim:read',           // Group DMs: list
  'mpim:history',        // Group DMs: read messages
  'chat:write',
  'users:read',
  // search:read removed — it's a user token scope (xoxp), not a bot token scope (xoxb).
  // The bot OAuth flow only yields a bot token, so requesting search:read would fail with
  // invalid_scope or grant a scope that can't be used. The slack_search MCP tool was
  // already removed in integration_tools.go for this reason.
  'reactions:write',
  'chat:write.customize',
];

const DRIVE_AUTO_SYNC_LIMIT_BYTES = 1024 * 1024 * 1024;
const DRIVE_MANIFEST_VERSION = 1;
const DRIVE_UPLOAD_BUFFER_LIMIT_BYTES = 25 * 1024 * 1024;
const DRIVE_UPLOAD_PART_BYTES = 8 * 1024 * 1024;

// Whitelist of valid mirror table names (prevents SQL injection via table name interpolation)
// SECURITY: Never interpolate provider names directly into SQL - always use this map
const MIRROR_TABLES: Record<string, string> = {
  github: 'github_mirrors',
  box: 'box_mirrors',
  onedrive: 'onedrive_mirrors',
  drive: 'drive_mirrors',
  google_drive: 'drive_mirrors', // Alias for google_drive provider
};

function getMirrorTableName(provider: string): string | null {
  return MIRROR_TABLES[provider] ?? null;
}

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
  env: EnvWithDriveCache,
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

function getRedirectBase(request: Request, env: EnvWithDriveCache): string {
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

type IntegrationProvider = 'google_drive' | 'github' | 'box' | 'onedrive';

function driveFileKey(dashboardId: string, fileId: string): string {
  return `drive/${dashboardId}/files/${fileId}`;
}

function mirrorManifestKey(provider: string, dashboardId: string): string {
  return `mirror/${provider}/${dashboardId}/manifest.json`;
}

function mirrorFileKey(provider: string, dashboardId: string, fileId: string): string {
  return `mirror/${provider}/${dashboardId}/files/${fileId}`;
}

async function cleanupIntegration(
  env: EnvWithDriveCache,
  provider: IntegrationProvider,
  userId: string
): Promise<void> {
  // SECURITY: Use whitelist to get table name - never interpolate provider directly
  const mirrorTable = getMirrorTableName(provider);
  if (!mirrorTable) {
    console.error(`[integrations] Invalid mirror provider: ${provider}`);
    return;
  }
  const mirrors = await env.DB.prepare(`
    SELECT dashboard_id FROM ${mirrorTable} WHERE user_id = ?
  `).bind(userId).all<{ dashboard_id: string }>();

  for (const mirror of mirrors.results || []) {
    try {
      if (provider === 'google_drive') {
        const manifestObject = await env.DRIVE_CACHE.get(driveManifestKey(mirror.dashboard_id));
        if (manifestObject) {
          const manifest = await manifestObject.json<DriveManifest>();
          await env.DRIVE_CACHE.delete(driveManifestKey(mirror.dashboard_id));
          for (const entry of manifest.entries) {
            await env.DRIVE_CACHE.delete(driveFileKey(mirror.dashboard_id, entry.id));
          }
        }
      } else {
        const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey(provider, mirror.dashboard_id));
        if (manifestObject) {
          const manifest = await manifestObject.json<DriveManifest>();
          await env.DRIVE_CACHE.delete(mirrorManifestKey(provider, mirror.dashboard_id));
          for (const entry of manifest.entries) {
            await env.DRIVE_CACHE.delete(mirrorFileKey(provider, mirror.dashboard_id, entry.id));
          }
        }
      }
    } catch (cacheErr) {
      console.error(`Failed to clean up ${provider} cache for dashboard:`, mirror.dashboard_id, cacheErr);
    }
  }

  await env.DB.prepare(`DELETE FROM ${mirrorTable} WHERE user_id = ?`).bind(userId).run();

  // Soft-delete terminal_integrations that reference this user's integrations for this provider
  // so sandboxes detect detach and clean up synced files
  const userIntegrations = await env.DB.prepare(`
    SELECT id FROM user_integrations WHERE user_id = ? AND provider = ?
  `).bind(userId, provider).all<{ id: string }>();

  for (const ui of userIntegrations.results || []) {
    await env.DB.prepare(`
      UPDATE terminal_integrations
      SET deleted_at = datetime('now'), updated_at = datetime('now')
      WHERE user_integration_id = ? AND deleted_at IS NULL
    `).bind(ui.id).run();
  }

  await env.DB.prepare(`DELETE FROM user_integrations WHERE user_id = ? AND provider = ?`).bind(userId, provider).run();
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
  env: EnvWithDriveCache,
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

async function consumeState(env: EnvWithDriveCache, state: string, provider: string) {
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

async function refreshGoogleAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
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
    const errBody = await tokenResponse.text().catch(() => '');
    console.error('Google Drive token refresh failed:', tokenResponse.status, errBody);

    // Check for invalid_grant - handle both JSON and plaintext responses
    let isInvalidGrant = errBody.includes('invalid_grant');
    if (!isInvalidGrant) {
      try {
        const errJson = JSON.parse(errBody) as { error?: string };
        isInvalidGrant = errJson.error === 'invalid_grant';
      } catch {}
    }

    // Only auto-disconnect on invalid_grant (revoked/expired refresh token)
    // Other errors (transient, misconfiguration) should not wipe user data
    if (isInvalidGrant) {
      console.log('Auto-disconnecting Google Drive due to invalid_grant for user:', userId);
      await cleanupIntegration(env, 'google_drive', userId);
      throw new Error('Google Drive session expired. Please reconnect.');
    }

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

async function refreshBoxAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
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
    const errBody = await tokenResponse.text().catch(() => '');
    console.error('Box token refresh failed:', tokenResponse.status, errBody);

    // Check for invalid_grant - handle both JSON and plaintext responses
    let isInvalidGrant = errBody.includes('invalid_grant');
    if (!isInvalidGrant) {
      try {
        const errJson = JSON.parse(errBody) as { error?: string };
        isInvalidGrant = errJson.error === 'invalid_grant';
      } catch {}
    }

    // Only auto-disconnect on invalid_grant (revoked/expired refresh token)
    if (isInvalidGrant) {
      console.log('Auto-disconnecting Box due to invalid_grant for user:', userId);
      await cleanupIntegration(env, 'box', userId);
      throw new Error('Box session expired. Please reconnect.');
    }

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

async function refreshOnedriveAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
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
    const errBody = await tokenResponse.text().catch(() => '');
    console.error('OneDrive token refresh failed:', tokenResponse.status, errBody);

    // Check for invalid_grant - handle both JSON and plaintext responses
    let isInvalidGrant = errBody.includes('invalid_grant');
    if (!isInvalidGrant) {
      try {
        const errJson = JSON.parse(errBody) as { error?: string };
        isInvalidGrant = errJson.error === 'invalid_grant';
      } catch {}
    }

    // Only auto-disconnect on invalid_grant (revoked/expired refresh token)
    if (isInvalidGrant) {
      console.log('Auto-disconnecting OneDrive due to invalid_grant for user:', userId);
      await cleanupIntegration(env, 'onedrive', userId);
      throw new Error('OneDrive session expired. Please reconnect.');
    }

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

function renderAuthExpiredPage(
  frontendUrl: string,
  payloadType: string,
  dashboardId: string | null,
  message: string
): Response {
  const frontendOrigin = new URL(frontendUrl).origin;
  const payload = JSON.stringify({ type: payloadType, dashboardId });
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
    <script>
      try {
        const targetWindow = window.opener || (window.parent !== window ? window.parent : null);
        if (targetWindow) {
          targetWindow.postMessage(${payload}, ${JSON.stringify(frontendOrigin)});
        }
      } catch {}
      try {
        var bc = new BroadcastChannel('orcabot-oauth');
        bc.postMessage(${payload});
        bc.close();
      } catch {}
      if (window.opener) {
        setTimeout(() => window.close(), 300);
      }
    </script>
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
      try {
        var bc = new BroadcastChannel('orcabot-oauth');
        bc.postMessage(${payload});
        bc.close();
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
      try {
        var bc = new BroadcastChannel('orcabot-oauth');
        bc.postMessage(${payload});
        bc.close();
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

export async function cоnnectGооgleDrive(
  request: Request,
  env: EnvWithDriveCache,
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
  env: EnvWithDriveCache
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

  console.log('Google Drive token exchange redirect_uri:', redirectUri);
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!tokenResponse.ok) {
    const errBody = await tokenResponse.text().catch(() => '');
    console.error('Google Drive token exchange failed:', tokenResponse.status, errBody);
    return renderErrorPage(`Failed to exchange token. ${tokenResponse.status}: ${errBody}`);
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
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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

export async function setGооgleDriveFоlder(
  request: Request,
  env: EnvWithDriveCache,
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

export async function getGithubIntegratiоn(
  request: Request,
  env: EnvWithDriveCache,
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

export async function getGithubRepоs(
  _request: Request,
  env: EnvWithDriveCache,
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
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'github_auth_invalid') {
      try {
        await cleanupIntegration(env, 'github', auth.user!.id);
      } catch (cleanupErr) {
        console.error('Failed to auto-disconnect GitHub after auth failure:', cleanupErr);
      }
      return Response.json({ connected: false, repos: [], error: 'GitHub session expired. Please reconnect.' });
    }
    return Response.json({ connected: false, repos: [] });
  }
}

export async function setGithubRepо(
  request: Request,
  env: EnvWithDriveCache,
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

export async function unlinkGithubRepо(
  request: Request,
  env: EnvWithDriveCache,
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

export async function disconnectGithub(
  _request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  await cleanupIntegration(env, 'github', auth.user!.id);

  return Response.json({ ok: true });
}

async function updateGithubMirrorCacheProgress(
  env: EnvWithDriveCache,
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
  env: EnvWithDriveCache,
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
  env: EnvWithDriveCache,
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

export async function syncGithubMirrоr(
  request: Request,
  env: EnvWithDriveCache,
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

async function runGithubSync(env: EnvWithDriveCache, userId: string, dashboardId: string) {
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
  env: EnvWithDriveCache,
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
  env: EnvWithDriveCache,
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

async function getBoxAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
  const record = await env.DB.prepare(`
    SELECT access_token FROM user_integrations
    WHERE user_id = ? AND provider = 'box'
  `).bind(userId).first<{ access_token: string }>();

  if (!record?.access_token) {
    throw new Error('Box must be connected.');
  }
  return record.access_token;
}

export async function getBоxIntegratiоn(
  request: Request,
  env: EnvWithDriveCache,
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

export async function getBоxFоlders(
  request: Request,
  env: EnvWithDriveCache,
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

export async function setBоxFоlder(
  request: Request,
  env: EnvWithDriveCache,
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

export async function unlinkBоxFоlder(
  request: Request,
  env: EnvWithDriveCache,
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

export async function disconnectBox(
  _request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  await cleanupIntegration(env, 'box', auth.user!.id);

  return Response.json({ ok: true });
}

async function updateBoxMirrorCacheProgress(
  env: EnvWithDriveCache,
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
  env: EnvWithDriveCache,
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

export async function getBоxSyncStatus(
  request: Request,
  env: EnvWithDriveCache,
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

export async function syncBоxMirrоr(
  request: Request,
  env: EnvWithDriveCache,
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

async function runBoxSync(env: EnvWithDriveCache, userId: string, dashboardId: string) {
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

export async function syncBоxLargeFiles(
  request: Request,
  env: EnvWithDriveCache,
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

export async function getBоxManifest(
  request: Request,
  env: EnvWithDriveCache,
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

async function getOnedriveAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
  const record = await env.DB.prepare(`
    SELECT access_token FROM user_integrations
    WHERE user_id = ? AND provider = 'onedrive'
  `).bind(userId).first<{ access_token: string }>();

  if (!record?.access_token) {
    throw new Error('OneDrive must be connected.');
  }
  return record.access_token;
}

export async function getОnedriveIntegratiоn(
  request: Request,
  env: EnvWithDriveCache,
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

export async function getОnedriveFоlders(
  request: Request,
  env: EnvWithDriveCache,
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

export async function setОnedriveFоlder(
  request: Request,
  env: EnvWithDriveCache,
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

export async function unlinkОnedriveFоlder(
  request: Request,
  env: EnvWithDriveCache,
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

export async function disconnectOnedrive(
  _request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  await cleanupIntegration(env, 'onedrive', auth.user!.id);

  return Response.json({ ok: true });
}

async function updateOnedriveMirrorCacheProgress(
  env: EnvWithDriveCache,
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
  env: EnvWithDriveCache,
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

export async function getОnedriveSyncStatus(
  request: Request,
  env: EnvWithDriveCache,
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

export async function syncОnedriveMirrоr(
  request: Request,
  env: EnvWithDriveCache,
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

async function runOnedriveSync(env: EnvWithDriveCache, userId: string, dashboardId: string) {
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

export async function syncОnedriveLargeFiles(
  request: Request,
  env: EnvWithDriveCache,
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

export async function getОnedriveManifest(
  request: Request,
  env: EnvWithDriveCache,
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

export async function getGооgleDriveIntegratiоn(
  request: Request,
  env: EnvWithDriveCache,
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

export async function unlinkGооgleDriveFоlder(
  request: Request,
  env: EnvWithDriveCache,
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

  // Soft-delete terminal_integrations for google_drive on this dashboard
  // so the sandbox detects detach and cleans up /workspace/drive/
  await env.DB.prepare(`
    UPDATE terminal_integrations
    SET deleted_at = datetime('now'), updated_at = datetime('now')
    WHERE dashboard_id = ? AND provider = 'google_drive' AND deleted_at IS NULL
  `).bind(dashboardId).run();

  return Response.json({ ok: true });
}

export async function disconnectGoogleDrive(
  _request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  await cleanupIntegration(env, 'google_drive', auth.user!.id);

  return Response.json({ ok: true });
}

async function updateDriveMirrorCacheProgress(
  env: EnvWithDriveCache,
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
  env: EnvWithDriveCache,
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
  env: EnvWithDriveCache,
  dashboardId: string,
  sandboxSessionId: string,
  sandboxMachineId: string,
  folderName: string
) {
  try {
    const res = await sandboxFetch(env, `/sessions/${sandboxSessionId}/drive/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dashboard_id: dashboardId,
        folder_name: folderName,
      }),
      machineId: sandboxMachineId || undefined,
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
  env: EnvWithDriveCache,
  provider: string,
  dashboardId: string,
  sandboxSessionId: string,
  sandboxMachineId: string,
  folderName: string
) {
  // SECURITY: Validate provider against whitelist before any database operations
  const tableName = getMirrorTableName(provider);
  if (!tableName) {
    console.error(`[integrations] Invalid mirror provider: ${provider}`);
    return;
  }

  try {
    const res = await sandboxFetch(env, `/sessions/${sandboxSessionId}/mirror/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider,
        dashboard_id: dashboardId,
        folder_name: folderName,
      }),
      machineId: sandboxMachineId || undefined,
    });
    if (!res.ok) {
      throw new Error(`sandbox sync failed: ${res.status}`);
    }
  } catch {
    await env.DB.prepare(`
      UPDATE ${tableName}
      SET sync_error = 'Failed to start sandbox sync', status = 'error', updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(dashboardId).run();
  }
}

export async function getGооgleDriveSyncStatus(
  request: Request,
  env: EnvWithDriveCache,
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

export async function syncGооgleDriveMirrоr(
  request: Request,
  env: EnvWithDriveCache,
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

async function runDriveSync(env: EnvWithDriveCache, userId: string, dashboardId: string) {
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

export async function syncGооgleDriveLargeFiles(
  request: Request,
  env: EnvWithDriveCache,
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
  env: EnvWithDriveCache
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

export async function getGооgleDriveManifest(
  request: Request,
  env: EnvWithDriveCache,
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

async function getGithubAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
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
    url.searchParams.set('visibility', 'all');
    url.searchParams.set('affiliation', 'owner,collaborator,organization_member');
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'OrcaBot',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error('GitHub repo listing failed:', res.status, errBody);
      if (res.status === 401 || res.status === 403) {
        throw new Error('github_auth_invalid');
      }
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
  env: EnvWithDriveCache
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

export async function updateDriveSyncPrоgressInternal(
  request: Request,
  env: EnvWithDriveCache
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

export async function getMirrоrManifestInternal(
  request: Request,
  env: EnvWithDriveCache
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

export async function getMirrоrFileInternal(
  request: Request,
  env: EnvWithDriveCache
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

export async function updateMirrоrSyncPrоgressInternal(
  request: Request,
  env: EnvWithDriveCache
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

  // SECURITY: Use whitelist to get table name - never interpolate provider directly
  const table = getMirrorTableName(data.provider);
  if (!table) {
    return Response.json({ error: 'E79907: invalid provider' }, { status: 400 });
  }

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

export async function renderGооgleDrivePicker(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_API_KEY) {
    return renderErrorPage('Google OAuth is not configured.');
  }

  let accessToken: string;
  try {
    accessToken = await refreshGoogleAccessToken(env, auth.user!.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refresh Google access token.';
    if (message.includes('must be connected again') || message.includes('session expired')) {
      try {
        await cleanupIntegration(env, 'google_drive', auth.user!.id);
      } catch (cleanupErr) {
        console.error('Failed to auto-disconnect Google Drive after refresh failure:', cleanupErr);
      }
      const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
      const url = new URL(request.url);
      const dashboardId = url.searchParams.get('dashboard_id');
      return renderAuthExpiredPage(
        frontendUrl,
        'drive-auth-expired',
        dashboardId,
        'Google Drive session expired. Please reconnect.'
      );
    }
    return renderErrorPage(message);
  }

  const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  return renderDrivePickerPage(accessToken, env.GOOGLE_API_KEY, frontendUrl, dashboardId);
}

export async function cоnnectGithub(
  request: Request,
  env: EnvWithDriveCache,
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
  env: EnvWithDriveCache
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
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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

export async function cоnnectBоx(
  request: Request,
  env: EnvWithDriveCache,
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

export async function callbackBоx(
  request: Request,
  env: EnvWithDriveCache
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

  console.log('Box token exchange redirect_uri:', redirectUri);
  const tokenResponse = await fetch('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!tokenResponse.ok) {
    const errBody = await tokenResponse.text().catch(() => '');
    console.error('Box token exchange failed:', tokenResponse.status, errBody);
    return renderErrorPage(`Failed to exchange token. ${tokenResponse.status}: ${errBody}`);
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
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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

export async function cоnnectОnedrive(
  request: Request,
  env: EnvWithDriveCache,
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

export async function callbackОnedrive(
  request: Request,
  env: EnvWithDriveCache
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

  console.log('OneDrive token exchange redirect_uri:', redirectUri);
  const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!tokenResponse.ok) {
    const errBody = await tokenResponse.text().catch(() => '');
    console.error('OneDrive token exchange failed:', tokenResponse.status, errBody);
    return renderErrorPage(`Failed to exchange token. ${tokenResponse.status}: ${errBody}`);
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
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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

// ============================================
// Gmail integration
// ============================================

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
  internalDate?: string;
  sizeEstimate?: number;
}

interface GmailHistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: GmailMessage }>;
  messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
  labelsAdded?: Array<{ message: { id: string }; labelIds: string[] }>;
  labelsRemoved?: Array<{ message: { id: string }; labelIds: string[] }>;
}

async function refreshGmailAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth is not configured.');
  }

  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'gmail'
  `).bind(userId).first<{ access_token: string; refresh_token: string | null }>();

  if (!record?.refresh_token) {
    throw new Error('Gmail must be connected again.');
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
    // 400/401 means token was revoked or is invalid - user needs to reconnect
    if (tokenResponse.status === 400 || tokenResponse.status === 401) {
      throw new Error('TOKEN_REVOKED');
    }
    throw new Error('Failed to refresh Gmail access token.');
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
    WHERE user_id = ? AND provider = 'gmail'
  `).bind(
    tokenData.access_token,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    userId
  ).run();

  return tokenData.access_token;
}

async function getGmailAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
  const record = await env.DB.prepare(`
    SELECT access_token, expires_at FROM user_integrations
    WHERE user_id = ? AND provider = 'gmail'
  `).bind(userId).first<{ access_token: string; expires_at: string | null }>();

  if (!record) {
    throw new Error('Gmail not connected.');
  }

  // Refresh if expired or expires within 5 minutes
  if (record.expires_at) {
    const expiresAt = new Date(record.expires_at).getTime();
    const now = Date.now();
    if (expiresAt - now < 5 * 60 * 1000) {
      return refreshGmailAccessToken(env, userId);
    }
  }

  return record.access_token;
}

async function getGmailProfile(accessToken: string): Promise<{ emailAddress: string }> {
  const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    // 401/403 means token is invalid/revoked - user needs to reconnect
    if (res.status === 401 || res.status === 403) {
      throw new Error('TOKEN_REVOKED');
    }
    throw new Error('Failed to fetch Gmail profile.');
  }

  return res.json() as Promise<{ emailAddress: string }>;
}

async function listGmailMessages(
  accessToken: string,
  labelIds: string[] = ['INBOX'],
  maxResults: number = 50,
  pageToken?: string
): Promise<{
  messages: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}> {
  const url = new URL('https://www.googleapis.com/gmail/v1/users/me/messages');
  url.searchParams.set('maxResults', String(maxResults));
  if (labelIds.length > 0) {
    url.searchParams.set('labelIds', labelIds.join(','));
  }
  if (pageToken) {
    url.searchParams.set('pageToken', pageToken);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error('Failed to list Gmail messages.');
  }

  return res.json() as Promise<{
    messages: Array<{ id: string; threadId: string }>;
    nextPageToken?: string;
    resultSizeEstimate?: number;
  }>;
}

async function getGmailMessage(
  accessToken: string,
  messageId: string,
  format: 'metadata' | 'minimal' | 'full' = 'metadata'
): Promise<GmailMessage> {
  const url = new URL(`https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}`);
  url.searchParams.set('format', format);
  if (format === 'metadata') {
    // Gmail API requires repeated metadataHeaders parameters, not comma-separated
    url.searchParams.append('metadataHeaders', 'From');
    url.searchParams.append('metadataHeaders', 'To');
    url.searchParams.append('metadataHeaders', 'Subject');
    url.searchParams.append('metadataHeaders', 'Date');
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error('Failed to fetch Gmail message.');
  }

  return res.json() as Promise<GmailMessage>;
}

async function modifyGmailMessage(
  accessToken: string,
  messageId: string,
  addLabelIds: string[] = [],
  removeLabelIds: string[] = []
): Promise<GmailMessage> {
  const res = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    }
  );

  if (!res.ok) {
    throw new Error('Failed to modify Gmail message.');
  }

  return res.json() as Promise<GmailMessage>;
}

async function setupGmailWatch(
  accessToken: string,
  topicName: string,
  labelIds: string[] = ['INBOX']
): Promise<{ historyId: string; expiration: string }> {
  const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/watch', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topicName,
      labelIds,
      labelFilterAction: 'include',
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to setup Gmail watch: ${errorText}`);
  }

  return res.json() as Promise<{ historyId: string; expiration: string }>;
}

async function stopGmailWatch(accessToken: string): Promise<void> {
  const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/stop', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok && res.status !== 404) {
    throw new Error('Failed to stop Gmail watch.');
  }
}

async function getGmailHistory(
  accessToken: string,
  startHistoryId: string,
  labelId?: string,
  maxResults: number = 100
): Promise<{
  history?: GmailHistoryRecord[];
  historyId: string;
  nextPageToken?: string;
}> {
  const url = new URL('https://www.googleapis.com/gmail/v1/users/me/history');
  url.searchParams.set('startHistoryId', startHistoryId);
  url.searchParams.set('maxResults', String(maxResults));
  if (labelId) {
    url.searchParams.set('labelId', labelId);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    if (res.status === 404) {
      // History ID is too old, need full resync
      throw new Error('HISTORY_EXPIRED');
    }
    throw new Error('Failed to fetch Gmail history.');
  }

  return res.json() as Promise<{
    history?: GmailHistoryRecord[];
    historyId: string;
    nextPageToken?: string;
  }>;
}

function extractHeader(message: GmailMessage, headerName: string): string | null {
  const headers = message.payload?.headers;
  if (!headers) return null;
  const header = headers.find(h => h.name.toLowerCase() === headerName.toLowerCase());
  return header?.value || null;
}

export async function connectGmail(
  request: Request,
  env: EnvWithDriveCache,
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
  await createState(env, auth.user!.id, 'gmail', state, {
    dashboard_id: dashboardId,
    popup: mode === 'popup',
  });

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/gmail/callback`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GMAIL_SCOPE.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

export async function callbackGmail(
  request: Request,
  env: EnvWithDriveCache
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

  const stateData = await consumeState(env, state, 'gmail');
  if (!stateData) {
    return renderErrorPage('Invalid or expired state.');
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === 'string'
    ? stateData.metadata.dashboard_id
    : null;
  const popup = stateData.metadata.popup === true;

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/gmail/callback`;

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

  // Fetch email address
  let emailAddress = '';
  try {
    const profile = await getGmailProfile(tokenData.access_token);
    emailAddress = profile.emailAddress;
  } catch {
    // Email will be empty if profile fetch fails
  }

  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    email_address: emailAddress,
  });

  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'gmail', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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

  const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
  if (popup) {
    return renderProviderAuthCompletePage(frontendUrl, 'Gmail', 'gmail-auth-complete', dashboardId);
  }

  return renderSuccessPage('Gmail');
}

export async function getGmailIntegration(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  const integration = await env.DB.prepare(`
    SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'gmail'
  `).bind(auth.user!.id).first<{ metadata: string }>();

  if (!integration) {
    return Response.json({ connected: false, linked: false, emailAddress: null });
  }

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(integration.metadata || '{}') as Record<string, unknown>;
  } catch {
    metadata = {};
  }

  if (!dashboardId) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null,
    });
  }

  const mirror = await env.DB.prepare(`
    SELECT email_address, label_ids, status, last_synced_at, watch_expiration
    FROM gmail_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{
    email_address: string;
    label_ids: string;
    status: string;
    last_synced_at: string | null;
    watch_expiration: string | null;
  }>();

  if (!mirror) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null,
    });
  }

  let labelIds: string[] = [];
  try {
    labelIds = JSON.parse(mirror.label_ids) as string[];
  } catch {
    labelIds = ['INBOX'];
  }

  return Response.json({
    connected: true,
    linked: true,
    emailAddress: mirror.email_address,
    labelIds,
    status: mirror.status,
    lastSyncedAt: mirror.last_synced_at,
    watchExpiration: mirror.watch_expiration,
  });
}

export async function setupGmailMirror(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as {
    dashboardId?: string;
    labelIds?: string[];
  };

  if (!data.dashboardId) {
    return Response.json({ error: 'E79901: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79902: Not found or no access' }, { status: 404 });
  }

  let accessToken: string;
  try {
    accessToken = await getGmailAccessToken(env, auth.user!.id);
  } catch (err) {
    if (err instanceof Error && err.message === 'TOKEN_REVOKED') {
      return Response.json({
        error: 'E79904: Gmail access was revoked. Please reconnect.',
        code: 'TOKEN_REVOKED'
      }, { status: 401 });
    }
    return Response.json({ error: 'E79903: Gmail not connected' }, { status: 404 });
  }

  let profile: { emailAddress: string };
  try {
    profile = await getGmailProfile(accessToken);
  } catch (err) {
    if (err instanceof Error && err.message === 'TOKEN_REVOKED') {
      return Response.json({
        error: 'E79904: Gmail access was revoked. Please reconnect.',
        code: 'TOKEN_REVOKED'
      }, { status: 401 });
    }
    throw err;
  }
  const labelIds = data.labelIds || ['INBOX'];
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO gmail_mirrors (
      dashboard_id, user_id, email_address, label_ids, status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, 'idle', ?, ?)
    ON CONFLICT(dashboard_id) DO UPDATE SET
      user_id = excluded.user_id,
      email_address = excluded.email_address,
      label_ids = excluded.label_ids,
      status = 'idle',
      history_id = null,
      watch_expiration = null,
      last_synced_at = null,
      sync_error = null,
      updated_at = excluded.updated_at
  `).bind(
    data.dashboardId,
    auth.user!.id,
    profile.emailAddress,
    JSON.stringify(labelIds),
    now,
    now
  ).run();

  // Perform initial sync (best-effort, don't fail setup if sync fails)
  try {
    await runGmailSync(env, auth.user!.id, data.dashboardId, accessToken);
  } catch {
    // Sync can be retried manually
  }

  return Response.json({ ok: true, emailAddress: profile.emailAddress });
}

export async function unlinkGmailMirror(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  if (!dashboardId) {
    return Response.json({ error: 'E79904: dashboard_id is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79905: Not found or no access' }, { status: 404 });
  }

  // Stop watch if active
  try {
    const accessToken = await getGmailAccessToken(env, auth.user!.id);
    await stopGmailWatch(accessToken);
  } catch {
    // Ignore errors stopping watch
  }

  // Delete mirror and all associated messages
  await env.DB.prepare(`DELETE FROM gmail_messages WHERE dashboard_id = ?`).bind(dashboardId).run();
  await env.DB.prepare(`DELETE FROM gmail_actions WHERE dashboard_id = ?`).bind(dashboardId).run();
  await env.DB.prepare(`DELETE FROM gmail_mirrors WHERE dashboard_id = ?`).bind(dashboardId).run();

  return Response.json({ ok: true });
}

export async function getGmailStatus(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  if (!dashboardId) {
    return Response.json({ error: 'E79906: dashboard_id is required' }, { status: 400 });
  }

  const mirror = await env.DB.prepare(`
    SELECT email_address, label_ids, history_id, watch_expiration, status, last_synced_at, sync_error
    FROM gmail_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{
    email_address: string;
    label_ids: string;
    history_id: string | null;
    watch_expiration: string | null;
    status: string;
    last_synced_at: string | null;
    sync_error: string | null;
  }>();

  if (!mirror) {
    return Response.json({ connected: false });
  }

  const messageCount = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM gmail_messages WHERE dashboard_id = ?
  `).bind(dashboardId).first<{ count: number }>();

  let labelIds: string[] = [];
  try {
    labelIds = JSON.parse(mirror.label_ids) as string[];
  } catch {
    labelIds = ['INBOX'];
  }

  return Response.json({
    connected: true,
    emailAddress: mirror.email_address,
    labelIds,
    historyId: mirror.history_id,
    watchExpiration: mirror.watch_expiration,
    watchActive: mirror.watch_expiration ? new Date(mirror.watch_expiration).getTime() > Date.now() : false,
    status: mirror.status,
    lastSyncedAt: mirror.last_synced_at,
    syncError: mirror.sync_error,
    messageCount: messageCount?.count || 0,
  });
}

async function runGmailSync(
  env: EnvWithDriveCache,
  userId: string,
  dashboardId: string,
  accessToken?: string
): Promise<void> {
  if (!accessToken) {
    accessToken = await getGmailAccessToken(env, userId);
  }

  await env.DB.prepare(`
    UPDATE gmail_mirrors SET status = 'syncing', sync_error = null, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();

  try {
    const mirror = await env.DB.prepare(`
      SELECT label_ids FROM gmail_mirrors WHERE dashboard_id = ?
    `).bind(dashboardId).first<{ label_ids: string }>();

    let labelIds: string[] = ['INBOX'];
    try {
      labelIds = JSON.parse(mirror?.label_ids || '["INBOX"]') as string[];
    } catch {
      labelIds = ['INBOX'];
    }

    // List recent messages - limit to 20 to stay under Cloudflare's 50 subrequest limit
    // (each message requires 1 API call for metadata)
    const listResult = await listGmailMessages(accessToken, labelIds, 20);
    const messages = listResult.messages || [];

    // Fetch metadata for each message
    for (const msg of messages) {
      const fullMsg = await getGmailMessage(accessToken, msg.id, 'metadata');

      const fromHeader = extractHeader(fullMsg, 'From');
      const toHeader = extractHeader(fullMsg, 'To');
      const subject = extractHeader(fullMsg, 'Subject');

      await env.DB.prepare(`
        INSERT INTO gmail_messages (
          id, user_id, dashboard_id, message_id, thread_id, internal_date,
          from_header, to_header, subject, snippet, labels, size_estimate, body_state,
          updated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'snippet', datetime('now'), datetime('now'))
        ON CONFLICT(dashboard_id, message_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          from_header = excluded.from_header,
          to_header = excluded.to_header,
          subject = excluded.subject,
          snippet = excluded.snippet,
          labels = excluded.labels,
          size_estimate = excluded.size_estimate,
          updated_at = datetime('now')
      `).bind(
        crypto.randomUUID(),
        userId,
        dashboardId,
        fullMsg.id,
        fullMsg.threadId,
        fullMsg.internalDate || new Date().toISOString(),
        fromHeader,
        toHeader,
        subject,
        fullMsg.snippet || null,
        JSON.stringify(fullMsg.labelIds || []),
        fullMsg.sizeEstimate || 0
      ).run();
    }

    // Get latest history ID from the most recent message
    let historyId: string | null = null;
    if (messages.length > 0) {
      const latestMsg = await getGmailMessage(accessToken, messages[0].id, 'minimal');
      // The history ID comes from the profile, not messages
      const profile = await getGmailProfile(accessToken);
      // We'll store the current state - history sync happens via watch
      historyId = profile.emailAddress ? null : null; // placeholder
    }

    await env.DB.prepare(`
      UPDATE gmail_mirrors
      SET status = 'ready', last_synced_at = datetime('now'), updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(dashboardId).run();

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown sync error';
    await env.DB.prepare(`
      UPDATE gmail_mirrors SET status = 'error', sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(errorMessage, dashboardId).run();
    throw error;
  }
}

export async function syncGmailMirror(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string };

  if (!data.dashboardId) {
    return Response.json({ error: 'E79907: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79908: Not found or no access' }, { status: 404 });
  }

  try {
    await runGmailSync(env, auth.user!.id, data.dashboardId);
    return Response.json({ ok: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Sync failed';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export async function getGmailMessages(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  if (!dashboardId) {
    return Response.json({ error: 'E79909: dashboard_id is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79910: Not found or no access' }, { status: 404 });
  }

  const messages = await env.DB.prepare(`
    SELECT message_id, thread_id, internal_date, from_header, to_header, subject, snippet, labels, size_estimate, body_state
    FROM gmail_messages
    WHERE dashboard_id = ?
    ORDER BY internal_date DESC
    LIMIT ? OFFSET ?
  `).bind(dashboardId, limit, offset).all<{
    message_id: string;
    thread_id: string;
    internal_date: string;
    from_header: string | null;
    to_header: string | null;
    subject: string | null;
    snippet: string | null;
    labels: string;
    size_estimate: number;
    body_state: string;
  }>();

  const totalCount = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM gmail_messages WHERE dashboard_id = ?
  `).bind(dashboardId).first<{ count: number }>();

  return Response.json({
    messages: (messages.results || []).map(m => ({
      messageId: m.message_id,
      threadId: m.thread_id,
      internalDate: m.internal_date,
      from: m.from_header,
      to: m.to_header,
      subject: m.subject,
      snippet: m.snippet,
      labels: JSON.parse(m.labels || '[]'),
      sizeEstimate: m.size_estimate,
      bodyState: m.body_state,
    })),
    total: totalCount?.count || 0,
    limit,
    offset,
  });
}

export async function getGmailMessageDetail(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  const messageId = url.searchParams.get('message_id');
  const format = url.searchParams.get('format') || 'metadata';

  if (!dashboardId || !messageId) {
    return Response.json({ error: 'E79911: dashboard_id and message_id are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79912: Not found or no access' }, { status: 404 });
  }

  // Fetch fresh from Gmail API
  try {
    const accessToken = await getGmailAccessToken(env, auth.user!.id);
    const gmailFormat = format === 'full' ? 'full' : 'metadata';
    const message = await getGmailMessage(accessToken, messageId, gmailFormat);

    return Response.json({
      messageId: message.id,
      threadId: message.threadId,
      labels: message.labelIds || [],
      snippet: message.snippet,
      payload: message.payload,
      internalDate: message.internalDate,
      sizeEstimate: message.sizeEstimate,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to fetch message';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export async function performGmailAction(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as {
    dashboardId?: string;
    messageId?: string;
    action?: string;
    labelIds?: string[];
  };

  if (!data.dashboardId || !data.messageId || !data.action) {
    return Response.json({ error: 'E79913: dashboardId, messageId, and action are required' }, { status: 400 });
  }

  const validActions = ['archive', 'trash', 'mark_read', 'mark_unread', 'label_add', 'label_remove'];
  if (!validActions.includes(data.action)) {
    return Response.json({ error: 'E79914: Invalid action' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79915: Not found or no access' }, { status: 404 });
  }

  try {
    const accessToken = await getGmailAccessToken(env, auth.user!.id);

    let addLabelIds: string[] = [];
    let removeLabelIds: string[] = [];

    switch (data.action) {
      case 'archive':
        removeLabelIds = ['INBOX'];
        break;
      case 'trash':
        addLabelIds = ['TRASH'];
        break;
      case 'mark_read':
        removeLabelIds = ['UNREAD'];
        break;
      case 'mark_unread':
        addLabelIds = ['UNREAD'];
        break;
      case 'label_add':
        addLabelIds = data.labelIds || [];
        break;
      case 'label_remove':
        removeLabelIds = data.labelIds || [];
        break;
    }

    const result = await modifyGmailMessage(accessToken, data.messageId, addLabelIds, removeLabelIds);

    // Log the action
    await env.DB.prepare(`
      INSERT INTO gmail_actions (id, user_id, dashboard_id, message_id, action, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      crypto.randomUUID(),
      auth.user!.id,
      data.dashboardId,
      data.messageId,
      data.action,
      JSON.stringify({ addLabelIds, removeLabelIds })
    ).run();

    // Update cached message labels
    await env.DB.prepare(`
      UPDATE gmail_messages SET labels = ?, updated_at = datetime('now')
      WHERE dashboard_id = ? AND message_id = ?
    `).bind(
      JSON.stringify(result.labelIds || []),
      data.dashboardId,
      data.messageId
    ).run();

    return Response.json({ ok: true, labels: result.labelIds });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Action failed';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export async function startGmailWatch(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string };

  if (!data.dashboardId) {
    return Response.json({ error: 'E79916: dashboardId is required' }, { status: 400 });
  }

  // Gmail watch requires GMAIL_PUBSUB_TOPIC env var
  if (!env.GMAIL_PUBSUB_TOPIC) {
    return Response.json({ error: 'E79917: Gmail Pub/Sub is not configured' }, { status: 500 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79918: Not found or no access' }, { status: 404 });
  }

  try {
    const accessToken = await getGmailAccessToken(env, auth.user!.id);

    const mirror = await env.DB.prepare(`
      SELECT label_ids FROM gmail_mirrors WHERE dashboard_id = ?
    `).bind(data.dashboardId).first<{ label_ids: string }>();

    let labelIds: string[] = ['INBOX'];
    try {
      labelIds = JSON.parse(mirror?.label_ids || '["INBOX"]') as string[];
    } catch {
      labelIds = ['INBOX'];
    }

    const watchResult = await setupGmailWatch(accessToken, env.GMAIL_PUBSUB_TOPIC, labelIds);

    await env.DB.prepare(`
      UPDATE gmail_mirrors
      SET history_id = ?, watch_expiration = ?, status = 'watching', updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      watchResult.historyId,
      watchResult.expiration,
      data.dashboardId
    ).run();

    return Response.json({
      ok: true,
      historyId: watchResult.historyId,
      expiration: watchResult.expiration,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to start watch';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export async function stopGmailWatchEndpoint(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string };

  if (!data.dashboardId) {
    return Response.json({ error: 'E79919: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79920: Not found or no access' }, { status: 404 });
  }

  try {
    const accessToken = await getGmailAccessToken(env, auth.user!.id);
    await stopGmailWatch(accessToken);

    await env.DB.prepare(`
      UPDATE gmail_mirrors
      SET watch_expiration = null, status = 'ready', updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(data.dashboardId).run();

    return Response.json({ ok: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to stop watch';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export async function handleGmailPush(
  request: Request,
  env: EnvWithDriveCache
): Promise<Response> {
  // This endpoint receives Pub/Sub push notifications from Gmail
  // It should be called without auth (Pub/Sub service account)

  try {
    const body = await request.json() as {
      message?: {
        data?: string;
        messageId?: string;
        publishTime?: string;
      };
      subscription?: string;
    };

    if (!body.message?.data) {
      return Response.json({ error: 'Missing message data' }, { status: 400 });
    }

    // Decode base64 message data
    const decoded = atob(body.message.data);
    const notification = JSON.parse(decoded) as {
      emailAddress: string;
      historyId: string;
    };

    // Find mirrors for this email address
    const mirrors = await env.DB.prepare(`
      SELECT dashboard_id, user_id, history_id, label_ids
      FROM gmail_mirrors
      WHERE email_address = ? AND status IN ('watching', 'ready')
    `).bind(notification.emailAddress).all<{
      dashboard_id: string;
      user_id: string;
      history_id: string | null;
      label_ids: string;
    }>();

    // Process each mirror
    for (const mirror of mirrors.results || []) {
      if (!mirror.history_id) {
        // No history ID yet, skip incremental sync
        continue;
      }

      try {
        const accessToken = await getGmailAccessToken(env, mirror.user_id);

        // Fetch history since last known ID
        const history = await getGmailHistory(
          accessToken,
          mirror.history_id,
          undefined,
          100
        );

        // Process new messages
        if (history.history) {
          for (const record of history.history) {
            if (record.messagesAdded) {
              for (const added of record.messagesAdded) {
                const msg = added.message;
                const fullMsg = await getGmailMessage(accessToken, msg.id, 'metadata');

                const fromHeader = extractHeader(fullMsg, 'From');
                const toHeader = extractHeader(fullMsg, 'To');
                const subject = extractHeader(fullMsg, 'Subject');

                await env.DB.prepare(`
                  INSERT INTO gmail_messages (
                    id, user_id, dashboard_id, message_id, thread_id, internal_date,
                    from_header, to_header, subject, snippet, labels, size_estimate, body_state,
                    updated_at, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'snippet', datetime('now'), datetime('now'))
                  ON CONFLICT(dashboard_id, message_id) DO UPDATE SET
                    labels = excluded.labels,
                    updated_at = datetime('now')
                `).bind(
                  crypto.randomUUID(),
                  mirror.user_id,
                  mirror.dashboard_id,
                  fullMsg.id,
                  fullMsg.threadId,
                  fullMsg.internalDate || new Date().toISOString(),
                  fromHeader,
                  toHeader,
                  subject,
                  fullMsg.snippet || null,
                  JSON.stringify(fullMsg.labelIds || []),
                  fullMsg.sizeEstimate || 0
                ).run();
              }
            }

            // Handle deleted messages
            if (record.messagesDeleted) {
              for (const deleted of record.messagesDeleted) {
                await env.DB.prepare(`
                  DELETE FROM gmail_messages WHERE dashboard_id = ? AND message_id = ?
                `).bind(mirror.dashboard_id, deleted.message.id).run();
              }
            }
          }
        }

        // Update history ID
        await env.DB.prepare(`
          UPDATE gmail_mirrors SET history_id = ?, last_synced_at = datetime('now'), updated_at = datetime('now')
          WHERE dashboard_id = ?
        `).bind(history.historyId, mirror.dashboard_id).run();

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Sync error';
        // Log error but continue processing other mirrors
        console.error(`Gmail push sync failed for ${mirror.dashboard_id}: ${errorMessage}`);

        if (errorMessage === 'HISTORY_EXPIRED') {
          // Need full resync
          await env.DB.prepare(`
            UPDATE gmail_mirrors SET history_id = null, status = 'ready', sync_error = 'History expired, full resync needed'
            WHERE dashboard_id = ?
          `).bind(mirror.dashboard_id).run();
        }
      }
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error('Gmail push handler error:', error);
    return Response.json({ error: 'Push processing failed' }, { status: 500 });
  }
}

export async function disconnectGmail(
  _request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  // Stop all watches
  try {
    const accessToken = await getGmailAccessToken(env, auth.user!.id);
    await stopGmailWatch(accessToken);
  } catch {
    // Ignore errors stopping watch
  }

  // Delete all user's Gmail mirrors and messages
  const mirrors = await env.DB.prepare(`
    SELECT dashboard_id FROM gmail_mirrors WHERE user_id = ?
  `).bind(auth.user!.id).all<{ dashboard_id: string }>();

  for (const mirror of mirrors.results || []) {
    await env.DB.prepare(`DELETE FROM gmail_messages WHERE dashboard_id = ?`).bind(mirror.dashboard_id).run();
    await env.DB.prepare(`DELETE FROM gmail_actions WHERE dashboard_id = ?`).bind(mirror.dashboard_id).run();
  }
  await env.DB.prepare(`DELETE FROM gmail_mirrors WHERE user_id = ?`).bind(auth.user!.id).run();

  // Delete integration
  await env.DB.prepare(`DELETE FROM user_integrations WHERE user_id = ? AND provider = 'gmail'`).bind(auth.user!.id).run();

  return Response.json({ ok: true });
}

// ============================================
// Google Calendar integration
// ============================================

interface CalendarEvent {
  id: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  organizer?: {
    email?: string;
    displayName?: string;
    self?: boolean;
  };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
  }>;
  updated?: string;
  created?: string;
}

async function refreshCalendarAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth is not configured.');
  }

  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'google_calendar'
  `).bind(userId).first<{ access_token: string; refresh_token: string | null }>();

  if (!record?.refresh_token) {
    throw new Error('Calendar must be connected again.');
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
    // 400/401 means token was revoked or is invalid - user needs to reconnect
    if (tokenResponse.status === 400 || tokenResponse.status === 401) {
      throw new Error('TOKEN_REVOKED');
    }
    throw new Error('Failed to refresh Calendar access token.');
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
    WHERE user_id = ? AND provider = 'google_calendar'
  `).bind(
    tokenData.access_token,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    userId
  ).run();

  return tokenData.access_token;
}

async function getCalendarAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
  const record = await env.DB.prepare(`
    SELECT access_token, expires_at FROM user_integrations
    WHERE user_id = ? AND provider = 'google_calendar'
  `).bind(userId).first<{ access_token: string; expires_at: string | null }>();

  if (!record) {
    throw new Error('Calendar not connected.');
  }

  // Refresh if expired or expires within 5 minutes
  if (record.expires_at) {
    const expiresAt = new Date(record.expires_at).getTime();
    const now = Date.now();
    if (expiresAt - now < 5 * 60 * 1000) {
      return refreshCalendarAccessToken(env, userId);
    }
  }

  return record.access_token;
}

async function getCalendarProfile(accessToken: string): Promise<{ email: string; name?: string }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    // 401/403 means token is invalid/revoked - user needs to reconnect
    if (res.status === 401 || res.status === 403) {
      throw new Error('TOKEN_REVOKED');
    }
    throw new Error('Failed to fetch calendar profile.');
  }

  const data = await res.json() as { email: string; name?: string };
  return { email: data.email, name: data.name };
}

async function listCalendarEvents(
  accessToken: string,
  calendarId: string = 'primary',
  timeMin?: string,
  timeMax?: string,
  maxResults: number = 50,
  pageToken?: string,
  syncToken?: string
): Promise<{
  items: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}> {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');

  if (syncToken) {
    url.searchParams.set('syncToken', syncToken);
  } else {
    if (timeMin) {
      url.searchParams.set('timeMin', timeMin);
    }
    if (timeMax) {
      url.searchParams.set('timeMax', timeMax);
    }
  }

  if (pageToken) {
    url.searchParams.set('pageToken', pageToken);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    if (res.status === 410) {
      // Sync token expired, need full sync
      throw new Error('SYNC_TOKEN_EXPIRED');
    }
    throw new Error('Failed to list calendar events.');
  }

  return res.json() as Promise<{
    items: CalendarEvent[];
    nextPageToken?: string;
    nextSyncToken?: string;
  }>;
}

async function getCalendarEvent(
  accessToken: string,
  calendarId: string,
  eventId: string
): Promise<CalendarEvent> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error('Failed to fetch calendar event.');
  }

  return res.json() as Promise<CalendarEvent>;
}

export async function connectCalendar(
  request: Request,
  env: EnvWithDriveCache,
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
  await createState(env, auth.user!.id, 'google_calendar', state, {
    dashboard_id: dashboardId,
    popup: mode === 'popup',
  });

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/calendar/callback`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', CALENDAR_SCOPE.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

export async function callbackCalendar(
  request: Request,
  env: EnvWithDriveCache
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

  const stateData = await consumeState(env, state, 'google_calendar');
  if (!stateData) {
    return renderErrorPage('Invalid or expired state.');
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === 'string'
    ? stateData.metadata.dashboard_id
    : null;
  const popup = stateData.metadata.popup === true;

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/calendar/callback`;

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

  // Fetch email address
  let emailAddress = '';
  try {
    const profile = await getCalendarProfile(tokenData.access_token);
    emailAddress = profile.email;
  } catch {
    // Email will be empty if profile fetch fails
  }

  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    email_address: emailAddress,
  });

  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'google_calendar', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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

  const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
  if (popup) {
    return renderProviderAuthCompletePage(frontendUrl, 'Calendar', 'calendar-auth-complete', dashboardId);
  }

  return renderSuccessPage('Google Calendar');
}

export async function getCalendarIntegration(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  const integration = await env.DB.prepare(`
    SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'google_calendar'
  `).bind(auth.user!.id).first<{ metadata: string }>();

  if (!integration) {
    return Response.json({ connected: false, linked: false, emailAddress: null });
  }

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(integration.metadata || '{}') as Record<string, unknown>;
  } catch {
    metadata = {};
  }

  if (!dashboardId) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null,
    });
  }

  const mirror = await env.DB.prepare(`
    SELECT email_address, calendar_id, status, last_synced_at
    FROM calendar_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{
    email_address: string;
    calendar_id: string;
    status: string;
    last_synced_at: string | null;
  }>();

  if (!mirror) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null,
    });
  }

  return Response.json({
    connected: true,
    linked: true,
    emailAddress: mirror.email_address,
    calendarId: mirror.calendar_id,
    status: mirror.status,
    lastSyncedAt: mirror.last_synced_at,
  });
}

export async function setupCalendarMirror(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as {
    dashboardId?: string;
    calendarId?: string;
  };

  if (!data.dashboardId) {
    return Response.json({ error: 'E79930: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79931: Not found or no access' }, { status: 404 });
  }

  let accessToken: string;
  try {
    accessToken = await getCalendarAccessToken(env, auth.user!.id);
  } catch (err) {
    if (err instanceof Error && err.message === 'TOKEN_REVOKED') {
      return Response.json({
        error: 'E79933: Calendar access was revoked. Please reconnect.',
        code: 'TOKEN_REVOKED'
      }, { status: 401 });
    }
    return Response.json({ error: 'E79932: Calendar not connected' }, { status: 404 });
  }

  let profile: { email: string; name?: string };
  try {
    profile = await getCalendarProfile(accessToken);
  } catch (err) {
    if (err instanceof Error && err.message === 'TOKEN_REVOKED') {
      return Response.json({
        error: 'E79933: Calendar access was revoked. Please reconnect.',
        code: 'TOKEN_REVOKED'
      }, { status: 401 });
    }
    throw err;
  }
  const calendarId = data.calendarId || 'primary';

  await env.DB.prepare(`
    INSERT INTO calendar_mirrors (
      dashboard_id, user_id, email_address, calendar_id, status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, 'idle', datetime('now'), datetime('now'))
    ON CONFLICT(dashboard_id) DO UPDATE SET
      email_address = excluded.email_address,
      calendar_id = excluded.calendar_id,
      status = 'idle',
      updated_at = datetime('now')
  `).bind(
    data.dashboardId,
    auth.user!.id,
    profile.email,
    calendarId
  ).run();

  // Trigger initial sync
  try {
    await runCalendarSync(env, auth.user!.id, data.dashboardId, accessToken);
  } catch (error) {
    console.error('Initial calendar sync failed:', error);
  }

  return Response.json({ ok: true, emailAddress: profile.email });
}

export async function unlinkCalendarMirror(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  if (!dashboardId) {
    return Response.json({ error: 'E79933: dashboard_id is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79934: Not found or no access' }, { status: 404 });
  }

  await env.DB.prepare(`DELETE FROM calendar_events WHERE dashboard_id = ?`).bind(dashboardId).run();
  await env.DB.prepare(`DELETE FROM calendar_mirrors WHERE dashboard_id = ?`).bind(dashboardId).run();

  return Response.json({ ok: true });
}

export async function getCalendarStatus(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  if (!dashboardId) {
    return Response.json({ error: 'E79935: dashboard_id is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79936: Not found or no access' }, { status: 404 });
  }

  const mirror = await env.DB.prepare(`
    SELECT email_address, calendar_id, status, sync_token, last_synced_at, sync_error
    FROM calendar_mirrors
    WHERE dashboard_id = ?
  `).bind(dashboardId).first<{
    email_address: string;
    calendar_id: string;
    status: string;
    sync_token: string | null;
    last_synced_at: string | null;
    sync_error: string | null;
  }>();

  if (!mirror) {
    return Response.json({ connected: false });
  }

  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM calendar_events WHERE dashboard_id = ?
  `).bind(dashboardId).first<{ count: number }>();

  return Response.json({
    connected: true,
    emailAddress: mirror.email_address,
    calendarId: mirror.calendar_id,
    status: mirror.status,
    lastSyncedAt: mirror.last_synced_at,
    syncError: mirror.sync_error,
    eventCount: countResult?.count || 0,
  });
}

async function runCalendarSync(
  env: EnvWithDriveCache,
  userId: string,
  dashboardId: string,
  accessToken?: string
): Promise<void> {
  if (!accessToken) {
    accessToken = await getCalendarAccessToken(env, userId);
  }

  await env.DB.prepare(`
    UPDATE calendar_mirrors SET status = 'syncing', sync_error = null, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();

  try {
    const mirror = await env.DB.prepare(`
      SELECT calendar_id, sync_token FROM calendar_mirrors WHERE dashboard_id = ?
    `).bind(dashboardId).first<{ calendar_id: string; sync_token: string | null }>();

    const calendarId = mirror?.calendar_id || 'primary';
    let syncToken = mirror?.sync_token;

    // For initial sync or if sync token expired, fetch events from now to 30 days ahead
    const now = new Date();
    const timeMin = syncToken ? undefined : now.toISOString();
    const timeMax = syncToken ? undefined : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    let listResult;
    try {
      listResult = await listCalendarEvents(accessToken, calendarId, timeMin, timeMax, 50, undefined, syncToken || undefined);
    } catch (error) {
      if (error instanceof Error && error.message === 'SYNC_TOKEN_EXPIRED') {
        // Full resync needed
        syncToken = null;
        listResult = await listCalendarEvents(accessToken, calendarId, now.toISOString(), new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(), 50);
        // Clear existing events for this dashboard
        await env.DB.prepare(`DELETE FROM calendar_events WHERE dashboard_id = ?`).bind(dashboardId).run();
      } else {
        throw error;
      }
    }

    const events = listResult.items || [];

    for (const event of events) {
      if (!event.id) continue;

      const startTime = event.start?.dateTime || event.start?.date || '';
      const endTime = event.end?.dateTime || event.end?.date || '';
      const allDay = !event.start?.dateTime && !!event.start?.date ? 1 : 0;

      await env.DB.prepare(`
        INSERT INTO calendar_events (
          id, user_id, dashboard_id, event_id, calendar_id,
          summary, description, location, start_time, end_time, all_day,
          status, html_link, organizer_email, attendees,
          updated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(dashboard_id, event_id) DO UPDATE SET
          summary = excluded.summary,
          description = excluded.description,
          location = excluded.location,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          all_day = excluded.all_day,
          status = excluded.status,
          html_link = excluded.html_link,
          organizer_email = excluded.organizer_email,
          attendees = excluded.attendees,
          updated_at = datetime('now')
      `).bind(
        crypto.randomUUID(),
        userId,
        dashboardId,
        event.id,
        calendarId,
        event.summary || null,
        event.description || null,
        event.location || null,
        startTime,
        endTime,
        allDay,
        event.status || null,
        event.htmlLink || null,
        event.organizer?.email || null,
        JSON.stringify(event.attendees || [])
      ).run();
    }

    // Update mirror with new sync token
    await env.DB.prepare(`
      UPDATE calendar_mirrors
      SET sync_token = ?, status = 'ready', last_synced_at = datetime('now'), updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      listResult.nextSyncToken || null,
      dashboardId
    ).run();

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Sync failed';
    await env.DB.prepare(`
      UPDATE calendar_mirrors SET status = 'error', sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(errorMessage, dashboardId).run();
    throw error;
  }
}

export async function syncCalendarMirror(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string };

  if (!data.dashboardId) {
    return Response.json({ error: 'E79937: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79938: Not found or no access' }, { status: 404 });
  }

  try {
    await runCalendarSync(env, auth.user!.id, data.dashboardId);
    return Response.json({ ok: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Sync failed';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export async function getCalendarEvents(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const timeMin = url.searchParams.get('time_min');
  const timeMax = url.searchParams.get('time_max');

  if (!dashboardId) {
    return Response.json({ error: 'E79939: dashboard_id is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79940: Not found or no access' }, { status: 404 });
  }

  let query = `
    SELECT event_id, calendar_id, summary, description, location,
           start_time, end_time, all_day, status, html_link, organizer_email, attendees
    FROM calendar_events
    WHERE dashboard_id = ?
  `;
  const params: (string | number)[] = [dashboardId];

  if (timeMin) {
    query += ` AND start_time >= ?`;
    params.push(timeMin);
  }
  if (timeMax) {
    query += ` AND start_time <= ?`;
    params.push(timeMax);
  }

  query += ` ORDER BY start_time ASC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const events = await env.DB.prepare(query).bind(...params).all<{
    event_id: string;
    calendar_id: string;
    summary: string | null;
    description: string | null;
    location: string | null;
    start_time: string;
    end_time: string;
    all_day: number;
    status: string | null;
    html_link: string | null;
    organizer_email: string | null;
    attendees: string;
  }>();

  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM calendar_events WHERE dashboard_id = ?
  `).bind(dashboardId).first<{ count: number }>();

  const formatted = (events.results || []).map(e => ({
    eventId: e.event_id,
    calendarId: e.calendar_id,
    summary: e.summary,
    description: e.description,
    location: e.location,
    startTime: e.start_time,
    endTime: e.end_time,
    allDay: e.all_day === 1,
    status: e.status,
    htmlLink: e.html_link,
    organizerEmail: e.organizer_email,
    attendees: JSON.parse(e.attendees || '[]') as Array<{
      email?: string;
      displayName?: string;
      responseStatus?: string;
    }>,
  }));

  return Response.json({
    events: formatted,
    total: countResult?.count || 0,
    limit,
    offset,
  });
}

export async function getCalendarEventDetail(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  const eventId = url.searchParams.get('event_id');

  if (!dashboardId || !eventId) {
    return Response.json({ error: 'E79941: dashboard_id and event_id are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79942: Not found or no access' }, { status: 404 });
  }

  // Try to fetch fresh from Calendar API
  try {
    const accessToken = await getCalendarAccessToken(env, auth.user!.id);
    const mirror = await env.DB.prepare(`
      SELECT calendar_id FROM calendar_mirrors WHERE dashboard_id = ?
    `).bind(dashboardId).first<{ calendar_id: string }>();

    const calendarId = mirror?.calendar_id || 'primary';
    const event = await getCalendarEvent(accessToken, calendarId, eventId);

    return Response.json({
      eventId: event.id,
      calendarId,
      summary: event.summary,
      description: event.description,
      location: event.location,
      startTime: event.start?.dateTime || event.start?.date,
      endTime: event.end?.dateTime || event.end?.date,
      allDay: !event.start?.dateTime && !!event.start?.date,
      status: event.status,
      htmlLink: event.htmlLink,
      organizerEmail: event.organizer?.email,
      attendees: event.attendees || [],
    });
  } catch {
    // Fall back to cached data
    const cached = await env.DB.prepare(`
      SELECT event_id, calendar_id, summary, description, location,
             start_time, end_time, all_day, status, html_link, organizer_email, attendees
      FROM calendar_events
      WHERE dashboard_id = ? AND event_id = ?
    `).bind(dashboardId, eventId).first<{
      event_id: string;
      calendar_id: string;
      summary: string | null;
      description: string | null;
      location: string | null;
      start_time: string;
      end_time: string;
      all_day: number;
      status: string | null;
      html_link: string | null;
      organizer_email: string | null;
      attendees: string;
    }>();

    if (!cached) {
      return Response.json({ error: 'E79943: Event not found' }, { status: 404 });
    }

    return Response.json({
      eventId: cached.event_id,
      calendarId: cached.calendar_id,
      summary: cached.summary,
      description: cached.description,
      location: cached.location,
      startTime: cached.start_time,
      endTime: cached.end_time,
      allDay: cached.all_day === 1,
      status: cached.status,
      htmlLink: cached.html_link,
      organizerEmail: cached.organizer_email,
      attendees: JSON.parse(cached.attendees || '[]'),
    });
  }
}

export async function disconnectCalendar(
  _request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  // Delete all user's calendar mirrors and events
  const mirrors = await env.DB.prepare(`
    SELECT dashboard_id FROM calendar_mirrors WHERE user_id = ?
  `).bind(auth.user!.id).all<{ dashboard_id: string }>();

  for (const mirror of mirrors.results || []) {
    await env.DB.prepare(`DELETE FROM calendar_events WHERE dashboard_id = ?`).bind(mirror.dashboard_id).run();
  }
  await env.DB.prepare(`DELETE FROM calendar_mirrors WHERE user_id = ?`).bind(auth.user!.id).run();

  // Delete integration
  await env.DB.prepare(`DELETE FROM user_integrations WHERE user_id = ? AND provider = 'google_calendar'`).bind(auth.user!.id).run();

  return Response.json({ ok: true });
}

// ============================================
// Google Contacts integration
// ============================================

interface GoogleContact {
  resourceName: string;
  etag?: string;
  names?: Array<{
    displayName?: string;
    givenName?: string;
    familyName?: string;
  }>;
  emailAddresses?: Array<{
    value?: string;
    type?: string;
  }>;
  phoneNumbers?: Array<{
    value?: string;
    type?: string;
  }>;
  organizations?: Array<{
    name?: string;
    title?: string;
  }>;
  photos?: Array<{
    url?: string;
  }>;
  biographies?: Array<{
    value?: string;
  }>;
}

async function refreshContactsAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth is not configured.');
  }

  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'google_contacts'
  `).bind(userId).first<{ access_token: string; refresh_token: string | null }>();

  if (!record?.refresh_token) {
    throw new Error('Contacts must be connected again.');
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
    // 400/401 means token was revoked or is invalid - user needs to reconnect
    if (tokenResponse.status === 400 || tokenResponse.status === 401) {
      throw new Error('TOKEN_REVOKED');
    }
    throw new Error('Failed to refresh Contacts access token.');
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
    WHERE user_id = ? AND provider = 'google_contacts'
  `).bind(
    tokenData.access_token,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    userId
  ).run();

  return tokenData.access_token;
}

async function getContactsAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
  const record = await env.DB.prepare(`
    SELECT access_token, expires_at FROM user_integrations
    WHERE user_id = ? AND provider = 'google_contacts'
  `).bind(userId).first<{ access_token: string; expires_at: string | null }>();

  if (!record) {
    throw new Error('Contacts not connected.');
  }

  // Refresh if expired or expires within 5 minutes
  if (record.expires_at) {
    const expiresAt = new Date(record.expires_at).getTime();
    const now = Date.now();
    if (expiresAt - now < 5 * 60 * 1000) {
      return refreshContactsAccessToken(env, userId);
    }
  }

  return record.access_token;
}

async function getContactsProfile(accessToken: string): Promise<{ email: string; name?: string }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    // 401/403 means token is invalid/revoked - user needs to reconnect
    if (res.status === 401 || res.status === 403) {
      throw new Error('TOKEN_REVOKED');
    }
    throw new Error('Failed to fetch contacts profile.');
  }

  const data = await res.json() as { email: string; name?: string };
  return { email: data.email, name: data.name };
}

async function listGoogleContacts(
  accessToken: string,
  pageSize: number = 100,
  pageToken?: string,
  syncToken?: string
): Promise<{
  connections: GoogleContact[];
  nextPageToken?: string;
  nextSyncToken?: string;
  totalPeople?: number;
}> {
  const url = new URL('https://people.googleapis.com/v1/people/me/connections');
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers,organizations,photos,biographies');

  if (syncToken) {
    url.searchParams.set('syncToken', syncToken);
  }
  if (pageToken) {
    url.searchParams.set('pageToken', pageToken);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    if (res.status === 410) {
      throw new Error('SYNC_TOKEN_EXPIRED');
    }
    throw new Error('Failed to list contacts.');
  }

  return res.json() as Promise<{
    connections: GoogleContact[];
    nextPageToken?: string;
    nextSyncToken?: string;
    totalPeople?: number;
  }>;
}

async function getGoogleContact(
  accessToken: string,
  resourceName: string
): Promise<GoogleContact> {
  const url = new URL(`https://people.googleapis.com/v1/${resourceName}`);
  url.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers,organizations,photos,biographies');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error('Failed to fetch contact.');
  }

  return res.json() as Promise<GoogleContact>;
}

async function searchGoogleContacts(
  accessToken: string,
  query: string,
  pageSize: number = 30
): Promise<{ results: GoogleContact[] }> {
  const url = new URL('https://people.googleapis.com/v1/people:searchContacts');
  url.searchParams.set('query', query);
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('readMask', 'names,emailAddresses,phoneNumbers,organizations,photos');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error('Failed to search contacts.');
  }

  const data = await res.json() as { results?: Array<{ person: GoogleContact }> };
  return { results: (data.results || []).map(r => r.person) };
}

export async function connectContacts(
  request: Request,
  env: EnvWithDriveCache,
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
  await createState(env, auth.user!.id, 'google_contacts', state, {
    dashboard_id: dashboardId,
    popup: mode === 'popup',
  });

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/contacts/callback`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', CONTACTS_SCOPE.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

export async function callbackContacts(
  request: Request,
  env: EnvWithDriveCache
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

  const stateData = await consumeState(env, state, 'google_contacts');
  if (!stateData) {
    return renderErrorPage('Invalid or expired state.');
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === 'string'
    ? stateData.metadata.dashboard_id
    : null;
  const popup = stateData.metadata.popup === true;

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/contacts/callback`;

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

  // Fetch email address
  let emailAddress = '';
  try {
    const profile = await getContactsProfile(tokenData.access_token);
    emailAddress = profile.email;
  } catch {
    // Email will be empty if profile fetch fails
  }

  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    email_address: emailAddress,
  });

  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'google_contacts', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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

  const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
  if (popup) {
    return renderProviderAuthCompletePage(frontendUrl, 'Contacts', 'contacts-auth-complete', dashboardId);
  }

  return renderSuccessPage('Google Contacts');
}

export async function getContactsIntegration(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  const integration = await env.DB.prepare(`
    SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'google_contacts'
  `).bind(auth.user!.id).first<{ metadata: string }>();

  if (!integration) {
    return Response.json({ connected: false, linked: false, emailAddress: null });
  }

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(integration.metadata || '{}') as Record<string, unknown>;
  } catch {
    metadata = {};
  }

  if (!dashboardId) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null,
    });
  }

  const mirror = await env.DB.prepare(`
    SELECT email_address, status, last_synced_at
    FROM contacts_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{
    email_address: string;
    status: string;
    last_synced_at: string | null;
  }>();

  if (!mirror) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null,
    });
  }

  return Response.json({
    connected: true,
    linked: true,
    emailAddress: mirror.email_address,
    status: mirror.status,
    lastSyncedAt: mirror.last_synced_at,
  });
}

export async function setupContactsMirror(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string };

  if (!data.dashboardId) {
    return Response.json({ error: 'E79950: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79951: Not found or no access' }, { status: 404 });
  }

  let accessToken: string;
  try {
    accessToken = await getContactsAccessToken(env, auth.user!.id);
  } catch (err) {
    if (err instanceof Error && err.message === 'TOKEN_REVOKED') {
      return Response.json({
        error: 'E79953: Contacts access was revoked. Please reconnect.',
        code: 'TOKEN_REVOKED'
      }, { status: 401 });
    }
    return Response.json({ error: 'E79952: Contacts not connected' }, { status: 404 });
  }

  let profile: { email: string; name?: string };
  try {
    profile = await getContactsProfile(accessToken);
  } catch (err) {
    if (err instanceof Error && err.message === 'TOKEN_REVOKED') {
      return Response.json({
        error: 'E79953: Contacts access was revoked. Please reconnect.',
        code: 'TOKEN_REVOKED'
      }, { status: 401 });
    }
    throw err;
  }

  await env.DB.prepare(`
    INSERT INTO contacts_mirrors (
      dashboard_id, user_id, email_address, status, updated_at, created_at
    ) VALUES (?, ?, ?, 'idle', datetime('now'), datetime('now'))
    ON CONFLICT(dashboard_id) DO UPDATE SET
      email_address = excluded.email_address,
      status = 'idle',
      updated_at = datetime('now')
  `).bind(
    data.dashboardId,
    auth.user!.id,
    profile.email
  ).run();

  // Trigger initial sync
  try {
    await runContactsSync(env, auth.user!.id, data.dashboardId, accessToken);
  } catch (error) {
    console.error('Initial contacts sync failed:', error);
  }

  return Response.json({ ok: true, emailAddress: profile.email });
}

export async function unlinkContactsMirror(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  if (!dashboardId) {
    return Response.json({ error: 'E79953: dashboard_id is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79954: Not found or no access' }, { status: 404 });
  }

  await env.DB.prepare(`DELETE FROM contacts WHERE dashboard_id = ?`).bind(dashboardId).run();
  await env.DB.prepare(`DELETE FROM contacts_mirrors WHERE dashboard_id = ?`).bind(dashboardId).run();

  return Response.json({ ok: true });
}

export async function getContactsStatus(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  if (!dashboardId) {
    return Response.json({ error: 'E79955: dashboard_id is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79956: Not found or no access' }, { status: 404 });
  }

  const mirror = await env.DB.prepare(`
    SELECT email_address, status, sync_token, last_synced_at, sync_error
    FROM contacts_mirrors
    WHERE dashboard_id = ?
  `).bind(dashboardId).first<{
    email_address: string;
    status: string;
    sync_token: string | null;
    last_synced_at: string | null;
    sync_error: string | null;
  }>();

  if (!mirror) {
    return Response.json({ connected: false });
  }

  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM contacts WHERE dashboard_id = ?
  `).bind(dashboardId).first<{ count: number }>();

  return Response.json({
    connected: true,
    emailAddress: mirror.email_address,
    status: mirror.status,
    lastSyncedAt: mirror.last_synced_at,
    syncError: mirror.sync_error,
    contactCount: countResult?.count || 0,
  });
}

async function runContactsSync(
  env: EnvWithDriveCache,
  userId: string,
  dashboardId: string,
  accessToken?: string
): Promise<void> {
  if (!accessToken) {
    accessToken = await getContactsAccessToken(env, userId);
  }

  await env.DB.prepare(`
    UPDATE contacts_mirrors SET status = 'syncing', sync_error = null, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();

  try {
    const mirror = await env.DB.prepare(`
      SELECT sync_token FROM contacts_mirrors WHERE dashboard_id = ?
    `).bind(dashboardId).first<{ sync_token: string | null }>();

    let syncToken = mirror?.sync_token;

    let listResult;
    try {
      listResult = await listGoogleContacts(accessToken, 100, undefined, syncToken || undefined);
    } catch (error) {
      if (error instanceof Error && error.message === 'SYNC_TOKEN_EXPIRED') {
        // Full resync needed
        syncToken = null;
        listResult = await listGoogleContacts(accessToken, 100);
        // Clear existing contacts for this dashboard
        await env.DB.prepare(`DELETE FROM contacts WHERE dashboard_id = ?`).bind(dashboardId).run();
      } else {
        throw error;
      }
    }

    const contacts = listResult.connections || [];

    for (const contact of contacts) {
      if (!contact.resourceName) continue;

      const displayName = contact.names?.[0]?.displayName || null;
      const givenName = contact.names?.[0]?.givenName || null;
      const familyName = contact.names?.[0]?.familyName || null;
      const photoUrl = contact.photos?.[0]?.url || null;
      const notes = contact.biographies?.[0]?.value || null;

      await env.DB.prepare(`
        INSERT INTO contacts (
          id, user_id, dashboard_id, resource_name,
          display_name, given_name, family_name,
          email_addresses, phone_numbers, organizations,
          photo_url, notes, updated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(dashboard_id, resource_name) DO UPDATE SET
          display_name = excluded.display_name,
          given_name = excluded.given_name,
          family_name = excluded.family_name,
          email_addresses = excluded.email_addresses,
          phone_numbers = excluded.phone_numbers,
          organizations = excluded.organizations,
          photo_url = excluded.photo_url,
          notes = excluded.notes,
          updated_at = datetime('now')
      `).bind(
        crypto.randomUUID(),
        userId,
        dashboardId,
        contact.resourceName,
        displayName,
        givenName,
        familyName,
        JSON.stringify(contact.emailAddresses || []),
        JSON.stringify(contact.phoneNumbers || []),
        JSON.stringify(contact.organizations || []),
        photoUrl,
        notes
      ).run();
    }

    // Update mirror with new sync token
    await env.DB.prepare(`
      UPDATE contacts_mirrors
      SET sync_token = ?, status = 'ready', last_synced_at = datetime('now'), updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      listResult.nextSyncToken || null,
      dashboardId
    ).run();

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Sync failed';
    await env.DB.prepare(`
      UPDATE contacts_mirrors SET status = 'error', sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(errorMessage, dashboardId).run();
    throw error;
  }
}

export async function syncContactsMirror(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as { dashboardId?: string };

  if (!data.dashboardId) {
    return Response.json({ error: 'E79957: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79958: Not found or no access' }, { status: 404 });
  }

  try {
    await runContactsSync(env, auth.user!.id, data.dashboardId);
    return Response.json({ ok: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Sync failed';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export async function getContacts(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const search = url.searchParams.get('search');

  if (!dashboardId) {
    return Response.json({ error: 'E79959: dashboard_id is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79960: Not found or no access' }, { status: 404 });
  }

  let query = `
    SELECT resource_name, display_name, given_name, family_name,
           email_addresses, phone_numbers, organizations, photo_url, notes
    FROM contacts
    WHERE dashboard_id = ?
  `;
  const params: (string | number)[] = [dashboardId];

  if (search) {
    query += ` AND (display_name LIKE ? OR email_addresses LIKE ?)`;
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern);
  }

  query += ` ORDER BY display_name ASC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const contacts = await env.DB.prepare(query).bind(...params).all<{
    resource_name: string;
    display_name: string | null;
    given_name: string | null;
    family_name: string | null;
    email_addresses: string;
    phone_numbers: string;
    organizations: string;
    photo_url: string | null;
    notes: string | null;
  }>();

  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM contacts WHERE dashboard_id = ?
  `).bind(dashboardId).first<{ count: number }>();

  const formatted = (contacts.results || []).map(c => ({
    resourceName: c.resource_name,
    displayName: c.display_name,
    givenName: c.given_name,
    familyName: c.family_name,
    emailAddresses: JSON.parse(c.email_addresses || '[]') as Array<{ value?: string; type?: string }>,
    phoneNumbers: JSON.parse(c.phone_numbers || '[]') as Array<{ value?: string; type?: string }>,
    organizations: JSON.parse(c.organizations || '[]') as Array<{ name?: string; title?: string }>,
    photoUrl: c.photo_url,
    notes: c.notes,
  }));

  return Response.json({
    contacts: formatted,
    total: countResult?.count || 0,
    limit,
    offset,
  });
}

export async function getContactDetail(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  const resourceName = url.searchParams.get('resource_name');

  if (!dashboardId || !resourceName) {
    return Response.json({ error: 'E79961: dashboard_id and resource_name are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79962: Not found or no access' }, { status: 404 });
  }

  // Try to fetch fresh from Contacts API
  try {
    const accessToken = await getContactsAccessToken(env, auth.user!.id);
    const contact = await getGoogleContact(accessToken, resourceName);

    return Response.json({
      resourceName: contact.resourceName,
      displayName: contact.names?.[0]?.displayName,
      givenName: contact.names?.[0]?.givenName,
      familyName: contact.names?.[0]?.familyName,
      emailAddresses: contact.emailAddresses || [],
      phoneNumbers: contact.phoneNumbers || [],
      organizations: contact.organizations || [],
      photoUrl: contact.photos?.[0]?.url,
      notes: contact.biographies?.[0]?.value,
    });
  } catch {
    // Fall back to cached data
    const cached = await env.DB.prepare(`
      SELECT resource_name, display_name, given_name, family_name,
             email_addresses, phone_numbers, organizations, photo_url, notes
      FROM contacts
      WHERE dashboard_id = ? AND resource_name = ?
    `).bind(dashboardId, resourceName).first<{
      resource_name: string;
      display_name: string | null;
      given_name: string | null;
      family_name: string | null;
      email_addresses: string;
      phone_numbers: string;
      organizations: string;
      photo_url: string | null;
      notes: string | null;
    }>();

    if (!cached) {
      return Response.json({ error: 'E79963: Contact not found' }, { status: 404 });
    }

    return Response.json({
      resourceName: cached.resource_name,
      displayName: cached.display_name,
      givenName: cached.given_name,
      familyName: cached.family_name,
      emailAddresses: JSON.parse(cached.email_addresses || '[]'),
      phoneNumbers: JSON.parse(cached.phone_numbers || '[]'),
      organizations: JSON.parse(cached.organizations || '[]'),
      photoUrl: cached.photo_url,
      notes: cached.notes,
    });
  }
}

export async function searchContactsEndpoint(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  const query = url.searchParams.get('q');

  if (!dashboardId || !query) {
    return Response.json({ error: 'E79964: dashboard_id and q are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79965: Not found or no access' }, { status: 404 });
  }

  try {
    const accessToken = await getContactsAccessToken(env, auth.user!.id);
    const result = await searchGoogleContacts(accessToken, query, 30);

    const contacts = result.results.map(c => ({
      resourceName: c.resourceName,
      displayName: c.names?.[0]?.displayName,
      givenName: c.names?.[0]?.givenName,
      familyName: c.names?.[0]?.familyName,
      emailAddresses: c.emailAddresses || [],
      phoneNumbers: c.phoneNumbers || [],
      organizations: c.organizations || [],
      photoUrl: c.photos?.[0]?.url,
    }));

    return Response.json({ contacts });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Search failed';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export async function disconnectContacts(
  _request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  // Delete all user's contacts mirrors and contacts
  const mirrors = await env.DB.prepare(`
    SELECT dashboard_id FROM contacts_mirrors WHERE user_id = ?
  `).bind(auth.user!.id).all<{ dashboard_id: string }>();

  for (const mirror of mirrors.results || []) {
    await env.DB.prepare(`DELETE FROM contacts WHERE dashboard_id = ?`).bind(mirror.dashboard_id).run();
  }
  await env.DB.prepare(`DELETE FROM contacts_mirrors WHERE user_id = ?`).bind(auth.user!.id).run();

  // Delete integration
  await env.DB.prepare(`DELETE FROM user_integrations WHERE user_id = ? AND provider = 'google_contacts'`).bind(auth.user!.id).run();

  return Response.json({ ok: true });
}

// ============================================
// Google Sheets integration
// ============================================

interface GoogleSpreadsheet {
  spreadsheetId: string;
  properties: {
    title: string;
  };
  sheets?: Array<{
    properties: {
      sheetId: number;
      title: string;
      index: number;
    };
  }>;
}

interface SheetValues {
  range: string;
  majorDimension: string;
  values: string[][];
}

async function refreshSheetsAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth is not configured.');
  }

  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'google_sheets'
  `).bind(userId).first<{ access_token: string; refresh_token: string | null }>();

  if (!record?.refresh_token) {
    throw new Error('Sheets must be connected again.');
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
    throw new Error('Failed to refresh Sheets access token.');
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
    WHERE user_id = ? AND provider = 'google_sheets'
  `).bind(
    tokenData.access_token,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    userId
  ).run();

  return tokenData.access_token;
}

async function getSheetsAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
  const record = await env.DB.prepare(`
    SELECT access_token, expires_at FROM user_integrations
    WHERE user_id = ? AND provider = 'google_sheets'
  `).bind(userId).first<{ access_token: string; expires_at: string | null }>();

  if (!record) {
    throw new Error('Sheets not connected.');
  }

  if (record.expires_at) {
    const expiresAt = new Date(record.expires_at).getTime();
    const now = Date.now();
    if (expiresAt - now < 5 * 60 * 1000) {
      return refreshSheetsAccessToken(env, userId);
    }
  }

  return record.access_token;
}

async function getSheetsProfile(accessToken: string): Promise<{ email: string; name?: string }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error('Failed to fetch sheets profile.');
  }

  const data = await res.json() as { email: string; name?: string };
  return { email: data.email, name: data.name };
}

async function listSpreadsheets(
  accessToken: string,
  pageSize: number = 20,
  pageToken?: string
): Promise<{
  files: Array<{ id: string; name: string; modifiedTime?: string }>;
  nextPageToken?: string;
}> {
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('q', "mimeType='application/vnd.google-apps.spreadsheet'");
  url.searchParams.set('fields', 'nextPageToken,files(id,name,modifiedTime)');
  url.searchParams.set('orderBy', 'modifiedTime desc');

  if (pageToken) {
    url.searchParams.set('pageToken', pageToken);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error('Failed to list spreadsheets.');
  }

  return res.json() as Promise<{
    files: Array<{ id: string; name: string; modifiedTime?: string }>;
    nextPageToken?: string;
  }>;
}

async function getSpreadsheet(
  accessToken: string,
  spreadsheetId: string
): Promise<GoogleSpreadsheet> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,properties.title,sheets.properties`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error('Failed to fetch spreadsheet.');
  }

  return res.json() as Promise<GoogleSpreadsheet>;
}

async function getSheetValues(
  accessToken: string,
  spreadsheetId: string,
  range: string
): Promise<SheetValues> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error('Failed to read sheet values.');
  }

  return res.json() as Promise<SheetValues>;
}

async function updateSheetValues(
  accessToken: string,
  spreadsheetId: string,
  range: string,
  values: string[][]
): Promise<{ updatedCells: number; updatedRows: number; updatedColumns: number }> {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  url.searchParams.set('valueInputOption', 'USER_ENTERED');

  const res = await fetch(url.toString(), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ range, values }),
  });

  if (!res.ok) {
    throw new Error('Failed to update sheet values.');
  }

  return res.json() as Promise<{ updatedCells: number; updatedRows: number; updatedColumns: number }>;
}

async function appendSheetValues(
  accessToken: string,
  spreadsheetId: string,
  range: string,
  values: string[][]
): Promise<{ updates: { updatedCells: number; updatedRows: number } }> {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append`);
  url.searchParams.set('valueInputOption', 'USER_ENTERED');
  url.searchParams.set('insertDataOption', 'INSERT_ROWS');

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ range, values }),
  });

  if (!res.ok) {
    throw new Error('Failed to append sheet values.');
  }

  return res.json() as Promise<{ updates: { updatedCells: number; updatedRows: number } }>;
}

export async function connectSheets(
  request: Request,
  env: EnvWithDriveCache,
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
  await createState(env, auth.user!.id, 'google_sheets', state, {
    dashboard_id: dashboardId,
    popup: mode === 'popup',
  });

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/sheets/callback`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SHEETS_SCOPE.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

export async function callbackSheets(
  request: Request,
  env: EnvWithDriveCache
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

  const stateData = await consumeState(env, state, 'google_sheets');
  if (!stateData) {
    return renderErrorPage('Invalid or expired state.');
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === 'string'
    ? stateData.metadata.dashboard_id
    : null;
  const popup = stateData.metadata.popup === true;

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/sheets/callback`;

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

  let emailAddress = '';
  try {
    const profile = await getSheetsProfile(tokenData.access_token);
    emailAddress = profile.email;
  } catch {
    // Email will be empty if profile fetch fails
  }

  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    email_address: emailAddress,
  });

  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'google_sheets', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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

  const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
  if (popup) {
    return renderProviderAuthCompletePage(frontendUrl, 'Sheets', 'sheets-auth-complete', dashboardId);
  }

  return renderSuccessPage('Google Sheets');
}

export async function getSheetsIntegration(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  const integration = await env.DB.prepare(`
    SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'google_sheets'
  `).bind(auth.user!.id).first<{ metadata: string }>();

  if (!integration) {
    return Response.json({ connected: false, linked: false, emailAddress: null });
  }

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(integration.metadata || '{}') as Record<string, unknown>;
  } catch {
    metadata = {};
  }

  if (!dashboardId) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null,
    });
  }

  const mirror = await env.DB.prepare(`
    SELECT email_address, spreadsheet_id, spreadsheet_name, status, last_accessed_at
    FROM sheets_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{
    email_address: string;
    spreadsheet_id: string | null;
    spreadsheet_name: string | null;
    status: string;
    last_accessed_at: string | null;
  }>();

  if (!mirror) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null,
    });
  }

  return Response.json({
    connected: true,
    linked: true,
    emailAddress: mirror.email_address,
    spreadsheetId: mirror.spreadsheet_id,
    spreadsheetName: mirror.spreadsheet_name,
    status: mirror.status,
    lastAccessedAt: mirror.last_accessed_at,
  });
}

export async function setupSheetsMirror(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as {
    dashboardId?: string;
    spreadsheetId?: string;
  };

  if (!data.dashboardId) {
    return Response.json({ error: 'E79970: dashboardId is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79971: Not found or no access' }, { status: 404 });
  }

  let accessToken: string;
  try {
    accessToken = await getSheetsAccessToken(env, auth.user!.id);
  } catch {
    return Response.json({ error: 'E79972: Sheets not connected' }, { status: 404 });
  }

  const profile = await getSheetsProfile(accessToken);

  let spreadsheetName: string | null = null;
  if (data.spreadsheetId) {
    try {
      const spreadsheet = await getSpreadsheet(accessToken, data.spreadsheetId);
      spreadsheetName = spreadsheet.properties.title;
    } catch {
      // Ignore error, name will be null
    }
  }

  await env.DB.prepare(`
    INSERT INTO sheets_mirrors (
      dashboard_id, user_id, email_address, spreadsheet_id, spreadsheet_name, status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'linked', datetime('now'), datetime('now'))
    ON CONFLICT(dashboard_id) DO UPDATE SET
      email_address = excluded.email_address,
      spreadsheet_id = excluded.spreadsheet_id,
      spreadsheet_name = excluded.spreadsheet_name,
      status = 'linked',
      updated_at = datetime('now')
  `).bind(
    data.dashboardId,
    auth.user!.id,
    profile.email,
    data.spreadsheetId || null,
    spreadsheetName
  ).run();

  return Response.json({ ok: true, emailAddress: profile.email });
}

export async function unlinkSheetsMirror(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  if (!dashboardId) {
    return Response.json({ error: 'E79973: dashboard_id is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79974: Not found or no access' }, { status: 404 });
  }

  await env.DB.prepare(`DELETE FROM sheets_mirrors WHERE dashboard_id = ?`).bind(dashboardId).run();

  return Response.json({ ok: true });
}

export async function listSpreadsheetsEndpoint(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const pageSize = parseInt(url.searchParams.get('page_size') || '20', 10);
  const pageToken = url.searchParams.get('page_token') || undefined;

  try {
    const accessToken = await getSheetsAccessToken(env, auth.user!.id);
    const result = await listSpreadsheets(accessToken, pageSize, pageToken);

    return Response.json({
      spreadsheets: result.files.map(f => ({
        id: f.id,
        name: f.name,
        modifiedTime: f.modifiedTime,
      })),
      nextPageToken: result.nextPageToken,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to list spreadsheets';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export async function getSpreadsheetEndpoint(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  const spreadsheetId = url.searchParams.get('spreadsheet_id');

  if (!dashboardId) {
    return Response.json({ error: 'E79975: dashboard_id is required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79976: Not found or no access' }, { status: 404 });
  }

  let sheetId = spreadsheetId;
  if (!sheetId) {
    const mirror = await env.DB.prepare(`
      SELECT spreadsheet_id FROM sheets_mirrors WHERE dashboard_id = ?
    `).bind(dashboardId).first<{ spreadsheet_id: string | null }>();
    sheetId = mirror?.spreadsheet_id || null;
  }

  if (!sheetId) {
    return Response.json({ error: 'E79977: No spreadsheet linked' }, { status: 400 });
  }

  try {
    const accessToken = await getSheetsAccessToken(env, auth.user!.id);
    const spreadsheet = await getSpreadsheet(accessToken, sheetId);

    await env.DB.prepare(`
      UPDATE sheets_mirrors SET last_accessed_at = datetime('now') WHERE dashboard_id = ?
    `).bind(dashboardId).run();

    return Response.json({
      spreadsheetId: spreadsheet.spreadsheetId,
      title: spreadsheet.properties.title,
      sheets: (spreadsheet.sheets || []).map(s => ({
        sheetId: s.properties.sheetId,
        title: s.properties.title,
        index: s.properties.index,
      })),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to fetch spreadsheet';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export async function readSheetValues(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  const spreadsheetId = url.searchParams.get('spreadsheet_id');
  const range = url.searchParams.get('range');

  if (!dashboardId || !range) {
    return Response.json({ error: 'E79978: dashboard_id and range are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79979: Not found or no access' }, { status: 404 });
  }

  let sheetId = spreadsheetId;
  if (!sheetId) {
    const mirror = await env.DB.prepare(`
      SELECT spreadsheet_id FROM sheets_mirrors WHERE dashboard_id = ?
    `).bind(dashboardId).first<{ spreadsheet_id: string | null }>();
    sheetId = mirror?.spreadsheet_id || null;
  }

  if (!sheetId) {
    return Response.json({ error: 'E79980: No spreadsheet linked' }, { status: 400 });
  }

  try {
    const accessToken = await getSheetsAccessToken(env, auth.user!.id);
    const result = await getSheetValues(accessToken, sheetId, range);

    return Response.json({
      range: result.range,
      values: result.values || [],
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to read values';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export async function writeSheetValues(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as {
    dashboardId?: string;
    spreadsheetId?: string;
    range?: string;
    values?: string[][];
  };

  if (!data.dashboardId || !data.range || !data.values) {
    return Response.json({ error: 'E79981: dashboardId, range, and values are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79982: Not found or no access' }, { status: 404 });
  }

  let sheetId = data.spreadsheetId;
  if (!sheetId) {
    const mirror = await env.DB.prepare(`
      SELECT spreadsheet_id FROM sheets_mirrors WHERE dashboard_id = ?
    `).bind(data.dashboardId).first<{ spreadsheet_id: string | null }>();
    sheetId = mirror?.spreadsheet_id || null;
  }

  if (!sheetId) {
    return Response.json({ error: 'E79983: No spreadsheet linked' }, { status: 400 });
  }

  try {
    const accessToken = await getSheetsAccessToken(env, auth.user!.id);
    const result = await updateSheetValues(accessToken, sheetId, data.range, data.values);

    return Response.json({
      ok: true,
      updatedCells: result.updatedCells,
      updatedRows: result.updatedRows,
      updatedColumns: result.updatedColumns,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to write values';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export async function appendSheetValuesEndpoint(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as {
    dashboardId?: string;
    spreadsheetId?: string;
    range?: string;
    values?: string[][];
  };

  if (!data.dashboardId || !data.range || !data.values) {
    return Response.json({ error: 'E79984: dashboardId, range, and values are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79985: Not found or no access' }, { status: 404 });
  }

  let sheetId = data.spreadsheetId;
  if (!sheetId) {
    const mirror = await env.DB.prepare(`
      SELECT spreadsheet_id FROM sheets_mirrors WHERE dashboard_id = ?
    `).bind(data.dashboardId).first<{ spreadsheet_id: string | null }>();
    sheetId = mirror?.spreadsheet_id || null;
  }

  if (!sheetId) {
    return Response.json({ error: 'E79986: No spreadsheet linked' }, { status: 400 });
  }

  try {
    const accessToken = await getSheetsAccessToken(env, auth.user!.id);
    const result = await appendSheetValues(accessToken, sheetId, data.range, data.values);

    return Response.json({
      ok: true,
      updatedCells: result.updates.updatedCells,
      updatedRows: result.updates.updatedRows,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to append values';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export async function setLinkedSpreadsheet(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const data = await request.json() as {
    dashboardId?: string;
    spreadsheetId?: string;
  };

  if (!data.dashboardId || !data.spreadsheetId) {
    return Response.json({ error: 'E79987: dashboardId and spreadsheetId are required' }, { status: 400 });
  }

  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user!.id).first<{ role: string }>();

  if (!access) {
    return Response.json({ error: 'E79988: Not found or no access' }, { status: 404 });
  }

  let accessToken: string;
  try {
    accessToken = await getSheetsAccessToken(env, auth.user!.id);
  } catch {
    return Response.json({ error: 'E79989: Sheets not connected' }, { status: 404 });
  }

  let spreadsheetName: string;
  try {
    const spreadsheet = await getSpreadsheet(accessToken, data.spreadsheetId);
    spreadsheetName = spreadsheet.properties.title;
  } catch {
    return Response.json({ error: 'E79990: Spreadsheet not found or not accessible' }, { status: 404 });
  }

  await env.DB.prepare(`
    UPDATE sheets_mirrors
    SET spreadsheet_id = ?, spreadsheet_name = ?, status = 'linked', updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(data.spreadsheetId, spreadsheetName, data.dashboardId).run();

  return Response.json({ ok: true, spreadsheetName });
}

export async function disconnectSheets(
  _request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  await env.DB.prepare(`DELETE FROM sheets_mirrors WHERE user_id = ?`).bind(auth.user!.id).run();
  await env.DB.prepare(`DELETE FROM user_integrations WHERE user_id = ? AND provider = 'google_sheets'`).bind(auth.user!.id).run();

  return Response.json({ ok: true });
}

// ===========================================
// Google Forms Integration
// ===========================================

async function refreshFormsAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth is not configured.');
  }

  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'google_forms'
  `).bind(userId).first<{ access_token: string; refresh_token: string | null }>();

  if (!record?.refresh_token) {
    throw new Error('Forms must be connected again.');
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
    throw new Error('Failed to refresh Forms access token.');
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
    SET access_token = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'google_forms'
  `).bind(tokenData.access_token, expiresAt, userId).run();

  return tokenData.access_token;
}

async function getFormsAccessToken(env: EnvWithDriveCache, userId: string): Promise<string> {
  const record = await env.DB.prepare(`
    SELECT access_token, expires_at FROM user_integrations
    WHERE user_id = ? AND provider = 'google_forms'
  `).bind(userId).first<{ access_token: string; expires_at: string | null }>();

  if (!record) {
    throw new Error('Forms not connected.');
  }

  if (record.expires_at) {
    const expiresAt = new Date(record.expires_at).getTime();
    const now = Date.now();
    if (expiresAt - now < 5 * 60 * 1000) {
      return refreshFormsAccessToken(env, userId);
    }
  }

  return record.access_token;
}

export async function connectForms(
  request: Request,
  env: EnvWithDriveCache,
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
  await createState(env, auth.user!.id, 'google_forms', state, {
    dashboard_id: dashboardId,
    popup: mode === 'popup',
  });

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/forms/callback`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', FORMS_SCOPE.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

export async function callbackForms(
  request: Request,
  env: EnvWithDriveCache
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

  const stateData = await consumeState(env, state, 'google_forms');
  if (!stateData) {
    return renderErrorPage('Invalid or expired state.');
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === 'string'
    ? stateData.metadata.dashboard_id
    : null;
  const popup = stateData.metadata.popup === true;

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/forms/callback`;

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

  let emailAddress = '';
  try {
    const userInfoRes = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );
    if (userInfoRes.ok) {
      const userInfo = await userInfoRes.json() as { email?: string };
      emailAddress = userInfo.email || '';
    }
  } catch {
    // Email will be empty if profile fetch fails
  }

  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    email_address: emailAddress,
  });

  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'google_forms', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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

  const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
  if (popup) {
    return renderProviderAuthCompletePage(frontendUrl, 'Forms', 'forms-auth-complete', dashboardId);
  }

  return renderSuccessPage('Google Forms');
}

export async function getFormsIntegration(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  const integration = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM user_integrations WHERE user_id = ? AND provider = 'google_forms'`
  ).bind(auth.user!.id).first<{ access_token: string; refresh_token: string | null; expires_at: string | null }>();

  if (!integration) {
    return Response.json({ connected: false, linked: false, emailAddress: null });
  }

  let emailAddress: string | null = null;
  try {
    const accessToken = await getFormsAccessToken(env, auth.user!.id);
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (userInfoRes.ok) {
      const userInfo = await userInfoRes.json() as { email?: string };
      emailAddress = userInfo.email || null;
    }
  } catch {
    // ignore
  }

  if (!dashboardId) {
    return Response.json({ connected: true, linked: false, emailAddress });
  }

  const mirror = await env.DB.prepare(
    `SELECT form_id, form_title, status FROM forms_mirrors WHERE dashboard_id = ? AND user_id = ?`
  ).bind(dashboardId, auth.user!.id).first<{ form_id: string | null; form_title: string | null; status: string }>();

  if (!mirror) {
    return Response.json({ connected: true, linked: false, emailAddress });
  }

  return Response.json({
    connected: true,
    linked: true,
    emailAddress,
    formId: mirror.form_id,
    formTitle: mirror.form_title,
    status: mirror.status,
  });
}

export async function setupFormsMirror(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const body = await request.json() as { dashboardId: string };
  const { dashboardId } = body;

  if (!dashboardId) {
    return Response.json({ error: 'dashboardId is required' }, { status: 400 });
  }

  const integration = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM user_integrations WHERE user_id = ? AND provider = 'google_forms'`
  ).bind(auth.user!.id).first<{ access_token: string; refresh_token: string | null; expires_at: string | null }>();

  if (!integration) {
    return Response.json({ error: 'Google Forms not connected' }, { status: 400 });
  }

  let emailAddress = '';
  try {
    const accessToken = await getFormsAccessToken(env, auth.user!.id);
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (userInfoRes.ok) {
      const userInfo = await userInfoRes.json() as { email?: string };
      emailAddress = userInfo.email || '';
    }
  } catch {
    // ignore
  }

  const existing = await env.DB.prepare(
    `SELECT dashboard_id FROM forms_mirrors WHERE dashboard_id = ?`
  ).bind(dashboardId).first();

  if (existing) {
    await env.DB.prepare(
      `UPDATE forms_mirrors SET user_id = ?, email_address = ?, status = 'idle', updated_at = datetime('now') WHERE dashboard_id = ?`
    ).bind(auth.user!.id, emailAddress, dashboardId).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO forms_mirrors (dashboard_id, user_id, email_address, status) VALUES (?, ?, ?, 'idle')`
    ).bind(dashboardId, auth.user!.id, emailAddress).run();
  }

  return Response.json({ ok: true, emailAddress });
}

export async function unlinkFormsMirror(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  if (!dashboardId) {
    return Response.json({ error: 'dashboard_id is required' }, { status: 400 });
  }

  await env.DB.prepare(
    `DELETE FROM form_responses WHERE dashboard_id = ? AND user_id = ?`
  ).bind(dashboardId, auth.user!.id).run();

  await env.DB.prepare(
    `DELETE FROM forms_mirrors WHERE dashboard_id = ? AND user_id = ?`
  ).bind(dashboardId, auth.user!.id).run();

  return Response.json({ ok: true });
}

export async function listFormsEndpoint(
  _request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const integration = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM user_integrations WHERE user_id = ? AND provider = 'google_forms'`
  ).bind(auth.user!.id).first<{ access_token: string; refresh_token: string | null; expires_at: string | null }>();

  if (!integration) {
    return Response.json({ connected: false, forms: [] });
  }

  const accessToken = await getFormsAccessToken(env, auth.user!.id);

  // List forms from Google Drive (forms are stored as drive files)
  const driveRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.form'&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!driveRes.ok) {
    const errorText = await driveRes.text();
    return Response.json({ error: `Failed to list forms: ${errorText}` }, { status: 500 });
  }

  const driveData = await driveRes.json() as { files: Array<{ id: string; name: string }> };

  return Response.json({
    connected: true,
    forms: driveData.files.map(f => ({ id: f.id, name: f.name })),
  });
}

export async function getFormEndpoint(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const formId = url.searchParams.get('form_id');

  if (!formId) {
    return Response.json({ error: 'form_id is required' }, { status: 400 });
  }

  const integration = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM user_integrations WHERE user_id = ? AND provider = 'google_forms'`
  ).bind(auth.user!.id).first<{ access_token: string; refresh_token: string | null; expires_at: string | null }>();

  if (!integration) {
    return Response.json({ error: 'Google Forms not connected' }, { status: 400 });
  }

  const accessToken = await getFormsAccessToken(env, auth.user!.id);

  const formRes = await fetch(
    `https://forms.googleapis.com/v1/forms/${formId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!formRes.ok) {
    const errorText = await formRes.text();
    return Response.json({ error: `Failed to get form: ${errorText}` }, { status: 500 });
  }

  const formData = await formRes.json() as {
    formId: string;
    info: { title: string; description?: string; documentTitle?: string };
    items?: Array<{
      itemId: string;
      title?: string;
      description?: string;
      questionItem?: {
        question: {
          questionId: string;
          required?: boolean;
          choiceQuestion?: { type: string; options: Array<{ value: string }> };
          textQuestion?: { paragraph: boolean };
          scaleQuestion?: { low: number; high: number };
          dateQuestion?: { includeTime: boolean; includeYear: boolean };
          timeQuestion?: { duration: boolean };
        };
      };
    }>;
    responderUri?: string;
  };

  return Response.json({
    formId: formData.formId,
    title: formData.info.title,
    description: formData.info.description,
    documentTitle: formData.info.documentTitle,
    responderUri: formData.responderUri,
    items: formData.items?.map(item => ({
      itemId: item.itemId,
      title: item.title,
      description: item.description,
      question: item.questionItem?.question,
    })) || [],
  });
}

export async function getFormResponsesEndpoint(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const formId = url.searchParams.get('form_id');
  const dashboardId = url.searchParams.get('dashboard_id');

  if (!formId || !dashboardId) {
    return Response.json({ error: 'form_id and dashboard_id are required' }, { status: 400 });
  }

  const integration = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM user_integrations WHERE user_id = ? AND provider = 'google_forms'`
  ).bind(auth.user!.id).first<{ access_token: string; refresh_token: string | null; expires_at: string | null }>();

  if (!integration) {
    return Response.json({ error: 'Google Forms not connected' }, { status: 400 });
  }

  const accessToken = await getFormsAccessToken(env, auth.user!.id);

  const responsesRes = await fetch(
    `https://forms.googleapis.com/v1/forms/${formId}/responses`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!responsesRes.ok) {
    const errorText = await responsesRes.text();
    return Response.json({ error: `Failed to get responses: ${errorText}` }, { status: 500 });
  }

  const responsesData = await responsesRes.json() as {
    responses?: Array<{
      responseId: string;
      createTime: string;
      lastSubmittedTime: string;
      respondentEmail?: string;
      answers?: Record<string, { questionId: string; textAnswers?: { answers: Array<{ value: string }> } }>;
    }>;
  };

  const responses = responsesData.responses || [];

  // Cache responses in database
  for (const response of responses) {
    const existing = await env.DB.prepare(
      `SELECT id FROM form_responses WHERE dashboard_id = ? AND response_id = ?`
    ).bind(dashboardId, response.responseId).first();

    if (existing) {
      await env.DB.prepare(
        `UPDATE form_responses SET respondent_email = ?, submitted_at = ?, answers = ?, updated_at = datetime('now') WHERE dashboard_id = ? AND response_id = ?`
      ).bind(response.respondentEmail || null, response.lastSubmittedTime, JSON.stringify(response.answers || {}), dashboardId, response.responseId).run();
    } else {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO form_responses (id, user_id, dashboard_id, form_id, response_id, respondent_email, submitted_at, answers) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, auth.user!.id, dashboardId, formId, response.responseId, response.respondentEmail || null, response.lastSubmittedTime, JSON.stringify(response.answers || {})).run();
    }
  }

  return Response.json({
    total: responses.length,
    responses: responses.map(r => ({
      responseId: r.responseId,
      respondentEmail: r.respondentEmail,
      submittedAt: r.lastSubmittedTime,
      answers: r.answers,
    })),
  });
}

export async function setLinkedForm(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const body = await request.json() as { dashboardId: string; formId: string; formTitle: string };
  const { dashboardId, formId, formTitle } = body;

  if (!dashboardId || !formId || !formTitle) {
    return Response.json({ error: 'dashboardId, formId, and formTitle are required' }, { status: 400 });
  }

  const existing = await env.DB.prepare(
    `SELECT dashboard_id FROM forms_mirrors WHERE dashboard_id = ?`
  ).bind(dashboardId).first();

  if (existing) {
    await env.DB.prepare(
      `UPDATE forms_mirrors SET form_id = ?, form_title = ?, status = 'linked', last_accessed_at = datetime('now'), updated_at = datetime('now') WHERE dashboard_id = ?`
    ).bind(formId, formTitle, dashboardId).run();
  } else {
    return Response.json({ error: 'Forms mirror not set up for this dashboard' }, { status: 400 });
  }

  return Response.json({ ok: true });
}

export async function disconnectForms(
  _request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  await env.DB.prepare(`DELETE FROM form_responses WHERE user_id = ?`).bind(auth.user!.id).run();
  await env.DB.prepare(`DELETE FROM forms_mirrors WHERE user_id = ?`).bind(auth.user!.id).run();
  await env.DB.prepare(`DELETE FROM user_integrations WHERE user_id = ? AND provider = 'google_forms'`).bind(auth.user!.id).run();

  return Response.json({ ok: true });
}

// ============================================
// Slack OAuth
// ============================================

export async function connectSlack(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    return renderErrorPage('Slack OAuth is not configured.');
  }

  const requestUrl = new URL(request.url);
  const dashboardId = requestUrl.searchParams.get('dashboard_id');
  const mode = requestUrl.searchParams.get('mode');
  const state = buildState();
  await createState(env, auth.user!.id, 'slack', state, {
    dashboard_id: dashboardId,
    popup: mode === 'popup',
  });

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/slack/callback`;

  const authUrl = new URL('https://slack.com/oauth/v2/authorize');
  authUrl.searchParams.set('client_id', env.SLACK_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', SLACK_SCOPE.join(','));
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

export async function callbackSlack(
  request: Request,
  env: EnvWithDriveCache
): Promise<Response> {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    return renderErrorPage('Slack OAuth is not configured.');
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return renderErrorPage('Missing authorization code.');
  }

  const stateData = await consumeState(env, state, 'slack');
  if (!stateData) {
    return renderErrorPage('Invalid or expired state.');
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === 'string'
    ? stateData.metadata.dashboard_id
    : null;
  const popup = stateData.metadata.popup === true;

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/slack/callback`;

  const body = new URLSearchParams();
  body.set('client_id', env.SLACK_CLIENT_ID);
  body.set('client_secret', env.SLACK_CLIENT_SECRET);
  body.set('code', code);
  body.set('redirect_uri', redirectUri);

  const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!tokenResponse.ok) {
    return renderErrorPage('Failed to exchange Slack token.');
  }

  const tokenData = await tokenResponse.json() as {
    ok: boolean;
    error?: string;
    access_token?: string;
    token_type?: string;
    scope?: string;
    bot_user_id?: string;
    team?: { id: string; name: string };
    authed_user?: { id: string; scope?: string; access_token?: string; token_type?: string };
    app_id?: string;
  };

  if (!tokenData.ok || !tokenData.access_token) {
    return renderErrorPage(`Slack authorization failed: ${tokenData.error || 'unknown error'}`);
  }

  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    team_id: tokenData.team?.id,
    team_name: tokenData.team?.name,
    bot_user_id: tokenData.bot_user_id,
    authed_user_id: tokenData.authed_user?.id,
    app_id: tokenData.app_id,
  });

  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'slack', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
      scope = excluded.scope,
      token_type = excluded.token_type,
      expires_at = excluded.expires_at,
      metadata = excluded.metadata,
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(),
    stateData.userId,
    tokenData.access_token,
    null, // Slack bot tokens do not use refresh tokens
    tokenData.scope || null,
    tokenData.token_type || null,
    null, // Slack bot tokens do not expire
    metadata
  ).run();

  const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
  if (popup) {
    return renderProviderAuthCompletePage(frontendUrl, 'Slack', 'slack-auth-complete', dashboardId);
  }

  return renderSuccessPage('Slack');
}

/**
 * Get Slack integration status for a user/dashboard.
 * GET /integrations/slack?dashboard_id=...
 */
export async function getSlackIntegration(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const integration = await env.DB.prepare(`
    SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'slack'
  `).bind(auth.user!.id).first<{ metadata: string }>();

  if (!integration) {
    return Response.json({ connected: false, teamName: null, teamId: null, channels: [] });
  }

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(integration.metadata || '{}');
  } catch {
    // Ignore parse errors
  }

  return Response.json({
    connected: true,
    teamName: meta.team_name || null,
    teamId: meta.team_id || null,
    botUserId: meta.bot_user_id || null,
    channels: [], // Channel list populated by MCP tool calls, not here
  });
}

/**
 * Get Slack activity status for a dashboard.
 * GET /integrations/slack/status?dashboard_id=...
 */
export async function getSlackStatus(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'dashboard_id is required' }, { status: 400 });
  }

  // Verify dashboard membership — any authenticated user could otherwise query any dashboard
  const membership = await env.DB.prepare(
    'SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?'
  ).bind(dashboardId, auth.user!.id).first();
  if (!membership) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  // Count active subscriptions and get last activity
  const stats = await env.DB.prepare(`
    SELECT COUNT(*) as sub_count, MAX(last_message_at) as last_activity
    FROM messaging_subscriptions
    WHERE dashboard_id = ? AND provider = 'slack' AND status = 'active'
  `).bind(dashboardId).first<{ sub_count: number; last_activity: string | null }>();

  return Response.json({
    channelCount: stats?.sub_count || 0,
    lastActivityAt: stats?.last_activity || null,
  });
}

/**
 * Disconnect Slack integration for a user.
 * DELETE /integrations/slack?dashboard_id=...
 */
export async function disconnectSlack(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  // Delete the user's Slack integration
  await env.DB.prepare(`
    DELETE FROM user_integrations WHERE user_id = ? AND provider = 'slack'
  `).bind(auth.user!.id).run();

  // Deactivate any messaging subscriptions for this user
  await env.DB.prepare(`
    UPDATE messaging_subscriptions SET status = 'paused', updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'slack'
  `).bind(auth.user!.id).run();

  return Response.json({ ok: true });
}

/**
 * List Slack channels the bot has access to.
 * GET /integrations/slack/channels?cursor=...
 *
 * Calls Slack's conversations.list API using the authenticated user's bot token.
 * No dashboard_id needed — this is user-scoped (one Slack integration per user),
 * not dashboard-scoped. Supports cursor-based pagination.
 */
export async function listSlackChannels(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor') || undefined;

  // Retrieve the user's Slack bot token
  const integration = await env.DB.prepare(`
    SELECT access_token FROM user_integrations WHERE user_id = ? AND provider = 'slack'
  `).bind(auth.user!.id).first<{ access_token: string }>();

  if (!integration?.access_token) {
    return Response.json({ error: 'Slack not connected' }, { status: 404 });
  }

  // Call Slack conversations.list with the bot token
  const params = new URLSearchParams({
    types: 'public_channel,private_channel',
    exclude_archived: 'true',
    limit: '200',
  });
  if (cursor) {
    params.set('cursor', cursor);
  }

  const resp = await fetch(`https://slack.com/api/conversations.list?${params}`, {
    headers: { Authorization: `Bearer ${integration.access_token}` },
  });

  if (!resp.ok) {
    console.error(`[integrations] Slack conversations.list failed: ${resp.status}`);
    return Response.json({ error: 'Failed to fetch channels from Slack' }, { status: 502 });
  }

  const body = await resp.json() as {
    ok: boolean;
    error?: string;
    channels?: Array<{
      id: string;
      name: string;
      is_private: boolean;
      num_members?: number;
      topic?: { value: string };
      purpose?: { value: string };
    }>;
    response_metadata?: { next_cursor?: string };
  };

  if (!body.ok) {
    console.error(`[integrations] Slack API error: ${body.error}`);
    return Response.json({ error: body.error || 'Slack API error' }, { status: 502 });
  }

  const channels = (body.channels || []).map(ch => ({
    id: ch.id,
    name: ch.name,
    is_private: ch.is_private,
    num_members: ch.num_members,
    topic: ch.topic?.value || null,
    purpose: ch.purpose?.value || null,
  }));

  // Slack returns empty string for next_cursor when there are no more pages
  const nextCursor = body.response_metadata?.next_cursor || null;

  return Response.json({ channels, next_cursor: nextCursor });
}

// ============================================
// Discord OAuth
// ============================================

// Bot permissions: VIEW_CHANNEL (1024) + SEND_MESSAGES (2048) + READ_MESSAGE_HISTORY (65536) + ADD_REACTIONS (64)
const DISCORD_BOT_PERMISSIONS = (1024 + 2048 + 65536 + 64).toString();

export async function connectDiscord(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return renderErrorPage('Discord OAuth is not configured.');
  }

  const requestUrl = new URL(request.url);
  const dashboardId = requestUrl.searchParams.get('dashboard_id');
  const mode = requestUrl.searchParams.get('mode');
  const state = buildState();
  await createState(env, auth.user!.id, 'discord', state, {
    dashboard_id: dashboardId,
    popup: mode === 'popup',
  });

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/discord/callback`;

  const authUrl = new URL('https://discord.com/oauth2/authorize');
  authUrl.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'bot identify guilds');
  authUrl.searchParams.set('permissions', DISCORD_BOT_PERMISSIONS);
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

export async function callbackDiscord(
  request: Request,
  env: EnvWithDriveCache
): Promise<Response> {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return renderErrorPage('Discord OAuth is not configured.');
  }
  if (!env.DISCORD_BOT_TOKEN) {
    return renderErrorPage('Discord bot token is not configured.');
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const guildId = url.searchParams.get('guild_id');
  if (!code || !state) {
    return renderErrorPage('Missing authorization code.');
  }

  const stateData = await consumeState(env, state, 'discord');
  if (!stateData) {
    return renderErrorPage('Invalid or expired state.');
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === 'string'
    ? stateData.metadata.dashboard_id
    : null;
  const popup = stateData.metadata.popup === true;

  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/discord/callback`;

  // Exchange code for token
  const body = new URLSearchParams();
  body.set('client_id', env.DISCORD_CLIENT_ID);
  body.set('client_secret', env.DISCORD_CLIENT_SECRET);
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', redirectUri);

  const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text().catch(() => '');
    console.error(`[integrations] Discord token exchange failed: ${tokenResponse.status} ${errText}`);
    return renderErrorPage('Failed to exchange Discord token.');
  }

  const tokenData = await tokenResponse.json() as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    guild?: { id: string; name: string; icon?: string | null };
  };

  if (!tokenData.access_token) {
    return renderErrorPage('Discord authorization failed: no access token.');
  }

  // Use the guild from token response, or from query param
  const resolvedGuildId = tokenData.guild?.id || guildId;
  const resolvedGuildName = tokenData.guild?.name || null;

  // Fetch user info using the user OAuth token
  let discordUser: { id: string; username: string; discriminator?: string; avatar?: string | null } | null = null;
  try {
    const userResp = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (userResp.ok) {
      discordUser = await userResp.json() as typeof discordUser;
    }
  } catch {
    // Non-critical — continue without user info
  }

  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    guild_id: resolvedGuildId,
    guild_name: resolvedGuildName,
    guild_icon: tokenData.guild?.icon || null,
    discord_user_id: discordUser?.id || null,
    discord_username: discordUser?.username || null,
  });

  // Calculate expiry for the user token (not used for API calls, but stored for reference)
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;

  // Store the BOT token as access_token (used by gateway for API calls).
  // The user token is only needed for the OAuth flow itself.
  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'discord', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
      scope = excluded.scope,
      token_type = excluded.token_type,
      expires_at = excluded.expires_at,
      metadata = excluded.metadata,
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(),
    stateData.userId,
    env.DISCORD_BOT_TOKEN, // Bot token for API calls (never expires)
    null,                  // Bot tokens don't need refresh
    tokenData.scope || null,
    'Bot',
    null,                  // Bot tokens don't expire
    metadata
  ).run();

  const frontendUrl = env.FRONTEND_URL || 'https://orcabot.com';
  if (popup) {
    return renderProviderAuthCompletePage(frontendUrl, 'Discord', 'discord-auth-complete', dashboardId);
  }

  return renderSuccessPage('Discord');
}

/**
 * Get Discord integration info for the current user.
 * GET /integrations/discord
 */
export async function getDiscordIntegration(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const integration = await env.DB.prepare(`
    SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'discord'
  `).bind(auth.user!.id).first<{ metadata: string }>();

  if (!integration) {
    return Response.json({ connected: false, guildName: null, guildId: null });
  }

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(integration.metadata || '{}');
  } catch {
    // Ignore parse errors
  }

  return Response.json({
    connected: true,
    guildName: meta.guild_name || null,
    guildId: meta.guild_id || null,
    discordUsername: meta.discord_username || null,
  });
}

/**
 * Get Discord activity status for a dashboard.
 * GET /integrations/discord/status?dashboard_id=...
 */
export async function getDiscordStatus(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  if (!dashboardId) {
    return Response.json({ error: 'dashboard_id is required' }, { status: 400 });
  }

  const membership = await env.DB.prepare(
    'SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?'
  ).bind(dashboardId, auth.user!.id).first();
  if (!membership) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const stats = await env.DB.prepare(`
    SELECT COUNT(*) as sub_count, MAX(last_message_at) as last_activity
    FROM messaging_subscriptions
    WHERE dashboard_id = ? AND provider = 'discord' AND status = 'active'
  `).bind(dashboardId).first<{ sub_count: number; last_activity: string | null }>();

  return Response.json({
    channelCount: stats?.sub_count || 0,
    lastActivityAt: stats?.last_activity || null,
  });
}

/**
 * Disconnect Discord integration for a user.
 * DELETE /integrations/discord?dashboard_id=...
 */
export async function disconnectDiscord(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  await env.DB.prepare(`
    DELETE FROM user_integrations WHERE user_id = ? AND provider = 'discord'
  `).bind(auth.user!.id).run();

  await env.DB.prepare(`
    UPDATE messaging_subscriptions SET status = 'paused', updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'discord'
  `).bind(auth.user!.id).run();

  return Response.json({ ok: true });
}

/**
 * List Discord channels the bot has access to in the user's guild.
 * GET /integrations/discord/channels
 */
export async function listDiscordChannels(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  if (!env.DISCORD_BOT_TOKEN) {
    return Response.json({ error: 'Discord bot token not configured' }, { status: 500 });
  }

  const integration = await env.DB.prepare(`
    SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'discord'
  `).bind(auth.user!.id).first<{ metadata: string }>();

  if (!integration) {
    return Response.json({ error: 'Discord not connected' }, { status: 404 });
  }

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(integration.metadata || '{}');
  } catch {
    return Response.json({ error: 'Invalid integration metadata' }, { status: 500 });
  }

  const guildId = meta.guild_id as string;
  if (!guildId) {
    return Response.json({ error: 'No guild associated with this integration' }, { status: 400 });
  }

  // Fetch channels from Discord API using bot token
  const resp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
  });

  if (!resp.ok) {
    console.error(`[integrations] Discord channels fetch failed: ${resp.status}`);
    return Response.json({ error: 'Failed to fetch channels from Discord' }, { status: 502 });
  }

  const rawChannels = await resp.json() as Array<{
    id: string;
    name: string;
    type: number;
    topic?: string | null;
    position: number;
    parent_id?: string | null;
  }>;

  // Filter to text channels (type 0) and announcement channels (type 5)
  const channels = rawChannels
    .filter(ch => ch.type === 0 || ch.type === 5)
    .sort((a, b) => a.position - b.position)
    .map(ch => ({
      id: ch.id,
      name: ch.name,
      is_private: false, // Guild channels visible to bot are not private
      topic: ch.topic || null,
    }));

  return Response.json({ channels });
}

// ============================================
// Generic Token-Based Messaging Integration Handlers
// (Telegram, WhatsApp, Teams, Matrix, Google Chat)
// ============================================

const TOKEN_CONNECT_PROVIDERS = ['telegram', 'whatsapp', 'teams', 'matrix', 'google_chat'] as const;
type TokenConnectProvider = typeof TOKEN_CONNECT_PROVIDERS[number];

/** Validation endpoints per provider — called with the token to verify it's valid */
const TOKEN_VALIDATION: Record<TokenConnectProvider, {
  validate: (token: string, metadata?: Record<string, unknown>) => Promise<{ ok: boolean; accountName: string; metadata: Record<string, unknown> }>;
}> = {
  telegram: {
    async validate(token: string) {
      const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      if (!resp.ok) throw new Error('Invalid Telegram bot token');
      const data = await resp.json() as { result: { first_name: string; username?: string; id: number } };
      return {
        ok: true,
        accountName: data.result.username ? `@${data.result.username}` : data.result.first_name,
        metadata: { bot_id: data.result.id, bot_username: data.result.username, bot_name: data.result.first_name },
      };
    },
  },
  whatsapp: {
    async validate(token: string, metadata?: Record<string, unknown>) {
      const phoneNumberId = metadata?.phone_number_id as string;
      if (!phoneNumberId) throw new Error('phone_number_id is required in metadata');
      const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error('Invalid WhatsApp Business API token');
      const data = await resp.json() as { display_phone_number?: string; verified_name?: string; id: string };
      return {
        ok: true,
        accountName: data.verified_name || data.display_phone_number || phoneNumberId,
        metadata: { phone_number_id: phoneNumberId, display_phone_number: data.display_phone_number, verified_name: data.verified_name },
      };
    },
  },
  teams: {
    async validate(token: string) {
      const resp = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error('Invalid Microsoft Graph API token');
      const data = await resp.json() as { displayName?: string; userPrincipalName?: string; id: string };
      return {
        ok: true,
        accountName: data.displayName || data.userPrincipalName || 'Teams User',
        metadata: { user_id: data.id, display_name: data.displayName, email: data.userPrincipalName },
      };
    },
  },
  matrix: {
    async validate(token: string, metadata?: Record<string, unknown>) {
      const homeserver = metadata?.homeserver as string;
      if (!homeserver) throw new Error('homeserver URL is required in metadata');
      const baseUrl = homeserver.replace(/\/$/, '');
      const resp = await fetch(`${baseUrl}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error('Invalid Matrix access token');
      const data = await resp.json() as { user_id: string; device_id?: string };
      return {
        ok: true,
        accountName: data.user_id,
        metadata: { user_id: data.user_id, device_id: data.device_id, homeserver: baseUrl },
      };
    },
  },
  google_chat: {
    async validate(token: string) {
      // Expects a pre-generated OAuth2 access token (not a service account JSON key).
      // To use a service account, exchange the JSON key for an access token first,
      // then paste the access token here.
      const resp = await fetch('https://chat.googleapis.com/v1/spaces?pageSize=1', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error('Invalid Google Chat API token — provide an OAuth2 access token, not a service account JSON key');
      return {
        ok: true,
        accountName: 'Google Chat Bot',
        metadata: {},
      };
    },
  },
};

function extractProviderFromUrl(request: Request): TokenConnectProvider | null {
  const url = new URL(request.url);
  const segments = url.pathname.replace(/^\/+/, '').split('/');
  // URL pattern: /integrations/{provider}/...
  const providerIdx = segments.indexOf('integrations');
  if (providerIdx < 0 || providerIdx + 1 >= segments.length) return null;
  const provider = segments[providerIdx + 1] as TokenConnectProvider;
  return TOKEN_CONNECT_PROVIDERS.includes(provider) ? provider : null;
}

/**
 * POST /integrations/:provider/connect-token
 * Body: { token: string, dashboardId?: string, metadata?: Record<string, unknown> }
 *
 * Validates the token against the provider's API, then upserts into user_integrations.
 */
export async function connectMessagingToken(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext,
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const provider = extractProviderFromUrl(request);
  if (!provider) {
    return Response.json({ error: 'Unknown messaging provider' }, { status: 400 });
  }

  // Token-based integrations are scoped per-user, not per-dashboard.
  // A user connects once and the token is shared across all their dashboards
  // (same model as Gmail, GitHub, Slack, Discord OAuth integrations).
  // The frontend may send dashboardId for context but it is not used for scoping.
  let body: { token: string; metadata?: Record<string, unknown> };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.token || typeof body.token !== 'string') {
    return Response.json({ error: 'token is required' }, { status: 400 });
  }

  // Validate token with the provider
  const validator = TOKEN_VALIDATION[provider];
  let result: { ok: boolean; accountName: string; metadata: Record<string, unknown> };
  try {
    result = await validator.validate(body.token.trim(), body.metadata);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Token validation failed';
    return Response.json({ error: msg }, { status: 400 });
  }

  // UPSERT into user_integrations
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO user_integrations (id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, NULL, 'Bearer', NULL, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
  `).bind(
    id,
    auth.user!.id,
    provider,
    body.token.trim(),
    JSON.stringify(result.metadata),
    now,
    now,
  ).run();

  return Response.json({
    connected: true,
    accountName: result.accountName,
    provider,
    metadata: result.metadata,
  });
}

/**
 * GET /integrations/:provider
 * Returns connection status for a token-based messaging provider.
 */
export async function getMessagingIntegration(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext,
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const provider = extractProviderFromUrl(request);
  if (!provider) {
    return Response.json({ error: 'Unknown messaging provider' }, { status: 400 });
  }

  const row = await env.DB.prepare(
    'SELECT id, metadata FROM user_integrations WHERE user_id = ? AND provider = ?'
  ).bind(auth.user!.id, provider).first<{ id: string; metadata: string }>();

  if (!row) {
    return Response.json({ connected: false, accountName: null });
  }

  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(row.metadata); } catch { /* empty */ }

  return Response.json({
    connected: true,
    accountName: meta.bot_username || meta.bot_name || meta.verified_name || meta.display_name || meta.user_id || 'Connected',
    provider,
    metadata: meta,
  });
}

/**
 * GET /integrations/:provider/chats|channels|rooms|spaces
 * Lists channels/chats/rooms/spaces for a token-based messaging provider.
 */
export async function listMessagingChannels(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext,
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const provider = extractProviderFromUrl(request);
  if (!provider) {
    return Response.json({ error: 'Unknown messaging provider' }, { status: 400 });
  }

  const row = await env.DB.prepare(
    'SELECT access_token, metadata FROM user_integrations WHERE user_id = ? AND provider = ?'
  ).bind(auth.user!.id, provider).first<{ access_token: string; metadata: string }>();

  if (!row) {
    return Response.json({ error: 'Not connected' }, { status: 404 });
  }

  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(row.metadata); } catch { /* empty */ }
  const token = row.access_token;

  try {
    switch (provider) {
      case 'telegram': {
        // Check if a webhook is active — if so, getUpdates is blocked by the Bot API.
        // Serve from D1 (subscriptions + inbound_messages) instead.
        const hasWebhook = await env.DB.prepare(`
          SELECT 1 FROM messaging_subscriptions
          WHERE user_id = ? AND provider = 'telegram' AND status IN ('pending', 'active')
          LIMIT 1
        `).bind(auth.user!.id).first();

        if (hasWebhook) {
          // Collect unique chat IDs from subscriptions + inbound messages
          const chatIdSet = new Set<string>();
          const subs = await env.DB.prepare(`
            SELECT chat_id FROM messaging_subscriptions
            WHERE user_id = ? AND provider = 'telegram' AND status IN ('pending', 'active') AND chat_id IS NOT NULL
          `).bind(auth.user!.id).all<{ chat_id: string }>();
          for (const r of subs.results || []) if (r.chat_id) chatIdSet.add(r.chat_id);

          const msgs = await env.DB.prepare(`
            SELECT DISTINCT im.channel_id FROM inbound_messages im
            JOIN messaging_subscriptions ms ON im.subscription_id = ms.id
            WHERE ms.user_id = ? AND ms.provider = 'telegram' AND im.channel_id IS NOT NULL
          `).bind(auth.user!.id).all<{ channel_id: string }>();
          for (const r of msgs.results || []) if (r.channel_id) chatIdSet.add(r.channel_id);

          // Enrich each via Telegram's getChat API (works with webhooks)
          const channels: { id: string; name: string; type: string }[] = [];
          for (const chatId of chatIdSet) {
            try {
              const chatResp = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId }),
              });
              if (chatResp.ok) {
                const chatData = await chatResp.json() as { ok: boolean; result: { id: number; type: string; title?: string; first_name?: string; username?: string } };
                if (chatData.ok) {
                  const c = chatData.result;
                  channels.push({ id: String(c.id), name: c.title || c.first_name || c.username || String(c.id), type: c.type });
                  continue;
                }
              }
            } catch { /* fall through to minimal entry */ }
            channels.push({ id: chatId, name: chatId, type: 'unknown' });
          }
          return Response.json({ channels });
        }

        // No webhook — safe to use getUpdates
        const resp = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100`);
        if (!resp.ok) return Response.json({ channels: [] });
        const data = await resp.json() as { result: Array<{ message?: { chat: { id: number; type: string; title?: string; first_name?: string; username?: string } } }> };
        const chatMap = new Map<number, { id: string; name: string; type: string }>();
        for (const update of data.result) {
          const chat = update.message?.chat;
          if (chat) {
            chatMap.set(chat.id, {
              id: String(chat.id),
              name: chat.title || chat.first_name || chat.username || String(chat.id),
              type: chat.type,
            });
          }
        }
        return Response.json({ channels: Array.from(chatMap.values()) });
      }

      case 'teams': {
        // List teams, then channels from the specified (or first) team.
        // Always returns team_id so the UI can use it for later MCP calls.
        const url = new URL(request.url);
        let teamId = url.searchParams.get('team_id');

        // Always fetch teams so we can return the full list for UI selection
        const teamsResp = await fetch('https://graph.microsoft.com/v1.0/me/joinedTeams', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!teamsResp.ok) return Response.json({ channels: [], teams: [] });
        const teamsData = await teamsResp.json() as { value: Array<{ id: string; displayName: string }> };
        const teams = teamsData.value.map(t => ({ id: t.id, name: t.displayName }));

        if (!teamId) {
          if (teams.length === 0) return Response.json({ channels: [], teams: [] });
          teamId = teams[0].id;
        }

        const resp = await fetch(`https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(teamId)}/channels`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) return Response.json({ channels: [], teams, team_id: teamId });
        const data = await resp.json() as { value: Array<{ id: string; displayName: string; description?: string }> };
        return Response.json({
          team_id: teamId,
          teams,
          channels: data.value.map(ch => ({ id: ch.id, name: ch.displayName, topic: ch.description || null, team_id: teamId })),
        });
      }

      case 'matrix': {
        const homeserver = (meta.homeserver as string || '').replace(/\/$/, '');
        if (!homeserver) return Response.json({ channels: [] });
        const resp = await fetch(`${homeserver}/_matrix/client/v3/joined_rooms`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) return Response.json({ channels: [] });
        const data = await resp.json() as { joined_rooms: string[] };
        // Fetch room names
        const rooms = await Promise.all(
          data.joined_rooms.slice(0, 50).map(async (roomId) => {
            try {
              const nameResp = await fetch(`${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (nameResp.ok) {
                const nameData = await nameResp.json() as { name: string };
                return { id: roomId, name: nameData.name || roomId };
              }
            } catch { /* fallback */ }
            return { id: roomId, name: roomId };
          })
        );
        return Response.json({ channels: rooms });
      }

      case 'google_chat': {
        const resp = await fetch('https://chat.googleapis.com/v1/spaces?pageSize=100', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) return Response.json({ channels: [] });
        const data = await resp.json() as { spaces?: Array<{ name: string; displayName: string; spaceType?: string }> };
        return Response.json({
          channels: (data.spaces || []).map(s => ({
            id: s.name,
            name: s.displayName || s.name,
            type: s.spaceType,
          })),
        });
      }

      case 'whatsapp': {
        // WhatsApp Business API has no "list conversations" endpoint.
        // Serve known chats from D1 inbound_messages + subscriptions.
        const chatSet = new Map<string, { id: string; name: string; type: string }>();

        // 1. Chats from existing subscriptions
        const waSubs = await env.DB.prepare(`
          SELECT chat_id, channel_name FROM messaging_subscriptions
          WHERE user_id = ? AND provider = 'whatsapp' AND status IN ('pending', 'active') AND chat_id IS NOT NULL
        `).bind(auth.user!.id).all<{ chat_id: string; channel_name: string | null }>();
        for (const r of waSubs.results || []) {
          if (r.chat_id) chatSet.set(r.chat_id, { id: r.chat_id, name: r.channel_name || r.chat_id, type: 'individual' });
        }

        // 2. Senders from inbound messages
        const waInbound = await env.DB.prepare(`
          SELECT DISTINCT im.sender_id, im.sender_name FROM inbound_messages im
          JOIN messaging_subscriptions ms ON im.subscription_id = ms.id
          WHERE ms.user_id = ? AND ms.provider = 'whatsapp' AND im.sender_id IS NOT NULL
        `).bind(auth.user!.id).all<{ sender_id: string; sender_name: string | null }>();
        for (const r of waInbound.results || []) {
          if (r.sender_id && !chatSet.has(r.sender_id)) {
            chatSet.set(r.sender_id, { id: r.sender_id, name: r.sender_name || r.sender_id, type: 'individual' });
          }
        }

        return Response.json({ channels: Array.from(chatSet.values()) });
      }

      default:
        return Response.json({ channels: [] });
    }
  } catch (err) {
    console.error(`[integrations] Failed to list channels for ${provider}:`, err);
    return Response.json({ channels: [] });
  }
}

/**
 * DELETE /integrations/:provider
 * Disconnects a token-based messaging provider.
 */
export async function disconnectMessaging(
  request: Request,
  env: EnvWithDriveCache,
  auth: AuthContext,
): Promise<Response> {
  const authError = requireAuth(auth);
  if (authError) return authError;

  const provider = extractProviderFromUrl(request);
  if (!provider) {
    return Response.json({ error: 'Unknown messaging provider' }, { status: 400 });
  }

  await env.DB.prepare(
    'DELETE FROM user_integrations WHERE user_id = ? AND provider = ?'
  ).bind(auth.user!.id, provider).run();

  return Response.json({ ok: true });
}
