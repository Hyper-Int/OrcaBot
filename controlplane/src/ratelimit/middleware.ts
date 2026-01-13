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

/**
 * Check rate limit for the request
 * Returns allowed: true if within limits, or a 429 response if exceeded
 */
export async function checkRateLimit(
  request: Request,
  env: Env
): Promise<RateLimitResult> {
  // Skip rate limiting if not configured (e.g., in tests)
  if (!env.RATE_LIMITER) {
    return { allowed: true };
  }

  // Use user ID if authenticated, otherwise use IP
  const userId = request.headers.get('X-User-ID');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = userId || `ip:${ip}`;

  try {
    const result = await env.RATE_LIMITER.limit({ key });

    if (!result.success) {
      return {
        allowed: false,
        response: new Response(
          JSON.stringify({
            error: 'Too many requests',
            message: 'Rate limit exceeded. Please try again later.',
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '60',
            },
          }
        ),
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
 * Rate limit by a custom key (e.g., for specific endpoints)
 */
export async function checkRateLimitByKey(
  key: string,
  env: Env
): Promise<RateLimitResult> {
  if (!env.RATE_LIMITER) {
    return { allowed: true };
  }

  try {
    const result = await env.RATE_LIMITER.limit({ key });

    if (!result.success) {
      return {
        allowed: false,
        response: new Response(
          JSON.stringify({
            error: 'Too many requests',
            message: 'Rate limit exceeded for this operation.',
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '60',
            },
          }
        ),
      };
    }

    return { allowed: true };
  } catch (error) {
    console.error('Rate limiting error:', error);
    return { allowed: true };
  }
}
