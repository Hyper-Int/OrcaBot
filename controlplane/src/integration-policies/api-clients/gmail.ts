// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: gmail-client-v1
console.log(`[gmail-client] REVISION: gmail-client-v1 loaded at ${new Date().toISOString()}`);

/**
 * Gmail API Client
 *
 * Executes Gmail API calls with OAuth access token.
 * Token never leaves the control plane.
 */

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    parts?: Array<{
      mimeType: string;
      body?: { data?: string };
    }>;
    body?: { data?: string };
  };
  internalDate?: string;
}

interface GmailSearchResult {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/**
 * Execute a Gmail action
 */
export async function executeGmailAction(
  action: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  switch (action) {
    case 'gmail.search':
    case 'gmail.list':
      return searchMessages(args, accessToken);
    case 'gmail.get':
      return getMessage(args, accessToken);
    case 'gmail.send':
      return sendMessage(args, accessToken);
    case 'gmail.archive':
      return archiveMessage(args, accessToken);
    case 'gmail.trash':
      return trashMessage(args, accessToken);
    case 'gmail.mark_read':
      return markRead(args, accessToken);
    case 'gmail.mark_unread':
      return markUnread(args, accessToken);
    case 'gmail.add_label':
      return addLabel(args, accessToken);
    case 'gmail.remove_label':
      return removeLabel(args, accessToken);
    default:
      throw new Error(`Unknown Gmail action: ${action}`);
  }
}

async function searchMessages(
  args: Record<string, unknown>,
  accessToken: string
): Promise<GmailMessage[]> {
  const query = args.query as string || '';
  const maxResults = Math.min(args.maxResults as number || 10, 100);
  const pageToken = args.pageToken as string || undefined;

  const params = new URLSearchParams({
    q: query,
    maxResults: maxResults.toString(),
  });
  if (pageToken) {
    params.set('pageToken', pageToken);
  }

  const response = await fetch(`${GMAIL_API_BASE}/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail API error: ${response.status} - ${error}`);
  }

  const searchResult = await response.json() as GmailSearchResult;

  if (!searchResult.messages?.length) {
    return [];
  }

  // Fetch full message details for each result
  const messages = await Promise.all(
    searchResult.messages.slice(0, maxResults).map(async (msg) => {
      return getMessage({ messageId: msg.id }, accessToken);
    })
  );

  return messages as GmailMessage[];
}

async function getMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<GmailMessage> {
  const messageId = args.messageId as string;
  if (!messageId) {
    throw new Error('messageId is required');
  }

  const response = await fetch(`${GMAIL_API_BASE}/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<GmailMessage>;
}

async function sendMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const to = args.to as string[] || [];
  const cc = args.cc as string[] || [];
  const bcc = args.bcc as string[] || [];
  const subject = args.subject as string || '';
  const body = args.body as string || '';
  const threadId = args.threadId as string || undefined;

  // Build RFC 2822 email
  const headers = [
    `To: ${to.join(', ')}`,
    cc.length ? `Cc: ${cc.join(', ')}` : null,
    bcc.length ? `Bcc: ${bcc.join(', ')}` : null,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
  ].filter(Boolean).join('\r\n');

  const email = `${headers}\r\n\r\n${body}`;
  const encodedEmail = btoa(unescape(encodeURIComponent(email)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const requestBody: Record<string, unknown> = { raw: encodedEmail };
  if (threadId) {
    requestBody.threadId = threadId;
  }

  const response = await fetch(`${GMAIL_API_BASE}/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail API error: ${response.status} - ${error}`);
  }

  return response.json();
}

async function archiveMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const messageId = args.messageId as string;
  if (!messageId) {
    throw new Error('messageId is required');
  }

  // Archive = remove INBOX label
  return modifyLabels(messageId, [], ['INBOX'], accessToken);
}

async function trashMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const messageId = args.messageId as string;
  if (!messageId) {
    throw new Error('messageId is required');
  }

  const response = await fetch(`${GMAIL_API_BASE}/messages/${messageId}/trash`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail API error: ${response.status} - ${error}`);
  }

  return response.json();
}

async function markRead(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const messageId = args.messageId as string;
  if (!messageId) {
    throw new Error('messageId is required');
  }

  return modifyLabels(messageId, [], ['UNREAD'], accessToken);
}

async function markUnread(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const messageId = args.messageId as string;
  if (!messageId) {
    throw new Error('messageId is required');
  }

  return modifyLabels(messageId, ['UNREAD'], [], accessToken);
}

async function addLabel(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const messageId = args.messageId as string;
  const labelId = args.labelId as string;
  if (!messageId || !labelId) {
    throw new Error('messageId and labelId are required');
  }

  return modifyLabels(messageId, [labelId], [], accessToken);
}

async function removeLabel(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const messageId = args.messageId as string;
  const labelId = args.labelId as string;
  if (!messageId || !labelId) {
    throw new Error('messageId and labelId are required');
  }

  return modifyLabels(messageId, [], [labelId], accessToken);
}

async function modifyLabels(
  messageId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
  accessToken: string
): Promise<unknown> {
  const response = await fetch(`${GMAIL_API_BASE}/messages/${messageId}/modify`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      addLabelIds,
      removeLabelIds,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail API error: ${response.status} - ${error}`);
  }

  return response.json();
}
