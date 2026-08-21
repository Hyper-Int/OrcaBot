// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Renders a benchmark chart to a 1200x630 social card.
//
// The card is a screenshot of the real chart rather than a separate drawing, so
// it cannot drift from the data: re-run this after a new run lands and the card
// updates with the numbers. LinkedIn and X both crop toward the centre and
// neither executes JS, so this has to be a flat PNG at exactly 1200x630.
//
// Usage (needs `npm run dev` on :3000):
//   node scripts/build-og-card.mjs open-weight-tts 0 public/benchmarks/og-open-weight-tts.png
//
// Args: <slug> <figure index on the page> <output path>

import { chromium } from "@playwright/test";
import path from "node:path";

const [slug, figIndex = "0", out] = process.argv.slice(2);
if (!slug || !out) {
  console.error("usage: build-og-card.mjs <slug> <figureIndex> <outPath>");
  process.exit(1);
}

const BASE = process.env.OG_BASE_URL ?? "http://localhost:3000";
const [W, H] = [1200, 630];

const browser = await chromium.launch();
// deviceScaleFactor 2 renders at 2400x1260 and downsamples, so text stays crisp
// on retina timelines rather than looking like a 1x screenshot.
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });

const url = `${BASE}/benchmarks/${slug}`;
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.locator("figure").nth(Number(figIndex)).waitFor({ timeout: 60_000 });
// Charts measure themselves on mount and animate in; let that settle.
await page.waitForTimeout(2500);

// Lift the chart out of the article and let it fill the frame on its own
// background. Cheaper and far more stable than trying to crop around the page
// chrome, which moves whenever the layout does.
await page.evaluate(
  ({ figIndex, W, H }) => {
    const PAD = 28;
    const fig = document.querySelectorAll("figure")[Number(figIndex)];
    document.body.replaceChildren(fig);
    Object.assign(document.body.style, {
      margin: "0", padding: "0", width: `${W}px`, height: `${H}px`,
      background: "#0a1120", overflow: "hidden", position: "relative",
    });
    // Interactive affordances mean nothing in a static image.
    fig.querySelectorAll("button").forEach((b) => {
      if (b.closest("figcaption")) b.remove();
      else b.style.pointerEvents = "none";
    });
    Object.assign(fig.style, {
      margin: "0", position: "absolute", top: "0", left: "0",
      width: `${W - PAD * 2}px`, transformOrigin: "top left",
    });
    // A chart authored for an article column is taller than a 1.9:1 card, so it
    // is scaled to fit and centred. Cropping instead loses the title off the top
    // and the x-axis off the bottom, which is most of what makes it readable.
    const r = fig.getBoundingClientRect();
    const scale = Math.min((W - PAD * 2) / r.width, (H - PAD * 2) / r.height);
    const [w, h] = [r.width * scale, r.height * scale];
    fig.style.transform = `translate(${(W - w) / 2}px, ${(H - h) / 2}px) scale(${scale})`;
  },
  { figIndex, W, H }
);
await page.waitForTimeout(400);

await page.screenshot({ path: path.resolve(out), clip: { x: 0, y: 0, width: W, height: H } });
await browser.close();
console.log(`[build-og-card] ${url} figure[${figIndex}] -> ${out} (${W}x${H})`);
