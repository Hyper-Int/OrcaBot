// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: analytics-v3-retry-and-drain
const MODULE_REVISION = "analytics-v3-retry-and-drain";
console.log(`[analytics] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import { API } from "@/config/env";
import { getAuthHeaders } from "@/stores/auth-store";

interface QueuedEvent {
  event_name: string;
  dashboard_id?: string;
  properties?: Record<string, unknown>;
}

const eventQueue: QueuedEvent[] = [];
let flushInterval: ReturnType<typeof setInterval> | null = null;
let initialized = false;
// Monotonically increasing counter — bumped on every identity transition.
// In-flight flush callbacks compare their snapshot against the current value
// to avoid re-queuing stale events after a user switch.
let flushGeneration = 0;

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_THRESHOLD = 20;
const MAX_BATCH_SIZE = 50;

/**
 * Queue an analytics event. Fire-and-forget — never throws.
 */
export function trackEvent(
  eventName: string,
  properties?: Record<string, unknown>,
  dashboardId?: string
): void {
  try {
    eventQueue.push({
      event_name: eventName,
      dashboard_id: dashboardId,
      properties,
    });

    if (eventQueue.length >= FLUSH_THRESHOLD) {
      flush();
    }
  } catch {
    // Analytics never breaks the app
  }
}

const MAX_RETRY_QUEUE_SIZE = 200;

/**
 * Drop all queued events. Call on auth transitions (logout / user switch)
 * to prevent events from one user being attributed to another.
 */
export function resetQueue(): void {
  eventQueue.length = 0;
  flushGeneration++;
}

/**
 * Send queued events to the control plane.
 * Drains the entire queue in MAX_BATCH_SIZE chunks so nothing is left behind
 * on page unload. On transient failure (5xx / network), re-queues events.
 * Client errors (4xx) are permanent — those batches are dropped.
 */
export function flush(): void {
  if (eventQueue.length === 0) return;

  const authHeaders = getAuthHeaders();
  // Don't send events when unauthenticated — they'd be rejected by the server
  // and would be re-queued indefinitely. Drop them instead.
  if (!authHeaders["X-User-ID"]) {
    eventQueue.length = 0;
    return;
  }

  // Snapshot generation so in-flight callbacks can detect identity transitions.
  const generation = flushGeneration;

  // Drain the entire queue — send multiple batches if needed so events
  // queued beyond MAX_BATCH_SIZE aren't stranded on page unload.
  while (eventQueue.length > 0) {
    const batch = eventQueue.splice(0, MAX_BATCH_SIZE);

    try {
      // Use fetch directly (not apiFetch) to avoid error handling side effects
      fetch(`${API.cloudflare.base}/analytics/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        credentials: "include",
        body: JSON.stringify({ events: batch }),
        // keepalive ensures delivery even during page unload
        keepalive: true,
      }).then((resp) => {
        // Only requeue on transient server errors (5xx). Client errors (4xx) mean
        // the batch is permanently invalid — retrying would poison the queue.
        if (resp.status >= 500) {
          requeueEvents(batch, generation);
        }
      }).catch(() => {
        // Network failure — transient, safe to retry
        requeueEvents(batch, generation);
      });
    } catch {
      requeueEvents(batch, generation);
    }
  }
}

function requeueEvents(batch: QueuedEvent[], generation: number): void {
  // If an identity transition happened while the request was in flight,
  // drop the batch — re-inserting would attribute user A's events to user B.
  if (generation !== flushGeneration) return;

  // Prepend failed events back to the queue, but cap total size to avoid
  // unbounded growth during extended outages.
  const available = MAX_RETRY_QUEUE_SIZE - eventQueue.length;
  if (available > 0) {
    eventQueue.unshift(...batch.slice(0, available));
  }
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    flush();
  }
}

function handlePageHide(): void {
  flush();
}

/**
 * Initialize analytics. Call once on app mount.
 */
export function initAnalytics(): void {
  if (initialized) return;
  initialized = true;

  flushInterval = setInterval(flush, FLUSH_INTERVAL_MS);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", handlePageHide);
}

/**
 * Stop analytics. Call on app unmount.
 */
export function stopAnalytics(): void {
  if (!initialized) return;
  initialized = false;

  flush();

  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  window.removeEventListener("pagehide", handlePageHide);
}
