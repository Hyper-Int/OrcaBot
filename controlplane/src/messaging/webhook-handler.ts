// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: messaging-webhook-v46-discord-slash-commands
const MODULE_REVISION = 'messaging-webhook-v46-discord-slash-commands';
console.log(`[messaging-webhook] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Messaging Webhook Handler
 *
 * Processes inbound webhooks from messaging platforms (Slack, Discord, Telegram, etc.).
 * This handler runs in Cloudflare Workers which are always-on, so webhooks are always accepted
 * even when sandbox VMs are sleeping.
 *
 * Flow:
 * 1. Verify webhook signature (platform-specific)
 * 2. Parse and normalize message
 * 3. Deduplicate via unique index
 * 4. Load subscription + policy
 * 5. Enforce inbound policy (channel filter, sender filter)
 * 6. Buffer in inbound_messages table
 * 7. Attempt delivery or wake VM
 *
 * Security: Webhook endpoints are unauthenticated (platforms can't send auth tokens)
 * but are signature-verified per platform. Unverified webhooks are rejected.
 */

import type { Env, MessagingPolicy } from '../types';
import { deliverOrWakeAndDrain } from './delivery';

/** Messaging providers use edge-only authorization (no terminal_integrations / MCP tools). */
const MESSAGING_PROVIDERS = new Set(['whatsapp', 'slack', 'discord', 'teams', 'matrix', 'google_chat']);

// ============================================
// Types
// ============================================

export interface NormalizedMessage {
  platformMessageId: string;
  senderId: string;
  senderName: string;
  channelId: string;
  channelName: string;
  text: string;
  metadata: Record<string, unknown>;
}

// ============================================
// Error types
// ============================================

/**
 * Structured error for subscription creation failures.
 * The `code` field lets the HTTP route return a machine-readable 400 instead of a 500.
 */
export class SubscriptionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SubscriptionError';
  }
}

// ============================================
// Webhook Signature Verification
// ============================================

async function verifySlackSignature(
  request: Request,
  signingSecret: string,
): Promise<boolean> {
  const signature = request.headers.get('X-Slack-Signature');
  const timestamp = request.headers.get('X-Slack-Request-Timestamp');
  if (!signature || !timestamp) return false;

  // Reject requests older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  const parsedTimestamp = parseInt(timestamp, 10);
  if (!Number.isFinite(parsedTimestamp)) return false;
  if (Math.abs(now - parsedTimestamp) > 300) return false;

  const body = await request.clone().text();
  const basestring = `v0:${timestamp}:${body}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(basestring));
  const computed = `v0=${Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')}`;

  // Constant-time comparison
  if (computed.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

async function verifyDiscordSignature(
  request: Request,
  publicKey: string,
): Promise<boolean> {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp) return false;

  const body = await request.clone().text();
  const message = new TextEncoder().encode(timestamp + body);

  try {
    const keyData = new Uint8Array(publicKey.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const sigData = new Uint8Array(signature.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
    return await crypto.subtle.verify('Ed25519', key, sigData, message);
  } catch {
    return false;
  }
}

/**
 * Verify Telegram webhook via the X-Telegram-Bot-Api-Secret-Token header.
 *
 * When we call setWebhook, we pass our webhook_secret as the secret_token parameter.
 * Telegram then includes this token in every webhook request via this header.
 * This is the real verification — the hookId in the URL is just for routing,
 * not a substitute for cryptographic verification.
 */
function verifyTelegramSecret(request: Request, webhookSecret: string): boolean {
  const headerToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!headerToken || !webhookSecret) return false;

  // Constant-time comparison to prevent timing attacks
  if (headerToken.length !== webhookSecret.length) return false;
  let mismatch = 0;
  for (let i = 0; i < headerToken.length; i++) {
    mismatch |= headerToken.charCodeAt(i) ^ webhookSecret.charCodeAt(i);
  }
  return mismatch === 0;
}

async function verifyWhatsAppSignature(request: Request, appSecret: string): Promise<boolean> {
  const signature = request.headers.get('X-Hub-Signature-256');
  if (!signature) return false;

  // HMAC must be computed over the raw body bytes, not re-encoded text.
  // Using arrayBuffer() preserves the exact wire bytes and avoids false
  // negatives from non-ASCII characters or different JSON escaping.
  const rawBody = await request.clone().arrayBuffer();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, rawBody);
  const expected = 'sha256=' + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

  // Constant-time comparison
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

// ============================================
// Message Parsing (platform-specific → normalized)
// ============================================

function parseSlackEvent(body: Record<string, unknown>): NormalizedMessage | null {
  const event = body.event as Record<string, unknown> | undefined;
  if (!event || event.type !== 'message') return null;

  const subtype = event.subtype as string | undefined;

  // Ignore bot messages to prevent loops
  if (event.bot_id || subtype === 'bot_message') return null;

  // Only handle subtypes that represent actual user messages:
  // - undefined (no subtype) = standard new message from a user
  // - 'message_changed' = edited message, real text is in event.message.text
  // - 'file_share' = message with a file attachment
  // - 'thread_broadcast' = thread reply broadcast to channel
  // All other subtypes (message_deleted, channel_join, channel_leave, etc.)
  // are not user messages and should be ignored.
  const ACCEPTED_SUBTYPES = new Set<string | undefined>([
    undefined,
    'file_share',
    'thread_broadcast',
    'message_changed',
  ]);
  if (!ACCEPTED_SUBTYPES.has(subtype)) return null;

  // For message_changed, the actual text lives under event.message.
  // Use a composite platformMessageId (original_ts:edit:event_ts) so edits
  // don't collide with the original message on the dedup unique index.
  let text: string;
  let user: string;
  let messageId: string;
  if (subtype === 'message_changed') {
    const inner = event.message as Record<string, unknown> | undefined;
    if (!inner) return null;
    // Ignore bot edits
    if (inner.bot_id) return null;
    text = (inner.text as string) || '';
    user = (inner.user as string) || '';
    const originalTs = (inner.ts as string) || '';
    const editEventTs = (event.ts as string) || '';
    messageId = `${originalTs}:edit:${editEventTs}`;
  } else {
    text = (event.text as string) || '';
    user = (event.user as string) || '';
    messageId = (event.client_msg_id as string) || (event.ts as string) || '';
  }

  // Skip empty messages (can happen with deleted content or attachments-only)
  if (!text.trim()) return null;

  return {
    platformMessageId: messageId,
    senderId: user,
    senderName: user || 'unknown',
    channelId: (event.channel as string) || '',
    channelName: (event.channel as string) || '',
    text,
    metadata: {
      // For message_changed, thread_ts is on the inner event.message, not the outer event
      thread_ts: subtype === 'message_changed'
        ? ((event.message as Record<string, unknown> | undefined)?.thread_ts ?? event.thread_ts)
        : event.thread_ts,
      ts: event.ts,
      team: (body.team_id as string) || '',
      subtype: subtype || undefined,
      is_edit: subtype === 'message_changed',
    },
  };
}

function parseDiscordEvent(body: Record<string, unknown>): NormalizedMessage | null {
  // Discord Interactions endpoint sends different payload shapes:
  // - type 1 = PING (handled before parsing, returns { type: 1 })
  // - type 2 = APPLICATION_COMMAND
  // - type 3 = MESSAGE_COMPONENT
  // - type 4 = APPLICATION_COMMAND_AUTOCOMPLETE
  //
  // For bot-based Event Subscriptions (the correct approach for inbound messages),
  // Discord sends gateway-like events via HTTP POST with:
  //   { t: "MESSAGE_CREATE", d: { ... message data ... } }
  //
  // We support both formats for forward-compatibility.

  // Format 1: Gateway-style event (Discord Event Subscriptions / Bot webhooks)
  // These have a "t" field with the event name and "d" with the payload
  if (typeof body.t === 'string' && body.t === 'MESSAGE_CREATE' && body.d) {
    const data = body.d as Record<string, unknown>;
    const author = data.author as Record<string, unknown> | undefined;
    if (author?.bot) return null; // Ignore bot messages

    const content = ((data.content as string) || '').trim();
    // Skip empty messages (attachments-only, embeds-only, sticker-only, etc.)
    if (!content) return null;

    return {
      platformMessageId: (data.id as string) || '',
      senderId: (author?.id as string) || '',
      senderName: (author?.username as string) || 'unknown',
      channelId: (data.channel_id as string) || '',
      channelName: (data.channel_id as string) || '',
      text: content,
      metadata: {
        guild_id: data.guild_id,
        message_reference: data.message_reference,
      },
    };
  }

  // Format 2: Slash command interaction (type 2 = APPLICATION_COMMAND)
  // User typed /orcabot <message> — extract the message from options.
  if (body.type === 2) {
    const interactionData = body.data as Record<string, unknown> | undefined;
    const member = body.member as Record<string, unknown> | undefined;
    const user = (member?.user || body.user) as Record<string, unknown> | undefined;

    // Extract text from slash command options (e.g. /orcabot message:"hello")
    const options = interactionData?.options as Array<{ name: string; value: string }> | undefined;
    if (options?.length) {
      // Concatenate all string option values (typically just one "message" option)
      const text = options
        .map(o => (typeof o.value === 'string' ? o.value : String(o.value)))
        .join(' ')
        .trim();

      if (text) {
        return {
          platformMessageId: (body.id as string) || '',
          senderId: (user?.id as string) || '',
          senderName: (user?.username as string) || 'unknown',
          channelId: (body.channel_id as string) || '',
          channelName: (body.channel_id as string) || '',
          text,
          metadata: {
            guild_id: body.guild_id,
            interaction_type: 'slash_command',
            command_name: interactionData?.name,
          },
        };
      }
    }

    // Fallback: resolved message (e.g. message command — right-click → Apps → command)
    const resolved = interactionData?.resolved as Record<string, unknown> | undefined;
    const messages = resolved?.messages as Record<string, Record<string, unknown>> | undefined;
    if (messages) {
      const firstMessageId = Object.keys(messages)[0];
      if (firstMessageId) {
        const msg = messages[firstMessageId];
        const author = msg.author as Record<string, unknown> | undefined;
        if (author?.bot) return null;

        const resolvedContent = ((msg.content as string) || '').trim();
        if (!resolvedContent) return null;

        return {
          platformMessageId: (msg.id as string) || firstMessageId,
          senderId: (author?.id as string) || '',
          senderName: (author?.username as string) || 'unknown',
          channelId: (body.channel_id as string) || (msg.channel_id as string) || '',
          channelName: (body.channel_id as string) || (msg.channel_id as string) || '',
          text: resolvedContent,
          metadata: {
            guild_id: body.guild_id,
            interaction_type: 'message_command',
            command_name: interactionData?.name,
          },
        };
      }
    }
  }

  // Format 3: Message component interaction (type 3) — user clicked a button/select
  // These don't contain a new user message, so we skip them
  // Format 4: Autocomplete (type 4) — no message content

  return null;
}

function parseTelegramUpdate(body: Record<string, unknown>): NormalizedMessage | null {
  const message = body.message as Record<string, unknown> | undefined;
  if (!message) return null;
  const from = message.from as Record<string, unknown> | undefined;
  if (from?.is_bot) return null;
  const chat = message.chat as Record<string, unknown> | undefined;

  // Use text if present, fall back to caption for media messages (photos, videos, documents).
  // Skip empty messages (stickers, voice-only, location, etc. with no text/caption).
  const text = ((message.text as string) || (message.caption as string) || '').trim();
  if (!text) return null;

  return {
    platformMessageId: String(message.message_id || ''),
    senderId: String(from?.id || ''),
    senderName: (from?.username as string) || (from?.first_name as string) || 'unknown',
    channelId: String(chat?.id || ''),
    channelName: (chat?.title as string) || (chat?.username as string) || String(chat?.id || ''),
    text,
    metadata: {
      chat_type: chat?.type,
      reply_to_message_id: (message.reply_to_message as Record<string, unknown>)?.message_id,
      update_id: body.update_id,
    },
  };
}

/**
 * Normalize a WhatsApp phone number to digits-only canonical form.
 * WhatsApp Cloud API sends msg.from as pure digits (e.g. "15551234567").
 * But users or UIs may pass "+1 (555) 123-4567" or "+15551234567".
 * Stripping all non-digits ensures subscription chat_id matches inbound channelId.
 */
function normalizeWhatsAppPhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

function parseWhatsAppWebhook(body: Record<string, unknown>): NormalizedMessage[] {
  // WhatsApp Cloud API webhook format: { entry: [{ changes: [{ value: { messages: [...] } }] }] }
  // A single webhook can batch multiple entries/changes/messages — iterate all.
  const results: NormalizedMessage[] = [];
  const entries = body.entry as Array<Record<string, unknown>> | undefined;
  if (!entries) return results;

  for (const entry of entries) {
    const changes = entry.changes as Array<Record<string, unknown>> | undefined;
    if (!changes) continue;

    for (const change of changes) {
      const value = change.value as Record<string, unknown> | undefined;
      if (!value) continue;
      const messages = value.messages as Array<Record<string, unknown>> | undefined;
      if (!messages) continue;
      const contacts = value.contacts as Array<Record<string, unknown>> | undefined;

      for (const msg of messages) {
        if (msg.type !== 'text') continue; // Only handle text messages for now

        const textObj = msg.text as Record<string, unknown> | undefined;
        const text = ((textObj?.body as string) || '').trim();
        if (!text) continue;

        // Match contact by wa_id (phone) falling back to first contact.
        // Normalize to digits-only so subscription routing always matches.
        const rawSenderId = (msg.from as string) || '';
        const senderId = normalizeWhatsAppPhone(rawSenderId);
        const contact = contacts?.find(
          c => normalizeWhatsAppPhone((c.wa_id as string) || '') === senderId
        ) || contacts?.[0];

        results.push({
          platformMessageId: (msg.id as string) || '',
          senderId,
          senderName: (contact?.profile as Record<string, unknown>)?.name as string || senderId || 'unknown',
          channelId: senderId, // WhatsApp uses sender phone (digits-only) as channel
          channelName: (contact?.profile as Record<string, unknown>)?.name as string || senderId || '',
          text,
          metadata: {
            phone_number_id: value.metadata && (value.metadata as Record<string, unknown>).phone_number_id,
            timestamp: msg.timestamp,
            context: msg.context, // reply context
          },
        });
      }
    }
  }

  return results;
}

function parseTeamsActivity(body: Record<string, unknown>): NormalizedMessage | null {
  // Teams Bot Framework activity format
  if (body.type !== 'message') return null;

  const text = ((body.text as string) || '').trim();
  if (!text) return null;

  const from = body.from as Record<string, unknown> | undefined;
  const conversation = body.conversation as Record<string, unknown> | undefined;
  const channelData = body.channelData as Record<string, unknown> | undefined;

  // Teams channel messages have the real channel ID in channelData.channel.id;
  // conversation.id is the thread/conversation context, not the subscription channel.
  const teamsChannelId = (channelData?.channel as Record<string, unknown>)?.id as string | undefined;

  return {
    platformMessageId: (body.id as string) || '',
    senderId: (from?.id as string) || '',
    senderName: (from?.name as string) || 'unknown',
    channelId: teamsChannelId || (conversation?.id as string) || '',
    channelName: teamsChannelId || (conversation?.id as string) || '',
    text,
    metadata: {
      team_id: channelData?.team && (channelData.team as Record<string, unknown>).id,
      tenant_id: channelData?.tenant && (channelData.tenant as Record<string, unknown>).id,
      conversation_id: conversation?.id, // thread context for replies
      reply_to_id: body.replyToId,
    },
  };
}

function parseMatrixEvent(body: Record<string, unknown>): NormalizedMessage | null {
  // Matrix webhook / appservice format
  // For simple webhooks, the body is the event itself
  if (body.type !== 'm.room.message') return null;

  const content = body.content as Record<string, unknown> | undefined;
  if (!content) return null;

  const msgtype = content.msgtype as string;
  if (msgtype !== 'm.text') return null; // Only handle text messages

  const text = ((content.body as string) || '').trim();
  if (!text) return null;

  return {
    platformMessageId: (body.event_id as string) || '',
    senderId: (body.sender as string) || '',
    senderName: (body.sender as string) || 'unknown',
    channelId: (body.room_id as string) || '',
    channelName: (body.room_id as string) || '',
    text,
    metadata: {
      origin_server_ts: body.origin_server_ts,
      relates_to: content['m.relates_to'],
    },
  };
}

function parseGoogleChatEvent(body: Record<string, unknown>): NormalizedMessage | null {
  // Google Chat webhook format
  if (body.type !== 'MESSAGE') return null;

  const message = body.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const text = ((message.text as string) || (message.argumentText as string) || '').trim();
  if (!text) return null;

  const sender = message.sender as Record<string, unknown> | undefined;
  const space = message.space as Record<string, unknown> | undefined;
  const thread = message.thread as Record<string, unknown> | undefined;

  return {
    platformMessageId: (message.name as string) || '',
    senderId: (sender?.name as string) || '',
    senderName: (sender?.displayName as string) || 'unknown',
    channelId: (space?.name as string) || '',
    channelName: (space?.displayName as string) || (space?.name as string) || '',
    text,
    metadata: {
      space_type: space?.spaceType,
      thread_name: thread?.name,
    },
  };
}

// ============================================
// Channel Name Resolution
// ============================================

/**
 * Resolve a channel ID to a human-readable channel name via the platform API.
 *
 * Slack and Discord webhooks only include channel IDs, not names. Without resolution,
 * channel name allowlists in policies will never match. This function looks up the
 * bot token from user_integrations and calls the platform API.
 *
 * Falls back gracefully — returns null if resolution fails (API error, missing token, etc.)
 * so webhook processing continues with the channel ID as a fallback.
 */
async function resolveChannelName(
  env: Env,
  provider: string,
  channelId: string,
  userId: string,
): Promise<string | null> {
  if (!channelId) return null;

  try {
    if (provider === 'slack') {
      const integration = await env.DB.prepare(
        `SELECT access_token FROM user_integrations WHERE user_id = ? AND provider = 'slack'`
      ).bind(userId).first<{ access_token: string }>();

      if (!integration?.access_token) return null;

      const response = await fetch('https://slack.com/api/conversations.info', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${integration.access_token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: channelId }),
      });

      if (!response.ok) return null;
      const data = await response.json() as { ok: boolean; channel?: { name?: string } };
      return data.ok ? (data.channel?.name || null) : null;
    }

    if (provider === 'discord') {
      // Discord channel name resolution is not reliably possible with user OAuth tokens.
      // The GET /channels/:id endpoint requires a Bot token or guild-scoped permissions
      // that user OAuth tokens typically don't have. Discord policies must use channel IDs
      // (snowflakes), which are globally unique and always available in webhook payloads.
      // Channel name resolution is skipped; ID-based matching is authoritative.
      return null;
    }
  } catch (err) {
    console.error(`[webhook] Failed to resolve channel name for ${provider}/${channelId}:`, err);
  }

  return null;
}

/**
 * Resolve a Slack user ID to a human-readable display name via the Slack API.
 *
 * Slack Events API only includes the user ID (e.g., U01234ABCDE), not the display name.
 * Without resolution, senderFilter.userNames allowlists will never match.
 * Discord already includes the username in the webhook payload so doesn't need this.
 *
 * Falls back gracefully — returns null if resolution fails.
 */
async function resolveSlackSenderName(
  env: Env,
  senderId: string,
  userId: string,
): Promise<string | null> {
  if (!senderId) return null;

  try {
    const integration = await env.DB.prepare(
      `SELECT access_token FROM user_integrations WHERE user_id = ? AND provider = 'slack'`
    ).bind(userId).first<{ access_token: string }>();

    if (!integration?.access_token) return null;

    const response = await fetch('https://slack.com/api/users.info', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${integration.access_token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ user: senderId }),
    });

    if (!response.ok) return null;
    const data = await response.json() as {
      ok: boolean;
      user?: { name?: string; real_name?: string; profile?: { display_name?: string } };
    };

    if (!data.ok || !data.user) return null;

    // Prefer display_name > real_name > name (Slack username)
    return data.user.profile?.display_name || data.user.real_name || data.user.name || null;
  } catch (err) {
    console.error(`[webhook] Failed to resolve Slack sender name for ${senderId}:`, err);
    return null;
  }
}

/**
 * Strip leading '#' and lowercase a channel name for comparison.
 * Policies may be configured with "#general" or "general" from the UI;
 * inbound resolution returns "general", outbound returns "general" (after this fix).
 * Normalizing at comparison time means both work regardless of format.
 */
function normalizeChannelName(name: string): string {
  return name.replace(/^#/, '').toLowerCase();
}

/**
 * Check if a channel matches a policy's channel filter.
 * Checks both channelId and channelName against both channelIds and channelNames arrays,
 * so policies work regardless of whether they're configured with IDs or names,
 * and regardless of whether channelName has been correctly resolved.
 * All name comparisons strip leading '#' and normalize case.
 */
export function channelMatchesFilter(
  channelId: string,
  channelName: string,
  filterChannelIds?: string[],
  filterChannelNames?: string[],
): boolean {
  // Check channelId against the IDs list
  if (filterChannelIds?.includes(channelId)) return true;
  // Check channelName against the names list (normalized: strip # and lowercase)
  const normalizedName = normalizeChannelName(channelName);
  if (filterChannelNames?.some(n => normalizeChannelName(n) === normalizedName)) return true;
  // Cross-check: channelId against names list (for policies that put IDs in names)
  if (filterChannelNames?.some(n => normalizeChannelName(n) === channelId.toLowerCase())) return true;
  // Cross-check: channelName against IDs list (for old messages where name = ID)
  if (channelName && filterChannelIds?.includes(channelName)) return true;
  return false;
}

// ============================================
// Main Handler
// ============================================

/**
 * Handle an inbound webhook from a messaging platform.
 *
 * Routing model:
 * - Slack/Discord: Single global URL per provider (POST /webhooks/slack, /webhooks/discord).
 *   Events are routed to subscriptions by matching provider + channel_id from the parsed event.
 *   This matches how Slack Event Subscriptions and Discord webhooks work (one URL per app).
 * - Telegram: Per-subscription URL (POST /webhooks/telegram/:hookId) because Telegram's
 *   setWebhook registers a unique URL per bot token.
 *
 * All endpoints are unauthenticated but signature-verified per platform.
 */
export async function handleInboundWebhook(
  request: Request,
  env: Env,
  provider: string,
  hookId: string | undefined,
  ctx: ExecutionContext,
): Promise<Response> {
  // 1. Verify webhook signature FIRST, before any DB lookup or JSON parsing.
  let signatureValid = false;

  if (provider === 'telegram') {
    if (!hookId) {
      return Response.json({ error: 'E79430: Telegram webhooks require a hookId' }, { status: 400 });
    }
    // Telegram needs the subscription's webhook_secret for verification
    const sub = await env.DB.prepare(`
      SELECT webhook_secret FROM messaging_subscriptions
      WHERE webhook_id = ? AND provider = 'telegram'
      LIMIT 1
    `).bind(hookId).first<{ webhook_secret: string }>();
    // Return uniform 200 for unknown Telegram webhooks to prevent ID probing
    if (!sub) return Response.json({ ok: true });
    signatureValid = verifyTelegramSecret(request, sub.webhook_secret);
  } else {
    switch (provider) {
      case 'slack': {
        const signingSecret = env.SLACK_SIGNING_SECRET;
        if (!signingSecret) {
          console.error('[webhook] SLACK_SIGNING_SECRET not configured');
          return Response.json({ error: 'E79431: Server configuration error' }, { status: 500 });
        }
        signatureValid = await verifySlackSignature(request, signingSecret);
        break;
      }
      case 'discord': {
        const publicKey = env.DISCORD_PUBLIC_KEY;
        if (!publicKey) {
          console.error('[webhook] DISCORD_PUBLIC_KEY not configured');
          return Response.json({ error: 'E79432: Server configuration error' }, { status: 500 });
        }
        signatureValid = await verifyDiscordSignature(request, publicKey);
        break;
      }
      case 'whatsapp': {
        // WhatsApp Cloud API uses app secret for HMAC-SHA256 signature verification
        const appSecret = env.WHATSAPP_APP_SECRET;
        if (appSecret) {
          signatureValid = await verifyWhatsAppSignature(request, appSecret);
        } else if (env.DEV_AUTH_ENABLED === 'true') {
          // Only skip verification in explicit dev mode
          signatureValid = true;
        } else {
          console.error('[webhook] WHATSAPP_APP_SECRET not configured — rejecting webhook (set DEV_AUTH_ENABLED=true to bypass)');
          return Response.json({ error: 'E79433: Server configuration error' }, { status: 500 });
        }
        break;
      }
      case 'teams':
      case 'matrix':
      case 'google_chat': {
        // These providers require JWT or shared-secret verification that is not yet implemented.
        // Reject webhooks until proper verification is added to prevent message injection.
        console.error(`[webhook] Provider '${provider}' webhook verification not yet implemented — rejecting`);
        return Response.json({ error: 'E79434: Webhook verification not implemented for this provider' }, { status: 403 });
      }
      default:
        console.error(`[webhook] No verification for provider: ${provider}`);
        return Response.json({ error: 'E79435: Unsupported provider' }, { status: 400 });
    }
  }

  if (!signatureValid) {
    console.error(`[webhook] Signature verification failed for ${provider}/${hookId ?? 'global'}`);
    return Response.json({ error: 'E79436: Invalid signature' }, { status: 401 });
  }

  // 2. Parse body and handle platform handshakes BEFORE subscription lookup.
  let body: Record<string, unknown>;
  try {
    body = await request.clone().json() as Record<string, unknown>;
  } catch {
    console.error(`[webhook] Non-JSON or malformed payload from ${provider}/${hookId ?? 'global'}`);
    return Response.json({ error: 'E79437: Invalid JSON payload' }, { status: 400 });
  }

  if (provider === 'slack' && body.type === 'url_verification') {
    return Response.json({ challenge: body.challenge });
  }
  if (provider === 'discord' && body.type === 1) {
    return Response.json({ type: 1 }); // Discord PING acknowledgment
  }
  // Discord slash command (type 2): must respond within 3 seconds.
  // We parse, route, and process in the background, then return an immediate ack.
  if (provider === 'discord' && body.type === 2) {
    const discordMessage = parseDiscordEvent(body);
    if (!discordMessage) {
      // No parseable message — acknowledge silently
      return Response.json({ type: 4, data: { content: 'No message content found.', flags: 64 } });
    }

    // Route by channel_id to matching subscriptions (same as the main flow below)
    const channelId = discordMessage.channelId;
    if (channelId) {
      const results = await env.DB.prepare(`
        SELECT * FROM messaging_subscriptions
        WHERE provider = 'discord' AND channel_id = ? AND status = 'active'
      `).bind(channelId).all();
      const subs = (results.results || []).filter(s => s.status === 'active');

      for (const subscription of subs) {
        const msgClone: NormalizedMessage = {
          ...discordMessage,
          metadata: { ...discordMessage.metadata },
        };
        ctx.waitUntil(processSubscriptionMessage(env, 'discord', subscription, msgClone, body, ctx));
      }
    }

    // Return ephemeral ack (only visible to the user who ran the command)
    const userName = discordMessage.senderName || 'User';
    return Response.json({
      type: 4,
      data: {
        content: `**${userName}**: ${discordMessage.text}`,
      },
    });
  }
  // Google Chat ADDED_TO_SPACE / REMOVED_FROM_SPACE events
  if (provider === 'google_chat' && (body.type === 'ADDED_TO_SPACE' || body.type === 'REMOVED_FROM_SPACE')) {
    return Response.json({ text: '' });
  }

  // 3. Parse the message first (needed for channel-based routing for Slack/Discord).
  let message: NormalizedMessage | null = null;
  switch (provider) {
    case 'slack':
      message = parseSlackEvent(body);
      break;
    case 'discord':
      message = parseDiscordEvent(body);
      break;
    case 'telegram':
      message = parseTelegramUpdate(body);
      break;
    case 'whatsapp': {
      const whatsappMessages = parseWhatsAppWebhook(body);
      message = whatsappMessages[0] ?? null;
      // Process additional batched messages (2nd onward) after the primary flow below.
      // We store them for later so we don't restructure the entire handler.
      if (whatsappMessages.length > 1) {
        (body as Record<string, unknown>).__whatsappBatchedMessages = whatsappMessages.slice(1);
      }
      break;
    }
    case 'teams':
      message = parseTeamsActivity(body);
      break;
    case 'matrix':
      message = parseMatrixEvent(body);
      break;
    case 'google_chat':
      message = parseGoogleChatEvent(body);
      break;
  }

  if (!message) {
    return Response.json({ ok: true });
  }

  // 4. Look up matching subscriptions.
  // - Telegram: by webhook_id (per-subscription URL)
  // - Slack/Discord: by provider + channel_id (global URL, route by channel from event)
  //   A single event may match multiple subscriptions (different dashboards subscribed
  //   to the same channel). All matching active subscriptions receive the message.
  let subscriptions: Record<string, unknown>[];

  if (provider === 'telegram' && hookId) {
    const sub = await env.DB.prepare(`
      SELECT * FROM messaging_subscriptions
      WHERE webhook_id = ? AND provider = 'telegram'
      LIMIT 1
    `).bind(hookId).first();
    subscriptions = sub ? [sub] : [];
  } else if (provider === 'whatsapp') {
    // WhatsApp routes by channel_id (phone_number_id) and optionally chat_id (sender phone).
    // Supports two subscription models:
    // 1. Catch-all: chat_id IS NULL — receives messages from ANY sender to this business number
    // 2. Specific: chat_id = sender_phone — only messages from that sender
    const chatId = message.channelId;
    const phoneNumberId = message.metadata?.phone_number_id as string | undefined;
    if (!chatId || !phoneNumberId) return Response.json({ ok: true });
    const results = await env.DB.prepare(`
      SELECT * FROM messaging_subscriptions
      WHERE provider = 'whatsapp' AND channel_id = ? AND status = 'active'
        AND (chat_id IS NULL OR chat_id = ?)
    `).bind(phoneNumberId, chatId).all();
    // Filter out hybrid subscriptions — bridge handles inbound for those (prevents double-delivery)
    const allWhatsAppSubs = results.results || [];
    subscriptions = allWhatsAppSubs.filter(
      (s: Record<string, unknown>) => !s.hybrid_mode,
    );
  } else if (provider === 'matrix') {
    // Matrix uses chat_id (room_id) for routing
    const chatId = message.channelId;
    if (!chatId) return Response.json({ ok: true });
    const results = await env.DB.prepare(`
      SELECT * FROM messaging_subscriptions
      WHERE provider = 'matrix' AND chat_id = ? AND status = 'active'
    `).bind(chatId).all();
    subscriptions = results.results || [];
  } else {
    // Slack/Discord: find all active subscriptions for this channel
    const channelId = message.channelId;
    if (!channelId) {
      return Response.json({ ok: true }); // No channel in event — can't route
    }

    if (provider === 'slack') {
      // Slack channel IDs are only unique within a workspace (team). To prevent
      // cross-workspace misrouting, we include team_id in the lookup.
      // Fail-closed: if the webhook doesn't include team_id, we can't safely route.
      const teamId = body.team_id as string | undefined;
      if (!teamId) {
        console.error('[webhook] Slack event missing team_id — cannot route safely');
        return Response.json({ ok: true });
      }
      const results = await env.DB.prepare(`
        SELECT * FROM messaging_subscriptions
        WHERE provider = 'slack' AND team_id = ? AND channel_id = ? AND status = 'active'
      `).bind(teamId, channelId).all();
      subscriptions = results.results || [];
    } else {
      // Discord channel IDs (snowflakes) are globally unique — no guild scoping needed
      const results = await env.DB.prepare(`
        SELECT * FROM messaging_subscriptions
        WHERE provider = ? AND channel_id = ? AND status = 'active'
      `).bind(provider, channelId).all();
      subscriptions = results.results || [];
    }
  }

  if (!subscriptions.length) {
    return Response.json({ ok: true });
  }

  // Filter to active subscriptions only
  const beforeActiveFilter = subscriptions.length;
  subscriptions = subscriptions.filter(s => s.status === 'active');
  if (!subscriptions.length) {
    return Response.json({ ok: true });
  }

  // 4a. For each matching subscription, process the message.
  // Most of the time there's exactly one subscription per channel, but multiple
  // dashboards could subscribe to the same Slack/Discord channel.
  // IMPORTANT: Clone message per subscription. processSubscriptionMessage mutates
  // channelName/senderName via API resolution (using each subscription's user token).
  // Without cloning, concurrent waitUntil calls share the same object — one subscription's
  // resolved senderName could leak into another's policy check (sender allowlist).
  for (const subscription of subscriptions) {
    const msgClone: NormalizedMessage = {
      ...message,
      metadata: { ...message.metadata },
    };
    ctx.waitUntil(processSubscriptionMessage(env, provider, subscription, msgClone, body, ctx));
  }

  // Process additional WhatsApp batched messages (if any).
  // Each additional message goes through the same subscription-lookup + fan-out flow.
  // Include phone_number_id in lookup to prevent cross-tenant leakage.
  const batchedMessages = (body as Record<string, unknown>).__whatsappBatchedMessages as NormalizedMessage[] | undefined;
  if (batchedMessages?.length) {
    for (const batchedMsg of batchedMessages) {
      const chatId = batchedMsg.channelId;
      const batchPhoneNumberId = batchedMsg.metadata?.phone_number_id as string | undefined;
      if (!chatId || !batchPhoneNumberId) continue;
      const batchResults = await env.DB.prepare(`
        SELECT * FROM messaging_subscriptions
        WHERE provider = 'whatsapp' AND chat_id = ? AND channel_id = ? AND status = 'active'
      `).bind(chatId, batchPhoneNumberId).all();
      const batchSubs = (batchResults.results || []).filter(s => s.status === 'active');
      for (const sub of batchSubs) {
        const clone: NormalizedMessage = { ...batchedMsg, metadata: { ...batchedMsg.metadata } };
        ctx.waitUntil(processSubscriptionMessage(env, provider, sub, clone, body, ctx));
      }
    }
  }

  return Response.json({ ok: true });
}

/**
 * Process an inbound message for a single subscription.
 * Extracted from handleInboundWebhook to support fan-out to multiple subscriptions.
 */
async function processSubscriptionMessage(
  env: Env,
  provider: string,
  subscription: Record<string, unknown>,
  message: NormalizedMessage,
  body: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<void> {
  // Resolve channel name and sender name from platform API (best-effort, bounded).
  const RESOLVE_TIMEOUT_MS = 1500;
  if ((provider === 'slack' || provider === 'discord') && message.channelId) {
    const resolvePromises: Promise<void>[] = [];

    resolvePromises.push(
      resolveChannelName(env, provider, message.channelId, subscription.user_id as string)
        .then(name => { if (name) message.channelName = name; })
        .catch(() => { /* best-effort */ }),
    );

    if (provider === 'slack' && message.senderId) {
      resolvePromises.push(
        resolveSlackSenderName(env, message.senderId, subscription.user_id as string)
          .then(name => { if (name) message.senderName = name; })
          .catch(() => { /* best-effort */ }),
      );
    }

    await Promise.race([
      Promise.allSettled(resolvePromises),
      new Promise<void>(resolve => setTimeout(resolve, RESOLVE_TIMEOUT_MS)),
    ]);
  }

  // Enforce subscription channel scoping (Telegram uses chatId, Slack/Discord use channelId).
  // WhatsApp is special: channel_id stores phone_number_id (business number) and
  // chat_id stores sender phone. Both must match their respective incoming values.
  //
  // Bridge-sourced messages skip scope check: the webhook_id lookup already provides
  // 1:1 subscription scoping, and bridge messages don't carry Business API metadata
  // like phone_number_id.
  const isBridgeMessage = message.metadata?.source === 'bridge' || message.metadata?.source === 'bridge_outgoing';
  const subChannelId = subscription.channel_id as string | null;
  const subChatId = subscription.chat_id as string | null;
  const subChannelName = subscription.channel_name as string | null;
  if (!isBridgeMessage && (subChannelId || subChatId || subChannelName)) {
    const incomingChannel = message.channelId || '';
    const incomingName = normalizeChannelName(message.channelName || '');
    let scopeMatch = false;
    if (provider === 'whatsapp') {
      // WhatsApp: channel_id = phone_number_id, chat_id = sender phone.
      // message.channelId = sender phone, message.metadata.phone_number_id = business number.
      const incomingPhoneNumberId = message.metadata?.phone_number_id as string | undefined;
      const chatMatch = !subChatId || incomingChannel === subChatId;
      const phoneMatch = !subChannelId || (!!incomingPhoneNumberId && incomingPhoneNumberId === subChannelId);
      scopeMatch = chatMatch && phoneMatch;
    } else if (subChannelId) {
      scopeMatch = incomingChannel === subChannelId;
    } else if (subChatId) {
      scopeMatch = incomingChannel === subChatId;
    } else if (subChannelName) {
      scopeMatch = incomingName === normalizeChannelName(subChannelName);
    }
    if (!scopeMatch) {
      return;
    }
  }

  // Enforce messageFilter from the messaging block's metadata.
  // This gates messages server-side before buffering, matching the frontend filter.
  const messagingItemRow = await env.DB.prepare(
    'SELECT metadata FROM dashboard_items WHERE id = ?'
  ).bind(subscription.item_id).first<{ metadata: string }>();

  let itemMetadata: Record<string, unknown> = {};
  try { itemMetadata = JSON.parse(messagingItemRow?.metadata || '{}'); }
  catch { /* default to empty */ }
  const messageFilter = (itemMetadata.messageFilter as string) || 'orcabot';

  if (messageFilter === 'orcabot') {
    // Bridge messages carry explicit isOrcabotChat flag; Business API webhooks are always orcabot chat
    const isOrcabotChat = message.metadata?.isOrcabotChat === true;
    const isBridgeMsg = message.metadata?.source === 'bridge' || message.metadata?.source === 'bridge_outgoing';
    const isBusinessApiMsg = !isBridgeMsg;
    if (!isOrcabotChat && !isBusinessApiMsg) {
      return; // Non-orcabot message filtered by messageFilter setting
    }
  }

  // Enforce inbound policy gate.
  // Messaging providers: edge = authorization (no terminal_integrations / MCP needed).
  // Non-messaging providers: terminal_integration with policy required.
  // If no edges exist at all, fail-closed.
  //
  // For messaging providers, only count edges where the messaging block is the SOURCE
  // (i.e. WhatsApp→Terminal "Receive" edges). A Terminal→WhatsApp "Send" edge only
  // authorizes outbound delivery, NOT inbound message buffering.
  const anyEdges = MESSAGING_PROVIDERS.has(provider)
    ? await env.DB.prepare(`
        SELECT COUNT(*) as cnt FROM dashboard_edges WHERE source_item_id = ?
      `).bind(subscription.item_id).first<{ cnt: number }>()
    : await env.DB.prepare(`
        SELECT COUNT(*) as cnt FROM dashboard_edges WHERE source_item_id = ? OR target_item_id = ?
      `).bind(subscription.item_id, subscription.item_id).first<{ cnt: number }>();
  const hasAnyEdges = (anyEdges?.cnt || 0) > 0;

  if (MESSAGING_PROVIDERS.has(provider)) {
    // Messaging: edge = authorization, no terminal policy check
    if (!hasAnyEdges) return;
  } else {
    // Non-messaging: check terminal integration policies
    const terminalPolicies = await env.DB.prepare(`
      SELECT ip.policy
      FROM dashboard_edges de
      JOIN dashboard_items di ON di.id = de.target_item_id AND di.type = 'terminal'
      JOIN terminal_integrations ti ON ti.item_id = de.target_item_id AND ti.provider = ? AND ti.deleted_at IS NULL
      JOIN integration_policies ip ON ip.id = ti.active_policy_id
      WHERE de.source_item_id = ?
    `).bind(provider, subscription.item_id).all<{ policy: string }>();

    const policies = (terminalPolicies.results || []).map(row => {
      try { return JSON.parse(row.policy) as MessagingPolicy; }
      catch { return null; }
    }).filter((p): p is MessagingPolicy => p !== null);

    if (policies.length > 0) {
      const allowedByAnyPolicy = policies.some(policy => {
        if (!policy.canReceive) return false;

        if (policy.channelFilter) {
          if (policy.channelFilter.mode === 'allowlist') {
            const { channelIds, channelNames } = policy.channelFilter;
            const hasFilter = channelIds?.length || channelNames?.length;
            if (!hasFilter) return false;
            if (!channelMatchesFilter(message.channelId, message.channelName, channelIds, channelNames)) {
              return false;
            }
          }
        }

        if (policy.senderFilter && policy.senderFilter.mode !== 'all') {
          const { mode, userIds, userNames } = policy.senderFilter;
          const senderIdMatch = userIds?.includes(message.senderId);
          const senderNameMatch = userNames?.some(n =>
            n.toLowerCase() === message.senderName.toLowerCase()
          );
          if (mode === 'allowlist' && !senderIdMatch && !senderNameMatch) return false;
          if (mode === 'blocklist' && (senderIdMatch || senderNameMatch)) return false;
        }

        return true;
      });

      if (!allowedByAnyPolicy && !hasAnyEdges) {
        return;
      }
    } else if (!hasAnyEdges) {
      return;
    }
  }

  // Deduplicate and buffer message
  const messageId = crypto.randomUUID();
  const expiresDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const expiresAt = expiresDate.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

  try {
    await env.DB.prepare(`
      INSERT INTO inbound_messages (
        id, subscription_id, dashboard_id, provider,
        platform_message_id, sender_id, sender_name,
        channel_id, channel_name, message_text, message_metadata,
        status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'buffered', ?)
    `).bind(
      messageId,
      subscription.id,
      subscription.dashboard_id,
      provider,
      message.platformMessageId,
      message.senderId,
      message.senderName,
      message.channelId,
      message.channelName,
      message.text,
      JSON.stringify(message.metadata),
      expiresAt,
    ).run();
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      return; // Deduplicated
    }
    throw err;
  }

  await env.DB.prepare(`
    UPDATE messaging_subscriptions SET last_message_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).bind(subscription.id).run();

  // Attempt immediate delivery or wake VM (in background — already in waitUntil from caller)
  const dashboardId = subscription.dashboard_id as string;
  const messagingItemId = subscription.item_id as string;
  const userId = subscription.user_id as string;

  // Broadcast inbound_message event for frontend connection data flow.
  // Connected frontends will fire the message through edges to downstream blocks.
  // This is fire-and-forget — if no clients are connected, nothing happens.
  try {
    const doId = env.DASHBOARD.idFromName(dashboardId);
    const stub = env.DASHBOARD.get(doId);
    await stub.fetch(new Request('http://do/inbound-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item_id: messagingItemId,
        text: message.text,
        provider,
        sender_name: message.senderName || message.senderId || 'unknown',
        message_id: messageId,
        // Bridge messages carry explicit isOrcabotChat flag; Business API webhook
        // messages are always from users messaging OrcaBot directly, so default true.
        is_orcabot_chat: message.metadata?.isOrcabotChat !== undefined
          ? message.metadata.isOrcabotChat === true
          : true,
      }),
    }));
  } catch (err) {
    console.warn(`[webhook] Failed to broadcast inbound_message to DO for dashboard ${dashboardId}:`, err);
  }

  await deliverOrWakeAndDrain(env, dashboardId, messagingItemId, userId, provider).catch(err => {
    console.error(`[webhook] Background delivery failed for dashboard ${dashboardId}:`, err);
  });
}

// ============================================
// Subscription Management
// ============================================

/**
 * Create a messaging subscription for a dashboard block.
 *
 * For Telegram, this also calls the Telegram Bot API to register our webhook URL
 * with the secret_token so that Telegram sends the X-Telegram-Bot-Api-Secret-Token
 * header for verification. Other providers (Slack, Discord) configure their webhook
 * URLs in their respective developer portals.
 *
 * @param webhookBaseUrl - The control plane's external base URL (e.g., https://api.orcabot.com)
 *                         used to construct the webhook callback URL for Telegram.
 */
/**
 * Match a user_integration by a key in its JSON metadata column.
 * Returns the integration ID if exactly one match is found, or the first match otherwise.
 * Falls back to the first integration for the provider if no metadata match.
 */
async function matchIntegrationByMetadata(
  env: Env,
  userId: string,
  provider: string,
  metaKey: string,
  metaValue: string | null,
): Promise<string | null> {
  const rows = await env.DB.prepare(
    `SELECT id, metadata FROM user_integrations WHERE user_id = ? AND provider = ?`
  ).bind(userId, provider).all<{ id: string; metadata: string | null }>();

  const intRows = rows.results || [];
  if (intRows.length === 0) return null;
  if (intRows.length === 1) return intRows[0].id;

  // Multiple integrations — match by metadata key
  if (metaValue) {
    const matched = matchIntegrationByMetadataSync(intRows, metaKey, metaValue);
    if (matched) return matched;
  }

  // No match — return first as last resort
  return intRows[0].id;
}

/**
 * Synchronous helper: find integration whose metadata[key] matches the given value.
 */
function matchIntegrationByMetadataSync(
  rows: Array<{ id: string; metadata: string | null }>,
  metaKey: string,
  metaValue: string,
): string | null {
  for (const row of rows) {
    if (!row.metadata) continue;
    try {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      if (meta[metaKey] === metaValue) return row.id;
    } catch { /* skip malformed JSON */ }
  }
  return null;
}

export async function createSubscription(
  env: Env,
  dashboardId: string,
  itemId: string,
  userId: string,
  provider: string,
  data: {
    channelId?: string;
    channelName?: string;
    chatId?: string;
    teamId?: string;
  },
  webhookBaseUrl: string,
): Promise<{ id: string; webhookId: string }> {
  // Verify the item exists and its type matches the provider. The route handler checks this
  // too, but enforcing here protects against non-HTTP call paths (admin scripts, future code).
  const item = await env.DB.prepare(
    'SELECT type FROM dashboard_items WHERE id = ? AND dashboard_id = ?'
  ).bind(itemId, dashboardId).first<{ type: string }>();
  if (!item) {
    throw new Error(`Item ${itemId} not found in dashboard ${dashboardId}`);
  }
  if (item.type !== provider) {
    throw new Error(`Item type '${item.type}' does not match provider '${provider}'`);
  }

  // Validate provider-specific scope. Without this, subscriptions with null scope
  // bypass the unique index (COALESCE(NULL, NULL) = NULL is not unique-constrained in SQLite)
  // and will never match inbound webhook routing.
  if ((provider === 'slack' || provider === 'discord' || provider === 'teams' || provider === 'google_chat') && !data.channelId) {
    throw new Error(`channelId is required for ${provider} subscriptions`);
  }
  if ((provider === 'telegram' || provider === 'matrix') && !data.chatId) {
    throw new Error(`chatId is required for ${provider} subscriptions`);
  }
  // WhatsApp allows catch-all subscriptions (chatId omitted) for platform-level routing.
  // When chatId is null, all messages to the business number are delivered.

  // Normalize WhatsApp chatId to digits-only so it matches inbound webhook channelId.
  if (provider === 'whatsapp' && data.chatId) {
    data.chatId = normalizeWhatsAppPhone(data.chatId);
  }

  // Resolve phone_number_id for WhatsApp subscriptions.
  // WhatsApp chat_id (sender phone) is NOT globally unique — the same sender can message
  // different business numbers. Without phone_number_id scoping, inbound messages from
  // the same sender would be delivered to subscriptions for the wrong business number.
  // Resolution order: 1. Platform env var, 2. user_integrations metadata. Fail if not resolvable.
  if (provider === 'whatsapp' && !data.channelId) {
    // Try platform-level env var first
    if (env.WHATSAPP_PHONE_NUMBER_ID) {
      data.channelId = env.WHATSAPP_PHONE_NUMBER_ID;
    } else {
      // Fallback to per-user integration metadata
      const integration = await env.DB.prepare(
        `SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'whatsapp'`
      ).bind(userId).first<{ metadata: string }>();

      if (integration?.metadata) {
        try {
          const meta = JSON.parse(integration.metadata) as { phone_number_id?: string };
          if (meta.phone_number_id) {
            data.channelId = meta.phone_number_id;
          }
        } catch { /* parse failure */ }
      }
    }

    if (!data.channelId) {
      throw new Error(
        'WhatsApp phone_number_id could not be resolved. ' +
        'Set WHATSAPP_PHONE_NUMBER_ID env var or reconnect WhatsApp with your Business phone number ID.'
      );
    }
  }

  // Resolve user_integration_id for providers with OAuth tokens (Slack, Discord).
  // This ties the subscription to the exact workspace/server integration used at creation time,
  // preventing wrong-token selection when a user has multiple integrations for the same provider.
  let resolvedIntegrationId: string | null = null;

  // Resolve team_id for Slack subscriptions.
  // Slack channel IDs are only unique within a workspace, so we MUST store team_id
  // to prevent cross-workspace misrouting. When a user has multiple Slack workspaces,
  // we verify the channel exists in the matched workspace via conversations.info.
  let resolvedTeamId: string | null = data.teamId || null;
  if (provider === 'slack') {
    const slackInts = await env.DB.prepare(
      `SELECT id, access_token, metadata FROM user_integrations WHERE user_id = ? AND provider = 'slack'`
    ).bind(userId).all<{ id: string; access_token: string; metadata: string | null }>();

    const intRows = slackInts.results || [];

    if (intRows.length === 0) {
      throw new SubscriptionError(
        'SLACK_RECONNECT_REQUIRED',
        'No Slack integration found. Please connect Slack first.',
      );
    }

    // Build a map of integration_id → team_id from metadata (+ backfill via auth.test)
    const intTeamMap: Array<{ id: string; token: string; teamId: string | null }> = [];
    for (const row of intRows) {
      let teamId: string | null = null;
      if (row.metadata) {
        try {
          const meta = JSON.parse(row.metadata) as { team_id?: string };
          teamId = meta.team_id || null;
        } catch { /* ignore */ }
      }
      // Backfill via auth.test for legacy integrations missing team_id
      if (!teamId && row.access_token) {
        try {
          const resp = await fetch('https://slack.com/api/auth.test', {
            headers: { Authorization: `Bearer ${row.access_token}` },
          });
          if (resp.ok) {
            const authResult = await resp.json() as { ok: boolean; team_id?: string; team?: string };
            if (authResult.ok && authResult.team_id) {
              teamId = authResult.team_id;
              const existingMeta = row.metadata ? JSON.parse(row.metadata) : {};
              existingMeta.team_id = authResult.team_id;
              if (authResult.team) existingMeta.team_name = authResult.team;
              await env.DB.prepare(
                `UPDATE user_integrations SET metadata = ?, updated_at = datetime('now') WHERE id = ?`
              ).bind(JSON.stringify(existingMeta), row.id).run();
              console.log(`[messaging] Backfilled team_id=${authResult.team_id} for Slack integration ${row.id}`);
            }
          }
        } catch (err) {
          console.error(`[messaging] auth.test backfill failed for integration ${row.id}:`, err);
        }
      }
      intTeamMap.push({ id: row.id, token: row.access_token, teamId });
    }

    if (resolvedTeamId) {
      // team_id already provided — match integration by team_id
      const match = intTeamMap.find((r) => r.teamId === resolvedTeamId);
      resolvedIntegrationId = match?.id || intTeamMap[0].id;
    } else if (intRows.length === 1) {
      // Single integration — no ambiguity
      resolvedIntegrationId = intTeamMap[0].id;
      resolvedTeamId = intTeamMap[0].teamId;
    } else if (data.channelId) {
      // Multiple integrations, no team_id — verify which workspace owns the channel
      for (const row of intTeamMap) {
        if (!row.token) continue;
        try {
          const resp = await fetch(`https://slack.com/api/conversations.info?channel=${data.channelId}`, {
            headers: { Authorization: `Bearer ${row.token}` },
          });
          if (resp.ok) {
            const result = await resp.json() as { ok: boolean; channel?: { id: string } };
            if (result.ok) {
              resolvedIntegrationId = row.id;
              resolvedTeamId = row.teamId;
              break;
            }
          }
        } catch { /* try next */ }
      }
      // Fallback if no workspace claimed the channel
      if (!resolvedIntegrationId) {
        resolvedIntegrationId = intTeamMap[0].id;
        resolvedTeamId = intTeamMap[0].teamId;
      }
    } else {
      // No channel, no team — pick first
      resolvedIntegrationId = intTeamMap[0].id;
      resolvedTeamId = intTeamMap[0].teamId;
    }

    if (!resolvedTeamId) {
      throw new SubscriptionError(
        'SLACK_RECONNECT_REQUIRED',
        'Slack team could not be identified. Please disconnect and reconnect Slack to continue.',
      );
    }
  }

  // Resolve integration ID for Discord.
  // Discord channels are scoped to a guild. When a user has multiple Discord integrations
  // (multiple bots/servers), discover which guild owns the channel via the Discord API,
  // then match the integration whose metadata contains that guild_id.
  if (provider === 'discord') {
    const discordInts = await env.DB.prepare(
      `SELECT id, access_token, metadata FROM user_integrations WHERE user_id = ? AND provider = 'discord'`
    ).bind(userId).all<{ id: string; access_token: string; metadata: string | null }>();

    const intRows = discordInts.results || [];
    if (intRows.length === 1) {
      resolvedIntegrationId = intRows[0].id;
    } else if (intRows.length > 1 && data.channelId) {
      // Multiple integrations — discover which guild owns this channel
      let channelGuildId: string | null = null;
      for (const row of intRows) {
        try {
          const resp = await fetch(`https://discord.com/api/v10/channels/${data.channelId}`, {
            headers: { Authorization: `Bot ${row.access_token}` },
          });
          if (resp.ok) {
            const ch = await resp.json() as { guild_id?: string };
            channelGuildId = ch.guild_id || null;
            break;
          }
        } catch { /* try next token */ }
      }
      if (channelGuildId) {
        resolvedIntegrationId = matchIntegrationByMetadataSync(intRows, 'guild_id', channelGuildId);
      }
      if (!resolvedIntegrationId) {
        resolvedIntegrationId = intRows[0].id;
      }
    } else if (intRows.length > 1) {
      resolvedIntegrationId = intRows[0].id;
    }
  }

  // Guard against duplicate active subscriptions for the same block + provider + channel + chat.
  // Multi-channel per block is allowed — each (channel_id, chat_id) pair gets its own row.
  // The partial unique index uses COALESCE(..., '') on both columns to match this check.
  const hasScope = data.channelId || data.chatId;
  const existing = hasScope ? await env.DB.prepare(`
    SELECT id, webhook_id, channel_id, channel_name, chat_id, team_id FROM messaging_subscriptions
    WHERE dashboard_id = ? AND item_id = ? AND provider = ?
      AND COALESCE(channel_id, '') = ?
      AND COALESCE(chat_id, '') = ?
      AND status IN ('pending', 'active')
    LIMIT 1
  `).bind(dashboardId, itemId, provider, data.channelId || '', data.chatId || '').first<{
    id: string; webhook_id: string;
    channel_id: string | null; channel_name: string | null; chat_id: string | null; team_id: string | null;
  }>() : null;

  if (existing) {
    // Reconcile metadata that may have changed (team_id, channel_name).
    const metadataChanged =
      (data.channelName ?? null) !== existing.channel_name ||
      resolvedTeamId !== existing.team_id;

    if (metadataChanged) {
      await env.DB.prepare(`
        UPDATE messaging_subscriptions
        SET channel_name = ?, team_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        data.channelName ?? existing.channel_name,
        resolvedTeamId ?? existing.team_id,
        existing.id,
      ).run();
      console.log(`[messaging] Reconciled subscription ${existing.id} metadata: ` +
        `name=${data.channelName ?? 'unchanged'}, team=${resolvedTeamId ?? 'unchanged'}`);
    }

    return { id: existing.id, webhookId: existing.webhook_id };
  }

  // Telegram: enforce one active subscription per user globally.
  // Telegram's setWebhook is per-bot (one URL per bot token). Creating a second
  // subscription would overwrite the first's webhook, and deleting either would
  // call deleteWebhook, breaking all subscriptions. Guard against this.
  if (provider === 'telegram') {
    const existingTelegram = await env.DB.prepare(`
      SELECT id, dashboard_id, item_id FROM messaging_subscriptions
      WHERE user_id = ? AND provider = 'telegram' AND status IN ('pending', 'active')
      LIMIT 1
    `).bind(userId).first<{ id: string; dashboard_id: string; item_id: string }>();

    if (existingTelegram) {
      throw new Error(
        `Only one active Telegram subscription per bot is allowed. ` +
        `Existing subscription ${existingTelegram.id} on dashboard ${existingTelegram.dashboard_id}. ` +
        `Delete it first to create a new one.`
      );
    }
  }

  const id = crypto.randomUUID();
  const webhookId = crypto.randomUUID();
  const webhookSecret = crypto.randomUUID(); // Used for webhook signature verification

  await env.DB.prepare(`
    INSERT INTO messaging_subscriptions (
      id, dashboard_id, item_id, user_id, provider,
      channel_id, channel_name, chat_id, team_id,
      webhook_id, webhook_secret, status, user_integration_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).bind(
    id, dashboardId, itemId, userId, provider,
    data.channelId || null,
    data.channelName || null,
    data.chatId || null,
    resolvedTeamId,
    webhookId,
    webhookSecret,
    resolvedIntegrationId,
  ).run();

  // For Discord: register /orcabot slash command as a guild command (instant availability).
  // Resolve guild_id from the integration metadata or by looking up the channel.
  if (provider === 'discord' && resolvedIntegrationId) {
    try {
      const intRow = await env.DB.prepare(
        'SELECT metadata FROM user_integrations WHERE id = ?'
      ).bind(resolvedIntegrationId).first<{ metadata: string | null }>();
      let guildId: string | null = null;
      if (intRow?.metadata) {
        try { guildId = (JSON.parse(intRow.metadata) as Record<string, string>).guild_id || null; } catch { /* */ }
      }
      // Fallback: resolve guild_id from channel
      if (!guildId && data.channelId && env.DISCORD_BOT_TOKEN) {
        try {
          const resp = await fetch(`https://discord.com/api/v10/channels/${data.channelId}`, {
            headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
          });
          if (resp.ok) {
            guildId = ((await resp.json()) as { guild_id?: string }).guild_id || null;
          }
        } catch { /* */ }
      }
      if (guildId) {
        await ensureDiscordSlashCommand(env, guildId);
      }
    } catch (err) {
      console.warn('[messaging] Failed to register Discord slash command (non-fatal):', err);
    }
  }

  // For Telegram: register the webhook URL with the Bot API so inbound messages arrive
  if (provider === 'telegram') {
    try {
      await registerTelegramWebhook(env, userId, webhookBaseUrl, webhookId, webhookSecret);
    } catch (err) {
      // Mark subscription as errored so it's not used for delivery
      await env.DB.prepare(`
        UPDATE messaging_subscriptions SET status = 'error', error_message = ? WHERE id = ?
      `).bind(
        err instanceof Error ? err.message : 'Failed to register webhook with Telegram',
        id,
      ).run();
      throw err;
    }
  }

  return { id, webhookId };
}

/**
 * Register a webhook URL with the Telegram Bot API.
 *
 * Calls setWebhook with our webhook URL and secret_token so that
 * Telegram sends the X-Telegram-Bot-Api-Secret-Token header for verification.
 *
 * Requires the user's Telegram bot token in user_integrations.
 */
async function registerTelegramWebhook(
  env: Env,
  userId: string,
  webhookBaseUrl: string,
  webhookId: string,
  webhookSecret: string,
): Promise<void> {
  // Look up the bot token from user_integrations
  const integration = await env.DB.prepare(
    `SELECT access_token FROM user_integrations WHERE user_id = ? AND provider = 'telegram'`
  ).bind(userId).first<{ access_token: string }>();

  if (!integration?.access_token) {
    throw new Error('Telegram bot token not found — connect Telegram first');
  }

  const callbackUrl = `${webhookBaseUrl.replace(/\/$/, '')}/webhooks/telegram/${webhookId}`;

  const response = await fetch(
    `https://api.telegram.org/bot${integration.access_token}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: callbackUrl,
        secret_token: webhookSecret,
        allowed_updates: ['message'],
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram setWebhook failed: ${response.status} — ${text}`);
  }

  const result = await response.json() as { ok: boolean; description?: string };
  if (!result.ok) {
    throw new Error(`Telegram setWebhook error: ${result.description || 'unknown'}`);
  }

  console.log(`[subscription] Registered Telegram webhook for user ${userId}: ${callbackUrl}`);
}

/**
 * Register the /orcabot slash command for a specific Discord guild.
 * Guild commands are available instantly (unlike global commands which take up to 1 hour).
 * Uses the bulk overwrite endpoint which is idempotent — safe to call on every subscription creation.
 */
async function ensureDiscordSlashCommand(env: Env, guildId: string): Promise<void> {
  const botToken = env.DISCORD_BOT_TOKEN;
  const clientId = env.DISCORD_CLIENT_ID;
  if (!botToken || !clientId) {
    throw new Error('DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID required');
  }

  const commands = [
    {
      name: 'orcabot',
      description: 'Send a message to OrcaBot',
      type: 1, // CHAT_INPUT (slash command)
      options: [
        {
          name: 'message',
          description: 'The message to send',
          type: 3, // STRING
          required: true,
        },
      ],
    },
  ];

  const response = await fetch(
    `https://discord.com/api/v10/applications/${clientId}/guilds/${guildId}/commands`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord guild command registration failed: ${response.status} — ${text}`);
  }

  console.log(`[subscription] Discord /orcabot slash command registered for guild ${guildId}`);
}

/**
 * List messaging subscriptions for a dashboard.
 * Returns a redacted shape — webhook_id, webhook_secret, and user_id are never
 * exposed. webhook_id/webhook_secret are sensitive (especially for Telegram
 * where the URL is the secret). user_id is an internal identifier that peers
 * on the same dashboard don't need and shouldn't see.
 */
export async function listSubscriptions(
  env: Env,
  dashboardId: string,
): Promise<unknown[]> {
  const result = await env.DB.prepare(`
    SELECT id, dashboard_id, item_id, provider,
           channel_id, channel_name, chat_id,
           status, last_message_at, error_message,
           created_at, updated_at
    FROM messaging_subscriptions
    WHERE dashboard_id = ? AND status != 'error'
    ORDER BY created_at DESC
  `).bind(dashboardId).all();

  return result.results || [];
}

/**
 * Delete a messaging subscription.
 * For Telegram, also deregisters the webhook with the Bot API so Telegram
 * stops sending requests to the now-dead URL. Without this, Telegram retries
 * for hours and the user believes they've disconnected but traffic continues.
 */
export async function deleteSubscription(
  env: Env,
  subscriptionId: string,
  userId: string,
): Promise<void> {
  // Load subscription before deleting to check provider and webhook_id
  const sub = await env.DB.prepare(`
    SELECT provider, webhook_id FROM messaging_subscriptions
    WHERE id = ? AND user_id = ?
  `).bind(subscriptionId, userId).first<{ provider: string; webhook_id: string }>();

  // Delete the subscription row first
  await env.DB.prepare(`
    DELETE FROM messaging_subscriptions
    WHERE id = ? AND user_id = ?
  `).bind(subscriptionId, userId).run();

  // For Telegram: only deregister the webhook if no other active Telegram
  // subscriptions remain for this user. With the single-subscription guard in
  // createSubscription this should always be the case, but check defensively.
  if (sub?.provider === 'telegram') {
    const remaining = await env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM messaging_subscriptions
      WHERE user_id = ? AND provider = 'telegram' AND status IN ('pending', 'active')
    `).bind(userId).first<{ cnt: number }>();

    if (!remaining?.cnt) {
      try {
        await deregisterTelegramWebhook(env, userId);
      } catch (err) {
        // Best-effort: log but don't block
        console.error(`[subscription] Failed to deregister Telegram webhook for user ${userId}:`, err);
      }
    }
  }

  // For bridge (personal WhatsApp): stop the Baileys session so it doesn't
  // continue ingesting messages after the subscription is deleted.
  if (sub?.webhook_id?.startsWith('bridge_') && env.BRIDGE_URL && env.BRIDGE_INTERNAL_TOKEN) {
    try {
      const { BridgeClient } = await import('../bridge/client');
      const bridge = new BridgeClient(env.BRIDGE_URL, env.BRIDGE_INTERNAL_TOKEN);
      await bridge.stopSession(sub.webhook_id);
      console.log(`[subscription] Stopped bridge session ${sub.webhook_id}`);
    } catch (err) {
      // Best-effort: bridge may already be stopped or unreachable
      console.error(`[subscription] Failed to stop bridge session ${sub.webhook_id}:`, err);
    }
  }
}

/**
 * Deregister the Telegram webhook by calling deleteWebhook.
 * This tells Telegram to stop sending updates to our URL.
 */
async function deregisterTelegramWebhook(env: Env, userId: string): Promise<void> {
  const integration = await env.DB.prepare(
    `SELECT access_token FROM user_integrations WHERE user_id = ? AND provider = 'telegram'`
  ).bind(userId).first<{ access_token: string }>();

  if (!integration?.access_token) return;

  const response = await fetch(
    `https://api.telegram.org/bot${integration.access_token}/deleteWebhook`,
    { method: 'POST' },
  );

  if (!response.ok) {
    const text = await response.text();
    console.warn(`[subscription] Telegram deleteWebhook returned ${response.status}: ${text}`);
  } else {
    console.log(`[subscription] Deregistered Telegram webhook for user ${userId}`);
  }
}

// ============================================
// Bridge Inbound Handler
// ============================================

/**
 * Handle an inbound message from the bridge service.
 *
 * The bridge maintains persistent WebSocket/long-poll connections (e.g. WhatsApp
 * personal via Baileys, Matrix /sync) and forwards normalized messages here.
 * Auth is via X-Bridge-Token (shared secret), not per-platform webhook signatures.
 *
 * This reuses the existing processSubscriptionMessage() pipeline for policy
 * enforcement, deduplication, buffering, and delivery.
 */
export async function handleBridgeInbound(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // 1. Verify bridge token
  const token = request.headers.get('X-Bridge-Token');
  if (!env.BRIDGE_INTERNAL_TOKEN || token !== env.BRIDGE_INTERNAL_TOKEN) {
    return Response.json({ error: 'E79438: Unauthorized' }, { status: 401 });
  }

  // 2. Parse normalized message from bridge
  let body: {
    provider: string;
    webhookId: string;
    platformMessageId: string;
    senderId: string;
    senderName: string;
    channelId: string;
    text: string;
    metadata: Record<string, unknown>;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: 'E79439: Invalid JSON payload' }, { status: 400 });
  }

  if (!body.provider || !body.webhookId || !body.text) {
    return Response.json({ error: 'E79440: provider, webhookId, and text are required' }, { status: 400 });
  }

  // 3. Handle handshake notifications from hybrid mode bridge
  if (body.metadata?.isHandshake === true) {
    const sub = await env.DB.prepare(`
      SELECT * FROM messaging_subscriptions
      WHERE webhook_id = ? AND provider = ? AND status IN ('pending', 'active')
      LIMIT 1
    `).bind(body.webhookId, body.provider).first<Record<string, unknown>>();

    if (!sub) return Response.json({ ok: true });

    // Store user phone from handshake metadata
    const userPhone = (body.metadata.userPhone as string) || null;
    if (userPhone && !sub.user_phone) {
      ctx.waitUntil(
        env.DB.prepare(`
          UPDATE messaging_subscriptions SET user_phone = ?, updated_at = datetime('now')
          WHERE id = ? AND user_phone IS NULL
        `).bind(userPhone, sub.id).run(),
      );
    }

    // Reply via Business API: "Connected to OrcaBot"
    const replyPhone = userPhone || (sub.user_phone as string);
    if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && replyPhone) {
      ctx.waitUntil((async () => {
        try {
          const { executeWhatsAppAction } = await import('../integration-policies/api-clients/whatsapp');
          await executeWhatsAppAction('whatsapp.send_message', {
            phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID,
            to: replyPhone,
            text: 'Connected to OrcaBot',
          }, env.WHATSAPP_ACCESS_TOKEN!);
          console.log(`[bridge-inbound] Handshake reply sent to ${replyPhone}`);
        } catch (err) {
          console.error('[bridge-inbound] Handshake reply failed:', err);
        }
      })());
    }

    // Update handshake timestamp + mark active
    ctx.waitUntil(
      env.DB.prepare(`
        UPDATE messaging_subscriptions
        SET hybrid_handshake_at = datetime('now'), status = 'active', updated_at = datetime('now')
        WHERE id = ?
      `).bind(sub.id).run(),
    );

    return Response.json({ ok: true, handshake: 'completed' });
  }

  // 4. Look up subscription by webhook_id
  const sub = await env.DB.prepare(`
    SELECT * FROM messaging_subscriptions
    WHERE webhook_id = ? AND provider = ? AND status IN ('pending', 'active')
    LIMIT 1
  `).bind(body.webhookId, body.provider).first();

  if (!sub) {
    return Response.json({ ok: true }); // Don't reveal subscription existence
  }

  // 5. Store user's phone on first bridge message for handshake routing
  if (!sub.user_phone && body.senderId && body.senderId !== '__system__' && body.senderId !== 'unknown') {
    ctx.waitUntil(
      env.DB.prepare(`
        UPDATE messaging_subscriptions SET user_phone = ?, updated_at = datetime('now')
        WHERE id = ? AND user_phone IS NULL
      `).bind(body.senderId, sub.id).run(),
    );
  }

  // 6. Build NormalizedMessage and reuse existing pipeline
  const message: NormalizedMessage = {
    platformMessageId: body.platformMessageId || `bridge-${crypto.randomUUID()}`,
    senderId: body.senderId || 'unknown',
    senderName: body.senderName || body.senderId || 'unknown',
    channelId: body.channelId || '',
    channelName: '',
    text: body.text,
    metadata: { ...(body.metadata ?? {}), source: 'bridge' },
  };

  // Process in background (same pattern as webhook handler)
  ctx.waitUntil(
    processSubscriptionMessage(env, body.provider, sub, message, body as Record<string, unknown>, ctx).catch(err => {
      console.error(`[bridge-inbound] processSubscriptionMessage failed for sub=${sub.id}:`, err);
    }),
  );

  // Mark subscription as active on first bridge message if still pending
  if (sub.status === 'pending') {
    ctx.waitUntil(
      env.DB.prepare(`
        UPDATE messaging_subscriptions SET status = 'active', updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'
      `).bind(sub.id).run(),
    );
  }

  return Response.json({ ok: true });
}
