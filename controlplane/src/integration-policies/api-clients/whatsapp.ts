// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: whatsapp-client-v2-auth-error-detection
const MODULE_REVISION = 'whatsapp-client-v2-auth-error-detection';
console.log(`[whatsapp-client] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * WhatsApp Business Cloud API Client
 *
 * Executes WhatsApp Business API calls with permanent access token.
 * Token never leaves the control plane.
 */

const WHATSAPP_API_BASE = 'https://graph.facebook.com/v21.0';

interface WhatsAppMessage {
  messaging_product: string;
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string }>;
}

async function whatsappFetch(
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

  const response = await fetch(`${WHATSAPP_API_BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'WhatsApp token expired or revoked. Please disconnect and reconnect WhatsApp with a fresh token.'
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
    throw new Error(`WhatsApp API error: ${errorCode}`);
  }

  // Some endpoints return 204 No Content
  if (response.status === 204) {
    return { ok: true };
  }

  return response.json();
}

/**
 * Execute a WhatsApp action
 */
export async function executeWhatsAppAction(
  action: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  switch (action) {
    case 'whatsapp.send_message':
      return sendMessage(args, accessToken);
    case 'whatsapp.send_template':
      return sendTemplate(args, accessToken);
    case 'whatsapp.reply_message':
      return replyMessage(args, accessToken);
    case 'whatsapp.send_reaction':
      return sendReaction(args, accessToken);
    case 'whatsapp.get_profile':
      return getProfile(args, accessToken);
    case 'whatsapp.mark_read':
      return markRead(args, accessToken);
    default:
      throw new Error(`Unknown WhatsApp action: ${action}`);
  }
}

async function sendMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<WhatsAppMessage> {
  const phoneNumberId = args.phone_number_id as string;
  const to = args.to as string;
  const text = args.text as string;
  if (!phoneNumberId) throw new Error('phone_number_id is required');
  if (!to) throw new Error('to is required');
  if (!text) throw new Error('text is required');

  const data = await whatsappFetch(
    `/${phoneNumberId}/messages`,
    accessToken,
    {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
    },
  ) as WhatsAppMessage;

  return data;
}

async function sendTemplate(
  args: Record<string, unknown>,
  accessToken: string
): Promise<WhatsAppMessage> {
  const phoneNumberId = args.phone_number_id as string;
  const to = args.to as string;
  const templateName = args.template_name as string;
  const languageCode = args.language_code as string;
  if (!phoneNumberId) throw new Error('phone_number_id is required');
  if (!to) throw new Error('to is required');
  if (!templateName) throw new Error('template_name is required');
  if (!languageCode) throw new Error('language_code is required');

  const data = await whatsappFetch(
    `/${phoneNumberId}/messages`,
    accessToken,
    {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
        },
      },
    },
  ) as WhatsAppMessage;

  return data;
}

async function replyMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<WhatsAppMessage> {
  const phoneNumberId = args.phone_number_id as string;
  const to = args.to as string;
  const text = args.text as string;
  const messageId = args.message_id as string;
  if (!phoneNumberId) throw new Error('phone_number_id is required');
  if (!to) throw new Error('to is required');
  if (!text) throw new Error('text is required');
  if (!messageId) throw new Error('message_id is required');

  const data = await whatsappFetch(
    `/${phoneNumberId}/messages`,
    accessToken,
    {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
        context: { message_id: messageId },
      },
    },
  ) as WhatsAppMessage;

  return data;
}

async function sendReaction(
  args: Record<string, unknown>,
  accessToken: string
): Promise<WhatsAppMessage> {
  const phoneNumberId = args.phone_number_id as string;
  const to = args.to as string;
  const messageId = args.message_id as string;
  const emoji = args.emoji as string;
  if (!phoneNumberId) throw new Error('phone_number_id is required');
  if (!to) throw new Error('to is required');
  if (!messageId) throw new Error('message_id is required');
  if (!emoji) throw new Error('emoji is required');

  const data = await whatsappFetch(
    `/${phoneNumberId}/messages`,
    accessToken,
    {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        to,
        type: 'reaction',
        reaction: {
          message_id: messageId,
          emoji,
        },
      },
    },
  ) as WhatsAppMessage;

  return data;
}

async function getProfile(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const phoneNumberId = args.phone_number_id as string;
  if (!phoneNumberId) throw new Error('phone_number_id is required');

  const data = await whatsappFetch(
    `/${phoneNumberId}`,
    accessToken,
  );

  return data;
}

async function markRead(
  args: Record<string, unknown>,
  accessToken: string
): Promise<WhatsAppMessage> {
  const phoneNumberId = args.phone_number_id as string;
  const messageId = args.message_id as string;
  if (!phoneNumberId) throw new Error('phone_number_id is required');
  if (!messageId) throw new Error('message_id is required');

  const data = await whatsappFetch(
    `/${phoneNumberId}/messages`,
    accessToken,
    {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      },
    },
  ) as WhatsAppMessage;

  return data;
}
