// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: messaging-send-v4-clean-logging
const MODULE_REVISION = 'messaging-send-v4-clean-logging';
console.log(`[messaging-send] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Outbound messaging send handler.
 *
 * When a terminal/prompt fires output into a messaging block's input handle,
 * the frontend calls this endpoint to send the text as a reply on the
 * appropriate communication channel (WhatsApp, Slack, Discord).
 *
 * Reply targeting is automatic: the most recent inbound message determines
 * the recipient/channel/thread.
 */

import type { Env, MessagingProvider } from '../types';
import { executeWhatsAppAction } from '../integration-policies/api-clients/whatsapp';
import { executeSlackAction } from '../integration-policies/api-clients/slack';
import { executeDiscordAction } from '../integration-policies/api-clients/discord';
import { getAccessToken } from '../integration-policies/token-refresh';
import { BridgeClient } from '../bridge/client';

interface SendRequest {
  dashboardId: string;
  itemId: string;
  text: string;
}

interface SubscriptionRow {
  id: string;
  dashboard_id: string;
  item_id: string;
  user_id: string;
  provider: string;
  channel_id: string | null;
  channel_name: string | null;
  chat_id: string | null;
  team_id: string | null;
  webhook_id: string | null;
  status: string;
  hybrid_mode: number;
  user_phone: string | null;
  user_integration_id: string | null;
}

interface InboundMessageRow {
  id: string;
  subscription_id: string;
  provider: string;
  platform_message_id: string;
  sender_id: string | null;
  sender_name: string | null;
  channel_id: string | null;
  message_metadata: string;
}

/**
 * Handle POST /messaging/send
 *
 * Looks up active subscriptions for the messaging block item,
 * finds recent inbound context for reply targeting, and sends
 * the message via the appropriate provider API.
 */
export async function handleMessagingSend(
  env: Env,
  userId: string,
  body: SendRequest,
): Promise<Response> {
  const { dashboardId, itemId, text } = body;

  if (!dashboardId || !itemId || !text?.trim()) {
    return Response.json(
      { error: 'dashboardId, itemId, and text are required' },
      { status: 400 },
    );
  }

  // Verify user has access to the dashboard
  const membership = await env.DB.prepare(
    `SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?`
  ).bind(dashboardId, userId).first<{ role: string }>();
  if (!membership) {
    return Response.json({ error: 'Not a member of this dashboard' }, { status: 403 });
  }

  // Find active subscriptions for this messaging block item
  const subs = await env.DB.prepare(`
    SELECT * FROM messaging_subscriptions
    WHERE item_id = ? AND dashboard_id = ? AND status IN ('pending', 'active')
  `).bind(itemId, dashboardId).all<SubscriptionRow>();

  if (!subs.results?.length) {
    return Response.json(
      { error: 'No active messaging subscriptions for this block' },
      { status: 404 },
    );
  }

  const results: Array<{ provider: string; ok: boolean; error?: string; messageId?: string }> = [];

  for (const sub of subs.results) {
    try {
      const result = await sendToSubscription(env, sub, text.trim());
      results.push({ provider: sub.provider, ok: true, messageId: result.messageId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[messaging-send] Failed to send via ${sub.provider} sub=${sub.id}:`, msg);
      results.push({ provider: sub.provider, ok: false, error: msg });
    }
  }

  const anySuccess = results.some((r) => r.ok);
  return Response.json(
    { ok: anySuccess, results },
    { status: anySuccess ? 200 : 502 },
  );
}

async function sendToSubscription(
  env: Env,
  sub: SubscriptionRow,
  text: string,
): Promise<{ messageId?: string }> {
  const provider = sub.provider as MessagingProvider;

  switch (provider) {
    case 'whatsapp':
      return sendWhatsApp(env, sub, text);
    case 'slack':
      return sendSlack(env, sub, text);
    case 'discord':
      return sendDiscord(env, sub, text);
    default:
      throw new Error(`Outbound send not yet supported for provider: ${provider}`);
  }
}

// ===== WhatsApp =====

async function sendWhatsApp(
  env: Env,
  sub: SubscriptionRow,
  text: string,
): Promise<{ messageId?: string }> {
  // Find the most recent inbound message for reply targeting
  const recent = await getRecentInbound(env, sub.id);

  // Determine recipient phone
  let recipientPhone: string | null = null;
  if (recent?.sender_id) {
    recipientPhone = recent.sender_id;
  } else if (sub.user_phone) {
    recipientPhone = sub.user_phone;
  }

  if (!recipientPhone) {
    throw new Error('No recipient phone — no inbound messages received yet');
  }

  // Determine phone_number_id for Business API
  const phoneNumberId = sub.channel_id || env.WHATSAPP_PHONE_NUMBER_ID;

  // In hybrid mode, the bridge is the user's PERSONAL WhatsApp (for inbound monitoring).
  // Outbound replies must go through Business API so they appear FROM the OrcaBot number.
  // Only use bridge for outbound in NON-hybrid (pure bridge) mode.
  if (!sub.hybrid_mode && sub.webhook_id?.startsWith('bridge_')) {
    try {
      const jid = `${recipientPhone}@s.whatsapp.net`;
      const bridge = new BridgeClient(env.BRIDGE_URL!, env.BRIDGE_INTERNAL_TOKEN!);
      const result = await bridge.sendMessage(sub.webhook_id, jid, text);
      if (result.ok) {
        return { messageId: result.messageId };
      }
    } catch (err) {
      console.warn(`[messaging-send] Bridge send failed, falling back to Business API:`, err);
    }
  }

  // Fall back to Business API
  if (!env.WHATSAPP_ACCESS_TOKEN || !phoneNumberId) {
    throw new Error('WhatsApp Business API not configured (missing access token or phone number ID)');
  }

  const result = await executeWhatsAppAction('whatsapp.send_message', {
    phone_number_id: phoneNumberId,
    to: recipientPhone,
    text,
  }, env.WHATSAPP_ACCESS_TOKEN) as { messages?: Array<{ id: string }> };

  return { messageId: result?.messages?.[0]?.id };
}

// ===== Slack =====

async function sendSlack(
  env: Env,
  sub: SubscriptionRow,
  text: string,
): Promise<{ messageId?: string }> {
  // Get the user's Slack OAuth token — prefer the exact integration stored on the subscription
  // to avoid picking the wrong workspace when the user has multiple Slack integrations.
  const integrationId = sub.user_integration_id
    || (await env.DB.prepare(
      `SELECT id FROM user_integrations WHERE user_id = ? AND provider = 'slack' LIMIT 1`
    ).bind(sub.user_id).first<{ id: string }>())?.id;

  if (!integrationId) {
    throw new Error('No Slack integration found for subscription owner');
  }

  const token = await getAccessToken(env, integrationId, 'slack');
  if (!token) {
    throw new Error('Slack token expired and could not be refreshed');
  }

  // Find the most recent inbound message for thread context
  const recent = await getRecentInbound(env, sub.id);
  const channelId = recent?.channel_id || sub.channel_id;

  if (!channelId) {
    throw new Error('No channel ID — no inbound messages received yet and no channel configured');
  }

  // Check for thread context
  let metadata: Record<string, unknown> = {};
  if (recent?.message_metadata) {
    try { metadata = JSON.parse(recent.message_metadata); } catch { /* ignore */ }
  }

  const threadTs = metadata.thread_ts as string | undefined;
  if (threadTs) {
    // Reply in thread
    const result = await executeSlackAction('slack.reply_thread', {
      channel: channelId,
      thread_ts: threadTs,
      text,
    }, token) as { ts?: string };
    return { messageId: result?.ts };
  }

  // Send as new message to channel
  const result = await executeSlackAction('slack.send_message', {
    channel: channelId,
    text,
  }, token) as { ts?: string };
  return { messageId: result?.ts };
}

// ===== Discord =====

async function sendDiscord(
  env: Env,
  sub: SubscriptionRow,
  text: string,
): Promise<{ messageId?: string }> {
  // Get the user's Discord OAuth token — prefer the exact integration stored on the subscription
  // to avoid picking the wrong server when the user has multiple Discord integrations.
  const integrationId = sub.user_integration_id
    || (await env.DB.prepare(
      `SELECT id FROM user_integrations WHERE user_id = ? AND provider = 'discord' LIMIT 1`
    ).bind(sub.user_id).first<{ id: string }>())?.id;

  if (!integrationId) {
    throw new Error('No Discord integration found for subscription owner');
  }

  const token = await getAccessToken(env, integrationId, 'discord');
  if (!token) {
    throw new Error('Discord token expired and could not be refreshed');
  }

  // Find the most recent inbound message for channel context
  const recent = await getRecentInbound(env, sub.id);
  const channelId = recent?.channel_id || sub.channel_id;

  if (!channelId) {
    throw new Error('No channel ID — no inbound messages received yet and no channel configured');
  }

  // Send message to channel
  const result = await executeDiscordAction('discord.send_message', {
    channel: channelId,
    text,
  }, token) as { id?: string };
  return { messageId: result?.id };
}

// ===== Helpers =====

async function getRecentInbound(
  env: Env,
  subscriptionId: string,
): Promise<InboundMessageRow | null> {
  return env.DB.prepare(`
    SELECT id, subscription_id, provider, platform_message_id,
           sender_id, sender_name, channel_id, message_metadata
    FROM inbound_messages
    WHERE subscription_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(subscriptionId).first<InboundMessageRow>();
}
