// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: gateway-v27-hybrid-24h-window
const MODULE_REVISION = 'gateway-v27-hybrid-24h-window';
console.log(`[integration-gateway] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Integration Policy Gateway Execute Handler
 *
 * This is the main enforcement point where:
 * 1. PTY token is verified (cryptographic authentication)
 * 2. Terminal integration and policy are loaded from DB
 * 3. Rate limits are checked
 * 4. Policy is enforced (boolean logic - no LLM)
 * 5. External API is called (Gmail, GitHub, etc.)
 * 6. Response is filtered based on policy
 * 7. Audit entry is logged
 * 8. Filtered response is returned to sandbox
 *
 * Security invariants:
 * - OAuth tokens NEVER leave the control plane
 * - Policy is loaded from DB, not from request
 * - All enforcement is boolean logic (no LLM judgment)
 * - Every request is logged before response is returned
 */

import type {
  Env,
  IntegrationProvider,
  AnyPolicy,
  GmailPolicy,
  GitHubPolicy,
  GoogleDrivePolicy,
  CalendarPolicy,
  BrowserPolicy,
  MessagingPolicy,
} from '../types';
import { verifyPtyToken, type PtyTokenClaims } from '../auth/pty-token';
import { enforcePolicy, type EnforcementResult } from './handler';
import { getAccessToken } from './token-refresh';
import { filterResponse, type FilterResult } from './response-filter';
import { executeGmailAction } from './api-clients/gmail';
import { executeGitHubAction } from './api-clients/github';
import { executeDriveAction } from './api-clients/drive';
import { executeCalendarAction } from './api-clients/calendar';
import { executeSlackAction } from './api-clients/slack';
import { executeDiscordAction } from './api-clients/discord';
import { executeTelegramAction, type TelegramD1Context } from './api-clients/telegram';
import { executeWhatsAppAction } from './api-clients/whatsapp';
import { executeTeamsAction } from './api-clients/teams';
import { executeMatrixAction } from './api-clients/matrix';
import { executeGoogleChatAction } from './api-clients/google_chat';

// ============================================
// Types
// ============================================

interface GatewayExecuteRequest {
  action: string;           // e.g., "gmail.search", "github.list_repos"
  args: Record<string, unknown>;
  // NOTE: body.context from sandbox is IGNORED for security.
  // Context is derived server-side from body.args to prevent forgery.
}

/**
 * Enforcement context derived server-side from args.
 * SECURITY: Never trust context from the sandbox request body.
 * The sandbox controls body.args (which is passed to the API), but we
 * derive the enforcement-relevant fields ourselves so the sandbox
 * cannot spoof recipientDomain, url, etc.
 */
interface DerivedEnforcementContext {
  url?: string;
  recipients?: string[];           // ALL recipients (to + cc + bcc)
  recipientDomains?: string[];     // ALL recipient domains
  recipient?: string;              // First recipient (for backward compat)
  recipientDomain?: string;        // First recipient domain (for backward compat)
  sender?: string;
  senderDomain?: string;
  resourceId?: string;
  repoOwner?: string;              // GitHub repo owner
  repoName?: string;               // GitHub repo name
  calendarId?: string;             // Calendar ID
  folderId?: string;               // Drive target folder ID
  fileName?: string;               // Drive file name (for extension check)
  mimeType?: string;               // Drive MIME type
  channelId?: string;              // Messaging channel/chat ID (Slack/Discord channel, Telegram chat_id)
  channelName?: string;            // Messaging channel name
  messageText?: string;            // Messaging: outbound message text (for maxMessageLength enforcement)
  threadTs?: string;               // Messaging: thread ID (for requireThreadReply enforcement)
  recipientUserId?: string;        // Messaging: DM recipient user ID (for allowedRecipients enforcement)
}

function extractEmailDomain(email: string): string | undefined {
  const match = email.match(/<([^>]+)>/) || email.match(/([^\s<>]+@[^\s<>]+)/);
  const addr = match ? match[1] : email;
  const parts = addr.split('@');
  return parts.length === 2 ? parts[1].toLowerCase() : undefined;
}

function extractEmailAddress(email: string): string | undefined {
  const match = email.match(/<([^>]+)>/) || email.match(/([^\s<>]+@[^\s<>]+)/);
  return match ? match[1].toLowerCase() : email.toLowerCase();
}

/**
 * Derive enforcement context from args server-side.
 * This prevents the sandbox from spoofing context fields.
 * Exported for use by validate-token endpoint.
 */
export function deriveEnforcementContext(action: string, args: Record<string, unknown>): DerivedEnforcementContext {
  const ctx: DerivedEnforcementContext = {};

  // Extract URL (for browser/web operations)
  if (typeof args.url === 'string') {
    ctx.url = args.url;
  }

  // Extract ALL recipients for Gmail send operations
  // IMPORTANT: Map as pairs to keep indices aligned - filtering separately
  // can drop different indices and misalign recipient[i] with recipientDomain[i]
  const rawRecipients: string[] = [];
  for (const field of ['to', 'cc', 'bcc']) {
    const val = args[field];
    if (Array.isArray(val)) {
      for (const entry of val) {
        if (typeof entry === 'string') {
          rawRecipients.push(entry);
        }
      }
    } else if (typeof val === 'string') {
      rawRecipients.push(val);
    }
  }
  if (rawRecipients.length > 0) {
    const pairs = rawRecipients.map(r => ({
      address: extractEmailAddress(r),
      domain: extractEmailDomain(r),
    })).filter(p => p.address); // Only drop if address parse completely fails

    ctx.recipients = pairs.map(p => p.address!);
    ctx.recipientDomains = pairs.map(p => p.domain || ''); // Keep empty string to preserve alignment
    ctx.recipient = ctx.recipients[0];
    ctx.recipientDomain = ctx.recipientDomains[0];
  }

  // Extract resourceId from common ID fields.
  // Slack uses `ts` (timestamp) to identify messages for edit/delete/react.
  // New messaging providers use snake_case (message_id, event_id).
  if (typeof args.fileId === 'string') ctx.resourceId = args.fileId;
  else if (typeof args.messageId === 'string') ctx.resourceId = args.messageId;
  else if (typeof args.message_id === 'string') ctx.resourceId = args.message_id;
  else if (typeof args.eventId === 'string') ctx.resourceId = args.eventId;
  else if (typeof args.event_id === 'string') ctx.resourceId = args.event_id;
  else if (typeof args.ts === 'string') ctx.resourceId = args.ts;
  else if (typeof args.timestamp === 'string') ctx.resourceId = args.timestamp;
  else if (typeof args.name === 'string' && (args.name as string).includes('/messages/')) ctx.resourceId = args.name;

  // Extract GitHub owner/repo for repo filter enforcement
  if (typeof args.owner === 'string') ctx.repoOwner = args.owner;
  if (typeof args.repo === 'string') ctx.repoName = args.repo;

  // Extract calendar ID for calendar filter enforcement
  if (typeof args.calendarId === 'string') {
    ctx.calendarId = args.calendarId;
  }

  // Extract Drive write fields for folder/filetype enforcement
  if (typeof args.folderId === 'string') ctx.folderId = args.folderId;
  if (typeof args.name === 'string') ctx.fileName = args.name;
  if (typeof args.mimeType === 'string') ctx.mimeType = args.mimeType;

  // Extract messaging channel ID for channel allowlist enforcement.
  // Different providers use different arg names for the target channel/chat/room/space:
  //   Slack/Discord: "channel"
  //   Telegram: "chat_id"
  //   Teams: "channel_id"
  //   Matrix: "room_id"
  //   Google Chat: "space" or "space_name"
  //   WhatsApp: "to" (recipient phone number)
  if (typeof args.channel === 'string') {
    ctx.channelId = args.channel;
  } else if (typeof args.chat_id === 'string') {
    ctx.channelId = args.chat_id;
  } else if (typeof args.channel_id === 'string') {
    ctx.channelId = args.channel_id;
  } else if (typeof args.room_id === 'string') {
    ctx.channelId = args.room_id;
  } else if (typeof args.space === 'string') {
    ctx.channelId = args.space;
  } else if (typeof args.space_name === 'string') {
    ctx.channelId = args.space_name;
  } else if (typeof args.to === 'string') {
    ctx.channelId = args.to;
  }
  // Channel name from args (if provided); otherwise enforcement uses ID only
  if (typeof args.channel_name === 'string') {
    ctx.channelName = args.channel_name;
  }

  // Extract messaging text for maxMessageLength enforcement
  if (typeof args.text === 'string') {
    ctx.messageText = args.text;
  }

  // Extract thread ID for requireThreadReply enforcement.
  // Different providers use different arg names for the parent message/thread:
  //   Slack: thread_ts
  //   Discord/Telegram: reply_to_message_id
  //   Teams: message_id (in reply_thread action)
  //   Matrix: event_id (in reply_thread action)
  //   Google Chat: thread_key or message_id (in reply_thread action)
  //   WhatsApp: message_id (in reply_message action, via context.message_id)
  if (typeof args.thread_ts === 'string') {
    ctx.threadTs = args.thread_ts;
  } else if (typeof args.reply_to_message_id === 'string') {
    ctx.threadTs = args.reply_to_message_id;
  } else if (typeof args.message_id === 'string') {
    ctx.threadTs = args.message_id;
  } else if (typeof args.event_id === 'string') {
    ctx.threadTs = args.event_id;
  } else if (typeof args.thread_key === 'string') {
    ctx.threadTs = args.thread_key;
  }

  // Extract DM recipient for allowedRecipients enforcement
  if (typeof args.user === 'string') {
    ctx.recipientUserId = args.user;
  } else if (typeof args.user_id === 'string') {
    ctx.recipientUserId = args.user_id;
  }

  return ctx;
}

/**
 * Resolve a channel ID to a human-readable channel name via the platform API.
 * Used for outbound enforcement so channel-name allowlists work when MCP tools
 * only pass channel IDs. Returns bare name without '#' prefix (e.g., "general")
 * to match inbound resolution format. Normalization at comparison time (in
 * channelMatchesFilter and enforcePolicy) handles any '#' in policy config.
 * Returns null on any error (fail-open for resolution, enforcement still has
 * the ID to check against channelIds).
 */
async function resolveOutboundChannelName(
  provider: IntegrationProvider,
  channelId: string,
  accessToken: string,
): Promise<string | null> {
  try {
    if (provider === 'slack') {
      const res = await fetch('https://slack.com/api/conversations.info', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: channelId }),
      });
      if (!res.ok) return null;
      const data = await res.json() as { ok: boolean; channel?: { name?: string } };
      return data.ok && data.channel?.name ? data.channel.name : null;
    }

    if (provider === 'discord') {
      // Discord channel name resolution is not reliably possible with user OAuth tokens.
      // The GET /channels/:id endpoint requires a Bot token or guild-scoped permissions.
      // Discord policies must use channel IDs (snowflakes) which are globally unique.
      return null;
    }

    // Telegram, WhatsApp, etc. — channel names not typically used in policies
    return null;
  } catch (err) {
    console.warn(`[gateway] Failed to resolve channel name for ${provider}/${channelId}:`, err);
    return null;
  }
}

interface GatewayExecuteResponse {
  allowed: boolean;
  decision: 'allowed' | 'denied' | 'filtered';
  reason?: string;
  filteredResponse?: unknown;
  policyId: string;
  policyVersion: number;
}

// ============================================
// Rate Limiting
// ============================================

type ActionCategory = 'reads' | 'writes' | 'sends' | 'deletes' | 'downloads' | 'uploads';

interface ExtendedRateLimits {
  readsPerMinute?: number;
  writesPerHour?: number;
  sendsPerDay?: number;
  sendsPerHour?: number;
  deletesPerHour?: number;
  downloadsPerHour?: number;
  uploadsPerHour?: number;
}

function getActionCategory(action: string): ActionCategory {
  if (action.includes('download') || action.includes('clone')) return 'downloads';
  if (action.includes('upload')) return 'uploads';
  if (action.includes('send') || action.includes('push') || action.includes('create_pr') ||
      action.includes('reply') || action.includes('draft')) return 'sends';
  if (action.includes('delete') || action.includes('trash') || action.includes('remove')) return 'deletes';
  // edit_message and react are write-like mutations (not reads). Without this,
  // messaging edit/reaction actions fall through to 'reads' and bypass send/write rate limits.
  if (action.includes('create') || action.includes('update') || action.includes('write') ||
      action.includes('archive') || action.includes('label') ||
      action.includes('move') || action.includes('share') ||
      action.includes('edit') || action.includes('react')) return 'writes';
  return 'reads';
}

async function checkRateLimit(
  env: Env,
  terminalIntegrationId: string,
  provider: IntegrationProvider,
  action: string,
  policy: AnyPolicy
): Promise<{ allowed: boolean; reason?: string }> {
  const rateLimits = (policy as { rateLimits?: ExtendedRateLimits & { messagesPerMinute?: number; messagesPerHour?: number } }).rateLimits;

  // For messaging providers, sendPolicy.maxPerHour is the primary send rate limit
  const msgSendMaxPerHour = (policy as { sendPolicy?: { maxPerHour?: number } }).sendPolicy?.maxPerHour;

  if (!rateLimits && !msgSendMaxPerHour) {
    return { allowed: true };
  }

  const category = getActionCategory(action);
  const MESSAGING_PROVIDERS = new Set(['slack', 'discord', 'telegram', 'whatsapp', 'teams', 'matrix', 'google_chat']);

  let limit: number | undefined;
  let window: 'minute' | 'hour' | 'day';

  switch (category) {
    case 'reads':
      // For messaging, messagesPerMinute applies to reads (read_messages, list_channels, etc.)
      if (MESSAGING_PROVIDERS.has(provider) && rateLimits?.messagesPerMinute != null) {
        limit = rateLimits.messagesPerMinute;
      } else {
        limit = rateLimits?.readsPerMinute;
      }
      window = 'minute';
      break;
    case 'writes':
      limit = rateLimits?.writesPerHour;
      window = 'hour';
      break;
    case 'deletes':
      limit = rateLimits?.deletesPerHour ?? rateLimits?.writesPerHour;
      window = 'hour';
      break;
    case 'sends':
      if (rateLimits?.sendsPerDay) {
        limit = rateLimits.sendsPerDay;
        window = 'day';
      } else if (MESSAGING_PROVIDERS.has(provider) && rateLimits?.messagesPerHour != null) {
        // messagesPerHour is the messaging-specific rate limit for sends;
        // takes priority over generic sendsPerHour for messaging providers
        limit = rateLimits.messagesPerHour;
        window = 'hour';
      } else {
        // sendPolicy.maxPerHour is the messaging-specific rate limit; fall back to rateLimits
        limit = msgSendMaxPerHour ?? rateLimits?.sendsPerHour ?? rateLimits?.writesPerHour;
        window = 'hour';
      }
      break;
    case 'downloads':
      limit = rateLimits?.downloadsPerHour ?? rateLimits?.readsPerMinute;
      window = rateLimits?.downloadsPerHour ? 'hour' : 'minute';
      break;
    case 'uploads':
      limit = rateLimits?.uploadsPerHour ?? rateLimits?.writesPerHour;
      window = 'hour';
      break;
  }

  if (limit == null) {
    return { allowed: true };
  }

  // A limit of 0 means "block all" for this category
  if (limit === 0) {
    return {
      allowed: false,
      reason: `Rate limit is 0 for ${category} (all ${category} blocked)`,
    };
  }

  const counterKey = `${terminalIntegrationId}:${provider}:${category}`;
  const counterId = env.RATE_LIMIT_COUNTER.idFromName(counterKey);
  const counter = env.RATE_LIMIT_COUNTER.get(counterId);

  try {
    const res = await counter.fetch(new Request('http://counter/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit, window }),
    }));

    if (!res.ok) {
      // Fail closed on error - deny requests when rate limiter is unavailable
      console.error(`[gateway] Rate limit check failed (failing closed): ${res.status}`);
      return { allowed: false, reason: 'Rate limiter unavailable - request denied for safety' };
    }

    const result = await res.json() as { allowed: boolean; remaining?: number };
    if (!result.allowed) {
      return {
        allowed: false,
        reason: `Rate limit exceeded for ${category} (${limit}/${window})`,
      };
    }
  } catch (err) {
    // Fail closed on error - deny requests when rate limiter is unavailable
    console.error(`[gateway] Rate limit check error (failing closed):`, err);
    return { allowed: false, reason: 'Rate limiter unavailable - request denied for safety' };
  }

  return { allowed: true };
}

// ============================================
// Audit Logging
// ============================================

async function logAuditEntry(
  env: Env,
  data: {
    terminalIntegrationId: string;
    terminalId: string;
    dashboardId: string;
    userId: string;
    provider: string;
    action: string;
    resourceId?: string;
    policyId: string;
    policyVersion: number;
    decision: string;
    denialReason?: string;
    requestSummary?: string;
  }
): Promise<void> {
  const id = `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

  await env.DB.prepare(`
    INSERT INTO integration_audit_log
    (id, terminal_integration_id, terminal_id, dashboard_id, user_id, provider, action, resource_id, policy_id, policy_version, policy_decision, denial_reason, request_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    id,
    data.terminalIntegrationId,
    data.terminalId,
    data.dashboardId,
    data.userId,
    data.provider,
    data.action,
    data.resourceId ?? null,
    data.policyId,
    data.policyVersion,
    data.decision,
    data.denialReason ?? null,
    data.requestSummary ?? null
  ).run();
}

// ============================================
// API Execution
// ============================================

async function executeProviderAPI(
  provider: IntegrationProvider,
  action: string,
  args: Record<string, unknown>,
  accessToken: string,
  telegramD1Ctx?: TelegramD1Context,
): Promise<unknown> {
  switch (provider) {
    case 'gmail':
      return executeGmailAction(action, args, accessToken);
    case 'github':
      return executeGitHubAction(action, args, accessToken);
    case 'google_drive':
      return executeDriveAction(action, args, accessToken);
    case 'google_calendar':
      return executeCalendarAction(action, args, accessToken);
    case 'slack':
      return executeSlackAction(action, args, accessToken);
    case 'discord':
      return executeDiscordAction(action, args, accessToken);
    case 'telegram':
      return executeTelegramAction(action, args, accessToken, telegramD1Ctx);
    case 'whatsapp':
      return executeWhatsAppAction(action, args, accessToken);
    case 'teams':
      return executeTeamsAction(action, args, accessToken);
    case 'matrix':
      return executeMatrixAction(action, args, accessToken);
    case 'google_chat':
      return executeGoogleChatAction(action, args, accessToken);
    case 'browser':
      // Browser actions are handled locally in sandbox
      throw new Error('Browser actions should not reach the gateway');
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

// ============================================
// Main Execute Handler
// ============================================

/**
 * Execute a gateway request with full policy enforcement
 *
 * POST /internal/gateway/:provider/execute
 *
 * Headers:
 *   Authorization: Bearer <pty_token>
 *
 * Body:
 *   {
 *     action: string,
 *     args: Record<string, unknown>,
 *     context?: { url?, recipient?, recipientDomain?, sender?, senderDomain?, resourceId? }
 *   }
 *
 * Response:
 *   {
 *     allowed: boolean,
 *     decision: "allowed" | "denied" | "filtered",
 *     reason?: string,
 *     filteredResponse?: unknown,
 *     policyId: string,
 *     policyVersion: number
 *   }
 */
export async function handleGatewayExecute(
  request: Request,
  env: Env,
  provider: IntegrationProvider
): Promise<Response> {
  // 1. Authenticate PTY token
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return Response.json(
      { error: 'AUTH_DENIED', reason: 'Missing Authorization header' },
      { status: 401 }
    );
  }

  const ptyToken = authHeader.slice(7);
  const claims = await verifyPtyToken(ptyToken, env.INTERNAL_API_TOKEN);

  if (!claims) {
    return Response.json(
      { error: 'AUTH_DENIED', reason: 'Invalid or expired PTY token' },
      { status: 401 }
    );
  }

  const { terminal_id: terminalId, dashboard_id: dashboardId, user_id: userId } = claims;

  // 2. Parse request body
  let body: GatewayExecuteRequest;
  try {
    body = await request.json() as GatewayExecuteRequest;
  } catch {
    return Response.json(
      { error: 'INVALID_REQUEST', reason: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  if (!body.action) {
    return Response.json(
      { error: 'INVALID_REQUEST', reason: 'Missing action' },
      { status: 400 }
    );
  }

  // 3. Load terminal_integration and active policy
  // Defense-in-depth: JOIN also verifies the policy belongs to this terminal_integration
  const ti = await env.DB.prepare(`
    SELECT ti.*, ip.policy, ip.security_level, ip.id as policy_id, ip.version as policy_version
    FROM terminal_integrations ti
    LEFT JOIN integration_policies ip ON ti.active_policy_id = ip.id AND ip.terminal_integration_id = ti.id
    WHERE ti.terminal_id = ? AND ti.provider = ? AND ti.deleted_at IS NULL
  `).bind(terminalId, provider).first<{
    id: string;
    terminal_id: string;
    item_id: string | null;
    dashboard_id: string;
    user_id: string;
    provider: string;
    user_integration_id: string | null;
    active_policy_id: string | null;
    policy: string | null;
    security_level: string | null;
    policy_id: string | null;
    policy_version: number | null;
  }>();

  if (!ti) {
    return Response.json(
      { error: 'NOT_ATTACHED', reason: `${provider} not attached to this terminal` },
      { status: 403 }
    );
  }

  // 4. Defense-in-depth: Verify terminal_integration matches token context
  if (ti.dashboard_id !== dashboardId || ti.user_id !== userId) {
    return Response.json(
      { error: 'AUTH_DENIED', reason: 'Dashboard mismatch' },
      { status: 403 }
    );
  }

  // 5. Verify policy exists
  if (!ti.active_policy_id || !ti.policy) {
    return Response.json(
      { error: 'POLICY_DENIED', reason: 'No policy configured' },
      { status: 403 }
    );
  }

  const policy = JSON.parse(ti.policy) as AnyPolicy;
  const policyId = ti.policy_id!;
  const policyVersion = ti.policy_version!;

  // 6. Check rate limits FIRST (fail fast)
  const rateLimitResult = await checkRateLimit(env, ti.id, provider, body.action, policy);
  if (!rateLimitResult.allowed) {
    await logAuditEntry(env, {
      terminalIntegrationId: ti.id,
      terminalId,
      dashboardId,
      userId,
      provider,
      action: body.action,
      policyId,
      policyVersion,
      decision: 'denied',
      denialReason: rateLimitResult.reason,
    });

    return Response.json(
      {
        allowed: false,
        decision: 'denied' as const,
        reason: rateLimitResult.reason,
        policyId,
        policyVersion,
      },
      { status: 429 }
    );
  }

  // 7. Derive enforcement context server-side from args (NEVER trust body.context)
  const derivedContext = deriveEnforcementContext(body.action, body.args);

  // 7b. For messaging providers: resolve channel name if we have an ID but no name.
  // MCP tools pass channel IDs (e.g. "C1234"), but policies may use channel names
  // (e.g. "#general"). Without resolution, channel-name allowlists silently deny all sends.
  const MESSAGING_PROVIDERS = new Set(['slack', 'discord', 'telegram', 'whatsapp', 'teams', 'matrix', 'google_chat']);
  let prefetchedAccessToken: string | null = null;
  if (MESSAGING_PROVIDERS.has(provider) && derivedContext.channelId && !derivedContext.channelName) {
    if (ti.user_integration_id) {
      prefetchedAccessToken = await getAccessToken(env, ti.user_integration_id, provider);
      if (prefetchedAccessToken) {
        const resolvedName = await resolveOutboundChannelName(provider, derivedContext.channelId, prefetchedAccessToken);
        if (resolvedName) {
          derivedContext.channelName = resolvedName;
        }
      }
    }
  }

  // 8. Enforce policy (boolean logic - NO LLM)
  const enforcement = await enforcePolicy(env, provider, body.action, policy, ti.id, derivedContext);

  if (!enforcement.allowed) {
    await logAuditEntry(env, {
      terminalIntegrationId: ti.id,
      terminalId,
      dashboardId,
      userId,
      provider,
      action: body.action,
      policyId,
      policyVersion,
      decision: enforcement.decision,
      denialReason: enforcement.reason,
    });

    return Response.json(
      {
        allowed: false,
        decision: enforcement.decision,
        reason: enforcement.reason,
        policyId,
        policyVersion,
      },
      { status: 403 }
    );
  }

  // 8. Browser actions: return enforcement result only (no API call needed).
  // Browser tools execute locally in the sandbox, but policy enforcement
  // happens here in the control plane to prevent the sandbox from bypassing
  // URL allowlists, capability checks, etc.
  if (provider === 'browser') {
    await logAuditEntry(env, {
      terminalIntegrationId: ti.id,
      terminalId,
      dashboardId,
      userId,
      provider,
      action: body.action,
      policyId,
      policyVersion,
      decision: 'allowed',
    });

    return Response.json({
      allowed: true,
      decision: 'allowed',
      filteredResponse: null,
      policyId,
      policyVersion,
    } as GatewayExecuteResponse);
  }

  // 8b. Drive sync config: return the dashboard's selected folder from DB.
  // No external API call needed — just a DB lookup.
  if (provider === 'google_drive' && body.action === 'drive.sync_config') {
    const mirror = await env.DB.prepare(`
      SELECT folder_id, folder_name FROM drive_mirrors WHERE dashboard_id = ?
    `).bind(dashboardId).first<{ folder_id: string; folder_name: string }>();

    await logAuditEntry(env, {
      terminalIntegrationId: ti.id,
      terminalId,
      dashboardId,
      userId,
      provider,
      action: body.action,
      policyId,
      policyVersion,
      decision: 'allowed',
    });

    return Response.json({
      allowed: true,
      decision: 'allowed' as const,
      filteredResponse: {
        folderId: mirror?.folder_id || '',
        folderName: mirror?.folder_name || '',
      },
      policyId,
      policyVersion,
    } as GatewayExecuteResponse);
  }

  // WhatsApp without OAuth: prefer platform credentials (Business API), fall back to bridge (Baileys).
  if (provider === 'whatsapp' && !ti.user_integration_id) {
    // Platform credentials take priority — skip bridge entirely
    if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
      // Fall through to the platform credential path below (line ~1009)
    } else {
      // Bridge-backed WhatsApp: route outbound through bridge service.
      // Scope by item_id to pick the correct WhatsApp block's bridge subscription
      // when multiple personal WhatsApp connections exist on the same dashboard.
      const bridgeSub = ti.item_id
        ? await env.DB.prepare(`
            SELECT webhook_id FROM messaging_subscriptions
            WHERE dashboard_id = ? AND user_id = ? AND item_id = ? AND provider = 'whatsapp'
              AND webhook_id LIKE 'bridge_%' AND status = 'active'
            LIMIT 1
          `).bind(dashboardId, userId, ti.item_id).first<{ webhook_id: string }>()
        : await env.DB.prepare(`
            SELECT webhook_id FROM messaging_subscriptions
            WHERE dashboard_id = ? AND user_id = ? AND provider = 'whatsapp'
              AND webhook_id LIKE 'bridge_%' AND status = 'active'
            LIMIT 1
          `).bind(dashboardId, userId).first<{ webhook_id: string }>();

      if (!bridgeSub) {
        return Response.json(
          { error: 'AUTH_DENIED', reason: 'No active bridge WhatsApp connection found' },
          { status: 403 }
        );
      }

    if (!env.BRIDGE_URL || !env.BRIDGE_INTERNAL_TOKEN) {
      return Response.json(
        { error: 'API_ERROR', reason: 'Bridge service not configured' },
        { status: 503 }
      );
    }

    let bridgeResponse: unknown;
    try {
      const { BridgeClient } = await import('../bridge/client');
      const bridge = new BridgeClient(env.BRIDGE_URL, env.BRIDGE_INTERNAL_TOKEN);

      switch (body.action) {
        case 'whatsapp.send_message':
        case 'whatsapp.reply_message': {
          const to = body.args.to as string;
          const text = body.args.text as string;
          if (!to || !text) throw new Error('to and text are required');
          bridgeResponse = await bridge.sendMessage(bridgeSub.webhook_id, to, text);
          break;
        }
        default:
          return Response.json(
            { error: 'API_ERROR', reason: `Action ${body.action} is not supported for bridge WhatsApp connections` },
            { status: 400 }
          );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[gateway] Bridge WhatsApp error for ${body.action}:`, errorMessage);

      await logAuditEntry(env, {
        terminalIntegrationId: ti.id,
        terminalId,
        dashboardId,
        userId,
        provider,
        action: body.action,
        policyId,
        policyVersion,
        decision: 'denied',
        denialReason: `Bridge error: ${errorMessage}`,
      });

      return Response.json(
        { error: 'API_ERROR', reason: errorMessage },
        { status: 502 }
      );
    }

    await logAuditEntry(env, {
      terminalIntegrationId: ti.id,
      terminalId,
      dashboardId,
      userId,
      provider,
      action: body.action,
      policyId,
      policyVersion,
      decision: 'allowed',
    });

    return Response.json({
      allowed: true,
      decision: 'allowed',
      filteredResponse: bridgeResponse,
      policyId,
      policyVersion,
    } as GatewayExecuteResponse);
    } // end else (bridge path)
  }

  if (!ti.user_integration_id) {
    // WhatsApp can use platform-level credentials when no per-user integration exists
    if (provider === 'whatsapp' && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
      prefetchedAccessToken = env.WHATSAPP_ACCESS_TOKEN;
      if (!body.args.phone_number_id) {
        body.args.phone_number_id = env.WHATSAPP_PHONE_NUMBER_ID;
      }
      // Auto-fill recipient from hybrid subscription's linked phone when agent doesn't specify one
      if (!body.args.to) {
        const hybridSub = await env.DB.prepare(`
          SELECT user_phone FROM messaging_subscriptions
          WHERE dashboard_id = ? AND user_id = ? AND provider = 'whatsapp'
            AND hybrid_mode = 1 AND status IN ('pending', 'active') AND user_phone IS NOT NULL
          LIMIT 1
        `).bind(dashboardId, userId).first<{ user_phone: string }>();
        if (hybridSub?.user_phone) {
          body.args.to = hybridSub.user_phone;
          console.log(`[gateway] Auto-filled WhatsApp recipient from hybrid subscription: ${hybridSub.user_phone}`);
        }
      }
    } else {
      return Response.json(
        { error: 'AUTH_DENIED', reason: 'OAuth connection not found' },
        { status: 403 }
      );
    }
  }

  const accessToken = prefetchedAccessToken ?? await getAccessToken(env, ti.user_integration_id!, provider);
  if (!accessToken) {
    return Response.json(
      { error: 'AUTH_DENIED', reason: 'OAuth token expired. Reconnect required.' },
      { status: 403 }
    );
  }

  // 9. Pre-check: For Drive actions targeting existing files (download, update, share,
  // delete), fetch file metadata first and filter before executing. This prevents bypass
  // because these actions either return no metadata (download returns {content, mimeType})
  // or modify a file that should be outside policy scope.
  // drive.get is NOT pre-checked because it already returns full metadata that
  // response filtering can inspect (avoids double API call).
  // drive.create is NOT pre-checked because the folder/filetype check is done at
  // request time in enforcePolicy() using args (folderId, mimeType, name).
  const DRIVE_ACTIONS_NEEDING_PRECHECK = new Set([
    'drive.download', 'drive.update', 'drive.share', 'drive.delete',
  ]);
  if (provider === 'google_drive' && DRIVE_ACTIONS_NEEDING_PRECHECK.has(body.action)) {
    const fileId = body.args.fileId as string;
    if (fileId) {
      let metadata: unknown;
      try {
        metadata = await executeDriveAction('drive.get', { fileId }, accessToken);
      } catch (err) {
        // Fail closed: if we can't fetch metadata, we can't verify the file
        // is within policy scope, so deny the action.
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        await logAuditEntry(env, {
          terminalIntegrationId: ti.id,
          terminalId,
          dashboardId,
          userId,
          provider,
          action: body.action,
          resourceId: fileId,
          policyId,
          policyVersion,
          decision: 'denied',
          denialReason: `Action denied: metadata fetch failed (${errorMessage})`,
        });

        return Response.json({
          allowed: false,
          decision: 'denied' as const,
          reason: `Action denied: unable to verify file against policy`,
          policyId,
          policyVersion,
        }, { status: 403 });
      }

      const metadataFilter = filterResponse('google_drive', 'drive.get', metadata, policy);
      if (metadataFilter.filtered && metadataFilter.data === null) {
        await logAuditEntry(env, {
          terminalIntegrationId: ti.id,
          terminalId,
          dashboardId,
          userId,
          provider,
          action: body.action,
          resourceId: fileId,
          policyId,
          policyVersion,
          decision: 'denied',
          denialReason: 'File filtered by policy (folder/filetype restriction)',
        });

        return Response.json({
          allowed: false,
          decision: 'denied' as const,
          reason: 'File filtered by policy (folder/filetype restriction)',
          policyId,
          policyVersion,
        }, { status: 403 });
      }
    }
  }

  // 9c. Discord: inject guild_id from stored metadata so LLM doesn't need to know it
  if (provider === 'discord') {
    const discordMeta = await env.DB.prepare(`
      SELECT metadata FROM user_integrations WHERE id = ?
    `).bind(ti.user_integration_id).first<{ metadata: string | null }>();
    if (discordMeta?.metadata) {
      try {
        const meta = JSON.parse(discordMeta.metadata) as { guild_id?: string };
        if (meta.guild_id && !body.args.guild_id) {
          body.args.guild_id = meta.guild_id;
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // 9d. WhatsApp Cloud API: inject phone_number_id from stored metadata so LLM doesn't need to know it
  if (provider === 'whatsapp' && ti.user_integration_id && !body.args.phone_number_id) {
    const waMeta = await env.DB.prepare(`
      SELECT metadata FROM user_integrations WHERE id = ?
    `).bind(ti.user_integration_id).first<{ metadata: string | null }>();
    if (waMeta?.metadata) {
      try {
        const meta = JSON.parse(waMeta.metadata) as { phone_number_id?: string };
        if (meta.phone_number_id) {
          body.args.phone_number_id = meta.phone_number_id;
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // 9e. Hybrid WhatsApp: check 24h Business API window and trigger re-handshake if expiring
  if (provider === 'whatsapp' && !ti.user_integration_id && env.WHATSAPP_BUSINESS_PHONE) {
    try {
      const hybridSub = await env.DB.prepare(`
        SELECT webhook_id, hybrid_handshake_at FROM messaging_subscriptions
        WHERE dashboard_id = ? AND user_id = ? AND provider = 'whatsapp'
          AND hybrid_mode = 1 AND status = 'active'
        LIMIT 1
      `).bind(dashboardId, userId).first<{ webhook_id: string; hybrid_handshake_at: string | null }>();

      if (hybridSub?.hybrid_handshake_at) {
        const handshakeAge = Date.now() - new Date(hybridSub.hybrid_handshake_at).getTime();
        const TWENTY_THREE_HOURS_MS = 23 * 60 * 60 * 1000;
        if (handshakeAge > TWENTY_THREE_HOURS_MS) {
          console.log(`[gateway] Hybrid 24h window expiring for ${hybridSub.webhook_id}, triggering re-handshake`);
          // Fire-and-forget: don't block the outbound send
          if (env.BRIDGE_URL && env.BRIDGE_INTERNAL_TOKEN) {
            import('../bridge/client').then(({ BridgeClient }) => {
              const bridge = new BridgeClient(env.BRIDGE_URL!, env.BRIDGE_INTERNAL_TOKEN!);
              bridge.triggerHandshake(hybridSub.webhook_id).catch((err) => {
                console.error(`[gateway] Re-handshake failed for ${hybridSub.webhook_id}:`, err);
              });
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      // Non-fatal: don't block outbound if window check fails
      console.error('[gateway] Hybrid window check error:', err);
    }
  }

  // 10. Execute the API call
  let apiResponse: unknown;
  try {
    const telegramCtx: TelegramD1Context | undefined = provider === 'telegram'
      ? { db: env.DB, userId }
      : undefined;
    apiResponse = await executeProviderAPI(provider, body.action, body.args, accessToken, telegramCtx);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';

    // Log full error internally for debugging
    console.error(`[gateway] API error for ${provider}/${body.action}:`, errorMessage);

    await logAuditEntry(env, {
      terminalIntegrationId: ti.id,
      terminalId,
      dashboardId,
      userId,
      provider,
      action: body.action,
      policyId,
      policyVersion,
      decision: 'denied',
      denialReason: `API error: ${errorMessage}`,
    });

    // Pass through provider API error messages (e.g. "Slack API error: not_in_channel")
    // These are public error codes that help the LLM and user diagnose the issue.
    return Response.json(
      { error: 'API_ERROR', reason: errorMessage },
      { status: 502 }
    );
  }

  // 11. Filter response based on policy
  const filterResult = filterResponse(provider, body.action, apiResponse, policy);

  // 12. Format response for LLM consumption (decode base64, strip HTML, etc.)
  const formattedData = formatResponseForLLM(provider, body.action, filterResult.data);

  // 13. Log success
  await logAuditEntry(env, {
    terminalIntegrationId: ti.id,
    terminalId,
    dashboardId,
    userId,
    provider,
    action: body.action,
    policyId,
    policyVersion,
    decision: filterResult.filtered ? 'filtered' : 'allowed',
  });

  // 14. Return filtered + formatted response
  return Response.json({
    allowed: true,
    decision: filterResult.filtered ? 'filtered' : 'allowed',
    filteredResponse: formattedData,
    policyId,
    policyVersion,
  } as GatewayExecuteResponse);
}

// ============================================
// Terminal Integrations Listing
// ============================================

/**
 * List integrations attached to a terminal
 *
 * GET /internal/terminals/:ptyId/integrations
 *
 * Headers:
 *   Authorization: Bearer <pty_token>
 *
 * Response:
 *   {
 *     integrations: [{
 *       provider: string,
 *       activePolicyId: string | null,
 *       accountEmail: string | null
 *     }]
 *   }
 */
export async function handleListTerminalIntegrations(
  request: Request,
  env: Env,
  ptyId: string
): Promise<Response> {
  // 1. Authenticate PTY token
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    console.log(`[gateway] ListTerminalIntegrations: missing Authorization header`);
    return Response.json(
      { error: 'AUTH_DENIED', reason: 'Missing Authorization header' },
      { status: 401 }
    );
  }

  const ptyToken = authHeader.slice(7);
  const claims = await verifyPtyToken(ptyToken, env.INTERNAL_API_TOKEN);

  if (!claims) {
    console.log(`[gateway] ListTerminalIntegrations: invalid/expired PTY token`);
    return Response.json(
      { error: 'AUTH_DENIED', reason: 'Invalid or expired PTY token' },
      { status: 401 }
    );
  }

  // 2. Verify PTY ID matches token
  if (claims.terminal_id !== ptyId) {
    console.log(`[gateway] ListTerminalIntegrations: PTY ID mismatch token=${claims.terminal_id} url=${ptyId}`);
    return Response.json(
      { error: 'AUTH_DENIED', reason: 'PTY ID mismatch' },
      { status: 403 }
    );
  }

  // 3. Load terminal integrations
  const integrations = await env.DB.prepare(`
    SELECT provider, active_policy_id, account_email
    FROM terminal_integrations
    WHERE terminal_id = ? AND deleted_at IS NULL
  `).bind(ptyId).all<{
    provider: string;
    active_policy_id: string | null;
    account_email: string | null;
  }>();

  return Response.json({
    integrations: integrations.results.map(row => ({
      provider: row.provider,
      activePolicyId: row.active_policy_id,
      accountEmail: row.account_email,
    })),
  });
}

/**
 * Batch list integrations for ALL terminals in a dashboard.
 * Returns integrations grouped by terminal_id in a single DB query.
 *
 * GET /internal/dashboards/:dashboardId/terminal-integrations
 *
 * Auth: X-Internal-Token (sandbox internal auth)
 *
 * Response:
 *   {
 *     terminals: {
 *       [terminalId]: [{ provider, activePolicyId, accountEmail }]
 *     }
 *   }
 *
 * REVISION: batch-integrations-v1
 */
export async function handleBatchListTerminalIntegrations(
  request: Request,
  env: Env,
  dashboardId: string
): Promise<Response> {
  // Auth: require internal token
  const internalToken = request.headers.get('X-Internal-Token');
  if (!internalToken || internalToken !== env.INTERNAL_API_TOKEN) {
    return Response.json(
      { error: 'AUTH_DENIED', reason: 'Invalid or missing internal token' },
      { status: 401 }
    );
  }

  // Single query for all terminals in this dashboard
  const integrations = await env.DB.prepare(`
    SELECT terminal_id, provider, active_policy_id, account_email
    FROM terminal_integrations
    WHERE dashboard_id = ? AND deleted_at IS NULL
  `).bind(dashboardId).all<{
    terminal_id: string;
    provider: string;
    active_policy_id: string | null;
    account_email: string | null;
  }>();

  // Group by terminal_id
  const terminals: Record<string, Array<{ provider: string; activePolicyId: string | null; accountEmail: string | null }>> = {};
  for (const row of integrations.results) {
    if (!terminals[row.terminal_id]) {
      terminals[row.terminal_id] = [];
    }
    terminals[row.terminal_id].push({
      provider: row.provider,
      activePolicyId: row.active_policy_id,
      accountEmail: row.account_email,
    });
  }

  return Response.json({ terminals });
}

// ============================================
// Response Formatting for LLM Consumption
// ============================================

/**
 * Format API responses for LLM consumption.
 * Decodes base64 bodies, strips HTML, extracts headers - so the LLM
 * sees clean text instead of raw API payloads.
 */
function formatResponseForLLM(
  provider: IntegrationProvider,
  action: string,
  data: unknown
): unknown {
  if (provider === 'gmail') {
    return formatGmailForLLM(action, data);
  }
  // Other providers return reasonably clean JSON already
  return data;
}

interface GmailPayloadPart {
  mimeType: string;
  body?: { data?: string; size?: number };
  parts?: GmailPayloadPart[];
}

interface RawGmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string; size?: number };
    parts?: GmailPayloadPart[];
    mimeType?: string;
  };
  internalDate?: string;
}

function formatGmailForLLM(action: string, data: unknown): unknown {
  // Only format read actions that return message objects
  if (!action.includes('search') && !action.includes('list') && action !== 'gmail.get') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(msg => formatSingleGmailMessage(msg as RawGmailMessage));
  }

  if (data && typeof data === 'object' && 'id' in data) {
    return formatSingleGmailMessage(data as RawGmailMessage);
  }

  return data;
}

function formatSingleGmailMessage(msg: RawGmailMessage): Record<string, unknown> {
  const headers = msg.payload?.headers || [];
  const getHeader = (name: string): string | undefined =>
    headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;

  // Extract body text from the message payload, capped at 4KB for LLM context efficiency
  let bodyText = extractMessageBody(msg.payload);
  const MAX_BODY_LENGTH = 4096;
  if (bodyText.length > MAX_BODY_LENGTH) {
    bodyText = bodyText.slice(0, MAX_BODY_LENGTH) + '\n[... truncated]';
  }

  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds,
    from: getHeader('from'),
    to: getHeader('to'),
    cc: getHeader('cc'),
    subject: getHeader('subject'),
    date: getHeader('date'),
    snippet: msg.snippet,
    body: bodyText,
  };
}

/**
 * Clean tracking/long URLs from any body text (plain or post-HTML-strip).
 * Applied to ALL email body output regardless of source format.
 */
function cleanBodyUrls(text: string): string {
  return text
    // Remove bare URLs on their own lines (tracking links, long encoded URLs)
    .replace(/^\s*https?:\/\/\S+\s*$/gm, '')
    // Remove remaining inline URLs longer than 80 chars (tracking URLs)
    .replace(/https?:\/\/\S{80,}/g, '')
    // Collapse excessive blank lines left behind
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract readable text from a Gmail message payload.
 * Handles single-part and multipart messages, preferring text/plain over text/html.
 * All output is cleaned of tracking URLs via cleanBodyUrls().
 */
function extractMessageBody(payload: RawGmailMessage['payload']): string {
  if (!payload) return '';

  // Try to find text/plain first, then text/html
  const plainText = findBodyByMimeType(payload, 'text/plain');
  if (plainText) return cleanBodyUrls(plainText);

  const htmlText = findBodyByMimeType(payload, 'text/html');
  if (htmlText) return cleanBodyUrls(stripHtml(htmlText));

  // Fallback: try the top-level body
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (payload.mimeType === 'text/html') return cleanBodyUrls(stripHtml(decoded));
    return cleanBodyUrls(decoded);
  }

  return '';
}

function findBodyByMimeType(
  payload: { mimeType?: string; body?: { data?: string }; parts?: GmailPayloadPart[] },
  targetMime: string
): string | undefined {
  // Check this node
  if (payload.mimeType === targetMime && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Recurse into parts (multipart messages)
  if (payload.parts) {
    for (const part of payload.parts) {
      const result = findBodyByMimeType(part, targetMime);
      if (result) return result;
    }
  }

  return undefined;
}

/**
 * Decode Gmail's base64url-encoded body data.
 */
function decodeBase64Url(data: string): string {
  // Gmail uses URL-safe base64: replace - with + and _ with /
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return atob(base64);
  } catch {
    return data; // Return raw if decode fails
  }
}

/**
 * Strip HTML tags and decode entities to produce readable text.
 */
function stripHtml(html: string): string {
  return html
    // Remove style/script blocks entirely
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // Remove hidden/tracking elements (1x1 images, display:none, etc.)
    .replace(/<img[^>]*(?:width\s*=\s*["']1["']|height\s*=\s*["']1["'])[^>]*>/gi, '')
    // Replace block elements with newlines
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(parseInt(dec)))
    // URL cleaning now handled by cleanBodyUrls() applied after extraction
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
