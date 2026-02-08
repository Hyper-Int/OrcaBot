// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: google-chat-client-v5-threadkey-query-param
const MODULE_REVISION = 'google-chat-client-v5-threadkey-query-param';
console.log(`[google-chat-client] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Google Chat REST API Client
 *
 * Executes Google Chat API calls with OAuth access token.
 * Token never leaves the control plane.
 */

const GOOGLE_CHAT_API_BASE = 'https://chat.googleapis.com/v1';

interface GoogleChatSpace {
  name: string;
  displayName: string;
  type: string;
  spaceType?: string;
  singleUserBotDm?: boolean;
}

interface GoogleChatMessage {
  name: string;
  sender: { name: string; displayName: string; type: string };
  text: string;
  createTime: string;
  thread?: { name: string };
}

async function googleChatFetch(
  endpoint: string,
  accessToken: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
  } = {},
): Promise<unknown> {
  const { method = 'GET', body } = options;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${GOOGLE_CHAT_API_BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'Google Chat token expired or revoked. Please disconnect and reconnect Google Chat with a fresh token.'
      );
    }
    const errBody = await response.text().catch(() => '');
    let errorCode = `${response.status}`;
    try {
      const errJson = JSON.parse(errBody) as { error?: { message?: string; code?: number } };
      if (errJson.error?.message) errorCode = errJson.error.message;
    } catch {
      // use status code
    }
    throw new Error(`Google Chat API error: ${errorCode}`);
  }

  // Some endpoints return 204 No Content
  if (response.status === 204) {
    return { ok: true };
  }

  return response.json();
}

/**
 * Execute a Google Chat action
 */
export async function executeGoogleChatAction(
  action: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  switch (action) {
    case 'google_chat.list_spaces':
      return listSpaces(accessToken);
    case 'google_chat.read_messages':
      return readMessages(args, accessToken);
    case 'google_chat.send_message':
      return sendMessage(args, accessToken);
    case 'google_chat.reply_thread':
      return replyThread(args, accessToken);
    case 'google_chat.add_reaction':
      return addReaction(args, accessToken);
    case 'google_chat.get_member':
      return getMember(args, accessToken);
    case 'google_chat.update_message':
      return updateMessage(args, accessToken);
    case 'google_chat.delete_message':
      return deleteMessage(args, accessToken);
    default:
      throw new Error(`Unknown Google Chat action: ${action}`);
  }
}

async function listSpaces(
  accessToken: string
): Promise<{ spaces: GoogleChatSpace[] }> {
  const filter = encodeURIComponent('spaceType="SPACE" OR spaceType="GROUP_CHAT"');
  const data = await googleChatFetch(
    `/spaces?filter=${filter}`,
    accessToken,
  ) as { spaces?: GoogleChatSpace[] };

  return { spaces: data.spaces || [] };
}

async function readMessages(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ messages: GoogleChatMessage[] }> {
  const space = args.space as string;
  if (!space) throw new Error('space is required');

  const limit = Math.min(args.limit as number || 20, 100);
  const spaceName = space.startsWith('spaces/') ? space : `spaces/${space}`;

  const params = new URLSearchParams({
    pageSize: String(limit),
    orderBy: 'createTime desc',
  });

  const data = await googleChatFetch(
    `/${spaceName}/messages?${params.toString()}`,
    accessToken,
  ) as { messages?: GoogleChatMessage[] };

  return { messages: data.messages || [] };
}

async function sendMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ name: string; text: string }> {
  const space = args.space as string;
  const text = args.text as string;
  if (!space) throw new Error('space is required');
  if (!text) throw new Error('text is required');

  const spaceName = space.startsWith('spaces/') ? space : `spaces/${space}`;

  const data = await googleChatFetch(
    `/${spaceName}/messages`,
    accessToken,
    { method: 'POST', body: { text } },
  ) as GoogleChatMessage;

  return { name: data.name, text: data.text };
}

async function replyThread(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ name: string; text: string }> {
  const space = args.space as string;
  const text = args.text as string;
  const threadKey = args.thread_key as string | undefined;
  const messageId = args.message_id as string | undefined;
  if (!space) throw new Error('space is required');
  if (!text) throw new Error('text is required');
  if (!threadKey && !messageId) throw new Error('thread_key or message_id is required');

  const spaceName = space.startsWith('spaces/') ? space : `spaces/${space}`;

  // Google Chat threading has two modes:
  // 1. thread.name — a full resource name like "spaces/.../threads/..."
  // 2. threadKey query param — an opaque caller-defined key (not a resource name)
  //
  // If thread_key starts with "spaces/", it's a thread resource name → use thread.name.
  // Otherwise it's a caller-defined key → pass via threadKey query param.
  // If message_id is provided, fetch the message to resolve its thread.name.
  let threadName: string | undefined;
  let threadKeyParam: string | undefined;

  if (threadKey) {
    if (threadKey.startsWith('spaces/')) {
      threadName = threadKey;
    } else {
      // Opaque thread key — pass as query param, not as thread.name
      threadKeyParam = threadKey;
    }
  } else {
    // Fetch the message to get its thread name
    const msgName = messageId!.startsWith('spaces/')
      ? messageId!
      : `${spaceName}/messages/${messageId}`;
    const msg = await googleChatFetch(
      `/${msgName}`,
      accessToken,
    ) as GoogleChatMessage;

    if (msg.thread?.name) {
      threadName = msg.thread.name;
    } else {
      // Fallback: message may not have a thread (e.g., DM).
      // Extract the message ID segment — messageId might be a full resource
      // name like "spaces/xxx/messages/yyy", so use only the last segment.
      const msgIdSegment = msgName.split('/').pop()!;
      threadName = `${spaceName}/threads/${msgIdSegment}`;
    }
  }

  // Build endpoint with query params
  const replyParams = new URLSearchParams({
    messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
  });
  if (threadKeyParam) {
    replyParams.set('threadKey', threadKeyParam);
  }

  const body: Record<string, unknown> = { text };
  if (threadName) {
    body.thread = { name: threadName };
  }

  const data = await googleChatFetch(
    `/${spaceName}/messages?${replyParams.toString()}`,
    accessToken,
    { method: 'POST', body },
  ) as GoogleChatMessage;

  return { name: data.name, text: data.text };
}

async function addReaction(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ ok: boolean }> {
  const space = args.space as string;
  const messageId = args.message_id as string;
  const emoji = args.emoji as string;
  if (!space) throw new Error('space is required');
  if (!messageId) throw new Error('message_id is required');
  if (!emoji) throw new Error('emoji is required');

  const spaceName = space.startsWith('spaces/') ? space : `spaces/${space}`;
  const messageName = messageId.startsWith('spaces/')
    ? messageId
    : `${spaceName}/messages/${messageId}`;

  await googleChatFetch(
    `/${messageName}/reactions`,
    accessToken,
    {
      method: 'POST',
      body: { emoji: { unicode: emoji } },
    },
  );

  return { ok: true };
}

async function getMember(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const space = args.space as string;
  const memberId = args.member_id as string;
  if (!space) throw new Error('space is required');
  if (!memberId) throw new Error('member_id is required');

  const spaceName = space.startsWith('spaces/') ? space : `spaces/${space}`;
  const memberName = memberId.startsWith('spaces/')
    ? memberId
    : `${spaceName}/members/${memberId}`;

  const data = await googleChatFetch(
    `/${memberName}`,
    accessToken,
  );

  return data;
}

async function updateMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ name: string; text: string }> {
  const space = args.space as string;
  const messageId = args.message_id as string;
  const text = args.text as string;
  if (!space) throw new Error('space is required');
  if (!messageId) throw new Error('message_id is required');
  if (!text) throw new Error('text is required');

  const spaceName = space.startsWith('spaces/') ? space : `spaces/${space}`;
  const messageName = messageId.startsWith('spaces/')
    ? messageId
    : `${spaceName}/messages/${messageId}`;

  const data = await googleChatFetch(
    `/${messageName}?updateMask=text`,
    accessToken,
    { method: 'PUT', body: { text } },
  ) as GoogleChatMessage;

  return { name: data.name, text: data.text };
}

async function deleteMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ ok: boolean }> {
  const space = args.space as string;
  const messageId = args.message_id as string;
  if (!space) throw new Error('space is required');
  if (!messageId) throw new Error('message_id is required');

  const spaceName = space.startsWith('spaces/') ? space : `spaces/${space}`;
  const messageName = messageId.startsWith('spaces/')
    ? messageId
    : `${spaceName}/messages/${messageId}`;

  await googleChatFetch(
    `/${messageName}`,
    accessToken,
    { method: 'DELETE' },
  );

  return { ok: true };
}
