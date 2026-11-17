import { describe, it, expect } from "vitest";
import { findAvailableSpace, frameToFit, PLACEMENT_GAP, type PlacedRect } from "./placement";

// A 1200x800 container at zoom 1 with no sidebar => viewport is flow (0,0)-(1200,800).
const VIEW = { x: 0, y: 0, zoom: 1 };
const W = 1200, H = 800, INSET = 0;

const rect = (x: number, y: number, width: number, height: number): PlacedRect => ({
  position: { x, y }, size: { width, height },
});

const overlaps = (a: PlacedRect, b: PlacedRect) =>
  a.position.x < b.position.x + b.size.width &&
  a.position.x + a.size.width > b.position.x &&
  a.position.y < b.position.y + b.size.height &&
  a.position.y + a.size.height > b.position.y;

const place = (existing: PlacedRect[], size: { width: number; height: number }) =>
  findAvailableSpace(existing, size, VIEW, W, H, INSET);

describe("findAvailableSpace", () => {
  it("never overlaps an existing block", () => {
    const existing = [rect(0, 0, 340, 470), rect(400, 32, 480, 500)];
    const size = { width: 300, height: 200 };
    const pos = place(existing, size);
    const placed = { position: pos, size };
    for (const e of existing) expect(overlaps(placed, e)).toBe(false);
  });

  it("keeps at least PLACEMENT_GAP from neighbours", () => {
    const existing = [rect(0, 0, 340, 470)];
    const size = { width: 200, height: 150 };
    const pos = place(existing, size);
    const gapX = Math.max(existing[0].position.x - (pos.x + size.width), pos.x - 340, 0);
    const gapY = Math.max(existing[0].position.y - (pos.y + size.height), pos.y - 470, 0);
    expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(PLACEMENT_GAP);
  });

  it("picks the roomier side rather than the first top-left fit", () => {
    // Narrow sliver on the left, wide open space on the right.
    const existing = [rect(180, 0, 60, 800)];
    const size = { width: 120, height: 120 };
    const pos = place(existing, size);
    expect(pos.x).toBeGreaterThan(240); // chose the open right side, not the sliver
  });

  it("places N blocks in a row without any mutual overlap (rapid creation)", () => {
    const placed: PlacedRect[] = [];
    const size = { width: 260, height: 180 };
    for (let i = 0; i < 8; i++) {
      const pos = findAvailableSpace(placed, size, VIEW, W, H, INSET);
      const p = { position: pos, size };
      for (const q of placed) expect(overlaps(p, q)).toBe(false);
      placed.push(p);
    }
    expect(placed).toHaveLength(8);
  });

  it("falls back to minimal growth when the viewport is full", () => {
    // Fill the viewport completely.
    const existing: PlacedRect[] = [];
    for (let y = 0; y < 800; y += 200) for (let x = 0; x < 1200; x += 300) existing.push(rect(x, y, 280, 180));
    const size = { width: 400, height: 300 };
    const pos = place(existing, size);
    const placed = { position: pos, size };
    for (const e of existing) expect(overlaps(placed, e)).toBe(false);
    // It must pick whichever direction grows the content bounding box LESS.
    const bboxW = 1180, bboxH = 780; // grid spans (0,0)-(1180,780)
    const growRight = Math.max(bboxW, 1180 + 32 + 400) * Math.max(bboxH, 300) - bboxW * bboxH;
    const growDown = Math.max(bboxW, 400) * Math.max(bboxH, 780 + 32 + 300) - bboxW * bboxH;
    const wentRight = pos.x >= bboxW;
    expect(wentRight).toBe(growRight <= growDown);
  });

  it("uses the viewport origin on an empty canvas", () => {
    const pos = place([], { width: 300, height: 200 });
    expect(pos.x).toBeGreaterThanOrEqual(0);
    expect(pos.y).toBeGreaterThanOrEqual(0);
    expect(pos.x).toBeLessThan(200);
    expect(pos.y).toBeLessThan(200);
  });

  it("respects the sidebar inset (never places under the sidebar)", () => {
    const pos = findAvailableSpace([], { width: 300, height: 200 }, VIEW, W, H, 320);
    expect(pos.x).toBeGreaterThanOrEqual(320);
  });
});

// Regression: the real SlopCodeBench dashboard sequence. Previously the runner
// terminal and an agent viewer ended up overlapping (observed in D1 as
// terminal(400,32,480x500) vs terminal(460,388,380x300)), because blocks created
// back-to-back were all placed against the same stale item list.
describe("SlopCodeBench dashboard sequence", () => {
  it("places panel -> runner -> 3 agent viewers -> browser with zero overlaps", () => {
    const sizes = [
      { width: 340, height: 470 }, // benchmark panel (from template)
      { width: 480, height: 500 }, // benchmark runner terminal
      { width: 380, height: 300 }, // agent viewer 1
      { width: 380, height: 300 }, // agent viewer 2
      { width: 380, height: 300 }, // agent viewer 3
      { width: 800, height: 500 }, // results browser
    ];
    const placed: PlacedRect[] = [];
    for (const size of sizes) {
      // Same call the app makes; `placed` stands in for items + reserved placements.
      const pos = findAvailableSpace(placed, size, VIEW, W, H, INSET);
      placed.push({ position: pos, size });
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(
          overlaps(placed[i], placed[j]),
          `block ${i} at (${placed[i].position.x},${placed[i].position.y}) overlaps ` +
          `block ${j} at (${placed[j].position.x},${placed[j].position.y})`,
        ).toBe(false);
      }
    }
  });
});

describe("frameToFit", () => {
  const rect = (x: number, y: number, width = 100, height = 100): PlacedRect => ({
    position: { x, y },
    size: { width, height },
  });
  /** Where a block lands on screen, given the framing. Mirrors ReactFlow's
   *  setCenter: the centre is placed at the middle of the container. */
  const project = (
    r: PlacedRect,
    f: { centerX: number; centerY: number; zoom: number },
    cw: number,
    ch: number,
  ) => ({
    left: (r.position.x - f.centerX) * f.zoom + cw / 2,
    top: (r.position.y - f.centerY) * f.zoom + ch / 2,
    right: (r.position.x + r.size.width - f.centerX) * f.zoom + cw / 2,
    bottom: (r.position.y + r.size.height - f.centerY) * f.zoom + ch / 2,
  });

  it("returns null when there is nothing to frame", () => {
    expect(frameToFit([], 1440, 900, 200)).toBeNull();
  });

  it("returns null before the container has been measured", () => {
    // A zero-height container means the layout has not settled; framing against it
    // would compute a zoom from nothing and lock it in.
    expect(frameToFit([rect(0, 0)], 1440, 0, 200)).toBeNull();
    expect(frameToFit([rect(0, 0)], 150, 900, 200)).toBeNull();
  });

  it("brings a block at the origin fully into view", () => {
    // The case every hand-written template hits: viewport {0,0,zoom:1} leaves a
    // block at the origin under the header and behind the sidebar.
    const items = [rect(0, 0, 560, 560), rect(600, 0, 900, 620)];
    const cw = 1440, ch = 900, inset = 200;
    const f = frameToFit(items, cw, ch, inset)!;
    for (const r of items) {
      const p = project(r, f, cw, ch);
      expect(p.left).toBeGreaterThanOrEqual(inset);
      expect(p.top).toBeGreaterThanOrEqual(0);
      expect(p.right).toBeLessThanOrEqual(cw);
      expect(p.bottom).toBeLessThanOrEqual(ch);
    }
  });

  it("clears the sidebar rather than centring under it", () => {
    const items = [rect(0, 0, 560, 560), rect(600, 0, 900, 620)];
    const wide = frameToFit(items, 1440, 900, 0)!;
    const inset = frameToFit(items, 1440, 900, 200)!;
    // A wider occlusion moves the centre LEFT in flow coordinates, which is what
    // pushes the content right on screen, clear of the sidebar.
    expect(inset.centerX).toBeLessThan(wide.centerX);
  });

  it("never magnifies a small dashboard", () => {
    // One little block on a big screen should sit at 1:1, not be blown up.
    const f = frameToFit([rect(0, 0, 200, 150)], 1920, 1080, 200)!;
    expect(f.zoom).toBe(1);
  });

  it("zooms out far enough for a sprawling canvas", () => {
    const items = [rect(0, 0, 400, 300), rect(4000, 2500, 400, 300)];
    const cw = 1440, ch = 900, inset = 200;
    const f = frameToFit(items, cw, ch, inset)!;
    expect(f.zoom).toBeLessThan(1);
    for (const r of items) {
      const p = project(r, f, cw, ch);
      expect(p.left).toBeGreaterThanOrEqual(inset - 1);
      expect(p.right).toBeLessThanOrEqual(cw + 1);
      expect(p.top).toBeGreaterThanOrEqual(-1);
      expect(p.bottom).toBeLessThanOrEqual(ch + 1);
    }
  });

  it("handles negative coordinates", () => {
    // Exported templates carry blocks at negative x and y; nothing may assume the
    // canvas starts at the origin.
    const items = [rect(-64, -208, 400, 300), rect(1200, 240, 400, 300)];
    const cw = 1440, ch = 900, inset = 200;
    const f = frameToFit(items, cw, ch, inset)!;
    for (const r of items) {
      const p = project(r, f, cw, ch);
      expect(p.left).toBeGreaterThanOrEqual(inset - 1);
      expect(p.right).toBeLessThanOrEqual(cw + 1);
    }
  });

  it("never returns a degenerate zoom", () => {
    const f = frameToFit([rect(0, 0, 500000, 500000)], 1440, 900, 200)!;
    expect(f.zoom).toBeGreaterThanOrEqual(0.1);
  });
});
