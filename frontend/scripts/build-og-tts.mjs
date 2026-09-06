// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Builds the social preview card for the open-weight TTS benchmark:
// public/benchmarks/og-open-weight-tts.png, 1200x630.
//
// A script rather than a hand-made PNG because the y-axis is live. Reader
// preference comes from blind rankings that keep arriving, so the cloud moves
// and the card goes stale on its own; the two existing cards were drawn once and
// cannot be re-cut without redrawing them.
//
// The x-axis is LOGARITHMIC, which the on-page chart's is not, and that is the
// one deliberate difference between them. The page fixes x at 6.8s because that
// covers the engines that keep up with real time. Ten of the thirty rated
// engines are slower than that -- Bark, Zonos and CSM by a wide margin, up to
// 51s a phrase -- so on a 6.8s axis they are drawn off-canvas rather than
// clipped or dropped. A card is a single glance with no filter controls and no
// hover, so it has to show every point it counts: log x fits 0.12s and 51s in
// one frame, and the flatness of the cloud across two and a half decades is the
// finding.
//
// Usage:
//   node scripts/build-og-tts.mjs                 # live scores from the API
//   node scripts/build-og-tts.mjs --scores f.json # a saved /tts/scores response
//   node scripts/build-og-tts.mjs --html-only     # write the HTML, skip the shot

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const RUN = path.join(ROOT, "src/data/benchmarks/open-weight-tts/2026-08.json");
const OUT_PNG = path.join(ROOT, "public/benchmarks/og-open-weight-tts.png");
const OUT_HTML = path.join(HERE, ".og-tts.html");
const SCORES_URL = process.env.TTS_SCORES_URL || "https://api.orcabot.com/tts/scores";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

// Card geometry and palette, both sampled from the existing cards so a new one
// sits beside them rather than beneath them.
const CARD = { w: 1200, h: 630 };
const BG = "#0b1a2e";
const SURFACE = "#101e33";
const GRID = "#1e3354";
const AXIS = "#2a4570";
const INK = { primary: "#e8edf5", secondary: "#c3cee0", muted: "#94a3c0" };

/** Fixed order, never cycled -- the same three the page uses. */
const CLASSES = [
  { id: "det-ff", label: "Deterministic feed-forward", color: "#3987e5" },
  { id: "stoch-ff", label: "Stochastic feed-forward", color: "#5ecfb0" },
  { id: "ar-lm", label: "Autoregressive LM", color: "#d95926" },
];

const run = JSON.parse(fs.readFileSync(RUN, "utf8"));
const INDEX = Object.fromEntries(run.columns.map((c, i) => [c, i]));
function col(name) {
  const i = INDEX[name];
  if (i === undefined) {
    throw new Error(`no "${name}" column in run ${run.run}: have ${run.columns.join(", ")}`);
  }
  return i;
}

async function loadRatings() {
  const file = arg("--scores");
  const body = file
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : await fetch(SCORES_URL).then((r) => {
        if (!r.ok) throw new Error(`${SCORES_URL} -> HTTP ${r.status}`);
        return r.json();
      });
  const raw = body.scores ?? {};
  const out = new Map();
  const entries = Array.isArray(raw) ? raw.map((s) => [s.config, s]) : Object.entries(raw);
  for (const [config, v] of entries) {
    const rating = typeof v === "number" ? v : v?.rating;
    if (rating != null) out.set(config, Number(rating));
  }
  return { ratings: out, minBallots: body.minBallots ?? null };
}

const { ratings, minBallots } = await loadRatings();

const points = run.rows
  .map((r) => ({
    config: r.config,
    name: r.display,
    cls: r.cells[col("Class")].sort,
    synth: Number(r.cells[col("x̄ t")].sort),
    disk: Number(r.cells[col("Disk")].sort),
    rating: ratings.get(r.config),
  }))
  .filter((p) => p.rating != null && Number.isFinite(p.synth) && p.synth > 0)
  .map((p) => ({ ...p, color: CLASSES.find((c) => c.id === p.cls)?.color ?? INK.muted }));

if (points.length < 6) {
  console.error(`only ${points.length} rated engines; the page hides the chart below 6, so no card`);
  process.exit(1);
}

// Plot box inside the panel. The header (title, subtitle, legend) takes the top
// 128px and the footer the bottom 32, so the SVG has to fit in what is left --
// getting this wrong pushes the x-axis title off the card and prints the footer
// on top of the plot.
const SVG_TOP = 128;
const SVG_H = CARD.h - SVG_TOP - 32;
const PANEL_H = SVG_H - 42;
const P = { x: 74, y: 26, w: CARD.w - 74 - 52, h: PANEL_H - 100 };
// X_MAX sits well beyond the slowest engine (51s) so its marker has room to draw
// inside the plot rather than half over the border.
const X_MIN = 0.09, X_MAX = 80;
const lx = (v) => Math.log10(v);
const sx = (v) => P.x + ((lx(v) - lx(X_MIN)) / (lx(X_MAX) - lx(X_MIN))) * P.w;
// Ratings run 0-100 but the axis goes to 105, so the best-rated engine sits a
// little below the frame instead of against it. Without that headroom its label
// has nowhere to go but down, into the densest part of the cloud.
const Y_MAX = 105;
const sy = (v) => P.y + P.h - (v / Y_MAX) * P.h;

const DISK = {
  min: Math.min(...points.map((p) => p.disk)),
  max: Math.max(...points.map((p) => p.disk)),
};
/** Area-proportional, floored so the smallest engine is still visible. */
const radius = (d) => 5 + 7 * Math.sqrt((d - DISK.min) / (DISK.max - DISK.min || 1));

const X_TICKS = [0.1, 0.3, 1, 3, 10, 30];
const Y_TICKS = [0, 25, 50, 75, 100];
const fmtX = (t) => (t < 1 ? `${t}s` : `${t}s`);

// Pearson r, quoted in the subtitle. Computed rather than typed, so a re-cut
// after more ballots cannot leave a stale number sitting next to fresh points.
const xs = points.map((p) => Math.log10(p.synth));
const ys = points.map((p) => p.rating);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const mx = mean(xs), my = mean(ys);
const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
const sd = (a, m) => Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0));
const r = cov / (sd(xs, mx) * sd(ys, my));

// Label only the corners of the story: best, worst, cheapest, slowest.
const byRating = [...points].sort((a, b) => b.rating - a.rating);
const labelled = new Set(
  [
    byRating[0],
    byRating[byRating.length - 1],
    [...points].sort((a, b) => a.synth - b.synth)[0],
    [...points].sort((a, b) => b.synth - a.synth)[0],
  ].map((p) => p.config)
);

const sub = points.length;
const fast = points.filter((p) => p.synth <= 1);
// "1-94" reads as a subtraction at a glance, so the range is spelled out.
const fastSpread = `${Math.round(Math.min(...fast.map((p) => p.rating)))} to ${Math.round(
  Math.max(...fast.map((p) => p.rating))
)}`;

const svg = `
<svg width="${CARD.w}" height="${SVG_H}" viewBox="0 0 ${CARD.w} ${SVG_H}">
  <rect x="40" y="0" width="${CARD.w - 80}" height="${PANEL_H}" rx="14" fill="${SURFACE}"/>
  ${Y_TICKS.map((t) => `<line x1="${P.x}" x2="${P.x + P.w}" y1="${sy(t)}" y2="${sy(t)}" stroke="${GRID}" stroke-width="1"/>`).join("")}
  ${X_TICKS.map((t) => `<line x1="${sx(t)}" x2="${sx(t)}" y1="${P.y}" y2="${P.y + P.h}" stroke="${GRID}" stroke-width="1"/>`).join("")}
  <line x1="${P.x}" x2="${P.x + P.w}" y1="${P.y + P.h}" y2="${P.y + P.h}" stroke="${AXIS}" stroke-width="1"/>
  <line x1="${P.x}" x2="${P.x}" y1="${P.y}" y2="${P.y + P.h}" stroke="${AXIS}" stroke-width="1"/>
  ${Y_TICKS.map((t) => `<text x="${P.x - 12}" y="${sy(t) + 5}" text-anchor="end" font-size="15" fill="${INK.muted}">${t}</text>`).join("")}
  ${X_TICKS.map((t) => `<text x="${sx(t)}" y="${P.y + P.h + 26}" text-anchor="middle" font-size="15" fill="${INK.muted}">${fmtX(t)}</text>`).join("")}
  <text x="${P.x + P.w / 2}" y="${P.y + P.h + 54}" text-anchor="middle" font-size="16" fill="${INK.secondary}">Compute per phrase, log scale (seconds, Apple M2)</text>
  <text transform="rotate(-90 22 ${P.y + P.h / 2})" x="22" y="${P.y + P.h / 2}" text-anchor="middle" font-size="16" fill="${INK.secondary}">Reader preference</text>
  ${/* Markers first, labels after, in two passes. In one pass a marker drawn
        later paints over an earlier point's label, which is how "NeuTTS-2E Q8"
        rendered as "euTTS-2E Q8" with a circle sitting on the missing letters. */ ""}
  ${points
    .map((p) => {
      const rr = radius(p.disk);
      return `<g>
      <circle cx="${sx(p.synth)}" cy="${sy(p.rating)}" r="${rr + 2}" fill="${SURFACE}"/>
      <circle cx="${sx(p.synth)}" cy="${sy(p.rating)}" r="${rr}" fill="${p.color}" fill-opacity="0.78" stroke="${p.color}" stroke-width="1"/>
    </g>`;
    })
    .join("")}
  ${points
    .filter((p) => labelled.has(p.config))
    .map((p) => {
      const rr = radius(p.disk);
      // Always above the marker: the y headroom guarantees room, so there is no
      // ceiling case to special-case. Only the right border flips the anchor.
      const right = sx(p.synth) > P.x + P.w * 0.72;
      return `<text x="${sx(p.synth) + (right ? -(rr + 7) : rr + 7)}" y="${sy(p.rating) - (rr + 7)}" text-anchor="${right ? "end" : "start"}" font-size="15" fill="${INK.primary}">${p.name}</text>`;
    })
    .join("")}
</svg>`;

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${CARD.w}px; height: ${CARD.h}px; background: ${BG};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  h1 { color: ${INK.primary}; font-size: 34px; font-weight: 700; text-align: center; padding-top: 26px; letter-spacing: -0.4px; }
  p.sub { color: ${INK.muted}; font-size: 18px; text-align: center; padding-top: 10px; }
  .legend { display: flex; justify-content: center; gap: 22px; padding-top: 12px; }
  .legend span { color: ${INK.muted}; font-size: 14px; display: inline-flex; align-items: center; gap: 7px; }
  .dot { width: 11px; height: 11px; border-radius: 999px; display: inline-block; }
  footer { color: ${INK.muted}; font-size: 15px; text-align: center; position: absolute; bottom: 16px; width: 100%; }
  .plot { position: absolute; top: ${SVG_TOP}px; left: 0; }
</style>
<h1>Open-weight TTS: reader preference vs compute per phrase</h1>
<p class="sub">${sub} engines ranked blind. Compute barely predicts preference (r = ${r.toFixed(2)}); the sub-second engines alone span ${fastSpread}.</p>
<div class="legend">
  ${CLASSES.map((c) => `<span><i class="dot" style="background:${c.color}"></i>${c.label}</span>`).join("")}
</div>
<div class="plot">${svg}</div>
<footer>orcabot.com/benchmarks</footer>
`;

fs.writeFileSync(OUT_HTML, html);
console.log(`[og-tts] ${sub} engines, r=${r.toFixed(3)}, minBallots=${minBallots}`);
console.log(`[og-tts] widest x: ${Math.min(...points.map((p) => p.synth))}s .. ${Math.max(...points.map((p) => p.synth))}s`);

if (argv.includes("--html-only")) {
  console.log(`[og-tts] wrote ${OUT_HTML}`);
  process.exit(0);
}

const { chromium } = await import("playwright");
const browser = await chromium.launch();
// 1x, not retina: generateMetadata declares og:image:width=1200/height=630, and
// the two existing cards are exactly that. A 2x file would contradict the
// declaration it ships with.
const page = await browser.newPage({
  viewport: { width: CARD.w, height: CARD.h },
  deviceScaleFactor: 1,
});
await page.goto("file://" + OUT_HTML, { waitUntil: "networkidle" });
await page.screenshot({ path: OUT_PNG });
await browser.close();
fs.unlinkSync(OUT_HTML);

const { size } = fs.statSync(OUT_PNG);
console.log(`[og-tts] wrote ${path.relative(ROOT, OUT_PNG)} (${Math.round(size / 1024)} KB)`);
