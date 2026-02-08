// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: response-filter-v7-empty-allowlist-pii
console.log(`[response-filter] REVISION: response-filter-v7-empty-allowlist-pii loaded at ${new Date().toISOString()}`);

/**
 * Response Filtering
 *
 * Filters API responses based on policy before returning to LLM.
 * This ensures the LLM never sees data it shouldn't have access to.
 *
 * Security: Even if an email matches a search query, if the sender is blocked,
 * the LLM doesn't learn the email exists.
 */

import type {
  IntegrationProvider,
  AnyPolicy,
  GmailPolicy,
  GitHubPolicy,
  GoogleDrivePolicy,
  CalendarPolicy,
  MessagingPolicy,
} from '../types';
import { globToRegex } from './handler';

export interface FilterResult {
  data: unknown;
  filtered: boolean;
  removedCount?: number;
}

/**
 * Filter API response based on policy
 */
export function filterResponse(
  provider: IntegrationProvider,
  action: string,
  response: unknown,
  policy: AnyPolicy
): FilterResult {
  switch (provider) {
    case 'gmail':
      return filterGmailResponse(action, response, policy as GmailPolicy);
    case 'github':
      return filterGitHubResponse(action, response, policy as GitHubPolicy);
    case 'google_drive':
      return filterDriveResponse(action, response, policy as GoogleDrivePolicy);
    case 'google_calendar':
      return filterCalendarResponse(action, response, policy as CalendarPolicy);
    // Messaging providers — channel filtering is done at enforcement time;
    // response filtering strips sensitive PII (emails, phones, profile URLs)
    case 'slack':
    case 'discord':
    case 'telegram':
    case 'whatsapp':
    case 'teams':
    case 'matrix':
    case 'google_chat':
      return filterMessagingResponse(action, response, policy as MessagingPolicy);
    default:
      return { data: response, filtered: false };
  }
}

// ============================================
// Gmail Filtering
// ============================================

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string };
  };
  internalDate?: string;
  from?: string;  // Extracted from headers
  to?: string;
  subject?: string;
}

function extractEmailDomain(email: string | undefined): string | undefined {
  if (!email) return undefined;
  // Extract email from "Name <email@domain.com>" or just "email@domain.com"
  const match = email.match(/<([^>]+)>/) || email.match(/([^\s<>]+@[^\s<>]+)/);
  const addr = match ? match[1] : email;
  const parts = addr.split('@');
  return parts.length === 2 ? parts[1].toLowerCase() : undefined;
}

function extractEmailAddress(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const match = email.match(/<([^>]+)>/) || email.match(/([^\s<>]+@[^\s<>]+)/);
  return match ? match[1].toLowerCase() : email.toLowerCase();
}

function filterGmailResponse(
  action: string,
  response: unknown,
  policy: GmailPolicy
): FilterResult {
  // Only filter read/search responses
  if (!action.includes('search') && !action.includes('list') && action !== 'gmail.get') {
    return { data: response, filtered: false };
  }

  // Handle list responses (array of messages)
  if (Array.isArray(response)) {
    return filterGmailMessages(response as GmailMessage[], policy);
  }

  // Handle single message response
  if (response && typeof response === 'object' && 'id' in response) {
    const result = filterGmailMessages([response as GmailMessage], policy);
    if (result.removedCount === 1) {
      return { data: null, filtered: true, removedCount: 1 };
    }
    return { data: response, filtered: false };
  }

  // Handle Gmail API list response format { messages: [...], nextPageToken: ... }
  if (response && typeof response === 'object' && 'messages' in response) {
    const listResponse = response as { messages: GmailMessage[]; nextPageToken?: string };
    const result = filterGmailMessages(listResponse.messages || [], policy);
    return {
      data: {
        ...listResponse,
        messages: result.data,
      },
      filtered: result.filtered,
      removedCount: result.removedCount,
    };
  }

  return { data: response, filtered: false };
}

function filterGmailMessages(
  messages: GmailMessage[],
  policy: GmailPolicy
): FilterResult & { data: GmailMessage[] } {
  const hasSenderFilter = policy.senderFilter && policy.senderFilter.mode !== 'all';
  const hasLabelFilter = policy.labelFilter && policy.labelFilter.mode !== 'all';

  if (!hasSenderFilter && !hasLabelFilter) {
    return { data: messages, filtered: false };
  }

  const originalCount = messages.length;

  const filtered = messages.filter(msg => {
    // Apply sender filter
    if (hasSenderFilter) {
      const { mode, domains, addresses } = policy.senderFilter!;

      let from = msg.from;
      if (!from && msg.payload?.headers) {
        const fromHeader = msg.payload.headers.find(h => h.name.toLowerCase() === 'from');
        from = fromHeader?.value;
      }

      const senderDomain = extractEmailDomain(from);
      const senderAddress = extractEmailAddress(from);

      if (mode === 'allowlist') {
        const domainMatch = domains?.some(d => d.toLowerCase() === senderDomain);
        const addressMatch = addresses?.some(a => a.toLowerCase() === senderAddress);
        if (!domainMatch && !addressMatch) return false;
      }

      if (mode === 'blocklist') {
        const domainBlocked = domains?.some(d => d.toLowerCase() === senderDomain);
        const addressBlocked = addresses?.some(a => a.toLowerCase() === senderAddress);
        if (domainBlocked || addressBlocked) return false;
      }
    }

    // Apply label filter
    if (hasLabelFilter) {
      const { labels } = policy.labelFilter!;
      // mode is 'allowlist' - message must have at least one allowed label
      if (labels?.length) {
        const msgLabels = msg.labelIds || [];
        const hasAllowedLabel = msgLabels.some(
          label => labels.some(allowed => allowed.toLowerCase() === label.toLowerCase())
        );
        if (!hasAllowedLabel) return false;
      }
    }

    return true;
  });

  const removedCount = originalCount - filtered.length;
  return {
    data: filtered,
    filtered: removedCount > 0,
    removedCount,
  };
}

// ============================================
// GitHub Filtering
// ============================================

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  owner: { login: string };
}

interface GitHubSearchCodeResult {
  name: string;
  path: string;
  repository: {
    full_name: string;
    owner: { login: string };
  };
}

function filterGitHubResponse(
  action: string,
  response: unknown,
  policy: GitHubPolicy
): FilterResult {
  if (!policy.repoFilter || policy.repoFilter.mode === 'all') {
    return { data: response, filtered: false };
  }

  // Filter repos in list/search results
  if (action.includes('list_repos') || action.includes('search_repos')) {
    if (Array.isArray(response)) {
      return filterGitHubRepos(response as GitHubRepo[], policy);
    }
  }

  // Filter search_code results by repository
  if (action.includes('search_code')) {
    // GitHub search API returns { items: [...], total_count: N }
    if (response && typeof response === 'object' && 'items' in response) {
      const searchResponse = response as { items: GitHubSearchCodeResult[]; total_count: number };
      const items = searchResponse.items || [];
      const originalCount = items.length;

      const filtered = items.filter(item => {
        if (!item.repository) return true;
        return isRepoAllowed(item.repository.full_name, item.repository.owner.login, policy);
      });

      const removedCount = originalCount - filtered.length;
      return {
        data: { ...searchResponse, items: filtered, total_count: searchResponse.total_count - removedCount },
        filtered: removedCount > 0,
        removedCount,
      };
    }
    // Array format
    if (Array.isArray(response)) {
      const items = response as GitHubSearchCodeResult[];
      const originalCount = items.length;
      const filtered = items.filter(item => {
        if (!item.repository) return true;
        return isRepoAllowed(item.repository.full_name, item.repository.owner.login, policy);
      });
      const removedCount = originalCount - filtered.length;
      return { data: filtered, filtered: removedCount > 0, removedCount };
    }
  }

  return { data: response, filtered: false };
}

/**
 * Check if a repo is allowed by the repoFilter policy.
 *
 * Allowlist uses OR logic: allow if org matches OR repo pattern matches.
 * This is consistent with request-time enforcement in handler.ts enforcePolicy().
 *
 * Blocklist uses OR logic: block if org matches OR repo pattern matches.
 */
function isRepoAllowed(fullName: string, ownerLogin: string, policy: GitHubPolicy): boolean {
  if (!policy.repoFilter || policy.repoFilter.mode === 'all') return true;

  const { mode, repos: repoPatterns, orgs } = policy.repoFilter;
  const repoName = fullName.toLowerCase();
  const ownerName = ownerLogin.toLowerCase();

  const orgMatch = orgs?.length
    ? orgs.some((o: string) => o.toLowerCase() === ownerName)
    : false;

  const patternMatch = repoPatterns?.length
    ? repoPatterns.some((pattern: string) => {
        return globToRegex(pattern.toLowerCase()).test(repoName);
      })
    : false;

  if (mode === 'allowlist') {
    // OR logic: allow if EITHER org or repo pattern matches
    // If neither orgs nor patterns are configured, nothing can match → deny
    const orgAllowed = orgs?.length ? orgMatch : false;
    const repoAllowed = repoPatterns?.length ? patternMatch : false;
    return orgAllowed || repoAllowed;
  }

  if (mode === 'blocklist') {
    // OR logic: block if EITHER org or repo pattern matches
    if (orgMatch || patternMatch) return false;
  }

  return true;
}

function filterGitHubRepos(
  repos: GitHubRepo[],
  policy: GitHubPolicy
): FilterResult & { data: GitHubRepo[] } {
  if (!policy.repoFilter || policy.repoFilter.mode === 'all') {
    return { data: repos, filtered: false };
  }

  const originalCount = repos.length;
  const filtered = repos.filter(repo => isRepoAllowed(repo.full_name, repo.owner.login, policy));
  const removedCount = originalCount - filtered.length;
  return {
    data: filtered,
    filtered: removedCount > 0,
    removedCount,
  };
}

// ============================================
// Drive Filtering
// ============================================

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  owners?: Array<{ emailAddress: string }>;
}

function filterDriveResponse(
  action: string,
  response: unknown,
  policy: GoogleDrivePolicy
): FilterResult {
  const hasFileTypeFilter = policy.fileTypeFilter && policy.fileTypeFilter.mode !== 'all';
  const hasFolderFilter = policy.folderFilter && policy.folderFilter.mode !== 'all' && policy.folderFilter.folderIds?.length;

  if (!hasFileTypeFilter && !hasFolderFilter) {
    return { data: response, filtered: false };
  }

  // Filter list/search/sync_list responses
  if (action.includes('list') || action.includes('search') || action === 'drive.sync_list') {
    // Handle Google Drive API response format { files: [...], ... }
    if (response && typeof response === 'object' && 'files' in response) {
      const listResponse = response as { files: DriveFile[]; nextPageToken?: string; totalSize?: number };
      const result = filterDriveFiles(listResponse.files || [], policy);
      return {
        data: {
          ...listResponse,
          files: result.data,
        },
        filtered: result.filtered,
        removedCount: result.removedCount,
      };
    }

    if (Array.isArray(response)) {
      return filterDriveFiles(response as DriveFile[], policy);
    }
  }

  // Filter changes_list responses — each change has a nested file object
  if (action === 'drive.changes_list') {
    if (response && typeof response === 'object' && 'changes' in response) {
      const changesResponse = response as { changes: Array<{ fileId: string; removed: boolean; file?: DriveFile }>; newStartPageToken: string };
      const originalCount = changesResponse.changes.length;
      const filteredChanges = changesResponse.changes.filter(change => {
        if (change.removed || !change.file) return true; // Pass through removals
        const result = filterDriveFiles([change.file], policy);
        return result.data.length > 0;
      });
      const removedCount = originalCount - filteredChanges.length;
      return {
        data: {
          ...changesResponse,
          changes: filteredChanges,
        },
        filtered: removedCount > 0,
        removedCount,
      };
    }
  }

  // Filter single file responses (get, download) - agent can't bypass filters
  // by using a known fileId to access files outside allowed scope
  if (action.includes('get') || action.includes('download')) {
    if (response && typeof response === 'object' && 'id' in response) {
      const file = response as DriveFile;
      const result = filterDriveFiles([file], policy);
      if (result.removedCount === 1) {
        return {
          data: null,
          filtered: true,
          removedCount: 1,
        };
      }
    }
  }

  return { data: response, filtered: false };
}

function filterDriveFiles(
  files: DriveFile[],
  policy: GoogleDrivePolicy
): FilterResult & { data: DriveFile[] } {
  const originalCount = files.length;
  let filtered = files;

  // Apply file type filter
  if (policy.fileTypeFilter && policy.fileTypeFilter.mode !== 'all') {
    const { mode, mimeTypes, extensions } = policy.fileTypeFilter;
    filtered = filtered.filter(file => {
      const mimeType = file.mimeType.toLowerCase();
      const fileName = file.name.toLowerCase();

      // Check mimeType match
      const mimeMatch = mimeTypes?.some((t: string) => mimeType.includes(t.toLowerCase()));
      // Check extension match
      const extMatch = extensions?.some((ext: string) => fileName.endsWith(ext.toLowerCase()));

      const typeMatch = mimeMatch || extMatch;
      if (mode === 'allowlist') return typeMatch;
      if (mode === 'blocklist') return !typeMatch;
      return true;
    });
  }

  // Apply folder filter if present
  if (policy.folderFilter && policy.folderFilter.mode !== 'all' && policy.folderFilter.folderIds?.length) {
    const { mode, folderIds } = policy.folderFilter;
    filtered = filtered.filter(file => {
      if (!file.parents?.length) return mode === 'blocklist'; // No parent = not in any folder
      const inAllowedFolder = file.parents.some(parent => folderIds!.includes(parent));
      if (mode === 'allowlist') return inAllowedFolder;
      if (mode === 'blocklist') return !inAllowedFolder;
      return true;
    });
  }

  const removedCount = originalCount - filtered.length;
  return {
    data: filtered,
    filtered: removedCount > 0,
    removedCount,
  };
}

// ============================================
// Calendar Filtering
// ============================================

interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  organizer?: { email: string };
  attendees?: Array<{ email: string }>;
}

function filterCalendarResponse(
  action: string,
  response: unknown,
  policy: CalendarPolicy
): FilterResult {
  // Calendar response filtering is intentionally a pass-through.
  //
  // The Google Calendar API already scopes events to the requested calendarId
  // (e.g., GET /calendars/{calendarId}/events). Request-time enforcement in
  // enforcePolicy() validates that calendarId is in the allowed list BEFORE
  // the API call is made.
  //
  // The previous implementation filtered by event.organizer.email, but this is
  // incorrect: organizer is the event CREATOR, not the calendar the event belongs
  // to. Invited events from external organizers and events on shared calendars
  // would be incorrectly filtered out, while events from an allowed organizer
  // on a disallowed calendar could slip through.
  //
  // For list_calendars, we DO filter to only show allowed calendars.
  if (!policy.calendarFilter || policy.calendarFilter.mode === 'all') {
    return { data: response, filtered: false };
  }

  const { calendarIds } = policy.calendarFilter;
  if (!calendarIds?.length) {
    return { data: response, filtered: false };
  }

  // Only filter list_calendars responses - filter out calendars not in the allowed list
  if (action === 'calendar.list_calendars') {
    if (response && typeof response === 'object' && 'calendars' in response) {
      const listResponse = response as { calendars: Array<{ id: string; summary: string; primary?: boolean }> };
      const calendars = listResponse.calendars || [];
      const originalCount = calendars.length;

      const filtered = calendars.filter(cal => {
        const calId = cal.id.toLowerCase();
        return calendarIds.some(id =>
          id.toLowerCase() === calId ||
          (id === 'primary' && cal.primary)
        );
      });

      const removedCount = originalCount - filtered.length;
      return {
        data: { ...listResponse, calendars: filtered },
        filtered: removedCount > 0,
        removedCount,
      };
    }
  }

  // Events are already scoped by calendarId at request time - no response filtering needed
  return { data: response, filtered: false };
}

// ============================================
// Messaging Filtering
// ============================================

/**
 * Filter messaging API responses to strip sensitive PII before the LLM sees it.
 * Slack/Discord API responses can contain emails, phone numbers, profile image URLs,
 * and other personal data that the LLM doesn't need for its task.
 */
function filterMessagingResponse(
  action: string,
  response: unknown,
  policy: MessagingPolicy,
): FilterResult {
  if (!response || typeof response !== 'object') {
    return { data: response, filtered: false };
  }

  // Deep-clone to avoid mutating cached API responses
  const cleaned = JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
  let didFilter = false;
  // For Discord array responses, we track a filtered array separately so PII stripping
  // still runs on it before returning (avoids the early-return that would skip PII strip).
  let discordArrayResult: Record<string, unknown>[] | null = null;

  // Channel list responses — filter to only channels in the allowlist.
  // list_channels is mapped to canReceive (not channel-targeted) so enforcement in
  // enforcePolicy doesn't apply channel restrictions. We filter at response time instead
  // to prevent channel metadata leaking outside the configured allowlist.
  if (action.includes('list_channels') && policy.channelFilter?.mode === 'allowlist') {
    const { channelIds, channelNames } = policy.channelFilter;
    const hasAllowlist = channelIds?.length || channelNames?.length;

    if (!hasAllowlist) {
      // Empty allowlist = deny all — return empty list (matches enforcePolicy's fail-closed invariant)
      if ('channels' in cleaned && Array.isArray(cleaned.channels)) {
        cleaned.channels = [];
        didFilter = true;
      } else if (Array.isArray(cleaned)) {
        discordArrayResult = [];
        didFilter = true;
      }
    } else {
      const normalizedNames = channelNames?.map(n => n.replace(/^#/, '').toLowerCase()) || [];

      const filterChannel = (ch: Record<string, unknown>): boolean => {
        const chId = ch.id as string | undefined;
        const chName = (ch.name as string | undefined)?.replace(/^#/, '').toLowerCase();
        const idMatch = chId && channelIds?.includes(chId);
        const nameMatch = chName && normalizedNames.includes(chName);
        return !!(idMatch || nameMatch);
      };

      // Slack returns { ok, channels: [...] }, Discord returns an array
      if ('channels' in cleaned && Array.isArray(cleaned.channels)) {
        const before = (cleaned.channels as Record<string, unknown>[]).length;
        cleaned.channels = (cleaned.channels as Record<string, unknown>[]).filter(filterChannel);
        didFilter = (cleaned.channels as unknown[]).length < before;
      } else if (Array.isArray(cleaned)) {
        discordArrayResult = (cleaned as unknown as Record<string, unknown>[]).filter(filterChannel);
        didFilter = true;
      }
    }
  }

  // User info responses — strip email, phone, profile image URLs
  if (action.includes('user_info') || action.includes('get_user')) {
    didFilter = stripUserPII(cleaned);
  }

  // Strip PII from array items (channel member data, Discord channel objects, etc.)
  if (discordArrayResult) {
    // Discord array was filtered — strip PII from the filtered result
    for (const item of discordArrayResult) {
      if (item && typeof item === 'object') {
        didFilter = stripUserPII(item) || didFilter;
      }
    }
    return { data: discordArrayResult, filtered: didFilter };
  }

  if (Array.isArray(cleaned)) {
    for (const item of cleaned) {
      if (item && typeof item === 'object') {
        didFilter = stripUserPII(item as Record<string, unknown>) || didFilter;
      }
    }
  }

  // Message list/search responses — strip user profile PII from embedded user objects
  if ('messages' in cleaned && Array.isArray(cleaned.messages)) {
    for (const msg of cleaned.messages as Record<string, unknown>[]) {
      if (msg && typeof msg === 'object') {
        // Slack search results embed user profiles in matches
        if (msg.user_profile && typeof msg.user_profile === 'object') {
          didFilter = stripUserPII(msg.user_profile as Record<string, unknown>) || didFilter;
        }
      }
    }
  }

  // User object at top level (e.g., users.info response)
  if ('user' in cleaned && cleaned.user && typeof cleaned.user === 'object') {
    didFilter = stripUserPII(cleaned.user as Record<string, unknown>) || didFilter;
  }

  return { data: cleaned, filtered: didFilter };
}

/**
 * Strip PII fields from a user-like object.
 * Returns true if any fields were removed.
 */
function stripUserPII(obj: Record<string, unknown>): boolean {
  let stripped = false;
  const PII_FIELDS = ['email', 'phone', 'skype', 'image_original', 'image_512', 'image_192', 'image_72'];

  for (const field of PII_FIELDS) {
    if (field in obj) {
      delete obj[field];
      stripped = true;
    }
  }

  // Recurse into nested profile objects
  if (obj.profile && typeof obj.profile === 'object') {
    const profile = obj.profile as Record<string, unknown>;
    for (const field of PII_FIELDS) {
      if (field in profile) {
        delete profile[field];
        stripped = true;
      }
    }
  }

  return stripped;
}
