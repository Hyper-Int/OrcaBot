// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: drive-client-v2-binary-base64
console.log(`[drive-client] REVISION: drive-client-v2-binary-base64 loaded at ${new Date().toISOString()}`);

/**
 * Google Drive API Client
 *
 * Executes Google Drive API calls with OAuth access token.
 * Token never leaves the control plane.
 */

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  webViewLink?: string;
  webContentLink?: string;
  size?: string;
  modifiedTime?: string;
  createdTime?: string;
  owners?: Array<{ displayName: string; emailAddress: string }>;
}

interface DriveFileList {
  files: DriveFile[];
  nextPageToken?: string;
}

/**
 * Execute a Google Drive action
 */
export async function executeDriveAction(
  action: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  switch (action) {
    case 'drive.list':
    case 'drive.search':
      return listFiles(args, accessToken);
    case 'drive.get':
      return getFile(args, accessToken);
    case 'drive.download':
      return downloadFile(args, accessToken);
    case 'drive.create':
      return createFile(args, accessToken);
    case 'drive.update':
      return updateFile(args, accessToken);
    case 'drive.delete':
      return deleteFile(args, accessToken);
    case 'drive.share':
      return shareFile(args, accessToken);
    default:
      throw new Error(`Unknown Drive action: ${action}`);
  }
}

async function driveFetch(
  path: string,
  accessToken: string,
  options?: RequestInit
): Promise<Response> {
  const response = await fetch(`${DRIVE_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Drive API error: ${response.status} - ${error}`);
  }

  return response;
}

async function listFiles(
  args: Record<string, unknown>,
  accessToken: string
): Promise<DriveFileList> {
  const query = args.query as string || undefined;
  const folderId = args.folderId as string || undefined;
  const pageSize = Math.min(args.pageSize as number || 100, 1000);
  const pageToken = args.pageToken as string || undefined;

  const params = new URLSearchParams({
    pageSize: pageSize.toString(),
    fields: 'files(id,name,mimeType,parents,webViewLink,webContentLink,size,modifiedTime,createdTime,owners),nextPageToken',
  });

  // Build query
  const queryParts: string[] = [];
  if (query) {
    queryParts.push(query);
  }
  if (folderId) {
    queryParts.push(`'${folderId}' in parents`);
  }
  queryParts.push('trashed = false');

  if (queryParts.length) {
    params.set('q', queryParts.join(' and '));
  }

  if (pageToken) {
    params.set('pageToken', pageToken);
  }

  const response = await driveFetch(`/files?${params}`, accessToken);
  return response.json() as Promise<DriveFileList>;
}

async function getFile(
  args: Record<string, unknown>,
  accessToken: string
): Promise<DriveFile> {
  const fileId = args.fileId as string;
  if (!fileId) {
    throw new Error('fileId is required');
  }

  const params = new URLSearchParams({
    fields: 'id,name,mimeType,parents,webViewLink,webContentLink,size,modifiedTime,createdTime,owners',
  });

  const response = await driveFetch(`/files/${fileId}?${params}`, accessToken);
  return response.json() as Promise<DriveFile>;
}

/**
 * Check if a MIME type is text-based (safe for response.text())
 */
function isTextMimeType(mimeType: string): boolean {
  const textTypes = [
    'text/',
    'application/json',
    'application/xml',
    'application/javascript',
    'application/typescript',
    'application/x-yaml',
    'application/toml',
    'application/csv',
    'application/sql',
    'application/graphql',
    'application/ld+json',
    'application/xhtml+xml',
    'application/svg+xml',
    'application/x-sh',
  ];
  const lower = mimeType.toLowerCase();
  return textTypes.some(t => lower.startsWith(t)) || lower.endsWith('+xml') || lower.endsWith('+json');
}

async function downloadFile(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ content: string; mimeType: string; encoding?: 'base64' }> {
  const fileId = args.fileId as string;
  if (!fileId) {
    throw new Error('fileId is required');
  }

  // First get file metadata to check mime type
  const file = await getFile({ fileId }, accessToken);

  // For Google Docs, Sheets, etc., use export (always text-safe)
  if (file.mimeType.startsWith('application/vnd.google-apps')) {
    const exportMimeType = getExportMimeType(file.mimeType);
    const response = await driveFetch(`/files/${fileId}/export?mimeType=${encodeURIComponent(exportMimeType)}`, accessToken);
    const content = await response.text();
    return { content, mimeType: exportMimeType };
  }

  // For regular files, download directly
  const response = await driveFetch(`/files/${fileId}?alt=media`, accessToken);

  if (isTextMimeType(file.mimeType)) {
    // Text files: read as UTF-8 text
    const content = await response.text();
    return { content, mimeType: file.mimeType };
  }

  // Binary files: read as ArrayBuffer and encode as base64
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const content = btoa(binary);
  return { content, mimeType: file.mimeType, encoding: 'base64' };
}

function getExportMimeType(googleMimeType: string): string {
  const exportTypes: Record<string, string> = {
    'application/vnd.google-apps.document': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain',
    'application/vnd.google-apps.drawing': 'image/png',
  };
  return exportTypes[googleMimeType] || 'text/plain';
}

async function createFile(
  args: Record<string, unknown>,
  accessToken: string
): Promise<DriveFile> {
  const name = args.name as string;
  const content = args.content as string || '';
  const mimeType = args.mimeType as string || 'text/plain';
  const folderId = args.folderId as string || undefined;

  if (!name) {
    throw new Error('name is required');
  }

  const metadata: Record<string, unknown> = { name, mimeType };
  if (folderId) {
    metadata.parents = [folderId];
  }

  // Use multipart upload
  const boundary = 'orcabot_boundary_' + crypto.randomUUID();
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    '',
    content,
    `--${boundary}--`,
  ].join('\r\n');

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Drive API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<DriveFile>;
}

async function updateFile(
  args: Record<string, unknown>,
  accessToken: string
): Promise<DriveFile> {
  const fileId = args.fileId as string;
  const content = args.content as string;
  if (!fileId) {
    throw new Error('fileId is required');
  }

  const name = args.name as string || undefined;
  const mimeType = args.mimeType as string || 'text/plain';

  // Use multipart upload for content update
  const boundary = 'orcabot_boundary_' + crypto.randomUUID();
  const metadata: Record<string, unknown> = {};
  if (name) metadata.name = name;

  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    '',
    content || '',
    `--${boundary}--`,
  ].join('\r\n');

  const response = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,name,mimeType,webViewLink`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Drive API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<DriveFile>;
}

async function deleteFile(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ success: boolean }> {
  const fileId = args.fileId as string;
  if (!fileId) {
    throw new Error('fileId is required');
  }

  const response = await driveFetch(`/files/${fileId}`, accessToken, {
    method: 'DELETE',
  });

  return { success: true };
}

async function shareFile(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const fileId = args.fileId as string;
  const email = args.email as string;
  const role = args.role as string || 'reader';
  if (!fileId || !email) {
    throw new Error('fileId and email are required');
  }

  const response = await driveFetch(`/files/${fileId}/permissions`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'user',
      role,
      emailAddress: email,
    }),
  });

  return response.json();
}
