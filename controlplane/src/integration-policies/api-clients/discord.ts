// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: discord-client-v1-initial
const MODULE_REVISION = 'discord-client-v1-initial';
console.log(`[discord-client] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Discord REST API Client
 *
 * Executes Discord API calls with bot token.
 * Token never leaves the control plane.
 */

const DISCORD_API_BASE = 'https://discord.com/api/v10';

interface DiscordMessage {
  id: string;
  content: string;
  author: {
    id: string;
    username: string;
    bot?: boolean;
  };
  channel_id: string;
  timestamp: string;
  message_reference?: {
    message_id: string;
    channel_id: string;
    guild_id?: string;
  };
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  topic?: string | null;
  guild_id?: string;
  position: number;
  parent_id?: string | null;
}

interface DiscordUser {
  id: string;
  username: string;
  discriminator?: string;
  avatar?: string | null;
  bot?: boolean;
}

async function discordFetch(
  endpoint: string,
  accessToken: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
  } = {},
): Promise<unknown> {
  const { method = 'GET', body } = options;

  const headers: Record<string, string> = {
    'Authorization': `Bot ${accessToken}`,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${DISCORD_API_BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    let errorCode = `${response.status}`;
    try {
      const errJson = JSON.parse(errBody) as { code?: number; message?: string };
      if (errJson.message) errorCode = errJson.message;
    } catch {
      // use status code
    }
    throw new Error(`Discord API error: ${errorCode}`);
  }

  // Some endpoints return 204 No Content
  if (response.status === 204) {
    return { ok: true };
  }

  return response.json();
}

/**
 * Execute a Discord action
 */
export async function executeDiscordAction(
  action: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  switch (action) {
    case 'discord.list_channels':
      return listChannels(args, accessToken);
    case 'discord.read_messages':
      return readMessages(args, accessToken);
    case 'discord.send_message':
      return sendMessage(args, accessToken);
    case 'discord.reply_thread':
      return replyThread(args, accessToken);
    case 'discord.react':
      return addReaction(args, accessToken);
    case 'discord.get_user_info':
      return getUserInfo(args, accessToken);
    case 'discord.edit_message':
      return editMessage(args, accessToken);
    case 'discord.delete_message':
      return deleteMessage(args, accessToken);
    default:
      throw new Error(`Unknown Discord action: ${action}`);
  }
}

async function listChannels(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ channels: DiscordChannel[] }> {
  const guildId = args.guild_id as string;
  if (!guildId) throw new Error('guild_id is required');

  const data = await discordFetch(
    `/guilds/${guildId}/channels`,
    accessToken,
  ) as DiscordChannel[];

  // Filter to text channels (0) and announcement channels (5)
  const textChannels = data.filter(ch => ch.type === 0 || ch.type === 5);

  return { channels: textChannels };
}

async function readMessages(
  args: Record<string, unknown>,
  accessToken: string
): Promise<DiscordMessage[]> {
  const channel = args.channel as string;
  if (!channel) throw new Error('channel is required');

  const limit = Math.min(args.limit as number || 20, 100);
  const params = new URLSearchParams({ limit: limit.toString() });
  if (args.before) params.set('before', args.before as string);
  if (args.after) params.set('after', args.after as string);

  const data = await discordFetch(
    `/channels/${channel}/messages?${params}`,
    accessToken,
  ) as DiscordMessage[];

  return data;
}

async function sendMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ id: string; channel_id: string }> {
  const channel = args.channel as string;
  const content = args.text as string || args.content as string;
  if (!channel) throw new Error('channel is required');
  if (!content) throw new Error('text is required');

  const data = await discordFetch(
    `/channels/${channel}/messages`,
    accessToken,
    { method: 'POST', body: { content } },
  ) as DiscordMessage;

  return { id: data.id, channel_id: data.channel_id };
}

async function replyThread(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ id: string; channel_id: string }> {
  const channel = args.channel as string;
  const messageId = args.message_id as string;
  const content = args.text as string || args.content as string;
  if (!channel) throw new Error('channel is required');
  if (!messageId) throw new Error('message_id is required');
  if (!content) throw new Error('text is required');

  const data = await discordFetch(
    `/channels/${channel}/messages`,
    accessToken,
    {
      method: 'POST',
      body: {
        content,
        message_reference: { message_id: messageId },
      },
    },
  ) as DiscordMessage;

  return { id: data.id, channel_id: data.channel_id };
}

async function addReaction(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ ok: boolean }> {
  const channel = args.channel as string;
  const messageId = args.message_id as string;
  const emoji = args.emoji as string;
  if (!channel) throw new Error('channel is required');
  if (!messageId) throw new Error('message_id is required');
  if (!emoji) throw new Error('emoji is required');

  // URL-encode the emoji for the path
  const encodedEmoji = encodeURIComponent(emoji);
  await discordFetch(
    `/channels/${channel}/messages/${messageId}/reactions/${encodedEmoji}/@me`,
    accessToken,
    { method: 'PUT' },
  );

  return { ok: true };
}

async function getUserInfo(
  args: Record<string, unknown>,
  accessToken: string
): Promise<DiscordUser> {
  const userId = args.user as string || args.user_id as string;
  if (!userId) throw new Error('user ID is required');

  const data = await discordFetch(
    `/users/${userId}`,
    accessToken,
  ) as DiscordUser;

  return data;
}

async function editMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ id: string; channel_id: string }> {
  const channel = args.channel as string;
  const messageId = args.message_id as string;
  const content = args.text as string || args.content as string;
  if (!channel) throw new Error('channel is required');
  if (!messageId) throw new Error('message_id is required');
  if (!content) throw new Error('text is required');

  const data = await discordFetch(
    `/channels/${channel}/messages/${messageId}`,
    accessToken,
    { method: 'PATCH', body: { content } },
  ) as DiscordMessage;

  return { id: data.id, channel_id: data.channel_id };
}

async function deleteMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ ok: boolean }> {
  const channel = args.channel as string;
  const messageId = args.message_id as string;
  if (!channel) throw new Error('channel is required');
  if (!messageId) throw new Error('message_id is required');

  await discordFetch(
    `/channels/${channel}/messages/${messageId}`,
    accessToken,
    { method: 'DELETE' },
  );

  return { ok: true };
}
