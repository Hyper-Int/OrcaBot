import { describe, it, expect } from "vitest";
import { findAvailableSpace, PLACEMENT_GAP, type PlacedRect } from "./placement";

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
