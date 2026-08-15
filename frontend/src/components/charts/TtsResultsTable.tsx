// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-results-table-v2-human-column
// The open-weight TTS comparison: every configuration that keeps pace with real
// time, and every row playable so the reader can hear the engine that produced
// the numbers.
//
// The Human column is the one number here that is not measured on my machine.
// Word error rate saturates once speech is merely intelligible, so it cannot
// separate the engines that are actually sold on naturalness; the column is fed
// by readers ranking four blind clips (see TtsPreferenceDialog) and aggregated
// server-side with Bradley-Terry. It is live, so it changes under the reader.

import * as React from "react";
import run from "@/data/benchmarks/open-weight-tts/2026-08.json";
import { TtsPreferenceDialog } from "./TtsPreferenceDialog";
import { useSamplePlayer } from "./useSamplePlayer";
import { useTtsScores } from "./useTtsScores";

const MODULE_REVISION = "tts-results-table-v2-human-column";
if (typeof window !== "undefined") {
  console.log(`[tts-results-table] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

interface Cell { v: string; sort: string; tone: string; align: string }
interface Row { config: string; display: string; group: string; sample: string | null; cells: Cell[] }

const ROWS = run.rows as Row[];
const AUDIO_BASE = "/benchmarks/tts/";

/** Real-time filter. Every configuration is listed by default, including the
 *  ones that cannot keep up with their own speech, because "how far off is it"
 *  is a real question and a table that silently omits the answer cannot be
 *  checked. The filter is opt-in for readers who only care about what can be
 *  spoken live. */
const RTF_COL = run.columns.indexOf("RTF");
const RTF_CUTOFF = run.rtfCutoff;
const rtfOf = (r: Row) => Number(r.cells[RTF_COL].sort);
const WITHIN_CUTOFF = ROWS.filter((r) => rtfOf(r) <= RTF_CUTOFF).length;

/** The Human column is spliced in here, right after the engine name, so the
 *  live number is visible without scrolling the table sideways. */
const HUMAN_COL = 1;
const COLUMNS: string[] = [run.columns[0], "Human", ...run.columns.slice(1)];

/** Opening sort: compute per phrase, cheapest first. Word error was the old
 *  default, but it saturates once speech is intelligible and two engines have no
 *  score under the stronger transcriber, so it is a poor way to meet the table.
 *  Cost per phrase is the axis every reader is actually shopping on. */
const DEFAULT_SORT = { col: COLUMNS.indexOf("Avg synth"), dir: "asc" as const };

/** The full table measures 1806px; past that, extra width is dead space.
 *  Re-measure if columns change. */
const MAX_TABLE_WIDTH = 1820;

/** Remembers that this reader has already been asked, so they are asked once. */
const BALLOT_KEY = "orcabot.tts.ballot.v1";

const INK = { primary: "#e8edf5", secondary: "#c3cee0", muted: "#94a3c0" };
const AXIS = "#2a4570";
const ACCENT = "#d95926";
const TONE: Record<string, string> = { good: "#6ee7a8", bad: "#f0908a", warn: "#e0b25e" };

const SAMPLE_OF = new Map(ROWS.map((r) => [r.config, r.sample]));
const NAME_OF = new Map(ROWS.map((r) => [r.config, r.display]));

/** Sort key from the precomputed data-sort value; numeric when it parses. */
function keyOf(c: Cell | undefined): number | string {
  const raw = (c?.sort ?? "").trim();
  if (raw === "") return "";
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw.toLowerCase();
}

function askedBefore(): boolean {
  try { return window.localStorage.getItem(BALLOT_KEY) !== null; } catch { return true; }
}
function rememberAsked(outcome: "submitted" | "skipped") {
  try { window.localStorage.setItem(BALLOT_KEY, outcome); } catch { /* private mode */ }
}

export function TtsResultsTable() {
  const figRef = React.useRef<HTMLElement>(null);
  const [overhang, setOverhang] = React.useState(0);
  React.useEffect(() => {
    const measure = () => {
      const parent = figRef.current?.parentElement;
      if (!parent) return;
      const left = parent.getBoundingClientRect().left;
      const avail = document.documentElement.clientWidth - left - 24; // 24px right gutter
      setOverhang(Math.max(0, Math.min(MAX_TABLE_WIDTH, avail) - parent.clientWidth));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const [sort, setSort] = React.useState<{ col: number; dir: "asc" | "desc" } | null>(DEFAULT_SORT);
  const [realtimeOnly, setRealtimeOnly] = React.useState(false);
  const [showBallot, setShowBallot] = React.useState(false);
  const pendingRef = React.useRef<Row | null>(null);
  const player = useSamplePlayer(AUDIO_BASE);

  // Live human ratings, shared with the preference chart. Failure is silent by
  // design: the column falls back to em-dashes and the other seventeen columns
  // are unaffected.
  const { ratings, minBallots, reload: loadScores } = useTtsScores();

  /** Splice the live rating in as a real cell so sorting needs no special case. */
  const rows = React.useMemo(() => {
    const visible = realtimeOnly ? ROWS.filter((r) => rtfOf(r) <= RTF_CUTOFF) : ROWS;
    const withHuman = visible.map((r) => {
      const rating = ratings.get(r.config);
      const human: Cell =
        rating == null
          ? { v: "—", sort: "", tone: "", align: "" }
          : { v: rating.toFixed(1), sort: String(rating), tone: "", align: "" };
      return { ...r, cells: [r.cells[0], human, ...r.cells.slice(1)] };
    });
    if (!sort) return withHuman;
    return [...withHuman].sort((a, b) => {
      const ka = keyOf(a.cells[sort.col]);
      const kb = keyOf(b.cells[sort.col]);
      // Missing values sink in both directions. Sorting by Human early on would
      // otherwise just float the un-rated engines to the top.
      const ea = ka === "", eb = kb === "";
      if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1;
      const cmp =
        typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [ratings, realtimeOnly, sort]);

  // asc -> desc -> back to the default, never to "unsorted". Unsorted rendered
  // the export's own row order, which is neither the default the reader arrived
  // at nor meaningful in itself, so a third click silently swapped the table
  // into an order nothing on the page explains.
  const onHeader = (col: number) =>
    setSort((s) => {
      if (!s || s.col !== col) return { col, dir: "asc" };
      if (s.dir === "asc") return { col, dir: "desc" };
      return DEFAULT_SORT;
    });

  const playRow = React.useCallback(
    (r: Row) => { if (r.sample) void player.toggle(r.config, r.sample); },
    [player]
  );

  /** First play is the moment the reader has opted into listening, so it is the
   *  one place a ranking request is not an interruption. Asked once, ever. */
  const onPlayClick = (r: Row) => {
    if (!r.sample) return;
    if (!showBallot && !askedBefore() && player.playing !== r.config) {
      pendingRef.current = r;
      setShowBallot(true);
      return;
    }
    playRow(r);
  };

  const closeBallot = (submitted: boolean) => {
    rememberAsked(submitted ? "submitted" : "skipped");
    setShowBallot(false);
    if (submitted) loadScores();
  };

  // Honour the click that opened the dialog, so the reader lands where they were
  // headed rather than having to press the same button twice. This waits for the
  // dialog to actually unmount: starting the clip inside the close handler races
  // the dialog's own teardown, which stops whatever is sounding and would kill
  // the clip a moment after it began.
  React.useEffect(() => {
    if (showBallot) return;
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    player.warm(ROWS.map((r) => r.sample).filter((s): s is string => !!s));
    playRow(pending);
  }, [showBallot, player, playRow]);

  const th: React.CSSProperties = {
    // Deliberately not sticky. A sticky header overlays the rows scrolled under
    // it, which swallows clicks on the play buttons; the rows nearly fit one
    // screen, so it was cost without benefit.
    padding: 0, whiteSpace: "nowrap",
    background: "var(--background-elevated)", borderBottom: `2px solid ${AXIS}`,
  };

  const humanHelp =
    minBallots == null
      ? "Reader preference, pooled from blind four-way rankings."
      : `Reader preference from blind four-way rankings, 0-100. Shown once an engine has ${minBallots} ballots.`;

  return (
    <>
      <figure
        ref={figRef}
        style={{
          margin: "2rem 0",
          // The table will not fit a column sized for prose, so it
          // widens past the article, rightwards into the empty gutter.
          //
          // Two things this deliberately is NOT. Not the usual 50%/50vw
          // negative-margin trick: that assumes the container is centred in the
          // viewport, and this one is pushed right by the TOC sidebar, so the
          // figure hung off the right edge. And not an explicit `width` either —
          // a fixed width raises the article grid track's min-content size, which
          // grows the whole two-column layout and scrolls the page sideways even
          // though the figure's own box fits. A negative right margin buys the
          // same pixels while *reducing* the intrinsic contribution, so the track
          // never grows and there is no feedback loop with the measurement.
          marginRight: overhang ? `-${overhang}px` : undefined,
          // Without this the page scrolls sideways by a constant 1288px at every
          // viewport, which is the table's *min-content* width leaking up into the
          // article grid track: the inner scroll container clips what you see, but
          // the track still sizes itself to fit the table unclipped. `clip` makes
          // the figure itself an intrinsic-size boundary and stops the leak. It has
          // to be `clip` rather than `hidden` — `hidden` would force the vertical
          // axis to scroll too, cutting the figure off inside the article.
          overflowX: "clip",
        }}
      >
        <div
          style={{
            display: "flex", alignItems: "center", gap: "0.6rem",
            flexWrap: "wrap", marginBottom: "0.6rem", fontSize: "0.8rem",
          }}
        >
          <button
            type="button"
            onClick={() => setRealtimeOnly((v) => !v)}
            aria-pressed={realtimeOnly}
            style={{
              font: "inherit", fontWeight: 600, padding: "0.3rem 0.7rem", borderRadius: 999,
              cursor: "pointer",
              border: `1px solid ${realtimeOnly ? ACCENT : AXIS}`,
              background: realtimeOnly ? `${ACCENT}1f` : "transparent",
              color: realtimeOnly ? INK.primary : INK.muted,
            }}
          >
            <span aria-hidden="true" style={{ marginRight: "0.4rem" }}>{realtimeOnly ? "☑" : "☐"}</span>
            Real time only (under {RTF_CUTOFF}×)
          </button>
          <span style={{ color: INK.muted }} aria-live="polite">
            {realtimeOnly
              ? `${WITHIN_CUTOFF} of ${ROWS.length} configurations`
              : `${ROWS.length} configurations`}
          </span>
        </div>

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
                        title={i === HUMAN_COL ? humanHelp : "Sort by this column"}
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
              {rows.map((r) => {
                const isPlaying = player.playing === r.config;
                const isLoading = player.loading === r.config;
                return (
                  <tr
                    key={r.config}
                    style={{
                      // The NeuTTS band: one backbone crossed with every
                      // precision and device it was measured on.
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
                          color:
                            ci === HUMAN_COL
                              ? c.sort ? INK.primary : INK.muted
                              : c.tone ? TONE[c.tone] ?? INK.secondary : INK.secondary,
                          whiteSpace: ci === COLUMNS.length - 1 ? "normal" : "nowrap",
                          minWidth: ci === COLUMNS.length - 1 ? 220 : undefined,
                          fontWeight: ci === HUMAN_COL && c.sort ? 600 : undefined,
                        }}
                      >
                        {ci === 0 ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
                            <button
                              type="button"
                              disabled={!r.sample}
                              onClick={() => onPlayClick(r)}
                              onPointerEnter={player.prime}
                              aria-label={r.sample ? `${isPlaying ? "Stop" : "Play"} ${r.display} sample` : `No audio sample for ${r.display}`}
                              title={r.sample ? undefined : "No audio sample in this export"}
                              style={{
                                width: 22, height: 22, flexShrink: 0, borderRadius: 999, cursor: "pointer",
                                border: `1px solid ${isPlaying ? ACCENT : AXIS}`,
                                background: isPlaying ? ACCENT : "transparent",
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
        <figcaption style={{ marginTop: "0.6rem", fontSize: "0.78rem", color: INK.muted }}>
          {run.caption}{run.caption ? " " : ""}
          <strong style={{ color: INK.secondary }}>Human</strong> is reader preference from blind
          four-way rankings, scored 0&ndash;100 by Bradley-Terry and updated live; an engine shows
          a dash until enough people have ranked it.{" "}
          <button
            type="button"
            onClick={() => { pendingRef.current = null; setShowBallot(true); }}
            style={{
              font: "inherit", color: INK.secondary, background: "none", border: "none",
              padding: 0, textDecoration: "underline", cursor: "pointer",
            }}
          >
            Rank four clips
          </button>.
        </figcaption>
      </figure>

      {showBallot && (
        <TtsPreferenceDialog
          player={player}
          sampleOf={(c) => SAMPLE_OF.get(c) ?? null}
          nameOf={(c) => NAME_OF.get(c) ?? c}
          onClose={closeBallot}
        />
      )}
    </>
  );
}
