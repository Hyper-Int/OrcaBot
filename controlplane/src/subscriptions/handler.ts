// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: subscriptions-handler-v7-stale-customer
const MODULE_REVISION = "subscriptions-handler-v7-stale-customer";
console.log(`[subscriptions-handler] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import type { Env } from "../types";
import * as stripe from "./stripe-client";
import { getSubscriptionStatus } from "./check";

/**
 * Resolve the frontend URL for Stripe redirects.
 * - Prefers FRONTEND_URL env var (always trusted).
 * - When STRIPE_SECRET_KEY is set (production), FRONTEND_URL is required — refuses
 *   to fall back to Origin to prevent open-redirect attacks with real money involved.
 * - In dev (no STRIPE_SECRET_KEY), falls back to Origin header for convenience.
 * - Returns null if no safe URL can be determined.
 */
function getFrontendUrl(request: Request, env: Env): string | null {
  if (env.FRONTEND_URL) return env.FRONTEND_URL;

  // When Stripe is configured (real money), require FRONTEND_URL — don't trust Origin.
  if (env.STRIPE_SECRET_KEY) {
    console.error("[subscriptions-handler] FRONTEND_URL must be set when STRIPE_SECRET_KEY is configured — refusing to use Origin header for Stripe redirects");
    return null;
  }

  // Dev mode (no Stripe key): trust Origin header for local development convenience
  const origin = request.headers.get("Origin");
  if (origin) return origin;

  console.warn("[subscriptions-handler] FRONTEND_URL not set and no Origin header — cannot determine redirect URL");
  return null;
}

/**
 * POST /subscriptions/checkout
 * Creates a Stripe Checkout session and returns the URL.
 * Creates a Stripe customer if none exists yet.
 */
export async function createCheckoutSession(
  request: Request,
  env: Env,
  userId: string,
  email: string,
  createdAt: string | undefined | null,
): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) {
    return Response.json(
      { error: "E79901: Billing not configured" },
      { status: 503 },
    );
  }

  // Block checkout if user already has a Stripe relationship or is exempt.
  // past_due / trialing users should use the portal to fix their subscription,
  // not create a second one.
  const subStatus = await getSubscriptionStatus(env, userId, email, createdAt);
  if (subStatus.status === "active" || subStatus.status === "exempt") {
    return Response.json(
      { error: "E79902: Already subscribed" },
      { status: 400 },
    );
  }
  if (subStatus.status === "past_due") {
    return Response.json(
      { error: "E79905: Subscription has a payment issue — use the billing portal to update payment method", usePortal: true },
      { status: 400 },
    );
  }
  // Check for Stripe-side trialing (paid trial via Stripe, not our free trial)
  if (subStatus.currentPeriodEnd) {
    // Has a Stripe subscription with billing data — don't create a duplicate
    return Response.json(
      { error: "E79902: Already subscribed" },
      { status: 400 },
    );
  }

  // Find existing Stripe customer
  let stripeCustomerId: string | null = null;
  const existing = await env.DB.prepare(
    "SELECT stripe_customer_id FROM user_subscriptions WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ stripe_customer_id: string }>();
  stripeCustomerId = existing?.stripe_customer_id ?? null;

  // If customer exists on Stripe, check for any non-canceled subscriptions to prevent duplicates.
  // This covers the race window between checkout completion and webhook arrival.
  if (stripeCustomerId) {
    try {
      const stripeSubs = await stripe.listCustomerSubscriptions(env.STRIPE_SECRET_KEY, stripeCustomerId);
      const activeSub = stripeSubs.data.find(
        (s) => s.status === "active" || s.status === "trialing" || s.status === "past_due" || s.status === "incomplete",
      );
      if (activeSub) {
        console.log(`[subscriptions-handler] blocking duplicate checkout: customer=${stripeCustomerId} has sub=${activeSub.id} status=${activeSub.status}`);
        return Response.json(
          { error: "E79902: A subscription is already in progress" },
          { status: 400 },
        );
      }
    } catch (err) {
      const stripeCode = (err as Error & { stripeCode?: string }).stripeCode;
      if (stripeCode === "resource_missing") {
        // Customer was deleted on Stripe (e.g. test data purged) — clear stale ID so we create a new one
        console.warn(`[subscriptions-handler] stale customer ${stripeCustomerId} not found on Stripe, will create new`);
        stripeCustomerId = null;
      } else {
        // Other Stripe API failure — log but don't block, DB checks above are sufficient
        console.warn(`[subscriptions-handler] failed to check Stripe subscriptions: ${err}`);
      }
    }
  }

  // Create Stripe customer if needed (or if previous one was stale)
  if (!stripeCustomerId) {
    const customer = await stripe.createCustomer(env.STRIPE_SECRET_KEY, email, email);
    stripeCustomerId = customer.id;

    // Insert/update subscription row with new customer ID
    await env.DB.prepare(`
      INSERT INTO user_subscriptions (id, user_id, stripe_customer_id, status)
      VALUES (?, ?, ?, 'incomplete')
      ON CONFLICT(user_id) DO UPDATE SET
        stripe_customer_id = excluded.stripe_customer_id,
        updated_at = datetime('now')
    `)
      .bind(crypto.randomUUID(), userId, stripeCustomerId)
      .run();
  }

  // Determine frontend URL for redirect
  const frontendUrl = getFrontendUrl(request, env);
  if (!frontendUrl) {
    return Response.json(
      { error: "E79904: FRONTEND_URL not configured" },
      { status: 503 },
    );
  }

  const session = await stripe.createCheckoutSession(
    env.STRIPE_SECRET_KEY,
    stripeCustomerId,
    env.STRIPE_PRICE_ID,
    `${frontendUrl}/dashboards?subscription=success`,
    `${frontendUrl}/dashboards?subscription=canceled`,
    userId,
  );

  return Response.json({ url: session.url });
}

/**
 * POST /subscriptions/portal
 * Creates a Stripe Customer Portal session for managing subscription.
 */
export async function createPortalSession(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) {
    return Response.json(
      { error: "E79901: Billing not configured" },
      { status: 503 },
    );
  }

  const sub = await env.DB.prepare(
    "SELECT stripe_customer_id FROM user_subscriptions WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ stripe_customer_id: string }>();

  if (!sub) {
    return Response.json(
      { error: "E79903: No subscription found" },
      { status: 404 },
    );
  }

  const frontendUrl = getFrontendUrl(request, env);
  if (!frontendUrl) {
    return Response.json(
      { error: "E79904: FRONTEND_URL not configured" },
      { status: 503 },
    );
  }

  const portal = await stripe.createPortalSession(
    env.STRIPE_SECRET_KEY,
    sub.stripe_customer_id,
    `${frontendUrl}/dashboards`,
  );

  return Response.json({ url: portal.url });
}
