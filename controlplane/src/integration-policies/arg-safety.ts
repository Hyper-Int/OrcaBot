// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: arg-safety-v3-gateway-provider-ids
import type { IntegrationProvider } from '../types';

const MODULE_REVISION = 'arg-safety-v3-gateway-provider-ids';
console.log(`[arg-safety] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Gateway argument validation, run before policy enforcement.
 *
 * enforcePolicy checks values derived from the LLM's arguments, and the API
 * clients then build requests from those same arguments. Anything that lets one
 * argument mean one thing to the check and another to the provider is a policy
 * bypass, so it is rejected here:
 *   - IDs interpolated into URL paths must be one plain path segment. A `/`,
 *     `..`, `?`, `#` or `%` would let an allowed ID reach another repo, channel,
 *     calendar or file once the URL is normalised.
 *   - Email header values must not contain CR/LF (header injection, e.g. Bcc).
 *   - Each recipient entry must be exactly one address; "a@ok.com, b@evil.com"
 *     would otherwise be checked as a@ok.com and sent to both.
 */

/** Messaging: the one arg each provider's client sends to (see api-clients/). */
export const MESSAGING_TARGET_FIELD: Record<string, string> = {
  slack: 'channel',
  discord: 'channel',
  telegram: 'chat_id',
  whatsapp: 'to',
  teams: 'channel_id',
  matrix: 'room_id',
  google_chat: 'space',
};

/**
 * Args each client interpolates into a URL path. Keyed by the gateway's
 * provider identifiers (IntegrationProvider) — a key that matches no provider
 * silently disables the check, so the type only admits real providers.
 */
export const PATH_SEGMENT_ARGS: Partial<Record<IntegrationProvider, string[]>> = {
  discord: ['channel', 'message_id', 'guild_id', 'user_id', 'user'],
  github: ['owner', 'repo'],
  google_drive: ['fileId', 'folderId'],
  gmail: ['messageId', 'threadId', 'labelId'],
  google_chat: ['member_id'],
  teams: ['team_id', 'channel_id', 'message_id', 'conversation_id', 'user_id'],
  whatsapp: ['phone_number_id', 'message_id'],
  twitter: ['tweet_id', 'user_id', 'username', 'target_user_id', 'account_id'],
  google_calendar: ['eventId', 'event_id'],
};

const EMAIL_PROVIDERS = new Set(['gmail', 'outlook']);
const EMAIL_HEADER_ARGS = ['subject', 'to', 'cc', 'bcc'];
const RECIPIENT_ARGS = ['to', 'cc', 'bcc'];

// Drive file/folder IDs are URL-safe base64-ish; folderId is also quoted into a
// Drive search query (`'<id>' in parents`), so a quote must never get through.
const DRIVE_ID = /^[A-Za-z0-9_-]+$/;

const CONTROL_OR_SPACE = /[\s\x00-\x1f\x7f]/;
const UNSAFE_PATH_CHARS = /[\/\\?#%]/;
const ADDR = '[^\\s<>@,;"]+@[^\\s<>@,;"]+';
// `addr` or `Display Name <addr>`; the display name can't hold separators or quotes.
const SINGLE_RECIPIENT = new RegExp(`^\\s*(?:${ADDR}|[^<>,;"\\r\\n]*<\\s*${ADDR}\\s*>)\\s*$`);

export function isSafePathSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' &&
    !UNSAFE_PATH_CHARS.test(value) && !CONTROL_OR_SPACE.test(value);
}

/**
 * A relative file path: no `.`/`..` segments (traversal) and no control
 * characters. Anything else is a legitimate filename character; the client
 * URL-encodes each segment (github.ts encodeRepoPath).
 */
function isSafeRelativePath(value: string): boolean {
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '.' && segment !== '..');
}

/** Google Chat space: `spaces/<id>` or a bare `<id>`. */
function chatSpaceName(space: string): string | null {
  const id = space.startsWith('spaces/') ? space.slice('spaces/'.length) : space;
  return isSafePathSegment(id) ? `spaces/${id}` : null;
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/** Returns a denial reason, or null if the args are safe to enforce and execute. */
export function validateGatewayArgs(provider: string, args: Record<string, unknown>): string | null {
  for (const field of PATH_SEGMENT_ARGS[provider as IntegrationProvider] ?? []) {
    const value = args[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !isSafePathSegment(value)) {
      return `E79610: Invalid ${field}: must be a single ID without '/', '..', '?', '#', '%' or spaces`;
    }
  }

  if (provider === 'google_drive') {
    for (const field of ['fileId', 'folderId']) {
      const value = args[field];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string' || !DRIVE_ID.test(value)) {
        return `E79621: Invalid ${field}: must be a Drive ID (letters, digits, '-' and '_')`;
      }
    }
  }

  if (provider === 'github' && args.path !== undefined) {
    if (typeof args.path !== 'string' || !isSafeRelativePath(args.path.replace(/^\/+/, ''))) {
      return "E79611: Invalid path: '.' and '..' segments are not allowed";
    }
  }

  if (provider === 'google_chat') {
    let spaceName: string | null = null;
    if (args.space !== undefined) {
      spaceName = typeof args.space === 'string' ? chatSpaceName(args.space) : null;
      if (!spaceName) return 'E79612: Invalid space';
    }
    if (args.message_id !== undefined) {
      const id = args.message_id;
      if (typeof id !== 'string') return 'E79612: Invalid message_id';
      if (id.startsWith('spaces/')) {
        // A full resource name replaces the space in the client, so it must be in the checked space.
        const parts = id.split('/');
        if (!spaceName || parts.length !== 4 || `${parts[0]}/${parts[1]}` !== spaceName ||
            parts[2] !== 'messages' || !isSafePathSegment(parts[3])) {
          return 'E79612: message_id must belong to the given space';
        }
      } else if (!isSafePathSegment(id)) {
        return 'E79612: Invalid message_id';
      }
    }
  }

  if (EMAIL_PROVIDERS.has(provider)) {
    for (const field of EMAIL_HEADER_ARGS) {
      if (stringValues(args[field]).some((v) => /[\r\n]/.test(v))) {
        return `E79613: Invalid ${field}: line breaks are not allowed`;
      }
    }
    for (const field of RECIPIENT_ARGS) {
      const value = args[field];
      if (value === undefined || value === null) continue;
      const entries = stringValues(value);
      if (entries.length !== (Array.isArray(value) ? value.length : 1)) {
        return `E79614: Invalid ${field}: recipients must be strings`;
      }
      if (entries.some((e) => !SINGLE_RECIPIENT.test(e))) {
        return `E79614: Invalid ${field}: give one address per entry`;
      }
    }
  }

  return null;
}
