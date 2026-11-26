// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: pokerbench-chart-v4-series-3
// The PokerBench headline: bb/100 per model over every series so far, as a bar chart in the
// style of a model-release benchmark chart, with the 95% range as a thin whisker
// (togglable) because most of the field overlaps zero and the chart must not hide it.
//
// Color = the model's maker (identity), never its rank. Reference categorical slots
// 1-3, dark steps, validated all-pairs against this page's navy surface #101e33:
//   node scripts/validate_palette.js "#3987e5,#d95926,#199e70" --mode dark --surface "#101e33" --pairs all
//   all checks pass (worst CVD dE 9.4 deutan; tritan 4.0 aqua/orange, so identity is also
//   carried by the maker name under every bar).

import * as React from "react";
import { POKERBENCH_STATE_URL } from "./PokerBenchLive";

const MODULE_REVISION = "pokerbench-chart-v4-series-3";
if (typeof window !== "undefined") {
  console.log(`[pokerbench-chart] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

type Maker = "Anthropic" | "OpenAI" | "Google";
const MAKERS: { id: Maker; color: string }[] = [
  { id: "Anthropic", color: "#d95926" },
  { id: "OpenAI", color: "#199e70" },
  { id: "Google", color: "#3987e5" },
];
const COLOR: Record<Maker, string> = Object.fromEntries(MAKERS.map((m) => [m.id, m.color])) as Record<Maker, string>;

interface Row {
  family: string; // first label line, e.g. "GPT-6.2"
  name: string; // second label line, e.g. "Astra"
  maker: Maker;
  bb: number;
  lo: number;
  hi: number;
  s1: number;
  s2: number;
  s3: number;
  note?: string;
}

// Series 1-3 combined (30 games, 3,000 hands per model, duplicate-deal bootstrap).
const ROWS: Row[] = [
  { family: "GPT-6.2", name: "Astra", maker: "OpenAI", bb: 65.4, lo: 36.1, hi: 98.5, s1: 51.1, s2: 52.3, s3: 92.7 },
  { family: "GPT-6.1", name: "Terra", maker: "OpenAI", bb: 14.7, lo: -4.2, hi: 34.3, s1: 35.4, s2: 26.2, s3: -17.4 },
  { family: "Claude", name: "Fable 5.2", maker: "Anthropic", bb: 12.1, lo: -7.7, hi: 34.2, s1: 12.4, s2: 15.2, s3: 8.7 },
  { family: "Gemini 4", name: "Hydrogen", maker: "Google", bb: 6.8, lo: -12.2, hi: 26.0, s1: -14.6, s2: 16.4, s3: 18.6 },
  { family: "Gemini 4", name: "Neon", maker: "Google", bb: 5.0, lo: -15.9, hi: 25.2, s1: 13.1, s2: -14.0, s3: 15.9, note: "high effort" },
  { family: "GPT-6.2", name: "Sol", maker: "OpenAI", bb: 0.5, lo: -21.4, hi: 22.3, s1: 8.0, s2: -1.0, s3: -5.6 },
  { family: "Gemini 4", name: "Argon", maker: "Google", bb: -4.2, lo: -25.1, hi: 16.8, s1: -6.1, s2: -16.7, s3: 10.0 },
  { family: "Claude", name: "Sonnet 5.5", maker: "Anthropic", bb: -21.4, lo: -55.1, hi: 10.5, s1: -42.5, s2: -17.4, s3: -4.3 },
  { family: "Claude", name: "Opus 5.5", maker: "Anthropic", bb: -23.8, lo: -52.6, hi: 4.8, s1: -43.2, s2: -15.7, s3: -12.4 },
  { family: "Claude", name: "Haiku 5.5", maker: "Anthropic", bb: -55.1, lo: -91.5, hi: -19.8, s1: -13.8, s2: -45.4, s3: -106.2 },
];

// Progress towards the benchmark's target. The relay counts every hand per model played
// in finished series games (pokerbench/relay.py, results_progress); the game in play adds
// its hands so far. SCORED_HANDS is what the bars above are built from: update it with ROWS.
const TARGET_HANDS = 10_000;
const SCORED_HANDS = 3_000;
const LIVE_RED = "#e66767";

interface Live {
  live: boolean;
  /** Hands per model played so far (null: the live table can't be reached). */
  played: number | null;
  detail: string | null;
}

/** The live table's latest snapshot, every 30s: is a game running, and how far along. */
function useLiveTable(): Live {
  const [state, setState] = React.useState<Live>({ live: false, played: null, detail: null });
  React.useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch(POKERBENCH_STATE_URL, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const s = await res.json();
        const asOf = Date.parse(s.relay?.as_of ?? "");
        // Live: a game running or about to start, in a snapshot from the last 10 minutes
        // (the relay sends one every couple of seconds while a game runs).
        const fresh = Number.isFinite(asOf) && Date.now() - asOf < 10 * 60_000 + (s.relay?.delay_s ?? 0) * 1000;
        const live = fresh && (s.status === "running" || s.status === "waiting_for_players");
        const finished = typeof s.progress?.hands === "number" ? s.progress.hands : null;
        // A running game's hands aren't in the results yet; a finished one's already are.
        const played = finished === null ? null : finished + (s.status === "running" ? s.hands_played ?? 0 : 0);
        const sr = s.series;
        const detail = live && sr ? `game ${sr.game + 1} of ${sr.games} under way` : null;
        if (!stop) setState({ live, played, detail });
      } catch {
        if (!stop) setState({ live: false, played: null, detail: null });
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  return state;
}

// Ink tokens: text never wears the series color.
const INK = { primary: "#e8edf5", secondary: "#c3cee0", muted: "#94a3c0" };
const GRID = "#1e3354";
const AXIS = "#2a4570";
const SURFACE = "#101e33";

const W = 760;
const H = 440;
const M = { top: 30, right: 16, bottom: 58, left: 48 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;
const Y = [-100, 100];
const Y_TICKS = [-100, -75, -50, -25, 0, 25, 50, 75, 100];
const BAND = PW / ROWS.length;
const BAR = 38;

const sy = (v: number) => M.top + ((Y[1] - v) / (Y[1] - Y[0])) * PH;
const cx = (i: number) => M.left + BAND * i + BAND / 2;
const fmt = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;

/** A bar from the zero line to v, with the 4px rounding on its data end only. */
function barPath(x: number, v: number): string {
  const y0 = sy(0), y1 = sy(v), r = Math.min(4, Math.abs(y1 - y0));
  const l = x - BAR / 2, rt = x + BAR / 2;
  if (v >= 0) {
    return `M${l},${y0} V${y1 + r} Q${l},${y1} ${l + r},${y1} H${rt - r} Q${rt},${y1} ${rt},${y1 + r} V${y0} Z`;
  }
  return `M${l},${y0} V${y1 - r} Q${l},${y1} ${l + r},${y1} H${rt - r} Q${rt},${y1} ${rt},${y1 - r} V${y0} Z`;
}

export function PokerBenchChart() {
  const [showRange, setShowRange] = React.useState(true);
  const [hover, setHover] = React.useState<number | null>(null);
  const [showTable, setShowTable] = React.useState(false);
  const pill = (active: boolean): React.CSSProperties => ({
    padding: "0.3rem 0.7rem",
    borderRadius: 999,
    border: `1px solid ${AXIS}`,
    background: active ? "#1e3354" : "transparent",
    color: active ? INK.primary : INK.muted,
    fontSize: "0.8rem",
    cursor: "pointer",
  });
  const h = hover === null ? null : ROWS[hover];
  const live = useLiveTable();
  const done = Math.min(TARGET_HANDS, Math.max(SCORED_HANDS, live.played ?? SCORED_HANDS));
  const unscored = done - SCORED_HANDS;
  const pct = (n: number) => `${(100 * n) / TARGET_HANDS}%`;

  return (
    <figure style={{ margin: "1.5rem 0 2.5rem" }}>
      <style>{`@keyframes pokerbench-live-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
        @media (prefers-reduced-motion: reduce) { .pokerbench-live-dot { animation: none !important } }`}</style>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.2rem" }}>
        <span style={{ fontSize: "1.15rem", fontWeight: 700, color: INK.primary, letterSpacing: "-0.01em" }}>PokerBench</span>
        {/* LIVE: highlighted only while the table is actually playing (or about to). */}
        <span
          title={live.live ? "A game is being played now: watch it below, two minutes behind." : "No game is being played right now."}
          style={{
            display: "inline-flex", alignItems: "center", gap: "0.35rem", padding: "0.12rem 0.55rem",
            borderRadius: 999, fontSize: "0.72rem", fontWeight: 800, letterSpacing: "0.12em",
            color: live.live ? "#fff" : INK.muted,
            background: live.live ? LIVE_RED : "transparent",
            border: `1px solid ${live.live ? LIVE_RED : AXIS}`,
          }}
        >
          <span
            className="pokerbench-live-dot"
            aria-hidden="true"
            style={{
              width: 7, height: 7, borderRadius: 999, background: live.live ? "#fff" : INK.muted,
              animation: live.live ? "pokerbench-live-pulse 1.6s ease-in-out infinite" : undefined,
            }}
          />
          LIVE
        </span>
        <span style={{ fontSize: "0.85rem", color: INK.secondary }}>No-limit hold&apos;em, 10 models at one table</span>
      </div>

      {/* Progress to the target: scored hands solid, the series being played lighter. */}
      <div style={{ margin: "0.55rem 0 0.7rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", fontSize: "0.78rem", color: INK.secondary, marginBottom: "0.3rem", flexWrap: "wrap" }}>
          <span>
            <strong style={{ color: INK.primary }}>{done.toLocaleString("en-US")}</strong> of {TARGET_HANDS.toLocaleString("en-US")} hands per model
            {unscored > 0 && (
              <span style={{ color: INK.muted }}>
                {" "}· {SCORED_HANDS.toLocaleString("en-US")} scored, {unscored.toLocaleString("en-US")} still to score
                {live.detail ? ` (${live.detail})` : ""}
              </span>
            )}
          </span>
          <span style={{ color: INK.muted }}>{Math.round((100 * done) / TARGET_HANDS)}%</span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={TARGET_HANDS}
          aria-valuenow={done}
          aria-label="Hands played per model"
          style={{ position: "relative", height: 8, borderRadius: 999, background: GRID, overflow: "hidden" }}
        >
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: pct(SCORED_HANDS), background: INK.secondary, borderRadius: 999 }} />
          {unscored > 0 && (
            <div
              style={{
                position: "absolute", top: 0, bottom: 0, left: `calc(${pct(SCORED_HANDS)} + 2px)`,
                width: `calc(${pct(unscored)} - 2px)`,
                background: INK.secondary, opacity: 0.4, borderRadius: "0 999px 999px 0",
              }}
            />
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.6rem" }}>
        <span style={{ fontSize: "0.78rem", color: INK.muted }}>
          Big blinds won per 100 hands · 3,000 hands each · higher is better
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
          <button type="button" aria-pressed={showRange} onClick={() => setShowRange((s) => !s)} style={pill(showRange)}>
            95% range
          </button>
          <button type="button" aria-pressed={showTable} onClick={() => setShowTable((s) => !s)} style={pill(showTable)}>
            {showTable ? "Hide data" : "View data"}
          </button>
        </span>
      </div>

      <div style={{ position: "relative", overflowX: "auto" }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          style={{ display: "block", background: SURFACE, borderRadius: 8, minWidth: 560 }}
          role="img"
          aria-label={`Bar chart of big blinds won per 100 hands. ${ROWS.map((r) => `${r.family} ${r.name} ${fmt(r.bb)}`).join(", ")}.`}
          fontFamily="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        >
          {Y_TICKS.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + PW} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? AXIS : GRID} strokeWidth={t === 0 ? 1.5 : 1} />
              <text x={M.left - 8} y={sy(t) + 4} textAnchor="end" fontSize={11} fill={INK.muted}>
                {t > 0 ? `+${t}` : t < 0 ? `−${-t}` : "0"}
              </text>
            </g>
          ))}

          {ROWS.map((r, i) => {
            const x = cx(i), hot = hover === i, dim = hover !== null && !hot;
            const up = r.bb >= 0;
            // Value label just beyond the bar's end. A surface-coloured halo cuts the
            // whisker behind it, so the label stays next to its bar and readable.
            const ly = up ? sy(r.bb) - 8 : sy(r.bb) + 17;
            return (
              <g key={r.name} opacity={dim ? 0.45 : 1} style={{ transition: "opacity 120ms" }}>
                {/* Hit target: the whole band, bigger than the mark. */}
                <rect
                  x={x - BAND / 2}
                  y={M.top}
                  width={BAND}
                  height={PH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: "pointer" }}
                />
                <path d={barPath(x, r.bb)} fill={COLOR[r.maker]} style={{ pointerEvents: "none" }} />
                {showRange && (
                  <g stroke={INK.secondary} strokeWidth={1.25} style={{ pointerEvents: "none" }} opacity={0.5}>
                    <line x1={x} x2={x} y1={sy(r.lo)} y2={sy(r.hi)} />
                    <line x1={x - 6} x2={x + 6} y1={sy(r.lo)} y2={sy(r.lo)} />
                    <line x1={x - 6} x2={x + 6} y1={sy(r.hi)} y2={sy(r.hi)} />
                  </g>
                )}
                <text x={x} y={ly} textAnchor="middle" fontSize={13} fontWeight={700} fill={INK.primary}
                  stroke={SURFACE} strokeWidth={5} paintOrder="stroke" strokeLinejoin="round" style={{ pointerEvents: "none" }}>
                  {fmt(r.bb)}
                </text>
                <text x={x} y={M.top + PH + 22} textAnchor="middle" fontSize={11} fill={INK.muted} style={{ pointerEvents: "none" }}>
                  {r.family}
                </text>
                <text x={x} y={M.top + PH + 38} textAnchor="middle" fontSize={12} fontWeight={600} fill={hot ? INK.primary : INK.secondary} style={{ pointerEvents: "none" }}>
                  {r.name}
                </text>
              </g>
            );
          })}
        </svg>

        {h && hover !== null && (
          <div
            style={{
              position: "absolute",
              left: `${(cx(hover) / W) * 100}%`,
              top: `${(sy(Math.max(h.hi, 0)) / H) * 100}%`,
              transform: `translate(${hover > 6 ? "-90%" : hover < 2 ? "-10%" : "-50%"}, -115%)`,
              pointerEvents: "none",
              background: "#0b1a2e",
              border: `1px solid ${COLOR[h.maker]}`,
              borderRadius: 6,
              padding: "0.45rem 0.65rem",
              fontSize: "0.75rem",
              color: INK.primary,
              whiteSpace: "nowrap",
              boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            }}
          >
            <strong>
              {h.family} {h.name}
            </strong>{" "}
            <span style={{ color: INK.muted }}>
              · {h.maker}
              {h.note ? ` · ${h.note}` : ""}
            </span>
            <br />
            {fmt(h.bb)} bb/100 · 95% range {fmt(h.lo)} to {fmt(h.hi)}
            <br />
            <span style={{ color: INK.secondary }}>
              Series 1 {fmt(h.s1)} · Series 2 {fmt(h.s2)} · Series 3 {fmt(h.s3)}
            </span>
          </div>
        )}
      </div>

      {/* Legend: color = maker; the maker is also named under every bar. */}
      <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", marginTop: "0.6rem", fontSize: "0.78rem", color: INK.muted }}>
        {MAKERS.map((m) => (
          <span key={m.id} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: m.color }} />
            {m.id}
          </span>
        ))}
        {showRange && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
            <span style={{ width: 2, height: 12, background: INK.secondary, opacity: 0.5 }} />
            95% confidence range
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>All medium reasoning effort except Gemini 4 Neon (high)</span>
      </div>

      {showTable && (
        <div style={{ marginTop: "0.9rem", overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse", color: INK.secondary }}>
            <thead>
              <tr>
                {["Model", "Maker", "bb/100", "95% range", "Series 1", "Series 2", "Series 3"].map((c) => (
                  <th key={c} style={{ textAlign: "left", padding: "0.3rem 0.6rem", borderBottom: `1px solid ${AXIS}`, color: INK.muted, fontWeight: 500 }}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.name}>
                  <td style={{ padding: "0.3rem 0.6rem" }}>
                    {r.family} {r.name}
                  </td>
                  <td style={{ padding: "0.3rem 0.6rem" }}>{r.maker}</td>
                  <td style={{ padding: "0.3rem 0.6rem" }}>{fmt(r.bb)}</td>
                  <td style={{ padding: "0.3rem 0.6rem" }}>
                    {fmt(r.lo)} to {fmt(r.hi)}
                  </td>
                  <td style={{ padding: "0.3rem 0.6rem" }}>{fmt(r.s1)}</td>
                  <td style={{ padding: "0.3rem 0.6rem" }}>{fmt(r.s2)}</td>
                  <td style={{ padding: "0.3rem 0.6rem" }}>{fmt(r.s3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
