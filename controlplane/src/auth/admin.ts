// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: admin-v1-admin-emails
const moduleRevision = 'admin-v1-admin-emails';

import type { Env } from '../types';

/**
 * Parse a comma-separated list of emails into a normalized Set.
 * Returns null if empty or not configured.
 */
function parseEmailList(value?: string): Set<string> | null {
  if (!value) {
    return null;
  }
  const entries = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return entries.length > 0 ? new Set(entries) : null;
}

/**
 * Check if a given email is in the ADMIN_EMAILS list.
 * Returns false if ADMIN_EMAILS is not configured.
 */
export function isAdminEmail(env: Env, email: string): boolean {
  const adminEmails = parseEmailList(env.ADMIN_EMAILS);
  if (!adminEmails) {
    return false;
  }
  return adminEmails.has(email.trim().toLowerCase());
}
