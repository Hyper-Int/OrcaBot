// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: stripe-webhook-v5-fail-closed
const MODULE_REVISION = "stripe-webhook-v5-fail-closed";
console.log(`[stripe-webhook] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import type { Env } from "../types";
import { verifyWebhookSignature, getSubscription } from "./stripe-client";

interface StripeEvent {
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

/**
 * POST /webhooks/stripe
 * Handles Stripe webhook events for subscription lifecycle.
 * Unauthenticated — uses Stripe signature verification.
 */
export async function handleStripeWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return Response.json(
      { error: "E79904: Webhook not configured" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("Stripe-Signature");
  if (!signature) {
    return Response.json(
      { error: "E79905: Missing signature" },
      { status: 400 },
    );
  }

  const body = await request.text();
  const isValid = await verifyWebhookSignature(body, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) {
    return Response.json(
      { error: "E79906: Invalid signature" },
      { status: 400 },
    );
  }

  const event = JSON.parse(body) as StripeEvent;
  console.log(`[stripe-webhook] Received event: ${event.type}`);

  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(env, event.data.object);
      break;
    case "customer.subscription.updated":
      await handleSubscriptionUpdated(env, event.data.object);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(env, event.data.object);
      break;
    case "invoice.payment_failed":
      await handlePaymentFailed(env, event.data.object);
      break;
    default:
      // Ignore unhandled event types
      break;
  }

  return Response.json({ received: true });
}

/**
 * Handle checkout.session.completed — user subscribed.
 * Uses INSERT OR REPLACE to self-heal if the row is missing.
 * Resolves user_id from metadata (set during checkout creation).
 */
async function handleCheckoutCompleted(
  env: Env,
  session: Record<string, unknown>,
): Promise<void> {
  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;
  const metadata = session.metadata as Record<string, string> | undefined;
  const metadataUserId = metadata?.user_id;

  if (!customerId || !subscriptionId) {
    console.log(`[stripe-webhook] checkout.session.completed: missing customer or subscription`);
    return;
  }

  console.log(`[stripe-webhook] checkout completed for customer=${customerId}, sub=${subscriptionId}, metadataUserId=${metadataUserId ?? "none"}`);

  // Fetch the actual subscription status from Stripe rather than assuming 'active'.
  // checkout.session.completed can fire before the subscription settles (e.g. trialing, incomplete).
  // Fail closed: default to 'incomplete' — the subscription.updated webhook will correct it.
  let realStatus = "incomplete";
  let currentPeriodEnd: string | null = null;
  let stripeTrialEnd: string | null = null;
  let cancelAtPeriodEnd = false;

  if (env.STRIPE_SECRET_KEY) {
    try {
      const stripeSub = await getSubscription(env.STRIPE_SECRET_KEY, subscriptionId);
      realStatus = stripeSub.status;
      cancelAtPeriodEnd = stripeSub.cancel_at_period_end;
      if (stripeSub.current_period_end) {
        currentPeriodEnd = new Date(stripeSub.current_period_end * 1000).toISOString();
      }
      if (stripeSub.trial_end) {
        stripeTrialEnd = new Date(stripeSub.trial_end * 1000).toISOString();
      }
      console.log(`[stripe-webhook] fetched real subscription status: ${realStatus} for sub=${subscriptionId}`);
    } catch (err) {
      console.warn(`[stripe-webhook] failed to fetch subscription ${subscriptionId}, storing as 'incomplete' — subscription.updated will correct: ${err}`);
    }
  } else {
    console.error(`[stripe-webhook] STRIPE_SECRET_KEY not set — cannot verify subscription status, storing as 'incomplete'`);
  }

  // Try updating existing row first
  const result = await env.DB.prepare(`
    UPDATE user_subscriptions
    SET stripe_subscription_id = ?,
        status = ?,
        current_period_end = ?,
        cancel_at_period_end = ?,
        stripe_trial_end = ?,
        updated_at = datetime('now')
    WHERE stripe_customer_id = ?
  `)
    .bind(subscriptionId, realStatus, currentPeriodEnd, cancelAtPeriodEnd ? 1 : 0, stripeTrialEnd, customerId)
    .run();

  // If no row was updated and we have user_id from metadata, insert one
  if (result.meta.changes === 0 && metadataUserId) {
    console.log(`[stripe-webhook] no existing row for customer=${customerId}, creating from metadata user_id=${metadataUserId}`);
    await env.DB.prepare(`
      INSERT INTO user_subscriptions (id, user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, stripe_trial_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        stripe_customer_id = excluded.stripe_customer_id,
        stripe_subscription_id = excluded.stripe_subscription_id,
        status = excluded.status,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        stripe_trial_end = excluded.stripe_trial_end,
        updated_at = datetime('now')
    `)
      .bind(crypto.randomUUID(), metadataUserId, customerId, subscriptionId, realStatus, currentPeriodEnd, cancelAtPeriodEnd ? 1 : 0, stripeTrialEnd)
      .run();
  } else if (result.meta.changes === 0) {
    console.warn(`[stripe-webhook] checkout.session.completed: no row for customer=${customerId} and no metadata user_id — cannot self-heal`);
  }
}

/**
 * Handle customer.subscription.updated — status changes, period end, cancellation.
 * Uses metadata[user_id] on the subscription to self-heal if the row is missing.
 */
async function handleSubscriptionUpdated(
  env: Env,
  subscription: Record<string, unknown>,
): Promise<void> {
  const customerId = subscription.customer as string;
  const subscriptionId = subscription.id as string;
  const status = subscription.status as string;
  const cancelAtPeriodEnd = subscription.cancel_at_period_end as boolean;
  const metadata = subscription.metadata as Record<string, string> | undefined;
  const metadataUserId = metadata?.user_id;

  // current_period_end is a Unix timestamp from Stripe
  const periodEndUnix = subscription.current_period_end as number | undefined;
  const currentPeriodEnd = periodEndUnix
    ? new Date(periodEndUnix * 1000).toISOString()
    : null;

  // trial_end is a Unix timestamp from Stripe (set when using Stripe trials)
  const trialEndUnix = subscription.trial_end as number | undefined;
  const stripeTrialEnd = trialEndUnix
    ? new Date(trialEndUnix * 1000).toISOString()
    : null;

  if (!customerId) {
    console.log(`[stripe-webhook] subscription.updated: missing customer`);
    return;
  }

  console.log(
    `[stripe-webhook] subscription updated: customer=${customerId}, status=${status}, cancelAtPeriodEnd=${cancelAtPeriodEnd}, trialEnd=${stripeTrialEnd ?? "none"}`,
  );

  const result = await env.DB.prepare(`
    UPDATE user_subscriptions
    SET stripe_subscription_id = ?,
        status = ?,
        current_period_end = ?,
        cancel_at_period_end = ?,
        stripe_trial_end = ?,
        updated_at = datetime('now')
    WHERE stripe_customer_id = ?
  `)
    .bind(
      subscriptionId,
      status,
      currentPeriodEnd,
      cancelAtPeriodEnd ? 1 : 0,
      stripeTrialEnd,
      customerId,
    )
    .run();

  // Self-heal: insert row if missing and we have user_id from subscription metadata
  if (result.meta.changes === 0 && metadataUserId) {
    console.log(`[stripe-webhook] no existing row for customer=${customerId}, creating from metadata user_id=${metadataUserId}`);
    await env.DB.prepare(`
      INSERT INTO user_subscriptions (id, user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, stripe_trial_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        stripe_customer_id = excluded.stripe_customer_id,
        stripe_subscription_id = excluded.stripe_subscription_id,
        status = excluded.status,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        stripe_trial_end = excluded.stripe_trial_end,
        updated_at = datetime('now')
    `)
      .bind(crypto.randomUUID(), metadataUserId, customerId, subscriptionId, status, currentPeriodEnd, cancelAtPeriodEnd ? 1 : 0, stripeTrialEnd)
      .run();
  }
}

/**
 * Handle customer.subscription.deleted — subscription canceled/expired.
 */
async function handleSubscriptionDeleted(
  env: Env,
  subscription: Record<string, unknown>,
): Promise<void> {
  const customerId = subscription.customer as string;

  if (!customerId) {
    console.log(`[stripe-webhook] subscription.deleted: missing customer`);
    return;
  }

  console.log(`[stripe-webhook] subscription deleted for customer=${customerId}`);

  await env.DB.prepare(`
    UPDATE user_subscriptions
    SET status = 'canceled',
        updated_at = datetime('now')
    WHERE stripe_customer_id = ?
  `)
    .bind(customerId)
    .run();
}

/**
 * Handle invoice.payment_failed — payment issue.
 */
async function handlePaymentFailed(
  env: Env,
  invoice: Record<string, unknown>,
): Promise<void> {
  const customerId = invoice.customer as string;

  if (!customerId) {
    console.log(`[stripe-webhook] invoice.payment_failed: missing customer`);
    return;
  }

  console.log(`[stripe-webhook] payment failed for customer=${customerId}`);

  await env.DB.prepare(`
    UPDATE user_subscriptions
    SET status = 'past_due',
        updated_at = datetime('now')
    WHERE stripe_customer_id = ?
  `)
    .bind(customerId)
    .run();
}
