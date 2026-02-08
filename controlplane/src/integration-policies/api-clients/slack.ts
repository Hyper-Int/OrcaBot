// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: slack-client-v3-list-channels-cursor
const MODULE_REVISION = 'slack-client-v3-list-channels-cursor';
console.log(`[slack-client] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Slack Web API Client
 *
 * Executes Slack API calls with bot token.
 * Token never leaves the control plane.
 */

const SLACK_API_BASE = 'https://slack.com/api';

interface SlackMessage {
  ts: string;
  text: string;
  user?: string;
  channel?: string;
  thread_ts?: string;
  reply_count?: number;
  username?: string;
  bot_id?: string;
}

interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_private: boolean;
  is_archived: boolean;
  topic?: { value: string };
  purpose?: { value: string };
  num_members?: number;
}

interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    email?: string;
    image_48?: string;
  };
  is_bot?: boolean;
}

async function slackFetch(
  method: string,
  accessToken: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw new Error(`Slack API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { ok: boolean; error?: string; [key: string]: unknown };
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error || 'unknown'}`);
  }

  return data;
}

/**
 * Execute a Slack action
 */
export async function executeSlackAction(
  action: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  switch (action) {
    case 'slack.list_channels':
      return listChannels(args, accessToken);
    case 'slack.read_messages':
      return readMessages(args, accessToken);
    case 'slack.send_message':
      return sendMessage(args, accessToken);
    case 'slack.reply_thread':
      return replyThread(args, accessToken);
    case 'slack.react':
      return addReaction(args, accessToken);
    case 'slack.search':
      return searchMessages(args, accessToken);
    case 'slack.get_user_info':
      return getUserInfo(args, accessToken);
    case 'slack.edit_message':
      return editMessage(args, accessToken);
    case 'slack.delete_message':
      return deleteMessage(args, accessToken);
    default:
      throw new Error(`Unknown Slack action: ${action}`);
  }
}

async function listChannels(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ channels: SlackChannel[]; next_cursor?: string }> {
  const limit = Math.min(args.limit as number || 100, 1000);
  const types = (args.types as string) || 'public_channel,private_channel';

  const data = await slackFetch('conversations.list', accessToken, {
    types,
    limit,
    exclude_archived: true,
    ...(args.cursor ? { cursor: args.cursor } : {}),
  }) as { channels: SlackChannel[]; response_metadata?: { next_cursor?: string } };

  return {
    channels: data.channels || [],
    // Slack returns empty string for next_cursor when no more pages
    next_cursor: data.response_metadata?.next_cursor || undefined,
  };
}

async function readMessages(
  args: Record<string, unknown>,
  accessToken: string
): Promise<SlackMessage[]> {
  const channel = args.channel as string;
  if (!channel) throw new Error('channel is required');

  const limit = Math.min(args.limit as number || 20, 100);

  const data = await slackFetch('conversations.history', accessToken, {
    channel,
    limit,
    ...(args.oldest ? { oldest: args.oldest } : {}),
    ...(args.latest ? { latest: args.latest } : {}),
  }) as { messages: SlackMessage[] };

  return data.messages || [];
}

async function sendMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ ts: string; channel: string }> {
  const channel = args.channel as string;
  const text = args.text as string;
  if (!channel) throw new Error('channel is required');
  if (!text) throw new Error('text is required');

  const data = await slackFetch('chat.postMessage', accessToken, {
    channel,
    text,
    ...(args.blocks ? { blocks: args.blocks } : {}),
  }) as { ts: string; channel: string };

  return { ts: data.ts, channel: data.channel };
}

async function replyThread(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ ts: string; channel: string }> {
  const channel = args.channel as string;
  const thread_ts = args.thread_ts as string;
  const text = args.text as string;
  if (!channel) throw new Error('channel is required');
  if (!thread_ts) throw new Error('thread_ts is required');
  if (!text) throw new Error('text is required');

  const data = await slackFetch('chat.postMessage', accessToken, {
    channel,
    text,
    thread_ts,
    ...(args.reply_broadcast ? { reply_broadcast: true } : {}),
  }) as { ts: string; channel: string };

  return { ts: data.ts, channel: data.channel };
}

async function addReaction(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ ok: boolean }> {
  const channel = args.channel as string;
  const timestamp = args.timestamp as string;
  const name = args.name as string;
  if (!channel) throw new Error('channel is required');
  if (!timestamp) throw new Error('timestamp is required');
  if (!name) throw new Error('name (emoji name) is required');

  await slackFetch('reactions.add', accessToken, {
    channel,
    timestamp,
    name,
  });

  return { ok: true };
}

/**
 * Search messages across Slack.
 *
 * NOTE: search.messages requires a user token (xoxp-...), not a bot token (xoxb-...).
 * Our OAuth flow stores the bot token from oauth.v2.access. If the workspace's Slack
 * app does not have user token scopes configured, this will return not_allowed_token_type.
 * The MCP tool is excluded from the sandbox tool list to avoid confusing LLM errors.
 * This function is kept for future use when user token storage is implemented.
 */
async function searchMessages(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ messages: SlackMessage[]; total: number }> {
  const query = args.query as string;
  if (!query) throw new Error('query is required');

  const count = Math.min(args.count as number || 20, 100);

  const data = await slackFetch('search.messages', accessToken, {
    query,
    count,
    sort: 'timestamp',
    sort_dir: 'desc',
  }) as { messages: { matches: SlackMessage[]; total: number } };

  return {
    messages: data.messages?.matches || [],
    total: data.messages?.total || 0,
  };
}

async function getUserInfo(
  args: Record<string, unknown>,
  accessToken: string
): Promise<SlackUser> {
  const user = args.user as string;
  if (!user) throw new Error('user ID is required');

  const data = await slackFetch('users.info', accessToken, {
    user,
  }) as { user: SlackUser };

  return data.user;
}

async function editMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ ts: string; channel: string }> {
  const channel = args.channel as string;
  const ts = args.ts as string;
  const text = args.text as string;
  if (!channel) throw new Error('channel is required');
  if (!ts) throw new Error('ts (message timestamp) is required');
  if (!text) throw new Error('text is required');

  const data = await slackFetch('chat.update', accessToken, {
    channel,
    ts,
    text,
  }) as { ts: string; channel: string };

  return { ts: data.ts, channel: data.channel };
}

async function deleteMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ ok: boolean }> {
  const channel = args.channel as string;
  const ts = args.ts as string;
  if (!channel) throw new Error('channel is required');
  if (!ts) throw new Error('ts (message timestamp) is required');

  await slackFetch('chat.delete', accessToken, {
    channel,
    ts,
  });

  return { ok: true };
}
