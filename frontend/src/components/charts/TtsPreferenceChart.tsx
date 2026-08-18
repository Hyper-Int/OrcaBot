// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-preference-chart-v2-human-axis
// What compute actually buys, plotted against what it costs: reader preference
// on the y-axis, compute per phrase on the x.
//
// This deliberately does NOT plot word error, which was the first version of
// this chart. Word error is the wrong y-axis for the question the chart is
// asking. It saturates once speech is merely intelligible, so it cannot rank
// engines that are all comprehensible and differ in how they sound; two of the
// thirteen have no medium-model score at all, so the stronger transcriber
// cannot be used without dropping them; and the article says outright that
// base.en understates good engines more than bad ones. Ranking engines on a
// measure the article spends a section warning you about is not a chart worth
// publishing.
//
// So it waits. The chart renders nothing at all until enough engines have a
// human rating, then appears on its own. That is why it has no fixed headline:
// the relationship between compute and preference is exactly the thing being
// measured, and asserting the finding before the data is in would be inventing
// it. Sharpen the title once the shape is known.
//
// x is Avg synth (compute per phrase), NOT the conventional RTF. RTF is compute
// per second of *audio*, so it flatters any engine that pads with silence.
// Every engine here speaks the same 84 phrases, so per-phrase compute compares
// directly and cannot be gamed.
//
// Marker area encodes total disk, so the third axis in "what will this cost me"
// is present without a third chart.
//
// Palette validated for CVD on this surface before use: the three class hues
// separate by >=14.8 in OKLab under the worst of protan/deutan/tritan, against
// a floor of 8, and every hue clears 4.3:1 contrast on #101e33.

import * as React from "react";
import run from "@/data/benchmarks/open-weight-tts/2026-08.json";
import { useTtsScores } from "./useTtsScores";

const MODULE_REVISION = "tts-preference-chart-v2-human-axis";
if (typeof window !== "undefined") {
  console.log(`[tts-preference-chart] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

/** Below this many rated engines a scatter is anecdote, not a chart. */
const MIN_ENGINES_TO_PLOT = 6;

const INK = { primary: "#e8edf5", secondary: "#c3cee0", muted: "#94a3c0" };
const GRID = "#1e3354";
const AXIS = "#2a4570";
const SURFACE = "#101e33";

/** Fixed order, never cycled. */
const CLASSES = [
  { id: "det-ff", label: "Deterministic feed-forward", color: "#3987e5" },
  { id: "stoch-ff", label: "Stochastic feed-forward", color: "#5ecfb0" },
  { id: "ar-lm", label: "Autoregressive LM", color: "#d95926" },
] as const;

const INDEX = Object.fromEntries(run.columns.map((c, i) => [c, i])) as Record<string, number>;
/** Column index by name, loud when the name is not there. A bare lookup returns
 *  undefined, which indexes into nothing and throws at module load with a stack
 *  pointing at React rather than at the renamed column - which is exactly what
 *  happened when "Total disk" became "Disk". */
function col(name: string): number {
  const i = INDEX[name];
  if (i === undefined) throw new Error(`[tts] no "${name}" column in run ${run.run}: have ${run.columns.join(", ")}`);
  return i;
}

interface Engine {
  config: string; name: string; cls: string; color: string;
  synth: number; disk: number; rtf: number;
}

const ENGINES: Engine[] = (
  run.rows as { config: string; display: string; cells: { v: string; sort: string }[] }[]
).map((r) => {
  const cls = r.cells[col("Class")].sort;
  return {
    config: r.config,
    name: r.display,
    cls,
    color: CLASSES.find((c) => c.id === cls)?.color ?? INK.muted,
    synth: Number(r.cells[col("x̄ synth")].sort),
    disk: Number(r.cells[col("Disk")].sort),
    rtf: Number(r.cells[col("RTF")].sort),
  };
});

const W = 780, H = 470;
const M = { top: 18, right: 26, bottom: 56, left: 58 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

const X_MAX = 6.8;   // Chatterbox Q4 at 6.39 is the slowest that survives the filter
const Y_MAX = 100;   // ratings are already scaled 0-100 server-side
const sx = (v: number) => M.left + (v / X_MAX) * PW;
const sy = (v: number) => M.top + PH - (v / Y_MAX) * PH;

const DISK = { min: Math.min(...ENGINES.map((e) => e.disk)), max: Math.max(...ENGINES.map((e) => e.disk)) };
/** Area-proportional, floored at 5px radius so the smallest is still a target. */
const radius = (disk: number) => 5 + 7 * Math.sqrt((disk - DISK.min) / (DISK.max - DISK.min));

const X_TICKS = [0, 1, 2, 3, 4, 5, 6];
const Y_TICKS = [0, 25, 50, 75, 100];

interface Point extends Engine { rating: number }

export function TtsPreferenceChart() {
  const { ratings, minBallots } = useTtsScores();
  const [hover, setHover] = React.useState<Point | null>(null);
  // Which class is isolated, if any. Isolating dims the others rather than
  // removing them, so the cloud they form stays visible as context.
  const [focus, setFocus] = React.useState<string | null>(null);

  const points: Point[] = React.useMemo(
    () =>
      ENGINES.flatMap((e) => {
        const rating = ratings.get(e.config);
        return rating == null ? [] : [{ ...e, rating }];
      }),
    [ratings]
  );

  // Nothing to say yet, so say nothing. An empty axis box would read as a bug,
  // and a placeholder would be a promise the page cannot keep on its own.
  if (points.length < MIN_ENGINES_TO_PLOT) return null;

  const isLit = (p: Point) => !focus || p.cls === focus;
  // Only label the extremes; at this density a name on every point is noise.
  const byRating = [...points].sort((a, b) => b.rating - a.rating);
  const cheapest = [...points].sort((a, b) => a.synth - b.synth)[0];
  const labelled = new Set([byRating[0], byRating[byRating.length - 1], cheapest].map((p) => p.config));

  return (
    <figure style={{ margin: "2rem 0" }}>
      <figcaption style={{ marginBottom: "0.75rem" }}>
        <strong style={{ display: "block", color: INK.primary, fontSize: "1rem", fontWeight: 600 }}>
          What the compute actually buys
        </strong>
        <span style={{ color: INK.muted, fontSize: "0.85rem" }}>
          Reader preference against compute per phrase. Up and to the left is better; marker size
          is total disk. Preference comes from blind four-way rankings and moves as more arrive,
          so an engine appears here only once{minBallots ? ` ${minBallots}` : ""} people have ranked it.
        </span>
      </figcaption>

      {/* Legend doubles as a filter. Colour follows the architecture class, so
          isolating a class never repaints the classes that remain. */}
      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
        {CLASSES.map((c) => {
          const active = focus === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setFocus((f) => (f === c.id ? null : c.id))}
              aria-pressed={active}
              style={{
                display: "inline-flex", alignItems: "center", gap: "0.4rem",
                font: "inherit", fontSize: "0.78rem", padding: "0.25rem 0.6rem", borderRadius: 999,
                border: `1px solid ${active ? c.color : AXIS}`,
                background: active ? `${c.color}1f` : "transparent",
                color: active ? INK.primary : INK.muted, cursor: "pointer",
              }}
            >
              <span style={{ width: 10, height: 10, borderRadius: 999, background: c.color, flexShrink: 0 }} />
              {c.label}
            </button>
          );
        })}
      </div>

      <div style={{ position: "relative" }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`Scatter plot of reader preference against compute per phrase for ${points.length} text-to-speech engines.`}
          style={{ display: "block", background: SURFACE, border: `1px solid ${AXIS}`, borderRadius: 8 }}
          onMouseLeave={() => setHover(null)}
        >
          {Y_TICKS.map((t) => (
            <line key={`gy${t}`} x1={M.left} x2={M.left + PW} y1={sy(t)} y2={sy(t)} stroke={GRID} strokeWidth={1} />
          ))}
          {X_TICKS.map((t) => (
            <line key={`gx${t}`} x1={sx(t)} x2={sx(t)} y1={M.top} y2={M.top + PH} stroke={GRID} strokeWidth={1} />
          ))}
          <line x1={M.left} x2={M.left + PW} y1={M.top + PH} y2={M.top + PH} stroke={AXIS} strokeWidth={1} />
          <line x1={M.left} x2={M.left} y1={M.top} y2={M.top + PH} stroke={AXIS} strokeWidth={1} />

          {Y_TICKS.map((t) => (
            <text key={`ty${t}`} x={M.left - 10} y={sy(t) + 4} textAnchor="end" fontSize={11} fill={INK.muted}>
              {t}
            </text>
          ))}
          {X_TICKS.map((t) => (
            <text key={`tx${t}`} x={sx(t)} y={M.top + PH + 20} textAnchor="middle" fontSize={11} fill={INK.muted}>
              {t}s
            </text>
          ))}
          <text x={M.left + PW / 2} y={H - 12} textAnchor="middle" fontSize={12} fill={INK.secondary}>
            Compute per phrase (seconds, Apple M2)
          </text>
          <text
            transform={`rotate(-90 14 ${M.top + PH / 2})`}
            x={14} y={M.top + PH / 2} textAnchor="middle" fontSize={12} fill={INK.secondary}
          >
            Reader preference
          </text>

          {points.map((p) => {
            const lit = isLit(p);
            const hot = hover?.config === p.config;
            const r = radius(p.disk);
            const right = p.synth > X_MAX * 0.75;
            // Labels sit above the marker, except near the ceiling where that
            // puts them through the top border. The best-rated engine is by
            // definition up there, so this is the common case, not an edge one.
            const high = p.rating > Y_MAX * 0.88;
            return (
              <g key={p.config} opacity={lit ? 1 : 0.18} onMouseEnter={() => setHover(p)} style={{ cursor: "pointer" }}>
                {/* 2px surface ring so overlapping markers stay separable. */}
                <circle cx={sx(p.synth)} cy={sy(p.rating)} r={r + 2} fill={SURFACE} />
                <circle
                  cx={sx(p.synth)} cy={sy(p.rating)} r={r}
                  fill={p.color} fillOpacity={hot ? 1 : 0.75}
                  stroke={hot ? INK.primary : p.color} strokeWidth={hot ? 2 : 1}
                />
                {/* Generous invisible hit target, independent of marker size. */}
                <circle cx={sx(p.synth)} cy={sy(p.rating)} r={Math.max(r + 8, 16)} fill="transparent" />
                {labelled.has(p.config) && lit && (
                  <text
                    x={sx(p.synth) + (right ? -(r + 6) : r + 6)}
                    y={sy(p.rating) + (high ? r + 15 : -(r + 6))}
                    textAnchor={right ? "end" : "start"}
                    fontSize={11}
                    fill={hot ? INK.primary : INK.secondary}
                  >
                    {p.name}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {hover && (
          <div
            style={{
              position: "absolute", pointerEvents: "none",
              left: `${(sx(hover.synth) / W) * 100}%`,
              top: `${(sy(hover.rating) / H) * 100}%`,
              transform: `translate(${hover.synth > X_MAX * 0.6 ? "-105%" : "12px"}, -110%)`,
              background: "#0b1a2e", border: `1px solid ${hover.color}`, borderRadius: 6,
              padding: "0.45rem 0.6rem", fontSize: "0.76rem", color: INK.secondary, whiteSpace: "nowrap",
              boxShadow: "0 6px 18px rgba(0,0,0,0.45)",
            }}
          >
            <strong style={{ color: INK.primary }}>{hover.name}</strong>
            <br />
            {hover.rating.toFixed(1)} preference · {hover.synth.toFixed(2)}s per phrase
            <br />
            <span style={{ color: INK.muted }}>
              {hover.rtf.toFixed(2)}× real time ·{" "}
              {hover.disk >= 1024 ? `${(hover.disk / 1024).toFixed(1)} GB` : `${Math.round(hover.disk)} MB`} on disk ·{" "}
              {CLASSES.find((c) => c.id === hover.cls)?.label}
            </span>
          </div>
        )}
      </div>
    </figure>
  );
}
