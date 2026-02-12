// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: subscription-check-v7-stripe-trial-end
const MODULE_REVISION = "subscription-check-v7-stripe-trial-end";
console.log(`[subscription-check] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import type { Env, SubscriptionStatus, SubscriptionInfo } from "../types";

const TRIAL_DURATION_DAYS = 3;

/**
 * Parse a comma-separated list of emails into a Set (lowercase).
 * Reuses the pattern from auth/google.ts parseAllowList.
 */
function parseEmailList(value?: string): Set<string> | null {
  if (!value) return null;
  const emails = value
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  return emails.length > 0 ? new Set(emails) : null;
}

/**
 * Check if email is in AUTH_ALLOWED_EMAILS (exempt from billing).
 * These users are treated as premium at runtime without DB storage.
 */
export function isExemptEmail(env: Env, email: string): boolean {
  const allowedEmails = parseEmailList(env.AUTH_ALLOWED_EMAILS);
  if (!allowedEmails) return false;
  return allowedEmails.has(email.trim().toLowerCase());
}

/**
 * Parse a created_at timestamp into a Date. Returns null if invalid/missing.
 *
 * Handles:
 * - D1 datetime('now'): 'YYYY-MM-DD HH:MM:SS' (no timezone → treat as UTC)
 * - ISO 8601 with Z:     '2026-01-15T10:30:00Z'
 * - ISO 8601 with offset: '2026-01-15T10:30:00+00:00'
 * - Any other format Date() can parse
 */
function parseCreatedAt(createdAt: string | undefined | null): Date | null {
  if (!createdAt) return null;
  let normalized = createdAt.trim();
  // D1 datetime('now') produces 'YYYY-MM-DD HH:MM:SS' — the space between
  // date and time is not reliably parsed by Date() in all JS engines.
  // Replace the first space with T to produce a valid ISO 8601 string.
  normalized = normalized.replace(" ", "T");
  // If the string has no timezone indicator (no Z, no +/- offset after the time),
  // assume UTC by appending Z.
  if (!/[Zz]$/.test(normalized) && !/[+-]\d{2}:\d{2}$/.test(normalized) && !/[+-]\d{4}$/.test(normalized)) {
    normalized += "Z";
  }
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Check if user's trial is still active based on created_at.
 */
export function isTrialActive(createdAt: string | undefined | null): boolean {
  const created = parseCreatedAt(createdAt);
  if (!created) return false; // Missing/invalid → treat as expired
  const trialEnd = new Date(created.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
  return new Date() < trialEnd;
}

/**
 * Get the trial expiry date as an ISO string. Returns null if createdAt is invalid.
 */
export function getTrialExpiry(createdAt: string | undefined | null): string | null {
  const created = parseCreatedAt(createdAt);
  if (!created) return null;
  return new Date(created.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Resolve the user's full subscription status.
 *
 * Priority (paid status is authoritative over free trial):
 * 1. AUTH_ALLOWED_EMAILS → exempt (runtime check, not DB)
 * 2. Stripe DB subscription → active / past_due / trialing (paid status wins)
 * 3. Free trial still active (from created_at) → trialing
 * 4. Otherwise → expired
 */
export async function getSubscriptionStatus(
  env: Env,
  userId: string,
  email: string,
  createdAt: string | undefined | null,
): Promise<SubscriptionInfo> {
  // 1. Exempt check (runtime only)
  if (isExemptEmail(env, email)) {
    return {
      status: "exempt",
      trialEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    };
  }

  const trialEndsAt = getTrialExpiry(createdAt);

  // 2. Stripe DB subscription check (paid status is authoritative over free trial)
  const sub = await env.DB.prepare(`
    SELECT status, current_period_end, cancel_at_period_end, stripe_trial_end
    FROM user_subscriptions WHERE user_id = ?
  `)
    .bind(userId)
    .first<{
      status: string;
      current_period_end: string | null;
      cancel_at_period_end: number;
      stripe_trial_end: string | null;
    }>();

  if (sub && (sub.status === "active" || sub.status === "past_due" || sub.status === "trialing")) {
    return {
      status: sub.status as SubscriptionStatus,
      // Use Stripe's trial_end when in Stripe trialing, otherwise use free trial expiry
      trialEndsAt: sub.status === "trialing" && sub.stripe_trial_end ? sub.stripe_trial_end : trialEndsAt,
      currentPeriodEnd: sub.current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end === 1,
    };
  }

  // 3. Free trial check (only if no paid Stripe status)
  if (isTrialActive(createdAt)) {
    return {
      status: "trialing",
      trialEndsAt,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    };
  }

  // Legacy user with missing createdAt — fetch from DB directly
  if (!trialEndsAt) {
    const userRow = await env.DB.prepare(
      "SELECT created_at FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{ created_at: string | null }>();

    if (userRow?.created_at && isTrialActive(userRow.created_at)) {
      return {
        status: "trialing",
        trialEndsAt: getTrialExpiry(userRow.created_at),
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      };
    }
  }

  // 4. No active subscription, no trial — expired
  // (covers: no sub row, or sub with canceled/incomplete/other status)
  return {
    status: "expired",
    trialEndsAt,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  };
}

/**
 * Gate check: returns true if user has access.
 * Used by route handlers to block operations for expired users.
 */
export async function hasActiveAccess(
  env: Env,
  userId: string,
  email: string,
  createdAt: string | undefined | null,
): Promise<boolean> {
  const { status } = await getSubscriptionStatus(env, userId, email, createdAt);
  return status === "exempt" || status === "trialing" || status === "active" || status === "past_due";
}
