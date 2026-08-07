// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: cost-accuracy-chart-v1
// SWE-bench Pro resolve rate vs cost per problem, one dot per arm per run.
// Runs toggle independently (both / either / neither) so the reader can watch
// the whole July cloud sit above June's — that gap IS the model drift.
//
// Palette: reference categorical slots 1 (blue) and 2 (orange), dark steps,
// validated against this page's navy surface #101e33 —
//   node scripts/validate_palette.js "#3987e5,#d95926" --mode dark --surface "#101e33"
//   worst adjacent CVD dE 26.8 protan / 32.4 tritan, normal 31.8 — all checks pass.
// Runs are assigned in CHRONOLOGICAL order, never by rank, so adding August takes
// slot 3 and never repaints June or July.

import * as React from "react";

const MODULE_REVISION = "cost-accuracy-chart-v1";
if (typeof window !== "undefined") {
  console.log(`[cost-accuracy-chart] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

interface Point {
  arm: string;
  cost: number;
  resolve: number;
  /** Arm carries no skill — the pure model-drift reference. */
  isBaseline?: boolean;
  /** Render the label under the mark. Set where a neighbour's dot sits in the
   *  default label position (June's baseline and Karpathy are ~0.3pp apart). */
  labelBelow?: boolean;
}

interface RunSeries {
  id: string;
  label: string;
  color: string;
  points: Point[];
}

const RUNS: RunSeries[] = [
  {
    id: "jun",
    label: "June 2026",
    color: "#3987e5",
    points: [
      { arm: "OMC", cost: 0.54, resolve: 54.99 },
      { arm: "GSD", cost: 0.6, resolve: 54.45 },
      { arm: "Superpowers v5", cost: 0.48, resolve: 54.17 },
      { arm: "Karpathy", cost: 0.37, resolve: 53.08 },
      { arm: "baseline", cost: 0.38, resolve: 52.8, isBaseline: true, labelBelow: true },
    ],
  },
  {
    id: "jul",
    label: "July 2026",
    color: "#d95926",
    points: [
      { arm: "OMC", cost: 0.53, resolve: 57.2 },
      { arm: "Superpowers v6", cost: 0.46, resolve: 57.06 },
      { arm: "Karpathy", cost: 0.37, resolve: 56.52 },
      { arm: "baseline", cost: 0.37, resolve: 55.56, isBaseline: true },
      { arm: "GSD", cost: 0.61, resolve: 55.42 },
      { arm: "Agent Skills", cost: 0.52, resolve: 54.46 },
    ],
  },
];

// Ink tokens — text never wears the series color.
const INK = { primary: "#e8edf5", secondary: "#c3cee0", muted: "#94a3c0" };
const GRID = "#1e3354";
const AXIS = "#2a4570";
const SURFACE = "#101e33";

const W = 760;
const H = 460;
const M = { top: 28, right: 24, bottom: 52, left: 60 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

// Fixed domains so toggling a run never rescales the axes — the whole point is
// to compare positions between runs.
const X = [0.32, 0.66];
const Y = [52, 58];

const sx = (c: number) => M.left + ((c - X[0]) / (X[1] - X[0])) * PW;
const sy = (r: number) => M.top + PH - ((r - Y[0]) / (Y[1] - Y[0])) * PH;

const X_TICKS = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65];
const Y_TICKS = [52, 53, 54, 55, 56, 57, 58];

export function CostAccuracyChart() {
  const [on, setOn] = React.useState<Record<string, boolean>>({ jun: true, jul: true });
  const [hover, setHover] = React.useState<{ p: Point; run: RunSeries } | null>(null);
  const [showTable, setShowTable] = React.useState(false);

  const visible = RUNS.filter((r) => on[r.id]);
  const toggle = (id: string) => setOn((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <figure style={{ margin: "2rem 0" }}>
      {/* Filters in one row above the chart */}
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.75rem" }}>
        {RUNS.map((r) => {
          const active = on[r.id];
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => toggle(r.id)}
              aria-pressed={active}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.45rem",
                padding: "0.3rem 0.7rem",
                borderRadius: 999,
                border: `1px solid ${active ? r.color : AXIS}`,
                background: active ? `${r.color}1f` : "transparent",
                color: active ? INK.primary : INK.muted,
                fontSize: "0.8rem",
                cursor: "pointer",
                transition: "all 120ms",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: active ? r.color : "transparent",
                  border: `2px solid ${active ? r.color : INK.muted}`,
                }}
              />
              {r.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setShowTable((s) => !s)}
          style={{
            marginLeft: "auto",
            padding: "0.3rem 0.7rem",
            borderRadius: 999,
            border: `1px solid ${AXIS}`,
            background: "transparent",
            color: INK.muted,
            fontSize: "0.8rem",
            cursor: "pointer",
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
          aria-label={`Scatter plot of SWE-bench Pro resolve rate versus cost per problem for ${
            visible.map((r) => r.label).join(" and ") || "no runs selected"
          }. Higher cost does not buy higher accuracy.`}
          fontFamily="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        >
          {/* Recessive grid */}
          {Y_TICKS.map((t) => (
            <line key={`gy${t}`} x1={M.left} x2={M.left + PW} y1={sy(t)} y2={sy(t)} stroke={GRID} strokeWidth={1} />
          ))}
          {X_TICKS.map((t) => (
            <line key={`gx${t}`} y1={M.top} y2={M.top + PH} x1={sx(t)} x2={sx(t)} stroke={GRID} strokeWidth={1} />
          ))}

          {/* Axes */}
          <line x1={M.left} x2={M.left + PW} y1={M.top + PH} y2={M.top + PH} stroke={AXIS} strokeWidth={1} />
          <line x1={M.left} x2={M.left} y1={M.top} y2={M.top + PH} stroke={AXIS} strokeWidth={1} />

          {Y_TICKS.map((t) => (
            <text key={`ty${t}`} x={M.left - 10} y={sy(t) + 4} textAnchor="end" fontSize={11} fill={INK.muted}>
              {t}%
            </text>
          ))}
          {X_TICKS.map((t) => (
            <text key={`tx${t}`} x={sx(t)} y={M.top + PH + 20} textAnchor="middle" fontSize={11} fill={INK.muted}>
              ${t.toFixed(2)}
            </text>
          ))}

          <text x={M.left + PW / 2} y={H - 10} textAnchor="middle" fontSize={12} fill={INK.secondary}>
            Cost per problem
          </text>
          <text
            x={-(M.top + PH / 2)}
            y={16}
            transform="rotate(-90)"
            textAnchor="middle"
            fontSize={12}
            fill={INK.secondary}
          >
            Resolve rate
          </text>

          {/* Marks. Baseline gets a hollow ring as secondary encoding so it reads
              as the reference even for a CVD reader or in greyscale. */}
          {visible.map((run) =>
            run.points.map((p) => {
              const isHot = hover?.p === p;
              return (
                <g key={`${run.id}-${p.arm}`}>
                  <circle
                    cx={sx(p.cost)}
                    cy={sy(p.resolve)}
                    r={isHot ? 9 : 6.5}
                    fill={p.isBaseline ? SURFACE : run.color}
                    stroke={run.color}
                    strokeWidth={p.isBaseline ? 2.5 : 2}
                    // 2px surface ring keeps overlapping marks separable
                    paintOrder="stroke"
                    style={{ cursor: "pointer", transition: "r 100ms" }}
                    onMouseEnter={() => setHover({ p, run })}
                    onMouseLeave={() => setHover(null)}
                  />
                  <text
                    x={sx(p.cost)}
                    y={sy(p.resolve) + (p.labelBelow ? 20 : -12)}
                    textAnchor="middle"
                    fontSize={10.5}
                    fill={isHot ? INK.primary : INK.muted}
                    style={{ pointerEvents: "none" }}
                  >
                    {p.arm}
                  </text>
                </g>
              );
            })
          )}

          {visible.length === 0 && (
            <text x={M.left + PW / 2} y={M.top + PH / 2} textAnchor="middle" fontSize={13} fill={INK.muted}>
              Select a run above to plot it
            </text>
          )}
        </svg>

        {/* Hover tooltip */}
        {hover && (
          <div
            style={{
              position: "absolute",
              left: `${(sx(hover.p.cost) / W) * 100}%`,
              top: `${(sy(hover.p.resolve) / H) * 100}%`,
              transform: "translate(-50%, -140%)",
              pointerEvents: "none",
              background: "#0b1a2e",
              border: `1px solid ${hover.run.color}`,
              borderRadius: 6,
              padding: "0.4rem 0.6rem",
              fontSize: "0.75rem",
              color: INK.primary,
              whiteSpace: "nowrap",
              boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            }}
          >
            <strong>{hover.p.arm}</strong> · {hover.run.label}
            <br />
            {hover.p.resolve.toFixed(2)}% at ${hover.p.cost.toFixed(2)}/problem
          </div>
        )}
      </div>

      {/* Legend — always present for >= 2 series, identity never by color alone */}
      <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", marginTop: "0.6rem", fontSize: "0.78rem", color: INK.muted }}>
        {RUNS.map((r) => (
          <span key={r.id} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", opacity: on[r.id] ? 1 : 0.4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 999, background: r.color }} />
            {r.label}
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
          <span style={{ width: 10, height: 10, borderRadius: 999, background: SURFACE, border: `2px solid ${INK.muted}` }} />
          hollow = baseline (no skill)
        </span>
      </div>

      {showTable && (
        <div style={{ marginTop: "0.9rem", overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse", color: INK.secondary }}>
            <thead>
              <tr>
                {["Run", "Arm", "Resolve %", "$/problem"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "0.3rem 0.6rem", borderBottom: `1px solid ${AXIS}`, color: INK.muted, fontWeight: 500 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {RUNS.flatMap((r) =>
                r.points.map((p) => (
                  <tr key={`${r.id}-${p.arm}`}>
                    <td style={{ padding: "0.3rem 0.6rem" }}>{r.label}</td>
                    <td style={{ padding: "0.3rem 0.6rem" }}>{p.arm}</td>
                    <td style={{ padding: "0.3rem 0.6rem" }}>{p.resolve.toFixed(2)}%</td>
                    <td style={{ padding: "0.3rem 0.6rem" }}>${p.cost.toFixed(2)}</td>
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
