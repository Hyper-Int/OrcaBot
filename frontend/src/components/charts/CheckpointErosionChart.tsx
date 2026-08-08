// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: checkpoint-erosion-chart-v1
// SlopCodeBench core solve rate by checkpoint, both runs, independently toggled.
//
// Colour encodes the RUN, not the arm, deliberately. With 5–6 arms per run,
// colouring by arm would need 11 hues (past the 8-slot limit, and it would cycle).
// The question this chart answers is run-level anyway: "does July erode
// differently from June?" So each run is one hue: thin lines carry the arms,
// a thick line carries the run mean, and hover names the arm. Same blue/orange
// as the cost/accuracy chart, so a colour means the same thing on both.
//
// Palette validated for this page's navy surface:
//   node scripts/validate_palette.js "#3987e5,#d95926" --mode dark --surface "#101e33"
//   worst adjacent CVD dE 26.8 protan / 32.4 tritan, all checks pass.

import * as React from "react";
import june from "@/data/benchmarks/agent-skills/2026-06.json";
import july from "@/data/benchmarks/agent-skills/2026-07.json";

const MODULE_REVISION = "checkpoint-erosion-chart-v1";
if (typeof window !== "undefined") {
  console.log(`[checkpoint-erosion-chart] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

interface Arm {
  arm: string;
  values: number[];
  cp1ToLast: number;
  isBaseline?: boolean;
}

const RUNS = [
  { id: "jun", label: june.label, color: "#3987e5", arms: june.slopcodebench.arms as Arm[] },
  { id: "jul", label: july.label, color: "#d95926", arms: july.slopcodebench.arms as Arm[] },
];

const CPS = june.slopcodebench.checkpoints;

const INK = { primary: "#e8edf5", secondary: "#c3cee0", muted: "#94a3c0" };
const GRID = "#1e3354";
const AXIS = "#2a4570";
const SURFACE = "#101e33";

const W = 760;
const H = 440;
const M = { top: 24, right: 24, bottom: 52, left: 52 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

const Y = [30, 85];
const sx = (cp: number) => M.left + ((cp - 1) / (CPS.length - 1)) * PW;
const sy = (v: number) => M.top + PH - ((v - Y[0]) / (Y[1] - Y[0])) * PH;
const Y_TICKS = [30, 40, 50, 60, 70, 80];

const mean = (arms: Arm[], i: number) => arms.reduce((s, a) => s + a.values[i], 0) / arms.length;
const path = (vals: number[]) => vals.map((v, i) => `${i === 0 ? "M" : "L"}${sx(CPS[i])},${sy(v)}`).join(" ");

/** Canonical arm identity across runs. "Superpowers v5" and "Superpowers v6" are
 *  the same pack, so highlighting Superpowers must catch both. */
const armKey = (name: string) => name.replace(/\s+v\d+$/, "");

const ARM_ORDER = ["baseline Codex 5.5", "Git Ship Done", "Oh My ClaudeCode", "Superpowers", "Karpathy", "Agent Skills"];
/** Display names differ slightly between the data files and the prose tables. */
const ARM_ALIAS: Record<string, string> = {
  baseline: "baseline Codex 5.5",
  GSD: "Git Ship Done",
  OMC: "Oh My ClaudeCode",
  Karpathy: "Karpathy",
  Superpowers: "Superpowers",
  "Agent Skills": "Agent Skills",
};
const displayArm = (name: string) => ARM_ALIAS[armKey(name)] ?? armKey(name);

export function CheckpointErosionChart() {
  const [on, setOn] = React.useState<Record<string, boolean>>({ jun: true, jul: true });
  const [hover, setHover] = React.useState<{ arm: Arm; runLabel: string; color: string } | null>(null);
  // Arm highlighting: identity without needing 6 CVD-safe hues.
  // Hover and pin are SEPARATE states on purpose. With one shared state, the
  // pointer is already hovering the button when the click lands, so the toggle
  // saw "already active" and switched it off, so clicking appeared to do nothing,
  // and mouse-leave then wiped it anyway.
  const [pinnedArm, setPinnedArm] = React.useState<string | null>(null);
  const [hoverArm, setHoverArm] = React.useState<string | null>(null);
  const [showTable, setShowTable] = React.useState(false);

  const visible = RUNS.filter((r) => on[r.id]);
  const armsPresent = ARM_ORDER.filter((a) =>
    visible.some((r) => r.arms.some((x) => displayArm(x.arm) === a))
  );

  // An arm can stop being visible while pinned: pin "Agent Skills" (a July-only
  // arm), then switch July off. Its chip leaves the legend, so honouring the pin
  // would dim every remaining line with no control left to release it. Derived
  // rather than cleared, so re-enabling the run restores the pin instead of
  // silently dropping it.
  const activePin = pinnedArm && armsPresent.includes(pinnedArm) ? pinnedArm : null;
  const activeHover = hoverArm && armsPresent.includes(hoverArm) ? hoverArm : null;
  const focusArm = activeHover ?? activePin;
  const isDim = (a: Arm) => focusArm !== null && displayArm(a.arm) !== focusArm;
  const isFocus = (a: Arm) => focusArm !== null && displayArm(a.arm) === focusArm;

  return (
    <figure style={{ margin: "2rem 0" }}>
      <h4 style={{ margin: "0 0 0.15rem", fontSize: "1.05rem", fontWeight: 700, color: INK.primary }}>
        SlopCodeBench: solve rate erodes over checkpoints
      </h4>
      <p style={{ margin: "0 0 0.85rem", fontSize: "0.83rem", color: INK.muted }}>
        Every arm declines together; no skill separates from the baseline, in either run.
      </p>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.75rem" }}>
        {RUNS.map((r) => {
          const active = on[r.id];
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => setOn((p) => ({ ...p, [r.id]: !p[r.id] }))}
              aria-pressed={active}
              style={{
                display: "inline-flex", alignItems: "center", gap: "0.45rem",
                padding: "0.3rem 0.7rem", borderRadius: 999,
                border: `1px solid ${active ? r.color : AXIS}`,
                background: active ? `${r.color}1f` : "transparent",
                color: active ? INK.primary : INK.muted,
                fontSize: "0.8rem", cursor: "pointer", transition: "all 120ms",
              }}
            >
              <span aria-hidden="true" style={{
                width: 10, height: 10, borderRadius: 999,
                background: active ? r.color : "transparent",
                border: `2px solid ${active ? r.color : INK.muted}`,
              }} />
              {r.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setShowTable((s) => !s)}
          style={{
            marginLeft: "auto", padding: "0.3rem 0.7rem", borderRadius: 999,
            border: `1px solid ${AXIS}`, background: "transparent",
            color: INK.muted, fontSize: "0.8rem", cursor: "pointer",
          }}
        >
          {showTable ? "Hide data" : "View data"}
        </button>
      </div>

      <div style={{ position: "relative", overflowX: "auto" }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          style={{ display: "block", background: SURFACE, borderRadius: 8, minWidth: 520 }}
          role="img"
          aria-label={`Core solve rate by checkpoint for ${visible.map((r) => r.label).join(" and ") || "no runs selected"}. Every arm declines from roughly 75-81 percent at checkpoint 1 to 33-50 percent by checkpoint 8.`}
          fontFamily="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        >
          {Y_TICKS.map((t) => (
            <line key={t} x1={M.left} x2={M.left + PW} y1={sy(t)} y2={sy(t)} stroke={GRID} strokeWidth={1} />
          ))}
          <line x1={M.left} x2={M.left + PW} y1={M.top + PH} y2={M.top + PH} stroke={AXIS} />
          <line x1={M.left} x2={M.left} y1={M.top} y2={M.top + PH} stroke={AXIS} />

          {Y_TICKS.map((t) => (
            <text key={t} x={M.left - 10} y={sy(t) + 4} textAnchor="end" fontSize={11} fill={INK.muted}>{t}%</text>
          ))}
          {CPS.map((cp) => (
            <text key={cp} x={sx(cp)} y={M.top + PH + 20} textAnchor="middle" fontSize={11} fill={INK.muted}>cp{cp}</text>
          ))}
          <text x={M.left + PW / 2} y={H - 10} textAnchor="middle" fontSize={12} fill={INK.secondary}>Checkpoint</text>
          <text x={-(M.top + PH / 2)} y={14} transform="rotate(-90)" textAnchor="middle" fontSize={12} fill={INK.secondary}>
            Core solve %
          </text>

          {/* Thin per-arm lines */}
          {visible.map((run) =>
            run.arms.map((a) => {
              const hot = hover?.arm === a || isFocus(a);
              const dim = isDim(a) || (hover != null && hover.arm !== a && focusArm === null);
              return (
                <path
                  key={`${run.id}-${a.arm}`}
                  d={path(a.values)}
                  fill="none"
                  stroke={run.color}
                  strokeWidth={hot ? 2.75 : 1.25}
                  strokeOpacity={hot ? 1 : dim ? 0.15 : 0.4}
                  strokeDasharray={a.isBaseline ? "5 3" : undefined}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHover({ arm: a, runLabel: run.label, color: run.color })}
                  onMouseLeave={() => setHover(null)}
                />
              );
            })
          )}

          {/* Bold run mean, recedes while an individual arm is singled out */}
          {visible.map((run) => (
            <path
              key={`${run.id}-mean`}
              d={path(CPS.map((_, i) => mean(run.arms, i)))}
              fill="none"
              stroke={run.color}
              strokeWidth={3}
              strokeOpacity={hover || focusArm ? 0.22 : 1}
              style={{ pointerEvents: "none" }}
            />
          ))}

          {visible.length === 0 && (
            <text x={M.left + PW / 2} y={M.top + PH / 2} textAnchor="middle" fontSize={13} fill={INK.muted}>
              Select a run above to plot it
            </text>
          )}
        </svg>

        {hover && (
          <div style={{
            position: "absolute", left: "50%", top: 8, transform: "translateX(-50%)",
            pointerEvents: "none", background: "#0b1a2e", border: `1px solid ${hover.color}`,
            borderRadius: 6, padding: "0.35rem 0.6rem", fontSize: "0.75rem", color: INK.primary,
            whiteSpace: "nowrap", boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}>
            <strong>{hover.arm.arm}</strong> · {hover.runLabel} · cp1→last {hover.arm.cp1ToLast}
          </div>
        )}
      </div>

      {/* Encoding legend: colour means RUN here, never arm */}
      <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", marginTop: "0.6rem", fontSize: "0.78rem", color: INK.muted }}>
        {RUNS.map((r) => (
          <span key={r.id} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", opacity: on[r.id] ? 1 : 0.4 }}>
            <span style={{ width: 14, height: 3, background: r.color }} /> {r.label} (thick = run mean)
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
          <span style={{ width: 14, height: 0, borderTop: `2px dashed ${INK.muted}` }} /> dashed = baseline
        </span>
      </div>

      {/* Arm legend. Arms are identified by NAME, not hue: five crossing lines
          cannot be told apart by colour under CVD (the reference palette scores
          all-pairs dE 1.6 at this series count), so identity comes from
          highlighting instead. Hover or tap a name to isolate it in both runs. */}
      <div style={{ marginTop: "0.7rem", fontSize: "0.78rem", color: INK.muted }}>
        <span style={{ marginRight: "0.6rem" }}>Highlight an arm:</span>
        {armsPresent.map((a) => {
          const pinned = activePin === a;
          const lit = focusArm === a;
          return (
            <button
              key={a}
              type="button"
              onMouseEnter={() => setHoverArm(a)}
              onMouseLeave={() => setHoverArm(null)}
              onClick={() => setPinnedArm((f) => (f === a ? null : a))}
              aria-pressed={pinned}
              title={pinned ? "Click to unpin" : "Click to keep this arm highlighted"}
              style={{
                display: "inline-block",
                margin: "0 0.35rem 0.35rem 0",
                padding: "0.18rem 0.55rem",
                borderRadius: 999,
                // Pinned reads stronger than a passing hover, so it is obvious
                // which state you are in once the pointer moves away.
                border: `1px solid ${pinned ? INK.primary : lit ? INK.secondary : AXIS}`,
                background: pinned ? "#2a4570" : lit ? "#1e3354" : "transparent",
                color: lit || pinned ? INK.primary : INK.muted,
                fontSize: "0.75rem",
                cursor: "pointer",
              }}
            >
              {a}
              {pinned ? " ×" : ""}
            </button>
          );
        })}
      </div>

      {showTable && (
        <div style={{ marginTop: "0.9rem", overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: "0.78rem", borderCollapse: "collapse", color: INK.secondary }}>
            <thead>
              <tr>
                {["Run", "Arm", ...CPS.map((c) => `cp${c}`), "cp1→last"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "0.25rem 0.45rem", borderBottom: `1px solid ${AXIS}`, color: INK.muted, fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {RUNS.flatMap((r) =>
                r.arms.map((a) => (
                  <tr key={`${r.id}-${a.arm}`}>
                    <td style={{ padding: "0.25rem 0.45rem" }}>{r.label}</td>
                    <td style={{ padding: "0.25rem 0.45rem" }}>{a.arm}</td>
                    {a.values.map((v, i) => <td key={i} style={{ padding: "0.25rem 0.45rem" }}>{v}</td>)}
                    <td style={{ padding: "0.25rem 0.45rem" }}>{a.cp1ToLast}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
