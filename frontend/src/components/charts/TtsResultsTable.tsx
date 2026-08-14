// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-results-table-v1
// The open-weight TTS comparison: 18 configurations x 18 columns, each row
// playable so the reader can hear the engine that produced the numbers.
//
// Playback goes through Web Audio rather than an <audio> element, matching the
// original export. Two reasons, both learned the hard way there:
//   - "canplaythrough" is a heuristic about download rate, so playback could
//     begin while the MP3 was still decoding and swallow the first word. For a
//     speech benchmark that is disqualifying. decodeAudioData resolves only once
//     the whole clip is PCM in memory, so a source that has started is
//     guaranteed to have every sample.
//   - macOS powers the output device down when idle and the first sound after
//     that loses a couple of hundred ms, below the browser and unaffected by
//     decoding early. A silent buffer pushed on first interaction wakes it.

import * as React from "react";
import run from "@/data/benchmarks/open-weight-tts/2026-08.json";

const MODULE_REVISION = "tts-results-table-v1";
if (typeof window !== "undefined") {
  console.log(`[tts-results-table] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

interface Cell { v: string; sort: string; tone: string; align: string }
interface Row { config: string; group: string; sample: string; cells: Cell[] }

const ROWS = run.rows as Row[];
const COLUMNS = run.columns as string[];
const AUDIO_BASE = "/benchmarks/tts/";

const INK = { primary: "#e8edf5", secondary: "#c3cee0", muted: "#94a3c0" };
const AXIS = "#2a4570";
const TONE: Record<string, string> = { good: "#6ee7a8", bad: "#f0908a", warn: "#e0b25e" };

/** Sort key from the precomputed data-sort value; numeric when it parses. */
function keyOf(c: Cell | undefined): number | string {
  const raw = (c?.sort ?? "").trim();
  if (raw === "") return "";
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw.toLowerCase();
}

export function TtsResultsTable() {
  const [sort, setSort] = React.useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const [playing, setPlaying] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<string | null>(null);

  const ctxRef = React.useRef<AudioContext | null>(null);
  const cacheRef = React.useRef<Map<string, AudioBuffer>>(new Map());
  const currentRef = React.useRef<AudioBufferSourceNode | null>(null);
  const primedRef = React.useRef(false);
  const warmedRef = React.useRef(false);

  const ctx = React.useCallback(() => {
    if (!ctxRef.current) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new AC();
    }
    return ctxRef.current;
  }, []);

  /** Wake the output device with a short silence so the first clip is not clipped. */
  const primeDevice = React.useCallback(() => {
    if (primedRef.current) return;
    const ac = ctx();
    const push = () => {
      // Only counts as primed once really running: a hover is not a user
      // gesture, so resume() can be refused there and the click should retry.
      if (primedRef.current || ac.state !== "running") return;
      primedRef.current = true;
      const s = ac.createBufferSource();
      s.buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * 0.5), ac.sampleRate);
      s.connect(ac.destination);
      s.start();
    };
    if (ac.state === "suspended") void ac.resume().then(push).catch(() => {});
    else push();
  }, [ctx]);

  const decode = React.useCallback(
    async (file: string): Promise<AudioBuffer> => {
      const hit = cacheRef.current.get(file);
      if (hit) return hit;
      const res = await fetch(AUDIO_BASE + file);
      const buf = await ctx().decodeAudioData(await res.arrayBuffer());
      cacheRef.current.set(file, buf);
      return buf;
    },
    [ctx]
  );

  const stop = React.useCallback(() => {
    const src = currentRef.current;
    currentRef.current = null;
    if (src) {
      src.onended = null;
      try { src.stop(); } catch { /* already ended */ }
    }
    setPlaying(null);
  }, []);

  // Once one clip is decoded the context is live, so warm the rest while idle
  // and no other row pays the decode cost on its first click either.
  const warmAll = React.useCallback(() => {
    if (warmedRef.current) return;
    warmedRef.current = true;
    const idle: (cb: () => void) => void =
      (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ??
      ((cb) => window.setTimeout(cb, 300) as unknown as void);
    idle(() => { ROWS.forEach((r) => { void decode(r.sample).catch(() => {}); }); });
  }, [decode]);

  const play = React.useCallback(
    async (row: Row) => {
      primeDevice();
      if (playing === row.config) { stop(); return; }
      stop();
      setLoading(row.config);
      try {
        const buf = await decode(row.sample);
        const src = ctx().createBufferSource();
        src.buffer = buf;
        src.connect(ctx().destination);
        src.onended = () => { if (currentRef.current === src) { currentRef.current = null; setPlaying(null); } };
        currentRef.current = src;
        src.start();
        setPlaying(row.config);
        warmAll();
      } catch {
        setPlaying(null);
      } finally {
        setLoading(null);
      }
    },
    [ctx, decode, playing, primeDevice, stop, warmAll]
  );

  React.useEffect(() => () => { try { currentRef.current?.stop(); } catch {} void ctxRef.current?.close(); }, []);

  const rows = React.useMemo(() => {
    const indexed = ROWS.map((r, i) => ({ r, i }));
    if (!sort) return indexed;
    return [...indexed].sort((a, b) => {
      const ka = keyOf(a.r.cells[sort.col]);
      const kb = keyOf(b.r.cells[sort.col]);
      const cmp = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [sort]);

  const onHeader = (col: number) =>
    setSort((s) => {
      const numeric = typeof keyOf(ROWS[0]?.cells[col]) === "number";
      if (!s || s.col !== col) return { col, dir: numeric ? "asc" : "asc" };
      if (s.dir === "asc") return { col, dir: "desc" };
      return null;
    });

  const th: React.CSSProperties = {
    // Deliberately not sticky. A sticky header overlays the rows scrolled under
    // it, which swallows clicks on the play buttons; 18 rows nearly fit one
    // screen, so it was cost without benefit.
    padding: 0, whiteSpace: "nowrap",
    background: "var(--background-elevated)", borderBottom: `2px solid ${AXIS}`,
  };

  return (
    <figure style={{ margin: "2rem 0" }}>
      <div style={{ overflowX: "auto", maxWidth: "100%", border: `1px solid ${AXIS}`, borderRadius: 8 }}>
        <table style={{ width: "100%", fontSize: "0.78rem", borderCollapse: "collapse", color: INK.secondary }}>
          <thead>
            <tr>
              {COLUMNS.map((c, i) => {
                const active = sort?.col === i;
                return (
                  <th key={c} style={th} aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}>
                    <button
                      type="button"
                      onClick={() => onHeader(i)}
                      title="Sort by this column"
                      style={{
                        font: "inherit", color: active ? INK.primary : INK.muted, background: "none",
                        border: "none", padding: "0.5rem 0.6rem", width: "100%", textAlign: i === 0 ? "left" : "right",
                        cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap",
                      }}
                    >
                      {c}
                      <span aria-hidden="true" style={{ opacity: active ? 0.95 : 0.3, marginLeft: "0.25rem" }}>
                        {active ? (sort!.dir === "asc" ? "▲" : "▼") : "⇅"}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ r }) => {
              const isPlaying = playing === r.config;
              const isLoading = loading === r.config;
              return (
                <tr
                  key={r.config}
                  style={{
                    // The NeuTTS band: one backbone crossed with every device it runs on.
                    background: r.group ? "rgba(57,135,229,0.07)" : undefined,
                    borderBottom: `1px solid ${AXIS}`,
                  }}
                >
                  {r.cells.map((c, ci) => (
                    <td
                      key={ci}
                      style={{
                        padding: "0.35rem 0.6rem",
                        textAlign: ci === 0 || c.align === "left" ? "left" : "right",
                        color: c.tone ? TONE[c.tone] ?? INK.secondary : INK.secondary,
                        whiteSpace: ci === COLUMNS.length - 1 ? "normal" : "nowrap",
                        minWidth: ci === COLUMNS.length - 1 ? 220 : undefined,
                      }}
                    >
                      {ci === 0 ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
                          <button
                            type="button"
                            onClick={() => void play(r)}
                            onPointerEnter={primeDevice}
                            aria-label={`${isPlaying ? "Stop" : "Play"} ${r.config} sample`}
                            style={{
                              width: 22, height: 22, flexShrink: 0, borderRadius: 999, cursor: "pointer",
                              border: `1px solid ${isPlaying ? "#d95926" : AXIS}`,
                              background: isPlaying ? "#d95926" : "transparent",
                              color: isPlaying ? "#fff" : INK.muted,
                              display: "inline-flex", alignItems: "center", justifyContent: "center",
                              fontSize: "0.6rem", lineHeight: 1, padding: 0,
                            }}
                          >
                            <span aria-hidden="true">{isLoading ? "…" : isPlaying ? "■" : "▶"}</span>
                          </button>
                          <span style={{ color: INK.primary }}>{c.v}</span>
                        </span>
                      ) : (
                        c.v
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {run.caption && (
        <figcaption style={{ marginTop: "0.6rem", fontSize: "0.78rem", color: INK.muted }}>{run.caption}</figcaption>
      )}
    </figure>
  );
}
