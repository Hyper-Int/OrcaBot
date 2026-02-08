// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Rate Limiting Middleware
 *
 * Uses Cloudflare's built-in rate limiting binding.
 * Limits requests per user (authenticated) or per IP (unauthenticated).
 */

import type { Env } from '../types';

export interface RateLimitResult {
  allowed: boolean;
  response?: Response;
}

type RateLimiterBinding = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
};

function buildRateLimitResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: 'E79601: Too many requests',
      message,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '60',
      },
    }
  );
}

async function applyRateLimit(
  limiter: RateLimiterBinding,
  key: string,
  message: string
): Promise<RateLimitResult> {
  try {
    const result = await limiter.limit({ key });

    if (!result.success) {
      return {
        allowed: false,
        response: buildRateLimitResponse(message),
      };
    }

    return { allowed: true };
  } catch (error) {
    // If rate limiting fails, allow the request but log the error
    console.error('Rate limiting error:', error);
    return { allowed: true };
  }
}

/**
 * Check rate limit for the request
 * Uses different limits for authenticated (200/min) vs unauthenticated (10/min) requests
 * Returns allowed: true if within limits, or a 429 response if exceeded
 */
export async function checkRateLimitIp(
  request: Request,
  env: Env
): Promise<RateLimitResult> {
  // Skip rate limiting in dev mode
  if (env.DEV_AUTH_ENABLED === 'true') {
    return { allowed: true };
  }

  if (!env.RATE_LIMITER) {
    return { allowed: true };
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return applyRateLimit(
    env.RATE_LIMITER as RateLimiterBinding,
    `ip:${ip}`,
    'Too many unauthenticated requests from your IP.'
  );
}

export async function checkRateLimitUser(
  userId: string,
  env: Env
): Promise<RateLimitResult> {
  // Skip rate limiting in dev mode
  if (env.DEV_AUTH_ENABLED === 'true') {
    return { allowed: true };
  }

  const limiter = env.RATE_LIMITER_AUTH || env.RATE_LIMITER;
  if (!limiter) {
    return { allowed: true };
  }

  return applyRateLimit(
    limiter as RateLimiterBinding,
    `user:${userId}`,
    'Rate limit exceeded. Please slow down.'
  );
}

/**
 * Rate limit by a custom key (e.g., for specific endpoints)
 */
export async function checkRatеLimitByKey(
  key: string,
  env: Env
): Promise<RateLimitResult> {
  // Skip rate limiting in dev mode
  if (env.DEV_AUTH_ENABLED === 'true') {
    return { allowed: true };
  }

  if (!env.RATE_LIMITER) {
    return { allowed: true };
  }

  return applyRateLimit(
    env.RATE_LIMITER as RateLimiterBinding,
    key,
    'Rate limit exceeded for this operation.'
  );
}
