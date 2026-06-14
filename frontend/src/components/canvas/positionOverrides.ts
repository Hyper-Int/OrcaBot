// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: position-overrides-v1-extract
//
// Optimistic post-drag position reconciliation, extracted as a pure function so it
// can be unit-tested deterministically (the visual "blink back to start" it prevents
// is only observable in manual UI testing).
//
// Why this exists: when a node is dropped, the canvas persists its new position via a
// DEBOUNCED (~500ms) mutation that then round-trips. In that window the item cache can
// be transiently reverted to the pre-drag position — e.g. a collab `item_update` echo
// or a refetch triggered by other dashboard activity (a second terminal initializing).
// A node rebuild during that window would rebuild the dragged node at its stale
// position, producing a one-frame "blink back to start, then jump to drop point".
//
// We hold the dropped position in a map for a fixed window and force it during rebuilds.
// Crucially we hold it for the WHOLE window rather than releasing it the moment the
// cache "matches" — the optimistic update matches instantly, so an early release would
// let the later stale revert slip through (this was the v18 bug). After the window the
// override expires so genuine remote moves still apply.

export interface PositionOverride {
  x: number;
  y: number;
  /** Epoch ms when the drop happened (used to expire the override). */
  at: number;
}

export interface OverridableNode {
  id: string;
  position: { x: number; y: number };
}

/** Positions within this many px are treated as equal (avoids needless clones). */
const POSITION_EPSILON = 0.5;

/**
 * Returns `nodes` with any active local position override applied, and prunes
 * expired or no-longer-present overrides from `overrides` (mutated in place — it is
 * a short-lived cache by design).
 *
 * Pure with respect to its inputs: given the same `nodes`, `overrides` contents,
 * `now` and `maxAgeMs`, it always produces the same result and the same post-state
 * of `overrides`. Pass `now` explicitly so tests don't depend on the clock.
 *
 * - An override older than `maxAgeMs`, or whose node is no longer present, is removed.
 * - A surviving override forces the node's position; if the node is already at that
 *   position (within epsilon) the original node object is returned unchanged.
 */
export function applyLocalPositionOverrides<T extends OverridableNode>(
  nodes: T[],
  overrides: Map<string, PositionOverride>,
  now: number,
  maxAgeMs: number,
): T[] {
  if (overrides.size === 0) return nodes;

  const liveIds = new Set(nodes.map((n) => n.id));
  for (const [nodeId, ov] of overrides) {
    if (!liveIds.has(nodeId) || now - ov.at > maxAgeMs) {
      overrides.delete(nodeId);
    }
  }

  if (overrides.size === 0) return nodes;

  return nodes.map((n) => {
    const ov = overrides.get(n.id);
    if (!ov) return n;
    if (
      Math.abs(n.position.x - ov.x) < POSITION_EPSILON &&
      Math.abs(n.position.y - ov.y) < POSITION_EPSILON
    ) {
      return n; // already at the dropped position — no need to clone
    }
    return { ...n, position: { x: ov.x, y: ov.y } };
  });
}
