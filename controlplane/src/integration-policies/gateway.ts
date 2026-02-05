// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: gateway-v11-sanitize-errors-devgate
console.log(`[integration-gateway] REVISION: gateway-v11-sanitize-errors-devgate loaded at ${new Date().toISOString()}`);

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
} from '../types';
import { verifyPtyToken, type PtyTokenClaims } from '../auth/pty-token';
import { enforcePolicy, type EnforcementResult } from './handler';
import { filterResponse, type FilterResult } from './response-filter';
import { executeGmailAction } from './api-clients/gmail';
import { executeGitHubAction } from './api-clients/github';
import { executeDriveAction } from './api-clients/drive';
import { executeCalendarAction } from './api-clients/calendar';

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

  // Extract resourceId from common ID fields
  if (typeof args.fileId === 'string') ctx.resourceId = args.fileId;
  else if (typeof args.messageId === 'string') ctx.resourceId = args.messageId;
  else if (typeof args.eventId === 'string') ctx.resourceId = args.eventId;

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

  return ctx;
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
  if (action.includes('create') || action.includes('update') || action.includes('write') ||
      action.includes('archive') || action.includes('label') ||
      action.includes('move') || action.includes('share')) return 'writes';
  return 'reads';
}

async function checkRateLimit(
  env: Env,
  terminalIntegrationId: string,
  provider: IntegrationProvider,
  action: string,
  policy: AnyPolicy
): Promise<{ allowed: boolean; reason?: string }> {
  const rateLimits = (policy as { rateLimits?: ExtendedRateLimits }).rateLimits;
  if (!rateLimits) {
    return { allowed: true };
  }

  const category = getActionCategory(action);

  let limit: number | undefined;
  let window: 'minute' | 'hour' | 'day';

  switch (category) {
    case 'reads':
      limit = rateLimits.readsPerMinute;
      window = 'minute';
      break;
    case 'writes':
      limit = rateLimits.writesPerHour;
      window = 'hour';
      break;
    case 'deletes':
      limit = rateLimits.deletesPerHour ?? rateLimits.writesPerHour;
      window = 'hour';
      break;
    case 'sends':
      if (rateLimits.sendsPerDay) {
        limit = rateLimits.sendsPerDay;
        window = 'day';
      } else {
        limit = rateLimits.sendsPerHour ?? rateLimits.writesPerHour;
        window = 'hour';
      }
      break;
    case 'downloads':
      limit = rateLimits.downloadsPerHour ?? rateLimits.readsPerMinute;
      window = rateLimits.downloadsPerHour ? 'hour' : 'minute';
      break;
    case 'uploads':
      limit = rateLimits.uploadsPerHour ?? rateLimits.writesPerHour;
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
// OAuth Token Management
// ============================================

async function getAccessToken(
  env: Env,
  userIntegrationId: string,
  provider: IntegrationProvider
): Promise<string | null> {
  const userInt = await env.DB.prepare(`
    SELECT access_token, refresh_token, expires_at
    FROM user_integrations WHERE id = ?
  `).bind(userIntegrationId).first<{
    access_token: string;
    refresh_token: string | null;
    expires_at: string | null;
  }>();

  if (!userInt) {
    return null;
  }

  // Check if token is expired
  if (userInt.expires_at) {
    const expiresAt = new Date(userInt.expires_at);
    const now = new Date();
    const bufferMs = 5 * 60 * 1000; // 5 minute buffer

    if (expiresAt.getTime() - bufferMs < now.getTime()) {
      // Token is expired or about to expire - try to refresh
      if (userInt.refresh_token) {
        const newToken = await refreshOAuthToken(env, userIntegrationId, provider, userInt.refresh_token);
        if (newToken) {
          return newToken;
        }
      }
      return null; // Token expired and can't refresh
    }
  }

  return userInt.access_token;
}

async function refreshOAuthToken(
  env: Env,
  userIntegrationId: string,
  provider: IntegrationProvider,
  refreshToken: string
): Promise<string | null> {
  let tokenUrl: string;
  let body: URLSearchParams;

  // Determine the token endpoint and construct the refresh request
  if (provider === 'gmail' || provider === 'google_drive' || provider === 'google_calendar') {
    // Google OAuth refresh
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      console.error('[gateway] Google OAuth not configured for token refresh');
      return null;
    }
    tokenUrl = 'https://oauth2.googleapis.com/token';
    body = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  } else if (provider === 'github') {
    // GitHub OAuth refresh
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      console.error('[gateway] GitHub OAuth not configured for token refresh');
      return null;
    }
    tokenUrl = 'https://github.com/login/oauth/access_token';
    body = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  } else {
    // Browser and other providers don't use OAuth refresh
    console.warn(`[gateway] OAuth refresh not supported for provider: ${provider}`);
    return null;
  }

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error(`[gateway] OAuth refresh failed for ${provider}:`, response.status, errBody);

      // Check for invalid_grant (revoked/expired refresh token)
      const isInvalidGrant = errBody.includes('invalid_grant') ||
        errBody.includes('bad_refresh_token') ||
        errBody.includes('The refresh token is invalid');

      if (isInvalidGrant) {
        // Mark the integration as needing reconnection
        console.warn(`[gateway] Refresh token invalid for ${provider}, user needs to reconnect`);
      }
      return null;
    }

    const tokenData = await response.json() as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };

    if (!tokenData.access_token) {
      console.error(`[gateway] OAuth refresh returned no access_token for ${provider}`);
      return null;
    }

    // Calculate new expiration time (use 3600s/1h default if not specified)
    const expiresIn = tokenData.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // Update the stored token
    // Note: Some providers may also return a new refresh_token
    if (tokenData.refresh_token) {
      await env.DB.prepare(`
        UPDATE user_integrations
        SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(tokenData.access_token, tokenData.refresh_token, expiresAt, userIntegrationId).run();
    } else {
      await env.DB.prepare(`
        UPDATE user_integrations
        SET access_token = ?, expires_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(tokenData.access_token, expiresAt, userIntegrationId).run();
    }

    console.log(`[gateway] OAuth token refreshed successfully for ${provider}`);
    return tokenData.access_token;
  } catch (err) {
    console.error(`[gateway] OAuth refresh error for ${provider}:`, err);
    return null;
  }
}

// ============================================
// API Execution
// ============================================

async function executeProviderAPI(
  provider: IntegrationProvider,
  action: string,
  args: Record<string, unknown>,
  accessToken: string
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

  if (!ti.user_integration_id) {
    return Response.json(
      { error: 'AUTH_DENIED', reason: 'OAuth connection not found' },
      { status: 403 }
    );
  }

  const accessToken = await getAccessToken(env, ti.user_integration_id, provider);
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

  // 10. Execute the API call
  let apiResponse: unknown;
  try {
    apiResponse = await executeProviderAPI(provider, body.action, body.args, accessToken);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';

    // Log full error internally for debugging
    console.error(`[gateway] API error for ${provider}/${body.action}:`, errorMessage);

    const isDev = env.DEV_AUTH_ENABLED === 'true';

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
      // In dev mode, keep full error for debugging; in prod, sanitize
      denialReason: isDev ? `API error: ${errorMessage}` : `API error (see server logs for details)`,
    });

    // In dev mode, return the full error for debugging; in prod, don't leak API details
    return Response.json(
      { error: 'API_ERROR', reason: isDev ? errorMessage : 'Action failed - please try again or contact support' },
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
  console.log(`[gateway] ListTerminalIntegrations: ptyId=${ptyId}`);

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
    console.log(`[gateway] ListTerminalIntegrations: invalid/expired PTY token (len=${ptyToken.length})`);
    return Response.json(
      { error: 'AUTH_DENIED', reason: 'Invalid or expired PTY token' },
      { status: 401 }
    );
  }

  console.log(`[gateway] ListTerminalIntegrations: claims.terminal_id=${claims.terminal_id} dashboard_id=${claims.dashboard_id}`);

  // 2. Verify PTY ID matches token
  if (claims.terminal_id !== ptyId) {
    console.log(`[gateway] ListTerminalIntegrations: PTY ID mismatch token.terminal_id=${claims.terminal_id} url.ptyId=${ptyId}`);
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

  console.log(`[gateway] ListTerminalIntegrations: found ${integrations.results.length} integrations for ptyId=${ptyId}`);
  for (const row of integrations.results) {
    console.log(`[gateway] ListTerminalIntegrations: provider=${row.provider} active_policy_id=${row.active_policy_id ?? 'NULL'}`);
  }

  return Response.json({
    integrations: integrations.results.map(row => ({
      provider: row.provider,
      activePolicyId: row.active_policy_id,
      accountEmail: row.account_email,
    })),
  });
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
