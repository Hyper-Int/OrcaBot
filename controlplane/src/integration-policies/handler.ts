// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: handler-v8-integration-persistence
console.log(`[integration-handler] REVISION: handler-v8-integration-persistence loaded at ${new Date().toISOString()}`);

import type {
  Env,
  IntegrationProvider,
  SecurityLevel,
  TerminalIntegration,
  TerminalIntegrationWithPolicy,
  IntegrationPolicy,
  AvailableIntegration,
  AnyPolicy,
  GmailPolicy,
  CalendarPolicy,
  ContactsPolicy,
  SheetsPolicy,
  FormsPolicy,
  GoogleDrivePolicy,
  OneDrivePolicy,
  BoxPolicy,
  GitHubPolicy,
  BrowserPolicy,
  HighRiskConfirmation,
} from '../types';
import { HIGH_RISK_CAPABILITIES } from '../types';
import { verifyPtyToken, type PtyTokenClaims } from '../auth/pty-token';

// ============================================
// Helper Functions
// ============================================

/**
 * Convert a glob pattern to a regex, properly escaping regex metacharacters.
 * Only `*` (match any chars) and `?` (match single char) are treated as wildcards.
 * All other regex-special characters (`.`, `+`, `(`, etc.) are escaped so they
 * match literally. This prevents patterns like `example.com` from matching
 * `exampleXcom` via unescaped `.`.
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape all regex metacharacters except * and ?
    .replace(/\*/g, '.*')                    // * → match any chars
    .replace(/\?/g, '.');                    // ? → match single char
  return new RegExp('^' + escaped + '$', 'i');
}

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Action categories for rate limiting
 */
type ActionCategory = 'reads' | 'writes' | 'sends' | 'deletes' | 'downloads' | 'uploads';

/**
 * Extended rate limits interface with provider-specific options
 */
interface ExtendedRateLimits {
  readsPerMinute?: number;
  writesPerHour?: number;
  sendsPerDay?: number;        // Gmail sends
  sendsPerHour?: number;       // Alternative: hourly send limit
  deletesPerHour?: number;     // Destructive ops
  downloadsPerHour?: number;   // Drive/OneDrive/Box downloads
  uploadsPerHour?: number;     // Drive/OneDrive/Box uploads
}

/**
 * Map provider actions to rate limit categories
 */
function getActionCategory(provider: IntegrationProvider, action: string): ActionCategory {
  // Download actions
  if (action.includes('download') || action.includes('clone')) {
    return 'downloads';
  }
  // Upload actions
  if (action.includes('upload')) {
    return 'uploads';
  }
  // Sending actions (emails, pushes, PRs)
  if (action.includes('send') || action.includes('push') || action.includes('create_pr') ||
      action.includes('reply') || action.includes('draft')) {
    return 'sends';
  }
  // Delete actions
  if (action.includes('delete') || action.includes('trash') || action.includes('remove')) {
    return 'deletes';
  }
  // Write actions
  if (action.includes('create') || action.includes('update') || action.includes('write') ||
      action.includes('archive') || action.includes('label') ||
      action.includes('move') || action.includes('share')) {
    return 'writes';
  }
  // Default to reads
  return 'reads';
}

/**
 * Check rate limit for an action using the RateLimitCounter Durable Object
 */
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

  const category = getActionCategory(provider, action);

  // Determine limit and window based on category (with provider-specific defaults)
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
      // Deletes have their own limit, fallback to writes
      limit = rateLimits.deletesPerHour ?? rateLimits.writesPerHour;
      window = 'hour';
      break;
    case 'sends':
      // Sends can use daily limit (Gmail) or hourly limit
      if (rateLimits.sendsPerDay) {
        limit = rateLimits.sendsPerDay;
        window = 'day';
      } else {
        limit = rateLimits.sendsPerHour ?? rateLimits.writesPerHour;
        window = 'hour';
      }
      break;
    case 'downloads':
      // Downloads have their own limit for Drive/OneDrive/Box
      limit = rateLimits.downloadsPerHour ?? rateLimits.readsPerMinute;
      window = rateLimits.downloadsPerHour ? 'hour' : 'minute';
      break;
    case 'uploads':
      // Uploads have their own limit
      limit = rateLimits.uploadsPerHour ?? rateLimits.writesPerHour;
      window = 'hour';
      break;
  }

  if (!limit) {
    return { allowed: true };
  }

  // Get the rate limit counter DO
  const counterKey = `${terminalIntegrationId}:${provider}:${category}`;
  const counterId = env.RATE_LIMIT_COUNTER.idFromName(counterKey);
  const counter = env.RATE_LIMIT_COUNTER.get(counterId);

  try {
    const response = await counter.fetch(new Request('http://rate-limit/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ window, limit, increment: true }),
    }));

    const result = await response.json() as { allowed: boolean; current: number; limit: number; remaining: number };

    if (!result.allowed) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${result.current}/${result.limit} ${category} per ${window}`,
      };
    }

    return { allowed: true };
  } catch (e) {
    // If rate limiting fails, deny the request (fail closed for security)
    console.error('[rate-limit] Failed to check rate limit (failing closed):', e);
    return { allowed: false, reason: 'Rate limiter unavailable - request denied for safety' };
  }
}

/**
 * Fields that CANNOT be modified after creation (immutable binding)
 */
const IMMUTABLE_FIELDS = [
  'terminal_id',
  'dashboard_id',
  'user_id',
  'provider',
  'user_integration_id',
] as const;

/**
 * Calculate security level based on policy capabilities
 */
export function calculateSecurityLevel(
  provider: IntegrationProvider,
  policy: AnyPolicy
): SecurityLevel {
  switch (provider) {
    case 'gmail': {
      const p = policy as GmailPolicy;
      // Only canSend is truly "full" access - it can send emails on behalf of the user
      if (p.canSend) return 'full';
      // Trash, archive, label, mark read are elevated - they modify but don't send
      if (p.canTrash || p.canArchive || p.canLabel || p.canMarkRead) return 'elevated';
      return 'restricted';
    }

    case 'google_calendar': {
      const p = policy as CalendarPolicy;
      if (p.canDelete) return 'full';
      if (p.canCreate || p.canUpdate) return 'elevated';
      return 'restricted';
    }

    case 'google_contacts': {
      const p = policy as ContactsPolicy;
      if (p.canDelete) return 'full';
      if (p.canCreate || p.canUpdate) return 'elevated';
      return 'restricted';
    }

    case 'google_sheets': {
      const p = policy as SheetsPolicy;
      if (p.writePolicy?.canDeleteSheets) return 'full';
      if (p.canWrite || p.canUseFormulas) return 'elevated';
      return 'restricted';
    }

    case 'google_forms': {
      const p = policy as FormsPolicy;
      if (p.canDelete) return 'full';
      if (p.canCreate || p.canUpdate || p.canReadResponses) return 'elevated';
      return 'restricted';
    }

    case 'google_drive':
    case 'onedrive':
    case 'box': {
      const p = policy as GoogleDrivePolicy | OneDrivePolicy | BoxPolicy;
      if (p.canDelete || p.canShare) return 'full';
      if (p.canUpload || p.canUpdate || p.canMove) return 'elevated';
      return 'restricted';
    }

    case 'github': {
      const p = policy as GitHubPolicy;
      if (p.canMergePRs || p.canPush || p.canDeleteRepos || p.canApprovePRs) return 'full';
      if (p.canCreatePRs || p.canCreateIssues || p.canCommentIssues || p.canClone) return 'elevated';
      return 'restricted';
    }

    case 'browser': {
      const p = policy as BrowserPolicy;
      if (p.canSubmitForms || p.canExecuteJs || p.canUpload || p.canInputCredentials) return 'full';
      if (p.canClick || p.canType || p.canFillForms || p.canDownload) return 'elevated';
      return 'restricted';
    }

    default: {
      // Exhaustive check
      const _exhaustive: never = provider;
      return 'restricted';
    }
  }
}

/**
 * Create default full-access policy for a provider
 */
export function createDefaultFullAccessPolicy(provider: IntegrationProvider): AnyPolicy {
  switch (provider) {
    case 'gmail':
      return {
        canRead: true,
        canArchive: true,
        canTrash: true,
        canMarkRead: true,
        canLabel: true,
        canSend: true,
      } as GmailPolicy;

    case 'google_calendar':
      return {
        canRead: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
      } as CalendarPolicy;

    case 'google_contacts':
      return {
        canRead: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
      } as ContactsPolicy;

    case 'google_sheets':
      return {
        canRead: true,
        canWrite: true,
        canUseFormulas: true,
        writePolicy: { canCreateNew: true, canDeleteSheets: true },
      } as SheetsPolicy;

    case 'google_forms':
      return {
        canRead: true,
        canReadResponses: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
      } as FormsPolicy;

    case 'google_drive':
      return {
        canRead: true,
        canDownload: true,
        canUpload: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
        canMove: true,
        canShare: true,
        sharePolicy: { noPublicSharing: false },
      } as GoogleDrivePolicy;

    case 'onedrive':
      return {
        canRead: true,
        canDownload: true,
        canUpload: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
        canMove: true,
        canShare: true,
        sharePolicy: { noAnonymousLinks: false },
      } as OneDrivePolicy;

    case 'box':
      return {
        canRead: true,
        canDownload: true,
        canUpload: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
        canMove: true,
        canShare: true,
        sharePolicy: { noOpenAccess: false },
      } as BoxPolicy;

    case 'github':
      return {
        canReadRepos: true,
        canReadCode: true,
        canClone: true,
        canPush: true,
        canReadIssues: true,
        canCreateIssues: true,
        canCommentIssues: true,
        canCloseIssues: true,
        canReadPRs: true,
        canCreatePRs: true,
        canApprovePRs: true,
        canMergePRs: true,
        canCreateReleases: true,
        canTriggerActions: true,
        canCreateRepos: false,
        canDeleteRepos: false,
        canManageSettings: false,
      } as GitHubPolicy;

    case 'browser':
      // Browser CANNOT have default full access - requires URL config
      return {
        canNavigate: true,
        urlFilter: { mode: 'allowlist', patterns: [] },
        canClick: true,
        canType: true,
        canScroll: true,
        canScreenshot: true,
        canExtractText: true,
        canFillForms: false,
        canSubmitForms: false,
        canDownload: false,
        canUpload: false,
        canExecuteJs: false,
        canUseStoredCredentials: false,
        canInputCredentials: false,
        canReadCookies: false,
        canInspectNetwork: false,
        canModifyRequests: false,
      } as BrowserPolicy;

    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${provider}`);
    }
  }
}

/**
 * Create read-only policy for a provider
 */
export function createReadOnlyPolicy(provider: IntegrationProvider): AnyPolicy {
  switch (provider) {
    case 'gmail':
      return {
        canRead: true,
        canArchive: false,
        canTrash: false,
        canMarkRead: false,
        canLabel: false,
        canSend: false,
      } as GmailPolicy;

    case 'google_calendar':
      return {
        canRead: true,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
      } as CalendarPolicy;

    case 'google_contacts':
      return {
        canRead: true,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
      } as ContactsPolicy;

    case 'google_sheets':
      return {
        canRead: true,
        canWrite: false,
        canUseFormulas: false,
      } as SheetsPolicy;

    case 'google_forms':
      return {
        canRead: true,
        canReadResponses: false,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
      } as FormsPolicy;

    case 'google_drive':
      return {
        canRead: true,
        canDownload: true,
        canUpload: false,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
        canMove: false,
        canShare: false,
      } as GoogleDrivePolicy;

    case 'onedrive':
      return {
        canRead: true,
        canDownload: true,
        canUpload: false,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
        canMove: false,
        canShare: false,
      } as OneDrivePolicy;

    case 'box':
      return {
        canRead: true,
        canDownload: true,
        canUpload: false,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
        canMove: false,
        canShare: false,
      } as BoxPolicy;

    case 'github':
      return {
        canReadRepos: true,
        canReadCode: true,
        canClone: false,
        canPush: false,
        canReadIssues: true,
        canCreateIssues: false,
        canCommentIssues: false,
        canCloseIssues: false,
        canReadPRs: true,
        canCreatePRs: false,
        canApprovePRs: false,
        canMergePRs: false,
        canCreateReleases: false,
        canTriggerActions: false,
        canCreateRepos: false,
        canDeleteRepos: false,
        canManageSettings: false,
      } as GitHubPolicy;

    case 'browser':
      return {
        canNavigate: true,
        urlFilter: { mode: 'allowlist', patterns: [] },
        canClick: false,
        canType: false,
        canScroll: true,
        canScreenshot: true,
        canExtractText: true,
        canFillForms: false,
        canSubmitForms: false,
        canDownload: false,
        canUpload: false,
        canExecuteJs: false,
        canUseStoredCredentials: false,
        canInputCredentials: false,
        canReadCookies: false,
        canInspectNetwork: false,
        canModifyRequests: false,
      } as BrowserPolicy;

    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${provider}`);
    }
  }
}

// ============================================
// Policy Enforcement
// ============================================

/**
 * Action to policy capability mapping
 */
const ACTION_TO_CAPABILITY: Record<string, Record<string, string>> = {
  gmail: {
    'gmail.read': 'canRead',
    'gmail.search': 'canRead',
    'gmail.get': 'canRead',
    'gmail.list': 'canRead',
    'gmail.archive': 'canArchive',
    'gmail.trash': 'canTrash',
    'gmail.markRead': 'canMarkRead',
    'gmail.mark_read': 'canMarkRead',
    'gmail.markUnread': 'canMarkRead',
    'gmail.mark_unread': 'canMarkRead',
    'gmail.label': 'canLabel',
    'gmail.add_label': 'canLabel',
    'gmail.removeLabel': 'canLabel',
    'gmail.remove_label': 'canLabel',
    'gmail.send': 'canSend',
    'gmail.draft': 'canSend',
    'gmail.reply': 'canSend',
  },
  google_calendar: {
    'calendar.read': 'canRead',
    'calendar.list': 'canRead',
    'calendar.get': 'canRead',
    'calendar.create': 'canCreate',
    'calendar.update': 'canUpdate',
    'calendar.delete': 'canDelete',
    'calendar.list_calendars': 'canRead',
    'calendar.list_events': 'canRead',
    'calendar.get_event': 'canRead',
    'calendar.search_events': 'canRead',
    'calendar.create_event': 'canCreate',
    'calendar.update_event': 'canUpdate',
    'calendar.delete_event': 'canDelete',
  },
  google_contacts: {
    'contacts.read': 'canRead',
    'contacts.list': 'canRead',
    'contacts.get': 'canRead',
    'contacts.create': 'canCreate',
    'contacts.update': 'canUpdate',
    'contacts.delete': 'canDelete',
  },
  google_sheets: {
    'sheets.read': 'canRead',
    'sheets.get': 'canRead',
    'sheets.list': 'canRead',
    'sheets.write': 'canWrite',
    'sheets.update': 'canWrite',
    'sheets.append': 'canWrite',
    'sheets.create': 'canWrite',
  },
  google_forms: {
    'forms.read': 'canRead',
    'forms.get': 'canRead',
    'forms.list': 'canRead',
    'forms.readResponses': 'canReadResponses',
    'forms.create': 'canCreate',
    'forms.update': 'canUpdate',
    'forms.delete': 'canDelete',
  },
  google_drive: {
    'drive.read': 'canRead',
    'drive.list': 'canRead',
    'drive.get': 'canRead',
    'drive.download': 'canDownload',
    'drive.upload': 'canUpload',
    'drive.create': 'canCreate',
    'drive.update': 'canUpdate',
    'drive.delete': 'canDelete',
    'drive.move': 'canMove',
    'drive.share': 'canShare',
    'drive.sync_list': 'canRead',
    'drive.changes_start_token': 'canRead',
    'drive.changes_list': 'canRead',
    'drive.sync_config': 'canRead',
  },
  onedrive: {
    'onedrive.read': 'canRead',
    'onedrive.list': 'canRead',
    'onedrive.get': 'canRead',
    'onedrive.download': 'canDownload',
    'onedrive.upload': 'canUpload',
    'onedrive.create': 'canCreate',
    'onedrive.update': 'canUpdate',
    'onedrive.delete': 'canDelete',
    'onedrive.move': 'canMove',
    'onedrive.share': 'canShare',
  },
  box: {
    'box.read': 'canRead',
    'box.list': 'canRead',
    'box.get': 'canRead',
    'box.download': 'canDownload',
    'box.upload': 'canUpload',
    'box.create': 'canCreate',
    'box.update': 'canUpdate',
    'box.delete': 'canDelete',
    'box.move': 'canMove',
    'box.share': 'canShare',
  },
  github: {
    'github.readRepos': 'canReadRepos',
    'github.listRepos': 'canReadRepos',
    'github.list_repos': 'canReadRepos',
    'github.get_repo': 'canReadRepos',
    'github.readCode': 'canReadCode',
    'github.getFile': 'canReadCode',
    'github.get_file': 'canReadCode',
    'github.list_files': 'canReadCode',
    'github.search_code': 'canReadCode',
    'github.clone': 'canClone',
    'github.push': 'canPush',
    'github.commit': 'canPush',
    'github.readIssues': 'canReadIssues',
    'github.listIssues': 'canReadIssues',
    'github.list_issues': 'canReadIssues',
    'github.createIssue': 'canCreateIssues',
    'github.create_issue': 'canCreateIssues',
    'github.commentIssue': 'canCommentIssues',
    'github.closeIssue': 'canCloseIssues',
    'github.readPRs': 'canReadPRs',
    'github.listPRs': 'canReadPRs',
    'github.list_prs': 'canReadPRs',
    'github.createPR': 'canCreatePRs',
    'github.create_pr': 'canCreatePRs',
    'github.approvePR': 'canApprovePRs',
    'github.mergePR': 'canMergePRs',
    'github.createRelease': 'canCreateReleases',
    'github.triggerAction': 'canTriggerActions',
    'github.createRepo': 'canCreateRepos',
    'github.deleteRepo': 'canDeleteRepos',
    'github.manageSettings': 'canManageSettings',
  },
  browser: {
    'browser.lifecycle': 'canNavigate',   // start/stop/status - no URL needed
    'browser.navigate': 'canNavigate',
    'browser.click': 'canClick',
    'browser.type': 'canType',
    'browser.scroll': 'canScroll',
    'browser.screenshot': 'canScreenshot',
    'browser.extractText': 'canExtractText',
    'browser.fillForm': 'canFillForms',
    'browser.submitForm': 'canSubmitForms',
    'browser.download': 'canDownload',
    'browser.upload': 'canUpload',
    'browser.executeJs': 'canExecuteJs',
    'browser.useCredentials': 'canUseStoredCredentials',
    'browser.inputCredentials': 'canInputCredentials',
    'browser.readCookies': 'canReadCookies',
    'browser.inspectNetwork': 'canInspectNetwork',
    'browser.modifyRequests': 'canModifyRequests',
  },
};

export interface EnforcementResult {
  allowed: boolean;
  decision: 'allowed' | 'denied' | 'filtered';
  reason?: string;
  filteredData?: unknown; // For response filtering
}

/**
 * Enforce policy for a specific action
 *
 * @param provider - The integration provider
 * @param action - The action being performed (e.g., "gmail.send")
 * @param policy - The active policy
 * @param terminalIntegrationId - The terminal integration ID for high-risk confirmation lookup
 * @param context - Enforcement context derived server-side (NEVER from sandbox request body)
 */
export async function enforcePolicy(
  env: Env,
  provider: IntegrationProvider,
  action: string,
  policy: AnyPolicy,
  terminalIntegrationId: string,
  context?: {
    url?: string;
    recipient?: string;
    recipientDomain?: string;
    recipients?: string[];           // ALL recipients (to + cc + bcc)
    recipientDomains?: string[];     // ALL recipient domains
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
): Promise<EnforcementResult> {
  // 1. Map action to capability
  const providerActions = ACTION_TO_CAPABILITY[provider];
  if (!providerActions) {
    return { allowed: false, decision: 'denied', reason: `Unknown provider: ${provider}` };
  }

  const capability = providerActions[action];
  if (!capability) {
    // Unknown action - deny by default for security
    return { allowed: false, decision: 'denied', reason: `Unknown action: ${action}` };
  }

  // 2. Check if capability is enabled in policy
  const policyObj = policy as unknown as Record<string, unknown>;
  const capabilityEnabled = policyObj[capability];

  if (capabilityEnabled !== true) {
    return {
      allowed: false,
      decision: 'denied',
      reason: `Policy does not allow ${capability}`,
    };
  }

  // 3. Check if this is a high-risk capability that requires confirmation
  const highRiskCaps = HIGH_RISK_CAPABILITIES[provider] || [];
  if (highRiskCaps.includes(capability)) {
    // Check if user has confirmed this capability
    const confirmed = await env.DB.prepare(`
      SELECT id FROM high_risk_confirmations
      WHERE terminal_integration_id = ? AND capability = ?
      LIMIT 1
    `)
      .bind(terminalIntegrationId, capability)
      .first();

    if (!confirmed) {
      return {
        allowed: false,
        decision: 'denied',
        reason: `High-risk capability ${capability} requires explicit user confirmation`,
      };
    }
  }

  // 4. Apply provider-specific filters
  if (provider === 'gmail' && context) {
    const gmailPolicy = policy as GmailPolicy;

    // NOTE: Sender filtering for read/search is NOT enforced at request time.
    // The sender is unknown until the API returns results. Sender filtering
    // is applied at response time by filterGmailResponse() in response-filter.ts,
    // which strips messages from non-allowed senders before returning to the agent.

    // Check send policy for send operations - ALL recipients must be allowed
    if (action === 'gmail.send' || action === 'gmail.reply' || action === 'gmail.draft') {
      if (gmailPolicy.sendPolicy) {
        const { allowedRecipients, allowedDomains } = gmailPolicy.sendPolicy;

        if (allowedDomains?.length || allowedRecipients?.length) {
          // Use recipients array (all to/cc/bcc) if available, fall back to single recipient
          const allRecipients = context.recipients?.length
            ? context.recipients
            : context.recipient ? [context.recipient] : [];
          const allDomains = context.recipientDomains?.length
            ? context.recipientDomains
            : context.recipientDomain ? [context.recipientDomain] : [];

          if (allRecipients.length === 0) {
            return {
              allowed: false,
              decision: 'denied',
              reason: 'No recipients provided for send operation',
            };
          }

          // EVERY recipient must match the allowlist - not just the first one
          for (let i = 0; i < allRecipients.length; i++) {
            const recipient = allRecipients[i]?.toLowerCase();
            const recipientDomain = allDomains[i]?.toLowerCase();

            const domainAllowed = allowedDomains?.some(d => d.toLowerCase() === recipientDomain);
            const recipientAllowed = allowedRecipients?.some(r => r.toLowerCase() === recipient);
            if (!domainAllowed && !recipientAllowed) {
              return {
                allowed: false,
                decision: 'denied',
                reason: `Recipient ${recipient} not in allowed list`,
              };
            }
          }
        }
      }
    }
  }

  // GitHub repoFilter enforcement for direct actions (get_repo, list_issues, get_file, etc.)
  if (provider === 'github' && context) {
    const githubPolicy = policy as GitHubPolicy;

    if (githubPolicy.repoFilter && githubPolicy.repoFilter.mode !== 'all' && context.repoOwner) {
      const { mode, repos: repoPatterns, orgs } = githubPolicy.repoFilter;
      const ownerName = context.repoOwner.toLowerCase();
      const fullName = context.repoName
        ? `${context.repoOwner}/${context.repoName}`.toLowerCase()
        : '';

      let orgMatch = true;  // default pass if no org filter
      let repoMatch = true; // default pass if no repo pattern filter

      if (orgs?.length) {
        orgMatch = orgs.some(o => o.toLowerCase() === ownerName);
      }

      if (repoPatterns?.length && fullName) {
        repoMatch = repoPatterns.some(pattern => {
          return globToRegex(pattern.toLowerCase()).test(fullName);
        });
      }

      if (mode === 'allowlist') {
        // Must match at least one allowed org or repo pattern
        const orgAllowed = orgs?.length ? orgMatch : false;
        const repoAllowed = repoPatterns?.length ? repoMatch : false;
        if (!orgAllowed && !repoAllowed) {
          return {
            allowed: false,
            decision: 'denied',
            reason: `Repository ${fullName || ownerName} not in allowlist`,
          };
        }
      }

      if (mode === 'blocklist') {
        // Must NOT match any blocked org or repo pattern
        const orgBlocked = orgs?.length && orgMatch;
        const repoBlocked = repoPatterns?.length && repoMatch;
        if (orgBlocked || repoBlocked) {
          return {
            allowed: false,
            decision: 'denied',
            reason: `Repository ${fullName || ownerName} is blocklisted`,
          };
        }
      }
    }
  }

  // Calendar calendarFilter and createPolicy enforcement
  if (provider === 'google_calendar' && context) {
    const calendarPolicy = policy as CalendarPolicy;

    // Skip calendarFilter for actions that don't target a specific calendar
    // (e.g., list_calendars just lists available calendars)
    const isCalendarScoped = action !== 'calendar.list_calendars' && action !== 'calendar.list';

    if (isCalendarScoped) {
      const calendarId = context.calendarId?.toLowerCase() || 'primary';

      // Check calendarFilter for calendar-scoped operations
      if (calendarPolicy.calendarFilter && calendarPolicy.calendarFilter.mode !== 'all') {
        const { calendarIds } = calendarPolicy.calendarFilter;
        if (calendarIds?.length) {
          const allowed = calendarIds.some(id => id.toLowerCase() === calendarId || (calendarId === 'primary' && id === 'primary'));
          if (!allowed) {
            return {
              allowed: false,
              decision: 'denied',
              reason: `Calendar ${calendarId} not in allowlist`,
            };
          }
        }
      }

      // Check createPolicy.allowedCalendars for create operations
      if (action.includes('create') && calendarPolicy.createPolicy?.allowedCalendars?.length) {
        const allowed = calendarPolicy.createPolicy.allowedCalendars.some(
          id => id.toLowerCase() === calendarId || (calendarId === 'primary' && id === 'primary')
        );
        if (!allowed) {
          return {
            allowed: false,
            decision: 'denied',
            reason: `Cannot create events in calendar ${calendarId}`,
          };
        }
      }
    }
  }

  // Drive folderFilter and fileTypeFilter enforcement for write actions
  // (create, update, share). Read/list/download filtering is handled by
  // response-filter.ts and the gateway pre-check, but writes must be
  // checked at request time to prevent creating files in disallowed folders
  // or with disallowed file types.
  if (provider === 'google_drive' && context) {
    const drivePolicy = policy as GoogleDrivePolicy;

    // Folder filter: enforce for create (target folderId) and update/share (existing file)
    if (drivePolicy.folderFilter && drivePolicy.folderFilter.mode !== 'all' && drivePolicy.folderFilter.folderIds?.length) {
      const { mode, folderIds } = drivePolicy.folderFilter;

      if (action === 'drive.create' && context.folderId) {
        const inAllowedFolder = folderIds.includes(context.folderId);
        if (mode === 'allowlist' && !inAllowedFolder) {
          return {
            allowed: false,
            decision: 'denied',
            reason: `Folder ${context.folderId} not in allowed folder list`,
          };
        }
        if (mode === 'blocklist' && inAllowedFolder) {
          return {
            allowed: false,
            decision: 'denied',
            reason: `Folder ${context.folderId} is blocklisted`,
          };
        }
      }
      // Note: drive.update and drive.share target existing files. Their folder
      // is checked via the gateway pre-check (metadata fetch + filter), not here,
      // because the folder info isn't in the request args.
    }

    // File type filter: enforce for create (mimeType and file name from args)
    if (drivePolicy.fileTypeFilter && drivePolicy.fileTypeFilter.mode !== 'all') {
      const { mode, mimeTypes, extensions } = drivePolicy.fileTypeFilter;

      if (action === 'drive.create') {
        const fileMime = context.mimeType?.toLowerCase();
        const fileName = context.fileName?.toLowerCase();

        const mimeMatch = mimeTypes?.some(t => fileMime?.includes(t.toLowerCase()));
        const extMatch = extensions?.some(ext => fileName?.endsWith(ext.toLowerCase()));
        const typeMatch = mimeMatch || extMatch;

        if (mode === 'allowlist' && !typeMatch) {
          return {
            allowed: false,
            decision: 'denied',
            reason: `File type ${fileMime || 'unknown'} (${fileName || 'unnamed'}) not in allowed types`,
          };
        }
        if (mode === 'blocklist' && typeMatch) {
          return {
            allowed: false,
            decision: 'denied',
            reason: `File type ${fileMime || 'unknown'} (${fileName || 'unnamed'}) is blocklisted`,
          };
        }
      }
    }
  }

  // Browser URL filter
  if (provider === 'browser') {
    const browserPolicy = policy as BrowserPolicy;
    if (browserPolicy.urlFilter && browserPolicy.urlFilter.patterns?.length) {
      // Browser lifecycle actions (start/stop/status) don't interact with any page
      // and don't need URL checks. All other actions require a URL when a filter
      // is configured.
      const BROWSER_LIFECYCLE_ACTIONS = new Set([
        'browser.lifecycle',  // start/stop/status mapped to this action
      ]);

      if (!BROWSER_LIFECYCLE_ACTIONS.has(action)) {
        if (!context?.url) {
          // Fail closed: all non-lifecycle browser actions require a URL
          // when an allowlist or blocklist is configured, including browser.navigate.
          // A navigate call without a URL is invalid and should be denied.
          return {
            allowed: false,
            decision: 'denied',
            reason: 'Browser URL required for URL filter enforcement but not available',
          };
        }
      }

      if (context?.url) {
        const { mode, patterns } = browserPolicy.urlFilter;
        const url = context.url.toLowerCase();

        if (mode === 'allowlist') {
          const allowed = patterns.some(pattern => globToRegex(pattern).test(url));
          if (!allowed) {
            return {
              allowed: false,
              decision: 'denied',
              reason: `URL ${url} not in allowlist`,
            };
          }
        } else if (mode === 'blocklist') {
          const blocked = patterns.some(pattern => globToRegex(pattern).test(url));
          if (blocked) {
            return {
              allowed: false,
              decision: 'denied',
              reason: `URL ${url} is blocklisted`,
            };
          }
        }
      }
    }
  }

  // 5. All checks passed
  return { allowed: true, decision: 'allowed' };
}

function formatTerminalIntegration(row: Record<string, unknown>): TerminalIntegration {
  return {
    id: row.id as string,
    terminalId: row.terminal_id as string,
    itemId: (row.item_id as string) ?? null,
    dashboardId: row.dashboard_id as string,
    userId: row.user_id as string,
    provider: row.provider as IntegrationProvider,
    userIntegrationId: row.user_integration_id as string | null,
    activePolicyId: row.active_policy_id as string | null,
    accountEmail: row.account_email as string | null,
    accountLabel: row.account_label as string | null,
    deletedAt: row.deleted_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string,
  };
}

function formatIntegrationPolicy(row: Record<string, unknown>): IntegrationPolicy {
  return {
    id: row.id as string,
    terminalIntegrationId: row.terminal_integration_id as string,
    version: row.version as number,
    policy: JSON.parse(row.policy as string) as AnyPolicy,
    securityLevel: row.security_level as SecurityLevel,
    createdAt: row.created_at as string,
    createdBy: row.created_by as string,
  };
}

async function ensureDashboardAccess(
  env: Env,
  dashboardId: string,
  userId: string
): Promise<{ role: string } | null> {
  const access = await env.DB.prepare(
    `SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?`
  )
    .bind(dashboardId, userId)
    .first<{ role: string }>();
  return access ?? null;
}

async function ensureTerminalAccess(
  env: Env,
  terminalId: string,
  userId: string
): Promise<{ dashboardId: string } | null> {
  // Terminal ID = PTY ID from sessions table
  const session = await env.DB.prepare(`
    SELECT s.dashboard_id
    FROM sessions s
    JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
    WHERE s.pty_id = ? AND dm.user_id = ?
  `)
    .bind(terminalId, userId)
    .first<{ dashboard_id: string }>();

  if (!session) return null;
  return { dashboardId: session.dashboard_id };
}

// ============================================
// API Handlers
// ============================================

/**
 * List available integrations for attaching to a terminal
 * Shows all user's connected accounts grouped by provider
 */
export async function listAvailableIntegrations(
  env: Env,
  dashboardId: string,
  terminalId: string,
  userId: string
): Promise<Response> {
  // Verify dashboard access
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: 'E79734: Not found or no access' }, { status: 404 });
  }

  // Verify terminal belongs to this dashboard
  const terminalAccess = await ensureTerminalAccess(env, terminalId, userId);
  if (!terminalAccess || terminalAccess.dashboardId !== dashboardId) {
    return Response.json({ error: 'E79735: Terminal not found or does not belong to this dashboard' }, { status: 404 });
  }

  // Get all user's OAuth integrations
  const userIntegrations = await env.DB.prepare(`
    SELECT id, provider, metadata
    FROM user_integrations
    WHERE user_id = ?
  `)
    .bind(userId)
    .all();

  // Get integrations already attached to this terminal
  const attachedIntegrations = await env.DB.prepare(`
    SELECT provider, id as terminal_integration_id, active_policy_id, user_integration_id
    FROM terminal_integrations
    WHERE terminal_id = ? AND deleted_at IS NULL
  `)
    .bind(terminalId)
    .all();

  const attachedMap = new Map<string, Record<string, unknown>>();
  for (const row of attachedIntegrations.results) {
    attachedMap.set(row.provider as string, row as Record<string, unknown>);
  }

  const integrations: AvailableIntegration[] = [];

  // Add OAuth-based integrations
  for (const row of userIntegrations.results) {
    const provider = row.provider as IntegrationProvider;
    const metadata = row.metadata ? JSON.parse(row.metadata as string) : {};
    const attached = attachedMap.get(provider);

    integrations.push({
      provider,
      userIntegrationId: row.id as string,
      accountEmail: metadata.email || metadata.login || null,
      accountLabel: metadata.name || null,
      connected: true,
      attached: !!attached && attached.user_integration_id === row.id,
      terminalIntegrationId: attached?.terminal_integration_id as string | undefined,
      policyId: attached?.active_policy_id as string | undefined,
    });
  }

  // Add browser (always available, no OAuth)
  const browserAttached = attachedMap.get('browser');
  integrations.push({
    provider: 'browser',
    connected: true,
    attached: !!browserAttached,
    terminalIntegrationId: browserAttached?.terminal_integration_id as string | undefined,
    policyId: browserAttached?.active_policy_id as string | undefined,
  });

  // Add disconnected providers (for "connect" buttons)
  const connectedProviders = new Set(userIntegrations.results.map((r) => r.provider as string));
  const allProviders: IntegrationProvider[] = [
    'gmail',
    'google_calendar',
    'google_contacts',
    'google_sheets',
    'google_forms',
    'google_drive',
    'onedrive',
    'box',
    'github',
  ];

  for (const provider of allProviders) {
    if (!connectedProviders.has(provider)) {
      integrations.push({
        provider,
        connected: false,
        attached: false,
      });
    }
  }

  return Response.json({ integrations });
}

/**
 * List integrations attached to a terminal
 */
export async function listTerminalIntegrations(
  env: Env,
  dashboardId: string,
  terminalId: string,
  userId: string
): Promise<Response> {
  // Verify dashboard access
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: 'E79734: Not found or no access' }, { status: 404 });
  }

  // Verify terminal belongs to this dashboard
  const terminalAccess = await ensureTerminalAccess(env, terminalId, userId);
  if (!terminalAccess || terminalAccess.dashboardId !== dashboardId) {
    return Response.json({ error: 'E79735: Terminal not found or does not belong to this dashboard' }, { status: 404 });
  }

  const rows = await env.DB.prepare(`
    SELECT ti.*, ip.policy, ip.version as policy_version, ip.security_level
    FROM terminal_integrations ti
    LEFT JOIN integration_policies ip ON ti.active_policy_id = ip.id
    WHERE ti.terminal_id = ? AND ti.dashboard_id = ? AND ti.deleted_at IS NULL
    ORDER BY ti.created_at DESC
  `)
    .bind(terminalId, dashboardId)
    .all();

  const integrations: TerminalIntegrationWithPolicy[] = rows.results.map((row) => {
    const base = formatTerminalIntegration(row as Record<string, unknown>);
    return {
      ...base,
      policy: row.policy ? (JSON.parse(row.policy as string) as AnyPolicy) : null,
      policyVersion: (row.policy_version as number) ?? null,
      securityLevel: (row.security_level as SecurityLevel) ?? null,
    };
  });

  return Response.json({ integrations });
}

/**
 * Attach an integration to a terminal (creates binding + initial policy)
 */
export async function attachIntegration(
  env: Env,
  dashboardId: string,
  terminalId: string,
  userId: string,
  data: {
    provider: IntegrationProvider;
    userIntegrationId?: string;
    policy?: AnyPolicy;
    accountLabel?: string;
    highRiskConfirmations?: string[];
  }
): Promise<Response> {
  const { provider, userIntegrationId, policy: providedPolicy, accountLabel, highRiskConfirmations } = data;

  // Verify dashboard access
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access || access.role === 'viewer') {
    return Response.json({ error: 'E79734: Not found or no access' }, { status: 404 });
  }

  // Verify terminal belongs to this dashboard (prevents attaching to guessed PTY IDs)
  const terminalAccess = await ensureTerminalAccess(env, terminalId, userId);
  if (!terminalAccess) {
    return Response.json({ error: 'E79735: Terminal not found or no access' }, { status: 404 });
  }
  if (terminalAccess.dashboardId !== dashboardId) {
    return Response.json({ error: 'E79736: Terminal does not belong to this dashboard' }, { status: 403 });
  }

  // Browser requires URL patterns
  if (provider === 'browser') {
    const browserPolicy = providedPolicy as BrowserPolicy | undefined;
    if (!browserPolicy?.urlFilter?.patterns?.length) {
      return Response.json(
        { error: 'Browser integration requires at least one URL pattern' },
        { status: 400 }
      );
    }
  } else {
    // Non-browser providers require userIntegrationId
    if (!userIntegrationId) {
      return Response.json(
        { error: 'userIntegrationId is required for non-browser providers' },
        { status: 400 }
      );
    }

    // Verify user owns the OAuth integration
    const userInt = await env.DB.prepare(
      `SELECT user_id, metadata FROM user_integrations WHERE id = ?`
    )
      .bind(userIntegrationId)
      .first<{ user_id: string; metadata: string }>();

    if (!userInt || userInt.user_id !== userId) {
      return Response.json(
        { error: 'OAuth connection does not belong to user' },
        { status: 403 }
      );
    }
  }

  // Check if already attached (non-deleted)
  const existing = await env.DB.prepare(`
    SELECT id FROM terminal_integrations
    WHERE terminal_id = ? AND provider = ? AND deleted_at IS NULL
  `)
    .bind(terminalId, provider)
    .first();

  if (existing) {
    return Response.json(
      { error: `${provider} is already attached to this terminal` },
      { status: 409 }
    );
  }

  // Get account email from OAuth metadata if available
  let accountEmail: string | null = null;
  if (userIntegrationId) {
    const userInt = await env.DB.prepare(
      `SELECT metadata FROM user_integrations WHERE id = ?`
    )
      .bind(userIntegrationId)
      .first<{ metadata: string }>();
    if (userInt?.metadata) {
      const meta = JSON.parse(userInt.metadata);
      accountEmail = meta.email || meta.login || null;
    }
  }

  // Determine policy - use provided or default
  const policy = providedPolicy ?? createDefaultFullAccessPolicy(provider);
  const securityLevel = calculateSecurityLevel(provider, policy);

  // Create terminal integration and initial policy in transaction (atomic batch)
  const terminalIntegrationId = generateId('ti');
  const policyId = generateId('pol');

  // Look up the stable item_id for this terminal (PTY ID -> session -> item_id)
  // This enables integration persistence across session boundaries.
  const sessionForItem = await env.DB.prepare(
    `SELECT item_id FROM sessions WHERE pty_id = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(terminalId).first<{ item_id: string }>();
  const itemId = sessionForItem?.item_id ?? null;

  // Build batch of statements for atomic execution
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      INSERT INTO terminal_integrations
        (id, terminal_id, item_id, dashboard_id, user_id, provider, user_integration_id,
         active_policy_id, account_email, account_label, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      terminalIntegrationId,
      terminalId,
      itemId,
      dashboardId,
      userId,
      provider,
      userIntegrationId ?? null,
      policyId,
      accountEmail,
      accountLabel ?? null,
      userId
    ),
    env.DB.prepare(`
      INSERT INTO integration_policies
        (id, terminal_integration_id, version, policy, security_level, created_by)
      VALUES (?, ?, 1, ?, ?, ?)
    `).bind(policyId, terminalIntegrationId, JSON.stringify(policy), securityLevel, userId),
  ];

  // Add high-risk confirmation statements to batch
  if (highRiskConfirmations?.length) {
    for (const capability of highRiskConfirmations) {
      const confirmId = generateId('hrc');
      statements.push(
        env.DB.prepare(`
          INSERT INTO high_risk_confirmations
            (id, terminal_integration_id, capability, confirmed_by)
          VALUES (?, ?, ?, ?)
        `).bind(confirmId, terminalIntegrationId, capability, userId)
      );
    }
  }

  // Execute all statements atomically
  await env.DB.batch(statements);

  return Response.json({
    id: terminalIntegrationId,
    provider,
    userIntegrationId: userIntegrationId ?? null,
    activePolicyId: policyId,
    policyVersion: 1,
    securityLevel,
    accountEmail,
    accountLabel: accountLabel ?? null,
  });
}

/**
 * Update integration policy (creates new policy revision)
 */
export async function updateIntegrationPolicy(
  env: Env,
  dashboardId: string,
  terminalId: string,
  provider: IntegrationProvider,
  userId: string,
  data: {
    policy: AnyPolicy;
    highRiskConfirmations?: string[];
  }
): Promise<Response> {
  const { policy, highRiskConfirmations } = data;

  // Verify dashboard access
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access || access.role === 'viewer') {
    return Response.json({ error: 'E79734: Not found or no access' }, { status: 404 });
  }

  // Verify terminal belongs to this dashboard
  const terminalAccess = await ensureTerminalAccess(env, terminalId, userId);
  if (!terminalAccess || terminalAccess.dashboardId !== dashboardId) {
    return Response.json({ error: 'E79735: Terminal not found or does not belong to this dashboard' }, { status: 404 });
  }

  // Find existing terminal integration
  const existing = await env.DB.prepare(`
    SELECT id, active_policy_id
    FROM terminal_integrations
    WHERE terminal_id = ? AND dashboard_id = ? AND provider = ? AND deleted_at IS NULL
  `)
    .bind(terminalId, dashboardId, provider)
    .first<{ id: string; active_policy_id: string | null }>();

  if (!existing) {
    return Response.json(
      { error: `${provider} is not attached to this terminal` },
      { status: 404 }
    );
  }

  // Browser requires URL patterns
  if (provider === 'browser') {
    const browserPolicy = policy as BrowserPolicy;
    if (!browserPolicy?.urlFilter?.patterns?.length) {
      return Response.json(
        { error: 'Browser policy requires at least one URL pattern' },
        { status: 400 }
      );
    }
  }

  // Get current version to increment
  const currentPolicy = await env.DB.prepare(`
    SELECT MAX(version) as max_version FROM integration_policies
    WHERE terminal_integration_id = ?
  `)
    .bind(existing.id)
    .first<{ max_version: number }>();

  const newVersion = (currentPolicy?.max_version ?? 0) + 1;
  const securityLevel = calculateSecurityLevel(provider, policy);
  const newPolicyId = generateId('pol');

  // Build batch of statements for atomic execution
  const statements: D1PreparedStatement[] = [
    // Insert new policy revision
    env.DB.prepare(`
      INSERT INTO integration_policies
        (id, terminal_integration_id, version, policy, security_level, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(newPolicyId, existing.id, newVersion, JSON.stringify(policy), securityLevel, userId),
    // Update active_policy_id pointer
    env.DB.prepare(`
      UPDATE terminal_integrations
      SET active_policy_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(newPolicyId, existing.id),
  ];

  // Add high-risk confirmation statements to batch
  if (highRiskConfirmations?.length) {
    for (const capability of highRiskConfirmations) {
      const confirmId = generateId('hrc');
      statements.push(
        env.DB.prepare(`
          INSERT INTO high_risk_confirmations
            (id, terminal_integration_id, capability, confirmed_by)
          VALUES (?, ?, ?, ?)
        `).bind(confirmId, existing.id, capability, userId)
      );
    }
  }

  // Execute all statements atomically
  await env.DB.batch(statements);

  return Response.json({
    activePolicyId: newPolicyId,
    policyVersion: newVersion,
    previousPolicyId: existing.active_policy_id,
    securityLevel,
  });
}

/**
 * Detach integration from terminal (soft delete)
 */
export async function detachIntegration(
  env: Env,
  dashboardId: string,
  terminalId: string,
  provider: IntegrationProvider,
  userId: string
): Promise<Response> {
  // Verify dashboard access
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access || access.role === 'viewer') {
    return Response.json({ error: 'E79734: Not found or no access' }, { status: 404 });
  }

  // Verify terminal belongs to this dashboard
  const terminalAccess = await ensureTerminalAccess(env, terminalId, userId);
  if (!terminalAccess || terminalAccess.dashboardId !== dashboardId) {
    return Response.json({ error: 'E79735: Terminal not found or does not belong to this dashboard' }, { status: 404 });
  }

  // Find existing terminal integration
  const existing = await env.DB.prepare(`
    SELECT id FROM terminal_integrations
    WHERE terminal_id = ? AND dashboard_id = ? AND provider = ? AND deleted_at IS NULL
  `)
    .bind(terminalId, dashboardId, provider)
    .first<{ id: string }>();

  if (!existing) {
    return Response.json(
      { error: `${provider} is not attached to this terminal` },
      { status: 404 }
    );
  }

  // Soft delete (preserve audit history)
  await env.DB.prepare(`
    UPDATE terminal_integrations
    SET deleted_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `)
    .bind(existing.id)
    .run();

  return Response.json({
    detached: true,
    deletedAt: new Date().toISOString(),
  });
}

/**
 * Get policy history for a terminal integration
 */
export async function getPolicyHistory(
  env: Env,
  dashboardId: string,
  terminalId: string,
  provider: IntegrationProvider,
  userId: string
): Promise<Response> {
  // Verify dashboard access
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: 'E79734: Not found or no access' }, { status: 404 });
  }

  // Verify terminal belongs to this dashboard
  const terminalAccess = await ensureTerminalAccess(env, terminalId, userId);
  if (!terminalAccess || terminalAccess.dashboardId !== dashboardId) {
    return Response.json({ error: 'E79735: Terminal not found or does not belong to this dashboard' }, { status: 404 });
  }

  // Find terminal integration (include soft-deleted for history)
  const ti = await env.DB.prepare(`
    SELECT id FROM terminal_integrations
    WHERE terminal_id = ? AND dashboard_id = ? AND provider = ?
    ORDER BY created_at DESC LIMIT 1
  `)
    .bind(terminalId, dashboardId, provider)
    .first<{ id: string }>();

  if (!ti) {
    return Response.json(
      { error: `${provider} has never been attached to this terminal` },
      { status: 404 }
    );
  }

  const policies = await env.DB.prepare(`
    SELECT * FROM integration_policies
    WHERE terminal_integration_id = ?
    ORDER BY version DESC
  `)
    .bind(ti.id)
    .all();

  return Response.json({
    policies: policies.results.map((row) => formatIntegrationPolicy(row as Record<string, unknown>)),
  });
}

/**
 * Get audit log for a terminal integration
 */
export async function getAuditLog(
  env: Env,
  dashboardId: string,
  terminalId: string,
  provider: IntegrationProvider,
  userId: string,
  limit = 100,
  offset = 0
): Promise<Response> {
  // Verify dashboard access
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: 'E79734: Not found or no access' }, { status: 404 });
  }

  // Verify terminal belongs to this dashboard
  const terminalAccess = await ensureTerminalAccess(env, terminalId, userId);
  if (!terminalAccess || terminalAccess.dashboardId !== dashboardId) {
    return Response.json({ error: 'E79735: Terminal not found or does not belong to this dashboard' }, { status: 404 });
  }

  const rows = await env.DB.prepare(`
    SELECT * FROM integration_audit_log
    WHERE dashboard_id = ? AND terminal_id = ? AND provider = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `)
    .bind(dashboardId, terminalId, provider, limit, offset)
    .all();

  return Response.json({
    entries: rows.results.map((row) => ({
      id: row.id,
      action: row.action,
      resourceId: row.resource_id,
      policyVersion: row.policy_version,
      decision: row.policy_decision,
      denialReason: row.denial_reason,
      requestSummary: row.request_summary,
      createdAt: row.created_at,
    })),
  });
}

/**
 * Get dashboard-wide audit log
 */
export async function getDashboardAuditLog(
  env: Env,
  dashboardId: string,
  userId: string,
  limit = 100,
  offset = 0
): Promise<Response> {
  // Verify dashboard access
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: 'E79734: Not found or no access' }, { status: 404 });
  }

  const rows = await env.DB.prepare(`
    SELECT * FROM integration_audit_log
    WHERE dashboard_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `)
    .bind(dashboardId, limit, offset)
    .all();

  return Response.json({
    entries: rows.results.map((row) => ({
      id: row.id,
      terminalId: row.terminal_id,
      provider: row.provider,
      action: row.action,
      resourceId: row.resource_id,
      policyVersion: row.policy_version,
      decision: row.policy_decision,
      denialReason: row.denial_reason,
      requestSummary: row.request_summary,
      createdAt: row.created_at,
    })),
  });
}

// ============================================
// Internal Gateway Handlers (Sandbox → Control Plane)
// ============================================

/**
 * Validate a gateway request and return the active policy
 * Called by sandbox MCP server before executing integration tools
 */
export async function validateGatewayRequest(
  env: Env,
  terminalId: string,
  provider: IntegrationProvider,
  dashboardId: string,
  userId: string
): Promise<Response> {
  // Look up terminal_integration by (terminal_id, provider)
  const ti = await env.DB.prepare(`
    SELECT id, active_policy_id, user_integration_id, dashboard_id, user_id
    FROM terminal_integrations
    WHERE terminal_id = ? AND provider = ? AND deleted_at IS NULL
  `)
    .bind(terminalId, provider)
    .first<{
      id: string;
      active_policy_id: string | null;
      user_integration_id: string | null;
      dashboard_id: string;
      user_id: string;
    }>();

  if (!ti) {
    return Response.json(
      { error: 'NOT_ATTACHED', reason: `${provider} not attached to terminal` },
      { status: 404 }
    );
  }

  // Defense-in-depth: Verify terminal_integration belongs to same dashboard/user
  if (ti.dashboard_id !== dashboardId || ti.user_id !== userId) {
    return Response.json(
      { error: 'AUTH_DENIED', reason: 'Terminal integration does not match token context' },
      { status: 403 }
    );
  }

  // Load active policy
  if (!ti.active_policy_id) {
    return Response.json(
      { error: 'POLICY_DENIED', reason: 'No policy configured for this integration' },
      { status: 403 }
    );
  }

  const policy = await env.DB.prepare(
    `SELECT * FROM integration_policies WHERE id = ?`
  )
    .bind(ti.active_policy_id)
    .first<Record<string, unknown>>();

  if (!policy) {
    return Response.json(
      { error: 'POLICY_DENIED', reason: 'Policy configuration error' },
      { status: 500 }
    );
  }

  // Defense-in-depth: Verify policy belongs to this terminal_integration
  if (policy.terminal_integration_id !== ti.id) {
    return Response.json(
      { error: 'POLICY_DENIED', reason: 'Policy configuration error' },
      { status: 500 }
    );
  }

  // Get OAuth token if needed (non-browser providers)
  let accessToken: string | null = null;
  if (provider !== 'browser' && ti.user_integration_id) {
    const userInt = await env.DB.prepare(`
      SELECT access_token, refresh_token, expires_at
      FROM user_integrations WHERE id = ?
    `)
      .bind(ti.user_integration_id)
      .first<{ access_token: string; refresh_token: string | null; expires_at: string | null }>();

    if (!userInt) {
      return Response.json(
        { error: 'AUTH_DENIED', reason: 'OAuth connection not found' },
        { status: 403 }
      );
    }

    // TODO: Check token expiration and refresh if needed
    accessToken = userInt.access_token;
  }

  return Response.json({
    terminalIntegrationId: ti.id,
    policyId: policy.id,
    policyVersion: policy.version,
    policy: JSON.parse(policy.policy as string),
    securityLevel: policy.security_level,
    accessToken,
  });
}

/**
 * Validate a gateway request using a PTY token
 * This is the secure entry point - terminal_id is extracted from the verified token
 *
 * Security: The terminal_id comes FROM the cryptographically verified token,
 * not from an untrusted header. This prevents a compromised sandbox from
 * impersonating other terminals.
 *
 * @param action - The action being performed (e.g., "gmail_search", "calendar_create_event")
 *                 Used for rate limiting based on action category
 */
export async function validateGatewayWithToken(
  env: Env,
  ptyToken: string,
  provider: IntegrationProvider,
  action?: string,
  context?: {
    url?: string;
    recipient?: string;
    recipientDomain?: string;
    sender?: string;
    senderDomain?: string;
    resourceId?: string;
  }
): Promise<Response> {
  // 1. Verify PTY token signature and extract claims
  const claims = await verifyPtyToken(ptyToken, env.INTERNAL_API_TOKEN);

  if (!claims) {
    return Response.json(
      { error: 'AUTH_DENIED', reason: 'Invalid or expired PTY token' },
      { status: 401 }
    );
  }

  // 2. Extract terminal_id from verified token (not from untrusted source)
  const terminalId = claims.terminal_id;
  const dashboardId = claims.dashboard_id;
  const userId = claims.user_id;

  // 3. Look up terminal_integration and policy
  const ti = await env.DB.prepare(`
    SELECT id, active_policy_id, user_integration_id, dashboard_id, user_id
    FROM terminal_integrations
    WHERE terminal_id = ? AND provider = ? AND deleted_at IS NULL
  `)
    .bind(terminalId, provider)
    .first<{
      id: string;
      active_policy_id: string | null;
      user_integration_id: string | null;
      dashboard_id: string;
      user_id: string;
    }>();

  if (!ti) {
    return Response.json(
      { error: 'NOT_ATTACHED', reason: `${provider} not attached to terminal` },
      { status: 404 }
    );
  }

  // Defense-in-depth: Verify terminal_integration belongs to same dashboard/user
  if (ti.dashboard_id !== dashboardId || ti.user_id !== userId) {
    return Response.json(
      { error: 'AUTH_DENIED', reason: 'Terminal integration does not match token context' },
      { status: 403 }
    );
  }

  // Load active policy
  if (!ti.active_policy_id) {
    return Response.json(
      { error: 'POLICY_DENIED', reason: 'No policy configured for this integration' },
      { status: 403 }
    );
  }

  const policyRow = await env.DB.prepare(
    `SELECT * FROM integration_policies WHERE id = ?`
  )
    .bind(ti.active_policy_id)
    .first<Record<string, unknown>>();

  if (!policyRow) {
    return Response.json(
      { error: 'POLICY_DENIED', reason: 'Policy configuration error' },
      { status: 500 }
    );
  }

  // Defense-in-depth: Verify policy belongs to this terminal_integration
  if (policyRow.terminal_integration_id !== ti.id) {
    return Response.json(
      { error: 'POLICY_DENIED', reason: 'Policy configuration error' },
      { status: 500 }
    );
  }

  const policy = JSON.parse(policyRow.policy as string) as AnyPolicy;

  // 4. Check rate limits if action is provided
  if (action) {
    const rateLimitResult = await checkRateLimit(env, ti.id, provider, action, policy);
    if (!rateLimitResult.allowed) {
      // Log rate limit denial
      await logAuditEntryInternal(env, {
        terminalIntegrationId: ti.id,
        terminalId,
        dashboardId,
        userId,
        provider,
        action,
        resourceId: context?.resourceId,
        policyId: policyRow.id as string,
        policyVersion: policyRow.version as number,
        decision: 'denied',
        denialReason: rateLimitResult.reason,
      });

      return Response.json(
        { error: 'RATE_LIMITED', reason: rateLimitResult.reason },
        { status: 429 }
      );
    }
  }

  // 5. Enforce policy for the specific action
  if (action) {
    const enforcement = await enforcePolicy(env, provider, action, policy, ti.id, context);

    // Log the enforcement decision
    await logAuditEntryInternal(env, {
      terminalIntegrationId: ti.id,
      terminalId,
      dashboardId,
      userId,
      provider,
      action,
      resourceId: context?.resourceId,
      policyId: policyRow.id as string,
      policyVersion: policyRow.version as number,
      decision: enforcement.decision,
      denialReason: enforcement.reason,
    });

    if (!enforcement.allowed) {
      return Response.json(
        {
          error: enforcement.decision === 'filtered' ? 'FILTERED' : 'POLICY_DENIED',
          reason: enforcement.reason,
          decision: enforcement.decision,
        },
        { status: 403 }
      );
    }
  }

  // 6. Get OAuth token if needed (non-browser providers)
  let accessToken: string | null = null;
  if (provider !== 'browser' && ti.user_integration_id) {
    const userInt = await env.DB.prepare(`
      SELECT access_token, refresh_token, expires_at
      FROM user_integrations WHERE id = ?
    `)
      .bind(ti.user_integration_id)
      .first<{ access_token: string; refresh_token: string | null; expires_at: string | null }>();

    if (!userInt) {
      return Response.json(
        { error: 'AUTH_DENIED', reason: 'OAuth connection not found' },
        { status: 403 }
      );
    }

    // TODO: Check token expiration and refresh if needed
    accessToken = userInt.access_token;
  }

  return Response.json({
    terminalIntegrationId: ti.id,
    policyId: policyRow.id,
    policyVersion: policyRow.version,
    policy,
    securityLevel: policyRow.security_level,
    accessToken,
  });
}

/**
 * Internal helper to log an audit entry (used by gateway functions)
 */
async function logAuditEntryInternal(
  env: Env,
  data: {
    terminalIntegrationId: string;
    terminalId: string;
    dashboardId: string;
    userId: string;
    provider: IntegrationProvider;
    action: string;
    resourceId?: string;
    policyId: string;
    policyVersion: number;
    decision: 'allowed' | 'denied' | 'filtered';
    denialReason?: string;
    requestSummary?: string;
  }
): Promise<void> {
  const id = generateId('aud');

  await env.DB.prepare(`
    INSERT INTO integration_audit_log
      (id, terminal_integration_id, terminal_id, dashboard_id, user_id, provider,
       action, resource_id, policy_id, policy_version, policy_decision, denial_reason, request_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
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
    )
    .run();
}

/**
 * Log an audit entry for a gateway operation (HTTP endpoint)
 */
export async function logAuditEntry(
  env: Env,
  data: {
    terminalIntegrationId: string;
    terminalId: string;
    dashboardId: string;
    userId: string;
    provider: IntegrationProvider;
    action: string;
    resourceId?: string;
    policyId: string;
    policyVersion: number;
    decision: 'allowed' | 'denied' | 'filtered';
    denialReason?: string;
    requestSummary?: string;
  }
): Promise<Response> {
  await logAuditEntryInternal(env, data);

  return Response.json({ logged: true });
}
