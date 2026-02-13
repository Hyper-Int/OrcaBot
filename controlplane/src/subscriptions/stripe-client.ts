// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: stripe-client-v4-bearer-auth
const MODULE_REVISION = "stripe-client-v4-bearer-auth";
console.log(`[stripe-client] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

const STRIPE_API_BASE = "https://api.stripe.com/v1";

/**
 * Encode params as application/x-www-form-urlencoded for Stripe API.
 * Supports nested objects via bracket notation (e.g. metadata[user_id]).
 */
function formEncode(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join("&");
}

/**
 * Make an authenticated request to the Stripe API.
 */
async function stripeRequest<T = Record<string, unknown>>(
  secretKey: string,
  method: string,
  path: string,
  params?: Record<string, string | undefined>,
): Promise<T> {
  const url = `${STRIPE_API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
  };

  const init: RequestInit = { method, headers };

  if (params && (method === "POST" || method === "PUT" || method === "PATCH")) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = formEncode(params);
  }

  const response = await fetch(url, init);
  const body = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const error = (body.error as Record<string, unknown>) || {};
    const stripeError = new Error(
      `Stripe API error: ${error.message || response.statusText} (${response.status})`,
    ) as Error & { stripeCode?: string };
    stripeError.stripeCode = error.code as string | undefined;
    throw stripeError;
  }

  return body as T;
}

/**
 * Create a Stripe customer.
 */
export async function createCustomer(
  secretKey: string,
  email: string,
  name: string,
): Promise<{ id: string }> {
  const result = await stripeRequest<{ id: string }>(secretKey, "POST", "/customers", {
    email,
    name,
  });
  return { id: result.id };
}

/**
 * Create a Stripe Checkout Session for a subscription.
 */
export async function createCheckoutSession(
  secretKey: string,
  customerId: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
  userId: string,
): Promise<{ id: string; url: string }> {
  const result = await stripeRequest<{ id: string; url: string }>(
    secretKey,
    "POST",
    "/checkout/sessions",
    {
      customer: customerId,
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: successUrl,
      cancel_url: cancelUrl,
      "metadata[user_id]": userId,
      "subscription_data[metadata][user_id]": userId,
    },
  );
  return { id: result.id, url: result.url };
}

/**
 * Create a Stripe Customer Portal session for managing subscriptions.
 */
export async function createPortalSession(
  secretKey: string,
  customerId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  const result = await stripeRequest<{ url: string }>(
    secretKey,
    "POST",
    "/billing_portal/sessions",
    {
      customer: customerId,
      return_url: returnUrl,
    },
  );
  return { url: result.url };
}

/**
 * Get a Stripe subscription by ID.
 * Returns status, trial_end, current_period_end.
 */
export async function getSubscription(
  secretKey: string,
  subscriptionId: string,
): Promise<{ id: string; status: string; trial_end: number | null; current_period_end: number | null; cancel_at_period_end: boolean }> {
  return stripeRequest(secretKey, "GET", `/subscriptions/${subscriptionId}`);
}

/**
 * List active/trialing/past_due subscriptions for a customer.
 * Used to check if a customer already has a subscription before creating checkout.
 */
export async function listCustomerSubscriptions(
  secretKey: string,
  customerId: string,
): Promise<{ data: Array<{ id: string; status: string }> }> {
  return stripeRequest(
    secretKey,
    "GET",
    `/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=5`,
  );
}

/**
 * Verify a Stripe webhook signature using HMAC-SHA256 (Web Crypto API).
 *
 * Stripe-Signature header format: t=timestamp,v1=hex_signature[,v1=hex_signature...]
 * During secret rotation, Stripe sends multiple v1 signatures — one for the old
 * secret and one for the new. We must accept any matching v1 signature.
 *
 * Signed payload: `${timestamp}.${raw_body}`
 */
export async function verifyWebhookSignature(
  payload: string,
  sigHeader: string,
  webhookSecret: string,
): Promise<boolean> {
  // Parse the signature header — collect ALL v1 signatures
  const parts = sigHeader.split(",");
  let timestamp = "";
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, ...rest] = part.split("=");
    const value = rest.join("="); // Handle edge case of = in value
    if (key === "t") timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) {
    return false;
  }

  // Reject timestamps older than 5 minutes (replay protection)
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) {
    return false;
  }

  // Compute expected signature
  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));

  // Convert to hex
  const expectedHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Check if ANY v1 signature matches (constant-time comparison for each)
  for (const candidate of signatures) {
    if (candidate.length !== expectedHex.length) continue;
    let diff = 0;
    for (let i = 0; i < expectedHex.length; i++) {
      diff |= expectedHex.charCodeAt(i) ^ candidate.charCodeAt(i);
    }
    if (diff === 0) return true;
  }
  return false;
}
