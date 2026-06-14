// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, it, expect } from "vitest";
import {
  applyLocalPositionOverrides,
  type PositionOverride,
  type OverridableNode,
} from "./positionOverrides";

const node = (id: string, x: number, y: number): OverridableNode => ({
  id,
  position: { x, y },
});

const MAX_AGE = 2500;

describe("applyLocalPositionOverrides", () => {
  it("returns nodes unchanged when there are no overrides", () => {
    const nodes = [node("a", 10, 10)];
    const overrides = new Map<string, PositionOverride>();
    const result = applyLocalPositionOverrides(nodes, overrides, 1000, MAX_AGE);
    expect(result).toBe(nodes); // same reference, no work done
  });

  it("forces the dropped position when the node still reports its OLD position", () => {
    // The core blink scenario: drop set the override to (200,200) but a stale
    // refetch/echo rebuilt the node back at its pre-drag (10,10).
    const nodes = [node("a", 10, 10)];
    const overrides = new Map<string, PositionOverride>([
      ["a", { x: 200, y: 200, at: 1000 }],
    ]);
    const result = applyLocalPositionOverrides(nodes, overrides, 1100, MAX_AGE);
    expect(result[0].position).toEqual({ x: 200, y: 200 });
    expect(overrides.has("a")).toBe(true); // still held — window not elapsed
  });

  it("REGRESSION (v18 bug): keeps holding the override even after the cache matches", () => {
    // The optimistic update makes the node match the override almost immediately.
    // The old code deleted the override on match, so a stale revert arriving a few
    // hundred ms later would slip through and cause the blink. The override MUST
    // survive a matching rebuild so it can still mask a subsequent stale revert.
    const overrides = new Map<string, PositionOverride>([
      ["a", { x: 200, y: 200, at: 1000 }],
    ]);

    // 1) Rebuild where cache already reflects the dropped position (optimistic match).
    const matched = applyLocalPositionOverrides([node("a", 200, 200)], overrides, 1050, MAX_AGE);
    expect(matched[0].position).toEqual({ x: 200, y: 200 });
    expect(overrides.has("a")).toBe(true); // NOT released on match

    // 2) Stale revert lands shortly after — still within the window — and is masked.
    const reverted = applyLocalPositionOverrides([node("a", 10, 10)], overrides, 1400, MAX_AGE);
    expect(reverted[0].position).toEqual({ x: 200, y: 200 });
  });

  it("expires the override after maxAge so genuine remote moves apply", () => {
    const overrides = new Map<string, PositionOverride>([
      ["a", { x: 200, y: 200, at: 1000 }],
    ]);
    // A remote move to (50,50) arriving after the window must win.
    const result = applyLocalPositionOverrides(
      [node("a", 50, 50)],
      overrides,
      1000 + MAX_AGE + 1,
      MAX_AGE,
    );
    expect(result[0].position).toEqual({ x: 50, y: 50 });
    expect(overrides.has("a")).toBe(false); // pruned
  });

  it("prunes overrides whose node is no longer present", () => {
    const overrides = new Map<string, PositionOverride>([
      ["gone", { x: 1, y: 1, at: 1000 }],
      ["a", { x: 200, y: 200, at: 1000 }],
    ]);
    const result = applyLocalPositionOverrides([node("a", 10, 10)], overrides, 1100, MAX_AGE);
    expect(overrides.has("gone")).toBe(false);
    expect(overrides.has("a")).toBe(true);
    expect(result[0].position).toEqual({ x: 200, y: 200 });
  });

  it("only overrides the dragged node, leaving others untouched", () => {
    const a = node("a", 10, 10);
    const b = node("b", 99, 99);
    const overrides = new Map<string, PositionOverride>([
      ["a", { x: 200, y: 200, at: 1000 }],
    ]);
    const result = applyLocalPositionOverrides([a, b], overrides, 1100, MAX_AGE);
    expect(result[0].position).toEqual({ x: 200, y: 200 });
    expect(result[1]).toBe(b); // untouched node keeps its identity
  });

  it("does not clone a node already at the override position (within epsilon)", () => {
    const a = node("a", 200.2, 199.9);
    const overrides = new Map<string, PositionOverride>([
      ["a", { x: 200, y: 200, at: 1000 }],
    ]);
    const result = applyLocalPositionOverrides([a], overrides, 1100, MAX_AGE);
    expect(result[0]).toBe(a); // identity preserved → React Flow won't re-render needlessly
  });

  it("preserves extra node fields when overriding position", () => {
    const styled = { id: "a", position: { x: 10, y: 10 }, selected: true, data: { k: 1 } };
    const overrides = new Map<string, PositionOverride>([
      ["a", { x: 200, y: 200, at: 1000 }],
    ]);
    const result = applyLocalPositionOverrides([styled], overrides, 1100, MAX_AGE);
    expect(result[0]).toMatchObject({ selected: true, data: { k: 1 }, position: { x: 200, y: 200 } });
  });
});
