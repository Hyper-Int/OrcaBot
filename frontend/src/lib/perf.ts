// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: perf-v1-span-timers
//
// Lightweight client-side span timing for user-perceived latency (component
// created → ready). Emits a single structured `[perf]` console line per span with
// per-segment deltas + total, e.g.:
//   [perf] terminal:abc123 total=1840ms create→session=+612ms session→ws=+1100ms ws→ready=+128ms
// Uses performance.now() (monotonic) and is keyed by a stable id (itemId/dashboardId)
// so marks recorded across different components/effects accumulate into one span.

const MODULE_REVISION = "perf-v1-span-timers";
if (typeof console !== "undefined") {
  console.log(`[perf] REVISION: ${MODULE_REVISION} loaded`);
}

interface Span {
  t0: number;
  last: number;
  segments: string[];
}

const spans = new Map<string, Span>();

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Begin (or restart) a span. Safe to call again; the latest call wins. */
export function perfStart(key: string): void {
  const t = now();
  spans.set(key, { t0: t, last: t, segments: [] });
}

/** Record an intermediate milestone (delta since the previous mark/start). */
export function perfMark(key: string, label: string): void {
  const s = spans.get(key);
  if (!s) return;
  const t = now();
  s.segments.push(`${label}=+${Math.round(t - s.last)}ms`);
  s.last = t;
}

/**
 * Close a span: records the final segment, logs the structured line, and clears it.
 * No-op if the span was never started (e.g. a reconnect path that skipped perfStart).
 */
export function perfEnd(key: string, label: string): void {
  const s = spans.get(key);
  if (!s) return;
  const t = now();
  s.segments.push(`${label}=+${Math.round(t - s.last)}ms`);
  const total = Math.round(t - s.t0);
  console.log(`[perf] ${key} total=${total}ms ${s.segments.join(" ")}`);
  spans.delete(key);
}

/** Discard a span without logging (e.g. the component unmounted before ready). */
export function perfCancel(key: string): void {
  spans.delete(key);
}

/** Whether a span is currently open for this key. */
export function perfActive(key: string): boolean {
  return spans.has(key);
}
