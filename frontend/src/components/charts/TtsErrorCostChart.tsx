// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-error-cost-v1
// Word error against what it costs to say a phrase, for every configuration in
// the table.
//
// x is Avg synth (compute per phrase), NOT the conventional RTF. RTF is compute
// per second of *audio*, so it flatters any engine that pads with silence.
// Every engine speaks the same 84 phrases, so per-phrase compute compares
// directly and cannot be gamed.
//
// The x axis is logarithmic, which a chart of a single benchmark run should
// normally avoid - it flatters small differences and hides large ones. Here it
// is unavoidable: the table stopped being real-time-only, so the range runs
// from Piper at 0.12s to Dots-TTS at 41.7s, a factor of 338. On a linear axis
// seventeen of the thirty-one engines land inside the first eighth of the
// width, on top of each other, which is not a chart of anything. Ticks are
// decade-anchored and labelled in seconds so the scale is legible rather than
// implied.
//
// Marker area encodes total disk, so "what will this cost me" is present on
// three axes without a third chart.
//
// Palette validated for CVD on this surface: the three architecture hues
// separate by >=14.8 in OKLab under the worst of protan/deutan/tritan, against
// a floor of 8, and each clears 4.3:1 contrast on #101e33. Unclassified engines
// are drawn in muted ink rather than a fourth hue - they are not a category,
// they are a missing value, and giving them a colour implies otherwise.

import * as React from "react";
import run from "@/data/benchmarks/open-weight-tts/2026-08.json";

const MODULE_REVISION = "tts-error-cost-v1";
if (typeof window !== "undefined") {
  console.log(`[tts-error-cost] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

const INK = { primary: "#e8edf5", secondary: "#c3cee0", muted: "#94a3c0" };
const GRID = "#1e3354";
const AXIS = "#2a4570";
const SURFACE = "#101e33";

/** Fixed order, never cycled. */
const CLASSES = [
  { id: "det-ff", label: "Deterministic feed-forward", color: "#3987e5" },
  { id: "stoch-ff", label: "Stochastic feed-forward", color: "#5ecfb0" },
  { id: "ar-lm", label: "Autoregressive LM", color: "#d95926" },
  { id: "?", label: "Unclassified", color: INK.muted },
] as const;

const INDEX = Object.fromEntries(run.columns.map((c, i) => [c, i])) as Record<string, number>;
/** Column index by name, loud when the name is not there. A bare lookup returns
 *  undefined, indexes into nothing, and throws at module load with a stack
 *  pointing at React rather than at the renamed column. */
function col(name: string): number {
  const i = INDEX[name];
  if (i === undefined) throw new Error(`[tts] no "${name}" column in run ${run.run}: have ${run.columns.join(", ")}`);
  return i;
}

interface Point {
  config: string; name: string; cls: string; color: string;
  synth: number; wer: number; disk: number; rtf: number; werText: string; synthText: string;
}

const POINTS: Point[] = (
  run.rows as { config: string; display: string; cells: { v: string; sort: string }[] }[]
).map((r) => {
  const cls = r.cells[col("Class")].sort;
  return {
    config: r.config,
    name: r.display,
    cls,
    color: CLASSES.find((c) => c.id === cls)?.color ?? INK.muted,
    synth: Number(r.cells[col("x̄ synth")].sort),
    wer: Number(r.cells[col("WER")].sort) * 100,
    disk: Number(r.cells[col("Disk")].sort),
    rtf: Number(r.cells[col("RTF")].sort),
    werText: r.cells[col("WER")].v,
    synthText: r.cells[col("x̄ synth")].v,
  };
});

const W = 780, H = 470;
const M = { top: 18, right: 26, bottom: 56, left: 58 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

const X_MIN = 0.1, X_MAX = 50;   // decade-aligned around the real 0.12s..41.7s
const Y_MAX = 60;                // Bark tops out at 55%
const lx = Math.log10(X_MIN), lxSpan = Math.log10(X_MAX) - lx;
const sx = (v: number) => M.left + ((Math.log10(v) - lx) / lxSpan) * PW;
const sy = (v: number) => M.top + PH - (v / Y_MAX) * PH;

const DISK = { min: Math.min(...POINTS.map((p) => p.disk)), max: Math.max(...POINTS.map((p) => p.disk)) };
/** Area-proportional, floored at 5px radius so the smallest is still a target. */
const radius = (disk: number) => 5 + 7 * Math.sqrt((disk - DISK.min) / (DISK.max - DISK.min));

const X_TICKS = [0.1, 0.3, 1, 3, 10, 30];
const Y_TICKS = [0, 10, 20, 30, 40, 50];
const tickLabel = (t: number) => (t < 1 ? `${t}s` : `${t}s`);

/** Labelled inline: the cheapest, the most accurate, the worst, and the dearest.
 *  A name on every point is noise at this density; the rest label on hover. */
const cheapest = POINTS.reduce((a, b) => (a.synth <= b.synth ? a : b));
const dearest = POINTS.reduce((a, b) => (a.synth >= b.synth ? a : b));
const best = POINTS.reduce((a, b) => (a.wer <= b.wer ? a : b));
const worst = POINTS.reduce((a, b) => (a.wer >= b.wer ? a : b));
const LABELLED = new Set([cheapest, dearest, best, worst].map((p) => p.config));

export function TtsErrorCostChart() {
  const [hover, setHover] = React.useState<Point | null>(null);
  // Which class is isolated, if any. Isolating dims the others rather than
  // removing them, so the cloud they form stays visible as context.
  const [focus, setFocus] = React.useState<string | null>(null);
  const isLit = (p: Point) => !focus || p.cls === focus;

  return (
    <figure style={{ margin: "2rem 0" }}>
      <figcaption style={{ marginBottom: "0.75rem" }}>
        <strong style={{ display: "block", color: INK.primary, fontSize: "1rem", fontWeight: 600 }}>
          What a phrase costs, against how much of it survives
        </strong>
        <span style={{ color: INK.muted, fontSize: "0.85rem" }}>
          Word error after a Whisper round trip, against compute per phrase. Down and to the
          left is better; marker size is total disk. Note the log scale on compute — the
          engines span a factor of 338.
        </span>
      </figcaption>

      {/* Legend doubles as a filter. Colour follows the architecture class, so
          isolating a class never repaints the classes that remain. */}
      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
        {CLASSES.map((c) => {
          const n = POINTS.filter((p) => p.cls === c.id).length;
          if (!n) return null;
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
          aria-label={`Scatter plot of word error rate against compute per phrase for ${POINTS.length} text-to-speech engines, on a logarithmic compute axis.`}
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
              {t}%
            </text>
          ))}
          {X_TICKS.map((t) => (
            <text key={`tx${t}`} x={sx(t)} y={M.top + PH + 20} textAnchor="middle" fontSize={11} fill={INK.muted}>
              {tickLabel(t)}
            </text>
          ))}
          <text x={M.left + PW / 2} y={H - 12} textAnchor="middle" fontSize={12} fill={INK.secondary}>
            Compute per phrase, log scale (seconds, Apple M2)
          </text>
          <text
            transform={`rotate(-90 14 ${M.top + PH / 2})`}
            x={14} y={M.top + PH / 2} textAnchor="middle" fontSize={12} fill={INK.secondary}
          >
            Word error rate
          </text>

          {POINTS.map((p) => {
            const lit = isLit(p);
            const hot = hover?.config === p.config;
            const r = radius(p.disk);
            const right = sx(p.synth) > M.left + PW * 0.72;
            const high = p.wer > Y_MAX * 0.86;
            return (
              <g key={p.config} opacity={lit ? 1 : 0.18} onMouseEnter={() => setHover(p)} style={{ cursor: "pointer" }}>
                {/* 2px surface ring so overlapping markers stay separable. */}
                <circle cx={sx(p.synth)} cy={sy(p.wer)} r={r + 2} fill={SURFACE} />
                <circle
                  cx={sx(p.synth)} cy={sy(p.wer)} r={r}
                  fill={p.color} fillOpacity={hot ? 1 : 0.75}
                  stroke={hot ? INK.primary : p.color} strokeWidth={hot ? 2 : 1}
                />
                {/* Generous invisible hit target, independent of marker size. */}
                <circle cx={sx(p.synth)} cy={sy(p.wer)} r={Math.max(r + 8, 16)} fill="transparent" />
                {LABELLED.has(p.config) && lit && (
                  <text
                    x={sx(p.synth) + (right ? -(r + 6) : r + 6)}
                    // Right-hand labels extend back over the plot, where the
                    // points are densest, so they sit higher to clear them.
                    y={sy(p.wer) + (high ? r + 15 : -(r + (right ? 14 : 6)))}
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
              top: `${(sy(hover.wer) / H) * 100}%`,
              transform: `translate(${sx(hover.synth) > M.left + PW * 0.6 ? "-105%" : "12px"}, -110%)`,
              background: "#0b1a2e", border: `1px solid ${hover.color}`, borderRadius: 6,
              padding: "0.45rem 0.6rem", fontSize: "0.76rem", color: INK.secondary, whiteSpace: "nowrap",
              boxShadow: "0 6px 18px rgba(0,0,0,0.45)",
            }}
          >
            <strong style={{ color: INK.primary }}>{hover.name}</strong>
            <br />
            {hover.werText} word error · {hover.synthText} per phrase
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
