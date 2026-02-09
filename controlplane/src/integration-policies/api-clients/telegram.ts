// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: telegram-client-v3-auth-error-detection
const MODULE_REVISION = 'telegram-client-v3-auth-error-detection';
console.log(`[telegram-client] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Telegram Bot API Client
 *
 * Executes Telegram Bot API calls with bot token.
 * Token never leaves the control plane.
 */

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name: string; username?: string; is_bot?: boolean };
  chat: { id: number; type: string; title?: string; username?: string; first_name?: string };
  date: number;
  text?: string;
  reply_to_message?: { message_id: number };
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  description?: string;
}

async function telegramFetch(
  method: string,
  accessToken: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const url = `https://api.telegram.org/bot${accessToken}/${method}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: params ? JSON.stringify(params) : undefined,
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        'Telegram bot token is invalid or revoked. Please disconnect and reconnect Telegram with a fresh bot token.'
      );
    }
    const errBody = await response.text().catch(() => '');
    let errorMsg = `${response.status}`;
    try {
      const errJson = JSON.parse(errBody) as { description?: string };
      if (errJson.description) errorMsg = errJson.description;
    } catch {
      // use status code
    }
    throw new Error(`Telegram API error: ${errorMsg}`);
  }

  const data = await response.json() as { ok: boolean; result: unknown; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
  }

  return data.result;
}

/**
 * Optional D1 context for read operations.
 * When a Telegram webhook is active, getUpdates is blocked by the Bot API.
 * We serve get_chats and read_messages from D1 (inbound_messages +
 * messaging_subscriptions) instead.
 */
export interface TelegramD1Context {
  db: D1Database;
  userId: string;
}

/**
 * Execute a Telegram action
 */
export async function executeTelegramAction(
  action: string,
  args: Record<string, unknown>,
  accessToken: string,
  d1Ctx?: TelegramD1Context,
): Promise<unknown> {
  switch (action) {
    case 'telegram.get_chats':
      return getChats(accessToken, d1Ctx);
    case 'telegram.read_messages':
      return readMessages(args, accessToken, d1Ctx);
    case 'telegram.send_message':
      return sendMessage(args, accessToken);
    case 'telegram.reply_thread':
      return replyThread(args, accessToken);
    case 'telegram.get_chat_info':
      return getChatInfo(args, accessToken);
    case 'telegram.edit_message':
      return editMessage(args, accessToken);
    case 'telegram.delete_message':
      return deleteMessage(args, accessToken);
    default:
      throw new Error(`Unknown Telegram action: ${action}`);
  }
}

async function getChats(
  accessToken: string,
  d1Ctx?: TelegramD1Context,
): Promise<{ chats: TelegramChat[] }> {
  // When D1 context is available, check if a webhook is active.
  // If so, getUpdates is blocked by the Bot API — serve from D1 instead.
  if (d1Ctx) {
    const hasWebhook = await d1Ctx.db.prepare(`
      SELECT 1 FROM messaging_subscriptions
      WHERE user_id = ? AND provider = 'telegram' AND status IN ('pending', 'active')
      LIMIT 1
    `).bind(d1Ctx.userId).first();

    if (hasWebhook) {
      return getChatsFromD1(accessToken, d1Ctx);
    }
  }

  // No webhook — safe to use getUpdates
  const data = await telegramFetch('getUpdates', accessToken, { limit: 100 }) as Array<{
    message?: { chat: TelegramChat };
    edited_message?: { chat: TelegramChat };
    channel_post?: { chat: TelegramChat };
  }>;

  const chatMap = new Map<number, TelegramChat>();
  for (const update of data) {
    const chat = update.message?.chat || update.edited_message?.chat || update.channel_post?.chat;
    if (chat && !chatMap.has(chat.id)) {
      chatMap.set(chat.id, chat);
    }
  }

  return { chats: Array.from(chatMap.values()) };
}

/**
 * List known chats from D1 inbound_messages + subscription chat_ids,
 * then enrich each with Telegram's getChat API (which works even with webhooks).
 */
async function getChatsFromD1(
  accessToken: string,
  d1Ctx: TelegramD1Context,
): Promise<{ chats: TelegramChat[] }> {
  // Collect unique chat IDs from two sources:
  // 1. Subscription chat_ids (what the user explicitly subscribed to)
  // 2. Inbound message channel_ids (chats that sent messages via webhook)
  const chatIdSet = new Set<string>();

  const subs = await d1Ctx.db.prepare(`
    SELECT chat_id FROM messaging_subscriptions
    WHERE user_id = ? AND provider = 'telegram' AND status IN ('pending', 'active') AND chat_id IS NOT NULL
  `).bind(d1Ctx.userId).all<{ chat_id: string }>();
  for (const row of subs.results || []) {
    if (row.chat_id) chatIdSet.add(row.chat_id);
  }

  const msgs = await d1Ctx.db.prepare(`
    SELECT DISTINCT channel_id FROM inbound_messages im
    JOIN messaging_subscriptions ms ON im.subscription_id = ms.id
    WHERE ms.user_id = ? AND ms.provider = 'telegram' AND im.channel_id IS NOT NULL
  `).bind(d1Ctx.userId).all<{ channel_id: string }>();
  for (const row of msgs.results || []) {
    if (row.channel_id) chatIdSet.add(row.channel_id);
  }

  // Enrich each chat ID via Telegram's getChat API (works with webhooks)
  const chats: TelegramChat[] = [];
  for (const chatId of chatIdSet) {
    try {
      const chat = await telegramFetch('getChat', accessToken, { chat_id: chatId }) as TelegramChat;
      chats.push(chat);
    } catch {
      // Chat may no longer be accessible; include a minimal entry
      chats.push({ id: Number(chatId), type: 'unknown' });
    }
  }

  return { chats };
}

async function readMessages(
  args: Record<string, unknown>,
  accessToken: string,
  d1Ctx?: TelegramD1Context,
): Promise<TelegramMessage[] | { messages: InboundMessageRow[] }> {
  const chatId = args.chat_id as string;
  if (!chatId) throw new Error('chat_id is required');

  const limit = Math.min((args.limit as number) || 20, 100);

  // When D1 context is available, check if a webhook is active.
  if (d1Ctx) {
    const hasWebhook = await d1Ctx.db.prepare(`
      SELECT 1 FROM messaging_subscriptions
      WHERE user_id = ? AND provider = 'telegram' AND status IN ('pending', 'active')
      LIMIT 1
    `).bind(d1Ctx.userId).first();

    if (hasWebhook) {
      return readMessagesFromD1(chatId, limit, d1Ctx);
    }
  }

  // No webhook — safe to use getUpdates
  const data = await telegramFetch('getUpdates', accessToken, { limit: 100 }) as Array<{
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
  }>;

  const messages: TelegramMessage[] = [];
  for (const update of data) {
    const msg = update.message || update.edited_message;
    if (msg && String(msg.chat.id) === String(chatId)) {
      messages.push(msg);
    }
  }

  return messages.slice(0, limit);
}

interface InboundMessageRow {
  platform_message_id: string;
  sender_id: string | null;
  sender_name: string | null;
  channel_id: string | null;
  message_text: string | null;
  created_at: string;
}

/**
 * Read messages from D1 inbound_messages for a specific Telegram chat.
 */
async function readMessagesFromD1(
  chatId: string,
  limit: number,
  d1Ctx: TelegramD1Context,
): Promise<{ messages: InboundMessageRow[] }> {
  const rows = await d1Ctx.db.prepare(`
    SELECT im.platform_message_id, im.sender_id, im.sender_name,
           im.channel_id, im.message_text, im.created_at
    FROM inbound_messages im
    JOIN messaging_subscriptions ms ON im.subscription_id = ms.id
    WHERE ms.user_id = ? AND ms.provider = 'telegram'
      AND im.channel_id = ?
    ORDER BY im.created_at DESC
    LIMIT ?
  `).bind(d1Ctx.userId, chatId, limit).all<InboundMessageRow>();

  return { messages: rows.results || [] };
}

async function sendMessage(
  args: Record<string, unknown>,
  accessToken: string,
): Promise<{ message_id: number; chat_id: number }> {
  const chatId = args.chat_id as string;
  const text = args.text as string;
  if (!chatId) throw new Error('chat_id is required');
  if (!text) throw new Error('text is required');

  const params: Record<string, unknown> = { chat_id: chatId, text };
  if (args.parse_mode) params.parse_mode = args.parse_mode;

  const result = await telegramFetch('sendMessage', accessToken, params) as TelegramMessage;
  return { message_id: result.message_id, chat_id: result.chat.id };
}

async function replyThread(
  args: Record<string, unknown>,
  accessToken: string,
): Promise<{ message_id: number; chat_id: number }> {
  const chatId = args.chat_id as string;
  const messageId = args.message_id as string;
  const text = args.text as string;
  if (!chatId) throw new Error('chat_id is required');
  if (!messageId) throw new Error('message_id is required');
  if (!text) throw new Error('text is required');

  const result = await telegramFetch('sendMessage', accessToken, {
    chat_id: chatId,
    text,
    reply_to_message_id: Number(messageId),
  }) as TelegramMessage;

  return { message_id: result.message_id, chat_id: result.chat.id };
}

async function getChatInfo(
  args: Record<string, unknown>,
  accessToken: string,
): Promise<TelegramChat> {
  const chatId = args.chat_id as string;
  if (!chatId) throw new Error('chat_id is required');

  return await telegramFetch('getChat', accessToken, { chat_id: chatId }) as TelegramChat;
}

async function editMessage(
  args: Record<string, unknown>,
  accessToken: string,
): Promise<{ message_id: number; chat_id: number }> {
  const chatId = args.chat_id as string;
  const messageId = args.message_id as string;
  const text = args.text as string;
  if (!chatId) throw new Error('chat_id is required');
  if (!messageId) throw new Error('message_id is required');
  if (!text) throw new Error('text is required');

  const result = await telegramFetch('editMessageText', accessToken, {
    chat_id: chatId,
    message_id: Number(messageId),
    text,
  }) as TelegramMessage;

  return { message_id: result.message_id, chat_id: result.chat.id };
}

async function deleteMessage(
  args: Record<string, unknown>,
  accessToken: string,
): Promise<{ ok: boolean }> {
  const chatId = args.chat_id as string;
  const messageId = args.message_id as string;
  if (!chatId) throw new Error('chat_id is required');
  if (!messageId) throw new Error('message_id is required');

  await telegramFetch('deleteMessage', accessToken, {
    chat_id: chatId,
    message_id: Number(messageId),
  });

  return { ok: true };
}
