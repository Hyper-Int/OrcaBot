// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { API } from "@/config/env";
import { apiPost } from "../client";

/**
 * Create a Stripe Checkout session for subscribing.
 * Returns a URL to redirect the user to.
 */
export async function createCheckoutSession(): Promise<{ url: string }> {
  return apiPost<{ url: string }>(API.cloudflare.subscriptionCheckout);
}

/**
 * Create a Stripe Customer Portal session for managing subscription.
 * Returns a URL to redirect the user to.
 */
export async function createPortalSession(): Promise<{ url: string }> {
  return apiPost<{ url: string }>(API.cloudflare.subscriptionPortal);
}
