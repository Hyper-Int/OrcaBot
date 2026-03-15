// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: outlook-client-v5-encode-message-ids
console.log(`[outlook-client] REVISION: outlook-client-v5-encode-message-ids loaded at ${new Date().toISOString()}`);

/**
 * Outlook API Client (Microsoft Graph)
 *
 * Executes Outlook Mail API calls with OAuth access token.
 * Token never leaves the control plane.
 */

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

interface OutlookMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: {
    contentType: string;
    content: string;
  };
  from?: {
    emailAddress: {
      name?: string;
      address: string;
    };
  };
  toRecipients?: Array<{
    emailAddress: {
      name?: string;
      address: string;
    };
  }>;
  ccRecipients?: Array<{
    emailAddress: {
      name?: string;
      address: string;
    };
  }>;
  bccRecipients?: Array<{
    emailAddress: {
      name?: string;
      address: string;
    };
  }>;
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  conversationId?: string;
}

interface OutlookSearchResult {
  value?: OutlookMessage[];
  '@odata.nextLink'?: string;
}

interface OutlookFolderResult {
  value?: Array<{
    id: string;
    displayName: string;
    parentFolderId?: string;
    childFolderCount?: number;
    unreadItemCount?: number;
    totalItemCount?: number;
  }>;
}

/**
 * Execute an Outlook action
 */
export async function executeOutlookAction(
  action: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  switch (action) {
    case 'outlook.search':
    case 'outlook.list':
      return searchMessages(args, accessToken);
    case 'outlook.get':
      return getMessage(args, accessToken);
    case 'outlook.send':
      return sendMessage(args, accessToken);
    case 'outlook.reply':
      return replyToMessage(args, accessToken);
    case 'outlook.forward':
      return forwardMessage(args, accessToken);
    case 'outlook.archive':
      return archiveMessage(args, accessToken);
    case 'outlook.delete':
      return deleteMessage(args, accessToken);
    case 'outlook.mark_read':
      return markRead(args, accessToken);
    case 'outlook.mark_unread':
      return markUnread(args, accessToken);
    case 'outlook.list_folders':
      return listFolders(args, accessToken);
    default:
      throw new Error(`Unknown Outlook action: ${action}`);
  }
}

async function searchMessages(
  args: Record<string, unknown>,
  accessToken: string
): Promise<OutlookMessage[]> {
  const query = args.query as string || '';
  const maxResults = Math.min((args.limit ?? args.maxResults ?? 10) as number, 100);
  const folder = args.folder as string | undefined;

  const params = new URLSearchParams({
    '$top': maxResults.toString(),
    '$orderby': 'receivedDateTime desc',
  });
  if (query) {
    params.set('$search', `"${query}"`);
  }

  // If folder is specified, scope to that mail folder; otherwise search all messages
  const basePath = folder
    ? `/me/mailFolders/${encodeURIComponent(folder)}/messages`
    : '/me/messages';

  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  // Microsoft Graph requires ConsistencyLevel: eventual for $search on messages
  if (query) {
    headers['ConsistencyLevel'] = 'eventual';
  }

  const response = await fetch(`${GRAPH_API_BASE}${basePath}?${params}`, { headers });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook API error: ${response.status} - ${error}`);
  }

  const searchResult = await response.json() as OutlookSearchResult;

  return searchResult.value || [];
}

async function getMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<OutlookMessage> {
  const messageId = (args.message_id ?? args.messageId) as string;
  if (!messageId) {
    throw new Error('message_id is required');
  }

  const response = await fetch(`${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<OutlookMessage>;
}

async function sendMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  // Accept both scalar string and array — MCP tool schemas send scalar strings
  const toRaw = args.to;
  const ccRaw = args.cc;
  const bccRaw = args.bcc;
  const to = Array.isArray(toRaw) ? toRaw as string[] : (typeof toRaw === 'string' && toRaw ? [toRaw] : []);
  const cc = Array.isArray(ccRaw) ? ccRaw as string[] : (typeof ccRaw === 'string' && ccRaw ? [ccRaw] : []);
  const bcc = Array.isArray(bccRaw) ? bccRaw as string[] : (typeof bccRaw === 'string' && bccRaw ? [bccRaw] : []);
  const subject = args.subject as string || '';
  const body = args.body as string || '';

  if (!to.length) {
    throw new Error('to is required');
  }

  const toRecipients = to.map((addr) => ({
    emailAddress: { address: addr },
  }));
  const ccRecipients = cc.map((addr) => ({
    emailAddress: { address: addr },
  }));
  const bccRecipients = bcc.map((addr) => ({
    emailAddress: { address: addr },
  }));

  const requestBody: Record<string, unknown> = {
    message: {
      subject,
      body: {
        contentType: 'Text',
        content: body,
      },
      toRecipients,
      ...(ccRecipients.length ? { ccRecipients } : {}),
      ...(bccRecipients.length ? { bccRecipients } : {}),
    },
  };

  const response = await fetch(`${GRAPH_API_BASE}/me/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook API error: ${response.status} - ${error}`);
  }

  // sendMail typically returns 202 with an empty body on success.
  // Graph may omit Content-Length, so parse defensively.
  const text = await response.text();
  if (!text) return { success: true, status: 'sent' };
  try { return JSON.parse(text); } catch { return { success: true, status: 'sent' }; }
}

async function replyToMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const messageId = (args.message_id ?? args.messageId) as string;
  const body = args.body as string || '';

  if (!messageId) {
    throw new Error('message_id is required');
  }

  const response = await fetch(`${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}/reply`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ comment: body }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook API error: ${response.status} - ${error}`);
  }

  const text = await response.text();
  if (!text) return { success: true, status: 'replied' };
  try { return JSON.parse(text); } catch { return { success: true, status: 'replied' }; }
}

async function forwardMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const messageId = (args.message_id ?? args.messageId) as string;
  const to = args.to as string;
  const body = args.body as string || '';

  if (!messageId) {
    throw new Error('message_id is required');
  }
  if (!to) {
    throw new Error('to is required');
  }

  const response = await fetch(`${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}/forward`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      comment: body,
      toRecipients: [
        { emailAddress: { address: to } },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook API error: ${response.status} - ${error}`);
  }

  const text = await response.text();
  if (!text) return { success: true, status: 'forwarded' };
  try { return JSON.parse(text); } catch { return { success: true, status: 'forwarded' }; }
}

async function archiveMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const messageId = (args.message_id ?? args.messageId) as string;
  if (!messageId) {
    throw new Error('message_id is required');
  }

  const response = await fetch(`${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}/move`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ destinationId: 'archive' }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook API error: ${response.status} - ${error}`);
  }

  return response.json();
}

async function deleteMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const messageId = (args.message_id ?? args.messageId) as string;
  if (!messageId) {
    throw new Error('message_id is required');
  }

  const response = await fetch(`${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook API error: ${response.status} - ${error}`);
  }

  // DELETE returns 204 with no body on success
  return { success: true, status: 'deleted' };
}

async function markRead(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const messageId = (args.message_id ?? args.messageId) as string;
  if (!messageId) {
    throw new Error('message_id is required');
  }

  const response = await fetch(`${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ isRead: true }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook API error: ${response.status} - ${error}`);
  }

  return response.json();
}

async function markUnread(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const messageId = (args.message_id ?? args.messageId) as string;
  if (!messageId) {
    throw new Error('message_id is required');
  }

  const response = await fetch(`${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ isRead: false }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook API error: ${response.status} - ${error}`);
  }

  return response.json();
}

async function listFolders(
  _args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const response = await fetch(`${GRAPH_API_BASE}/me/mailFolders`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Outlook API error: ${response.status} - ${error}`);
  }

  const result = await response.json() as OutlookFolderResult;

  return result.value || [];
}
