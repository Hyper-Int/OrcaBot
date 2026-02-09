// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Rate Limit Counter Durable Object
 *
 * Provides atomic rate limiting for integration policy enforcement.
 * Each DO instance handles rate limits for a specific terminal_integration + action category.
 *
 * Key format: "{terminal_integration_id}:{provider}:{action_category}"
 * Example: "ti_abc123:gmail:reads", "ti_abc123:gmail:sends"
 *
 * Supports three time windows:
 * - minute: 60,000ms
 * - hour: 3,600,000ms
 * - day: 86,400,000ms
 *
 * Design:
 * - Uses Durable Object for per-key isolation and atomic increments
 * - Counters auto-expire after their window passes
 * - No persistence needed - counters reset naturally
 */

interface CounterEntry {
  count: number;
  windowStart: number;
}

interface CheckResult {
  allowed: boolean;
  current: number;
  limit: number;
  remaining: number;
  resetAt: number;
}

type TimeWindow = 'minute' | 'hour' | 'day';

const WINDOW_MS: Record<TimeWindow, number> = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

export class RateLimitCounter implements DurableObject {
  private state: DurableObjectState;
  private counts: Map<string, CounterEntry> = new Map();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // POST /check - Check and optionally increment counter
    // Body: { window: "minute"|"hour"|"day", limit: number, increment?: boolean }
    if (path === '/check' && request.method === 'POST') {
      try {
        const body = await request.json() as {
          window: TimeWindow;
          limit: number;
          increment?: boolean;
        };

        const result = this.checkAndMaybeIncrement(
          body.window,
          body.limit,
          body.increment ?? true
        );

        return Response.json(result);
      } catch (e) {
        return Response.json(
          { error: 'Invalid request body' },
          { status: 400 }
        );
      }
    }

    // GET /status - Get current counter status without incrementing
    // Query: ?window=minute|hour|day
    if (path === '/status' && request.method === 'GET') {
      const window = (url.searchParams.get('window') || 'minute') as TimeWindow;
      const result = this.getStatus(window);
      return Response.json(result);
    }

    // POST /reset - Reset counter for a window (admin use)
    if (path === '/reset' && request.method === 'POST') {
      const body = await request.json() as { window?: TimeWindow };
      if (body.window) {
        this.resetWindow(body.window);
      } else {
        this.counts.clear();
      }
      return Response.json({ reset: true });
    }

    return Response.json({ error: 'E79229: Not found' }, { status: 404 });
  }

  /**
   * Check if action is allowed and optionally increment counter
   */
  private checkAndMaybeIncrement(
    window: TimeWindow,
    limit: number,
    increment: boolean
  ): CheckResult {
    const windowMs = WINDOW_MS[window];
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const key = `${window}:${windowStart}`;

    // Clean old windows
    this.cleanOldWindows(windowMs, windowStart);

    // Get or create entry
    let entry = this.counts.get(key);
    if (!entry) {
      entry = { count: 0, windowStart };
      this.counts.set(key, entry);
    }

    // Check limit
    const allowed = entry.count < limit;
    const current = entry.count;

    // Increment if allowed and requested
    if (allowed && increment) {
      entry.count++;
    }

    return {
      allowed,
      current: increment && allowed ? entry.count : current,
      limit,
      remaining: Math.max(0, limit - (increment && allowed ? entry.count : current)),
      resetAt: windowStart + windowMs,
    };
  }

  /**
   * Get current status without incrementing
   */
  private getStatus(window: TimeWindow): { count: number; windowStart: number; windowEnd: number } {
    const windowMs = WINDOW_MS[window];
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const key = `${window}:${windowStart}`;

    const entry = this.counts.get(key);
    return {
      count: entry?.count ?? 0,
      windowStart,
      windowEnd: windowStart + windowMs,
    };
  }

  /**
   * Reset a specific window
   */
  private resetWindow(window: TimeWindow): void {
    const windowMs = WINDOW_MS[window];
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const key = `${window}:${windowStart}`;
    this.counts.delete(key);
  }

  /**
   * Clean expired window entries
   */
  private cleanOldWindows(windowMs: number, currentWindowStart: number): void {
    for (const [key, entry] of this.counts) {
      if (entry.windowStart < currentWindowStart - windowMs) {
        this.counts.delete(key);
      }
    }
  }
}
