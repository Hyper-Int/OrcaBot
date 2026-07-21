// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Canvas auto-placement. Extracted from the dashboard page so it can be unit tested
// independently of React — placement bugs (overlapping blocks) are pure geometry.

export const PLACEMENT_GAP = 32; // gap between items when finding space

export interface PlacedRect {
  position: { x: number; y: number };
  size: { width: number; height: number };
}

/**
 * Find available space for a new component that doesn't overlap existing items.
 *
 * Strategy:
 * 1. Scan the visible viewport on a fine grid and keep every position where the new
 *    block fits. Rather than taking the FIRST fit (which hugs the top-left and packs
 *    blocks against each other), score each candidate by its CLEARANCE — the distance
 *    to the nearest neighbour or viewport edge — and take the roomiest. That lands new
 *    blocks in the largest open pocket.
 * 2. If nothing fits in view, extend the canvas in whichever direction costs the least:
 *    pick the placement that grows the content bounding box by the smallest area, so
 *    the viewport has to expand as little as possible.
 *
 * Returns a snapped position (16px grid).
 *
 * @param sidebarInset  Pixels of the left edge occluded by the workspace sidebar.
 */
export function findAvailableSpace(
  existingItems: PlacedRect[],
  newSize: { width: number; height: number },
  viewport: { x: number; y: number; zoom: number },
  containerWidth: number,
  containerHeight: number,
  sidebarInset: number,
): { x: number; y: number } {
  // Convert viewport to flow coordinates (visible area)
  const zoom = viewport.zoom || 1;
  const viewLeft = (-viewport.x + sidebarInset) / zoom; // shift right past sidebar
  const viewTop = -viewport.y / zoom;
  const viewWidth = (containerWidth - sidebarInset) / zoom;
  const viewHeight = containerHeight / zoom;

  const snap = (v: number) => Math.round(v / 16) * 16;
  const rects = existingItems.map((i) => ({
    x: i.position.x, y: i.position.y, w: i.size.width, h: i.size.height,
  }));

  const fits = (x: number, y: number): boolean => {
    for (const r of rects) {
      if (
        x < r.x + r.w + PLACEMENT_GAP &&
        x + newSize.width + PLACEMENT_GAP > r.x &&
        y < r.y + r.h + PLACEMENT_GAP &&
        y + newSize.height + PLACEMENT_GAP > r.y
      ) return false; // overlaps a neighbour (incl. gap)
    }
    return true;
  };

  // Distance from the candidate rect to the nearest NEIGHBOUR. Deliberately ignores
  // viewport edges: counting them scores the middle of the canvas highest and parks
  // every block dead centre. Measuring only against other blocks means the roomiest
  // open pocket wins, and (once quantised below) the block still packs to that
  // pocket's top-left corner rather than floating in its middle.
  const ROOMY = 320; // clearance beyond this is "wide open" — treat as equally good
  const clearance = (x: number, y: number): number => {
    let best = ROOMY;
    for (const r of rects) {
      const dx = Math.max(r.x - (x + newSize.width), x - (r.x + r.w), 0);
      const dy = Math.max(r.y - (y + newSize.height), y - (r.y + r.h), 0);
      best = Math.min(best, Math.max(dx, dy));
      if (best <= 0) return 0;
    }
    return best;
  };

  // 1. Roomiest spot inside the viewport. Step is capped so a zoomed-out viewport
  //    can't blow up the scan (bounded ~60x60 candidates).
  const margin = 24;
  const usableW = viewWidth - margin * 2;
  const usableH = viewHeight - margin * 2;
  if (usableW >= newSize.width && usableH >= newSize.height) {
    const stepX = Math.max(32, Math.ceil((usableW - newSize.width) / 60 / 16) * 16 || 32);
    const stepY = Math.max(32, Math.ceil((usableH - newSize.height) / 60 / 16) * 16 || 32);
    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;
    const maxY = viewTop + viewHeight - margin - newSize.height;
    const maxX = viewLeft + viewWidth - margin - newSize.width;
    for (let y = snap(viewTop + margin); y <= maxY; y += stepY) {
      for (let x = snap(viewLeft + margin); x <= maxX; x += stepX) {
        if (!fits(x, y)) continue;
        // Pack row-major (left-to-right, then down). Packing tightly is what actually
        // minimises canvas growth — an earlier version scored by clearance, which
        // pushed each block away from its neighbours, stranded usable gaps, and made
        // the canvas expand far sooner. Clearance is kept only as a tie-breaker so
        // that among equally-packed spots we still prefer the less cramped one.
        const packing = (y - viewTop) * 4 + (x - viewLeft);
        const score = -packing * 1000 + Math.min(clearance(x, y), ROOMY);
        if (score > bestScore) { bestScore = score; best = { x: snap(x), y: snap(y) }; }
      }
    }
    if (best) return best;
  }

  // 2. Nothing fits in view — grow the canvas as little as possible.
  if (rects.length === 0) return { x: snap(viewLeft + margin), y: snap(viewTop + margin) };

  const bbox = rects.reduce(
    (a, r) => ({
      left: Math.min(a.left, r.x), top: Math.min(a.top, r.y),
      right: Math.max(a.right, r.x + r.w), bottom: Math.max(a.bottom, r.y + r.h),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
  const bboxW = bbox.right - bbox.left;
  const bboxH = bbox.bottom - bbox.top;
  const candidates = [
    { x: bbox.right + PLACEMENT_GAP, y: Math.max(bbox.top, viewTop + margin) }, // to the right
    { x: Math.max(bbox.left, viewLeft + margin), y: bbox.bottom + PLACEMENT_GAP }, // below
  ];
  let bestPos = candidates[0];
  let bestCost = Infinity;
  for (const c of candidates) {
    const w = Math.max(bbox.right, c.x + newSize.width) - Math.min(bbox.left, c.x);
    const h = Math.max(bbox.bottom, c.y + newSize.height) - Math.min(bbox.top, c.y);
    // Minimise how far the user must zoom OUT to see everything, not raw area.
    // Area growth always favours extending the already-long axis, which produces a
    // runaway single-row strip; this keeps the canvas roughly viewport-shaped.
    const cost = Math.max(w / Math.max(viewWidth, 1), h / Math.max(viewHeight, 1));
    if (cost < bestCost) { bestCost = cost; bestPos = c; }
  }
  return { x: snap(bestPos.x), y: snap(bestPos.y) };
}
