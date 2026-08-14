// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-speed-accuracy-v1
// The article's headline finding, made visual: every real-time engine placed by
// what it costs to speak a phrase against how much of that phrase survives a
// Whisper round trip. Piper sits alone in the bottom-left, and the expensive
// LM-backed cluster to its right buys no intelligibility at all.
//
// Axis choices, both deliberate and both argued in the article:
//   - x is Avg synth (compute per phrase), NOT the conventional RTF. RTF is
//     compute per second of *audio*, so it flatters any engine that pads with
//     silence. Every engine here speaks the same 84 phrases, so per-phrase
//     compute compares directly and cannot be gamed.
//   - y is WER base rather than the stronger WER med, only because two engines
//     (Chatterbox Turbo and FastPitch) have no medium-model score, and dropping
//     the headline arrival from the headline chart would be perverse. base.en
//     understates the good engines, so the real spread is wider than shown.
//
// Marker area encodes total disk, which is the third axis in "nothing beats
// Piper on all three at once" — otherwise that claim is only in the prose.
//
// Palette validated for CVD on this surface before use: the three class hues
// separate by >=14.8 in OKLab under the worst of protan/deutan/tritan, against
// a floor of 8, and every hue clears 4.3:1 contrast on #101e33.

import * as React from "react";
import run from "@/data/benchmarks/open-weight-tts/2026-08.json";

const MODULE_REVISION = "tts-speed-accuracy-v1";
if (typeof window !== "undefined") {
  console.log(`[tts-speed-accuracy] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
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
] as const;

const COL = Object.fromEntries(run.columns.map((c, i) => [c, i])) as Record<string, number>;
const num = (r: { cells: { sort: string }[] }, c: string) => Number(r.cells[COL[c]].sort);

interface Point {
  name: string; cls: string; color: string;
  synth: number; wer: number; disk: number; rtf: number; werText: string;
}

const POINTS: Point[] = (run.rows as { display: string; cells: { v: string; sort: string }[] }[]).map((r) => {
  const cls = r.cells[COL["Class"]].sort;
  return {
    name: r.display,
    cls,
    color: CLASSES.find((c) => c.id === cls)?.color ?? INK.muted,
    synth: num(r, "Avg synth"),
    wer: num(r, "WER base") * 100,
    disk: num(r, "Total disk"),
    rtf: num(r, "RTF"),
    werText: r.cells[COL["WER base"]].v,
  };
});

// Labelled inline: the two extremes that calibrate the axes, the cheapest and
// dearest LM-backed engines, and the one engine only nominally in the running.
// The rest label on hover — a number on every point is noise at this density.
const LABELLED: Record<string, { dx: number; dy: number }> = {
  "Piper": { dx: 10, dy: -8 },
  "Chatterbox Turbo": { dx: 0, dy: -14 },
  "Chatterbox Q4": { dx: -10, dy: -12 },
  "SpeechT5": { dx: 12, dy: 4 },
  "Qwen3-TTS": { dx: 10, dy: -10 },
  "FastPitch": { dx: 12, dy: 4 },
};

const W = 780, H = 470;
const M = { top: 18, right: 26, bottom: 56, left: 58 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

const X_MAX = 6.8;   // Chatterbox Q4 at 6.39 is the slowest that survives the filter
const Y_MAX = 26;    // SpeechT5 at 24.2 is the worst
const sx = (v: number) => M.left + (v / X_MAX) * PW;
const sy = (v: number) => M.top + PH - (v / Y_MAX) * PH;

const DISK = { min: Math.min(...POINTS.map((p) => p.disk)), max: Math.max(...POINTS.map((p) => p.disk)) };
/** Area-proportional, floored at 5px radius so the smallest is still a target. */
const radius = (disk: number) =>
  5 + 7 * Math.sqrt((disk - DISK.min) / (DISK.max - DISK.min));

const X_TICKS = [0, 1, 2, 3, 4, 5, 6];
const Y_TICKS = [0, 5, 10, 15, 20, 25];

export function TtsSpeedAccuracyChart() {
  const [hover, setHover] = React.useState<Point | null>(null);
  // Which class is isolated, if any. Isolating dims the others rather than
  // removing them, so the cloud they form stays visible as context.
  const [focus, setFocus] = React.useState<string | null>(null);

  const isLit = (p: Point) => !focus || p.cls === focus;

  return (
    <figure style={{ margin: "2rem 0" }}>
      <figcaption style={{ marginBottom: "0.75rem" }}>
        <strong style={{ display: "block", color: INK.primary, fontSize: "1rem", fontWeight: 600 }}>
          Nothing buys its way to better intelligibility
        </strong>
        <span style={{ color: INK.muted, fontSize: "0.85rem" }}>
          Word error after a Whisper round trip against compute per phrase, for every engine that
          keeps pace with real time. Down and to the left is better; marker size is total disk.
        </span>
      </figcaption>

      {/* Legend doubles as a filter. Colour follows the architecture class, so
          dimming a class never repaints the classes that remain. */}
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
          aria-label="Scatter plot of word error rate against compute per phrase for thirteen text-to-speech engines. Piper is alone in the low-error, low-compute corner."
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
            Word error rate
          </text>

          {POINTS.map((p) => {
            const lit = isLit(p);
            const hot = hover?.name === p.name;
            const r = radius(p.disk);
            return (
              <g
                key={p.name}
                opacity={lit ? 1 : 0.18}
                onMouseEnter={() => setHover(p)}
                style={{ cursor: "pointer" }}
              >
                {/* 2px surface ring so overlapping markers stay separable. */}
                <circle cx={sx(p.synth)} cy={sy(p.wer)} r={r + 2} fill={SURFACE} />
                <circle
                  cx={sx(p.synth)} cy={sy(p.wer)} r={r}
                  fill={p.color} fillOpacity={hot ? 1 : 0.75}
                  stroke={hot ? INK.primary : p.color} strokeWidth={hot ? 2 : 1}
                />
                {/* Generous invisible hit target, independent of marker size. */}
                <circle cx={sx(p.synth)} cy={sy(p.wer)} r={Math.max(r + 8, 16)} fill="transparent" />
                {LABELLED[p.name] && lit && (
                  <text
                    x={sx(p.synth) + LABELLED[p.name].dx}
                    y={sy(p.wer) + LABELLED[p.name].dy}
                    textAnchor={LABELLED[p.name].dx < 0 ? "end" : LABELLED[p.name].dx === 0 ? "middle" : "start"}
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
              transform: `translate(${hover.synth > X_MAX * 0.6 ? "-105%" : "12px"}, -110%)`,
              background: "#0b1a2e", border: `1px solid ${hover.color}`, borderRadius: 6,
              padding: "0.45rem 0.6rem", fontSize: "0.76rem", color: INK.secondary, whiteSpace: "nowrap",
              boxShadow: "0 6px 18px rgba(0,0,0,0.45)",
            }}
          >
            <strong style={{ color: INK.primary }}>{hover.name}</strong>
            <br />
            {hover.werText} word error · {hover.synth.toFixed(2)}s per phrase
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
