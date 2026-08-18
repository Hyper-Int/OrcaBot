// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-results-table-v6-unlock-on-ballot-close
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
import { useClassFilter } from "./useClassFilter";
import { useTtsScores } from "./useTtsScores";

const MODULE_REVISION = "tts-results-table-v6-unlock-on-ballot-close";
if (typeof window !== "undefined") {
  console.log(`[tts-results-table] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

interface Cell { v: string; sort: string; tone: string; align: string; href?: string }
interface Row { config: string; display: string; group: string; sample: string | null; cells: Cell[] }

const ROWS = run.rows as Row[];
const AUDIO_BASE = "/benchmarks/tts/";

/** Real-time filter. Every configuration is listed by default, including the
 *  ones that cannot keep up with their own speech, because "how far off is it"
 *  is a real question and a table that silently omits the answer cannot be
 *  checked. The filter is opt-in for readers who only care about what can be
 *  spoken live. */
const RTF_COL = run.columns.indexOf("RTF");
if (RTF_COL < 0) throw new Error(`[tts] no "RTF" column in run ${run.run}: have ${run.columns.join(", ")}`);
const RTF_CUTOFF = run.rtfCutoff;
const rtfOf = (r: Row) => Number(r.cells[RTF_COL].sort);

/** The Human column is spliced in here, right after the engine name, so the
 *  live number is visible without scrolling the table sideways. */
const HUMAN_COL = 1;
const COLUMNS: string[] = [run.columns[0], "Human", ...run.columns.slice(1)];

/** Notes became an icon: as text it was the widest column in the table and the
 *  only one that wrapped, which set the height of every row for a sentence most
 *  readers do not want on every line. */
const NOTES_COL = COLUMNS.indexOf("Notes");

/** Note popup width. Fixed rather than content-sized so every note wraps the
 *  same way and the position can be computed before it renders. */
const NOTE_WIDTH = 320;

const CLASS_COL = COLUMNS.indexOf("Class");
/** What the architecture codes mean, keyed by the export's own value - the sort
 *  key still reads "stoch-ff" even though the cell now prints "st-ff". These are
 *  the same definitions the article gives; the codes are unreadable without
 *  them, and nobody reads a column guide before a table. */
const CLASS_DESC: Record<string, string> = {
  "det-ff":
    "Deterministic feed-forward: one forward pass with a fixed duration predictor. Timing is identical every run and it cannot hallucinate words.",
  "stoch-ff":
    "Stochastic feed-forward: the same shape with sampling inside, so the output length varies between runs.",
  "ar-lm":
    "Autoregressive LM: samples audio tokens one at a time. Length is emergent, cloning and emotion become possible, and speed is floored by sequential decoding however much you quantize.",
};

/** Architecture classes present in this run, with the colours the chart uses -
 *  filtering here and isolating there should look like the same scheme, because
 *  they are the same grouping. Derived from the data so a new class appears
 *  without being registered anywhere. */
const CLASS_COLOURS: Record<string, string> = {
  "det-ff": "#3987e5",
  "stoch-ff": "#5ecfb0",
  "ar-lm": "#d95926",
};
const CLASSES = [...new Map(
  ROWS.map((r) => [r.cells[run.columns.indexOf("Class")].sort, r.cells[run.columns.indexOf("Class")].v])
).entries()]
  .map(([key, label]) => ({
    key,
    label,
    colour: CLASS_COLOURS[key] ?? INK.muted,
    count: ROWS.filter((r) => r.cells[run.columns.indexOf("Class")].sort === key).length,
  }))
  .sort((a, b) => b.count - a.count);

const LICENCE_COL = COLUMNS.indexOf("Licence");
/** Widest licence that should fit whole: "NeuTTS, <$5M" measures 90px at this
 *  font. Anything longer - only "CPML (non-commercial)" at 144px today - is
 *  clipped to an ellipsis and readable on hover, rather than setting the width
 *  of a column that is otherwise four characters wide. */
const LICENCE_MAX = 92;

/** RTF index in the *rendered* columns, which is one further along than in the
 *  run data because Human is spliced in ahead of it. Reading the un-spliced
 *  index here would test the wrong column entirely. */
const RTF_COL_RENDERED = COLUMNS.indexOf("RTF");
/** The two orderings where "can it keep up" is the axis, and so the only two
 *  where a line drawn at the cutoff means anything. Under any other sort the
 *  fast and slow engines interleave and the boundary is not a place. */
const BOUNDARY_SORTS = new Set(["RTF", "x\u0304 synth"]);

/** Opening sort: compute per phrase, cheapest first. Word error was the old
 *  default, but it saturates once speech is intelligible and two engines have no
 *  score under the stronger transcriber, so it is a poor way to meet the table.
 *  Cost per phrase is the axis every reader is actually shopping on. */
const DEFAULT_SORT = { col: COLUMNS.indexOf("x̄ synth"), dir: "asc" as const };

/** The table's natural width, with Notes an icon, Avg audio gone and the cell
 *  padding trimmed. Past this the columns just stretch, so the breakout stops
 *  here rather than filling whatever the viewport offers. Re-measure if columns
 *  or padding change. */
const MAX_TABLE_WIDTH = 1180;

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
  // Shared with the charts: one class selection governs the whole page, so
  // filtering to ar-lm in the table narrows the plot below it too.
  const { active: classFilter, toggle: toggleClass, clear: clearClasses, shows: classShows } = useClassFilter();
  /** The note being shown, with the anchor it was opened from. Positioned fixed
   *  rather than inside the cell: the table scrolls horizontally, and anything
   *  absolutely placed within it is clipped at the container edge - which is
   *  exactly where the Notes column sits. */
  //
  // `pinned` is the difference between a note that follows the pointer away and
  // one that stays. It also has to exist for click to work at all: a tap fires
  // mouseenter *then* click, so a handler that simply toggled would open on the
  // first and close on the second, and the icon would look dead to anyone
  // without a mouse.
  const [note, setNote] = React.useState<
    { config: string; text: string; x: number; y: number; w: number; pinned: boolean } | null
  >(null);
  const openNote = (e: React.SyntheticEvent, config: string, text: string, pinned = false) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Position by the box's own left edge, with an explicit width, rather than
    // centring with translateX(-50%). A fixed element only gets the space from
    // `left` to the viewport edge, so centring on an icon near the right - which
    // is where the Notes column is - shrink-wrapped the note to 75px and turned
    // it into a vertical column of words on a phone.
    const w = Math.min(NOTE_WIDTH, window.innerWidth - 16);
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    setNote((prev) => ({
      config, text, w,
      x: left,
      y: r.bottom + 6,
      // Hovering a different row while one is pinned should not silently unpin.
      pinned: pinned || (prev?.config === config && prev.pinned),
    }));
  };
  const closeIfNotPinned = (config: string) =>
    setNote((n) => (n && n.config === config && !n.pinned ? null : n));
  const [showBallot, setShowBallot] = React.useState(false);
  const pendingRef = React.useRef<Row | null>(null);
  const player = useSamplePlayer(AUDIO_BASE);

  // Live human ratings, shared with the preference chart. Failure is silent by
  // design: the column falls back to em-dashes and the other seventeen columns
  // are unaffected.
  const { ratings, minBallots, reload: loadScores } = useTtsScores();

  /** Splice the live rating in as a real cell so sorting needs no special case. */
  const rows = React.useMemo(() => {
    const classOf = (r: Row) => r.cells[run.columns.indexOf("Class")].sort;
    const visible = ROWS.filter(
      (r) =>
        (!realtimeOnly || rtfOf(r) <= RTF_CUTOFF) &&
        classShows(classOf(r))
    );
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
  }, [classShows, ratings, realtimeOnly, sort]);

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
    // This close is a gesture; the effect below that honours the reader's
    // original click is not. Take the element's playback grant here, while the
    // activation exists, or a reader who skips the dialog without playing
    // anything in it gets silence for the row they asked to hear. Skipping is
    // exactly the path where nothing in the dialog has claimed it already.
    player.unlock();
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

  // Escape closes, and so does anything else the reader does with the page. A
  // tooltip that survives a scroll ends up floating over unrelated rows.
  React.useEffect(() => {
    if (!note) return;
    const close = () => setNote(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    // Anywhere that is not this icon dismisses a pinned note - otherwise the
    // only way to close one on a touch screen is to find it again.
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.('button[aria-label^="Note on"]')) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [note]);

  /** Label for the rule drawn between the engines that keep up and those that do
   *  not, or null where no rule belongs. Only shown when everything is listed -
   *  with the filter on there is nothing on the far side to divide from - and
   *  only under a sort where the two groups are actually contiguous. */
  const boundaryAfter = (i: number): string | null => {
    if (realtimeOnly || !sort || !BOUNDARY_SORTS.has(COLUMNS[sort.col])) return null;
    const next = rows[i + 1];
    if (!next) return null;
    const here = Number(rows[i].cells[RTF_COL_RENDERED].sort) <= RTF_CUTOFF;
    const there = Number(next.cells[RTF_COL_RENDERED].sort) <= RTF_CUTOFF;
    if (here === there) return null;
    // Which side is which depends on the sort direction, so say it rather than
    // leaving the reader to infer it from a bare line.
    // The subject stays put and the direction flips. Naming whichever group
    // happens to be underneath instead means the sentence changes meaning as
    // well as direction, and the reader has to re-read it after every sort.
    return here
      ? `below: slower than real time, over ${RTF_CUTOFF}\u00d7`
      : `above: slower than real time, over ${RTF_CUTOFF}\u00d7`;
  };

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
          {/* Architecture filters. Additive: pressing none shows everything, so
              there is no "all" chip to keep in sync with the others. */}
          <span style={{ display: "inline-flex", gap: "0.3rem", flexWrap: "wrap" }}>
            {CLASSES.map((c) => {
              const on = classFilter.has(c.key);
              return (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={on}
                  title={CLASS_DESC[c.key]}
                  onClick={() => toggleClass(c.key)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: "0.35rem",
                    font: "inherit", fontWeight: 600, padding: "0.3rem 0.6rem", borderRadius: 999,
                    cursor: "pointer",
                    border: `1px solid ${on ? c.colour : AXIS}`,
                    background: on ? `${c.colour}1f` : "transparent",
                    color: on ? INK.primary : INK.muted,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{ width: 8, height: 8, borderRadius: 999, background: c.colour, opacity: on ? 1 : 0.55 }}
                  />
                  {c.label}
                </button>
              );
            })}
          </span>
          <span style={{ color: INK.muted }} aria-live="polite">
            {rows.length === ROWS.length
              ? `${ROWS.length} configurations`
              : `${rows.length} of ${ROWS.length} configurations`}
          </span>
          {(realtimeOnly || classFilter.size > 0) && (
            <button
              type="button"
              onClick={() => { setRealtimeOnly(false); clearClasses(); }}
              style={{
                font: "inherit", color: INK.muted, background: "none", border: "none",
                padding: 0, textDecoration: "underline", cursor: "pointer",
              }}
            >
              clear
            </button>
          )}
          {/* Without this a blocked audio context looks like a dead play
              button, which is unfixable by the reader because they cannot see
              why. On a phone there is no console to check either. */}
          {player.problem && (
            <span role="status" style={{ color: TONE.warn }}>
              {player.problem === "blocked"
                ? "Your browser blocked audio playback. On iPhone, check the ring/silent switch, then tap play again."
                : "That sample could not be loaded. Try again, or another row."}
            </span>
          )}
        </div>

        <div style={{ overflowX: "auto", maxWidth: "100%", border: `1px solid ${AXIS}`, borderRadius: 8 }}>
          <table
            style={{
              width: "100%", fontSize: "0.78rem", borderCollapse: "collapse", color: INK.secondary,
              // .legal-content sets margin-bottom: 1.5rem on tables, which here
              // lands *inside* the bordered wrapper and reads as an empty row
              // under the last one. It also switches tables to display:block
              // under 640px, which would give this a second scroll container
              // nested in the one it already has.
              marginBottom: 0,
              display: "table",
            }}
          >
            <thead>
              <tr>
                {COLUMNS.map((c, i) => {
                  const active = sort?.col === i;
                  return (
                    <th key={c} style={th} aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}>
                      <button
                        type="button"
                        onClick={() => (i === NOTES_COL ? undefined : onHeader(i))}
                        disabled={i === NOTES_COL}
                        title={
                          i === NOTES_COL
                            ? "Hover or tap a row's note icon"
                            : i === HUMAN_COL
                              ? humanHelp
                              : "Sort by this column"
                        }
                        style={{
                          font: "inherit", color: active ? INK.primary : INK.muted, background: "none",
                          border: "none", padding: "0.5rem 0.45rem", width: "100%", textAlign: i === 0 ? "left" : "right",
                          cursor: i === NOTES_COL ? "default" : "pointer",
                          fontWeight: 600, whiteSpace: "nowrap",
                        }}
                      >
                        {c}
                        {i !== NOTES_COL && (
                          <span aria-hidden="true" style={{ opacity: active ? 0.95 : 0.3, marginLeft: "0.25rem" }}>
                            {active ? (sort!.dir === "asc" ? "▲" : "▼") : "⇅"}
                          </span>
                        )}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => {
                const isPlaying = player.playing === r.config;
                const isLoading = player.loading === r.config;
                const row = (
                  <tr style={{ borderBottom: `1px solid ${AXIS}` }}>
                    {r.cells.map((c, ci) => (
                      <td
                        key={ci}
                        style={{
                          padding: "0.35rem 0.45rem",
                          textAlign:
                            ci === NOTES_COL ? "center" : ci === 0 || c.align === "left" ? "left" : "right",
                          color:
                            ci === HUMAN_COL
                              ? c.sort ? INK.primary : INK.muted
                              : c.tone ? TONE[c.tone] ?? INK.secondary : INK.secondary,
                          whiteSpace: "nowrap",
                          fontWeight: ci === HUMAN_COL && c.sort ? 600 : undefined,
                        }}
                      >
                        {ci === NOTES_COL ? (
                          c.v.trim() ? (
                            <button
                              type="button"
                              onClick={(e) =>
                                note?.config === r.config && note.pinned
                                  ? setNote(null)
                                  : openNote(e, r.config, c.v, true)
                              }
                              onMouseEnter={(e) => openNote(e, r.config, c.v)}
                              onMouseLeave={() => closeIfNotPinned(r.config)}
                              onFocus={(e) => openNote(e, r.config, c.v)}
                              onBlur={() => closeIfNotPinned(r.config)}
                              aria-expanded={note?.config === r.config}
                              aria-label={`Note on ${r.display}`}
                              style={{
                                width: 20, height: 20, borderRadius: 999, padding: 0, cursor: "pointer",
                                border: `1px solid ${note?.config === r.config ? ACCENT : AXIS}`,
                                background: note?.config === r.config ? ACCENT : "transparent",
                                color: note?.config === r.config ? "#fff" : INK.muted,
                                display: "inline-flex", alignItems: "center", justifyContent: "center",
                                fontSize: "0.62rem", lineHeight: 1, fontWeight: 700,
                              }}
                            >
                              <span aria-hidden="true">i</span>
                            </button>
                          ) : null
                        ) : ci === CLASS_COL && CLASS_DESC[c.sort] ? (
                          <span
                            onMouseEnter={(e) => openNote(e, `${r.config}:cls`, CLASS_DESC[c.sort])}
                            onMouseLeave={() => closeIfNotPinned(`${r.config}:cls`)}
                            style={{ borderBottom: `1px dotted ${INK.muted}`, cursor: "help" }}
                          >
                            {c.v}
                          </span>
                        ) : ci === LICENCE_COL && c.v ? (
                          <span
                            // Only pops up when the text is actually clipped, so
                            // MIT and Apache-2.0 stay quiet.
                            onMouseEnter={(e) => {
                              const el = e.currentTarget;
                              if (el.scrollWidth > el.clientWidth + 1) openNote(e, `${r.config}:lic`, c.v);
                            }}
                            onMouseLeave={() => closeIfNotPinned(`${r.config}:lic`)}
                            style={{
                              display: "inline-block", maxWidth: LICENCE_MAX, verticalAlign: "bottom",
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            }}
                          >
                            <CellText cell={c} />
                          </span>
                        ) : ci === 0 ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
                            <button
                              type="button"
                              disabled={!r.sample}
                              onClick={() => onPlayClick(r)}
                              onPointerEnter={() => player.prime(r.sample ?? undefined)}
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
                            <CellText cell={c} color={INK.primary} />
                          </span>
                        ) : (
                          <CellText cell={c} />
                        )}
                      </td>
                    ))}
                  </tr>
                );
                const divider = boundaryAfter(ri);
                return divider ? (
                  <React.Fragment key={r.config}>
                    {row}
                    <tr aria-hidden="true">
                      {/* A band, not a rule. Drawn in the header's own surface and
                          border so it reads as part of the table's structure; in
                          the accent it looked like a warning about the rows under
                          it, which is not what a change of pace is. */}
                      <td
                        colSpan={COLUMNS.length}
                        style={{
                          padding: "0.28rem 0.45rem",
                          background: "var(--background-elevated)",
                          borderTop: `1px solid ${AXIS}`,
                          borderBottom: `1px solid ${AXIS}`,
                          fontSize: "0.66rem", letterSpacing: "0.09em",
                          textTransform: "uppercase", fontWeight: 600,
                          color: INK.muted, whiteSpace: "nowrap",
                        }}
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                          {/* Three descending blocks: a graphic for "the pace
                              drops here" that needs no colour to carry it. */}
                          <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "flex-end", gap: 2, height: 9 }}>
                            <i style={{ width: 3, height: 9, background: INK.muted, opacity: 0.85, display: "block" }} />
                            <i style={{ width: 3, height: 6, background: INK.muted, opacity: 0.6, display: "block" }} />
                            <i style={{ width: 3, height: 3, background: INK.muted, opacity: 0.35, display: "block" }} />
                          </span>
                          {divider}
                        </span>
                      </td>
                    </tr>
                  </React.Fragment>
                ) : (
                  <React.Fragment key={r.config}>{row}</React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {/* The Human column only fills up if people rank, and a link buried in a
            caption asks too quietly. The invitation goes under the table, where
            someone who has just finished reading it is standing. */}
        <div
          style={{
            display: "flex", alignItems: "center", gap: "0.7rem", flexWrap: "wrap",
            marginTop: "0.7rem", padding: "0.6rem 0.75rem",
            border: `1px solid ${AXIS}`, borderRadius: 8,
            background: "var(--background-elevated)",
          }}
        >
          <button
            type="button"
            onClick={() => { pendingRef.current = null; setShowBallot(true); }}
            style={{
              font: "inherit", fontSize: "0.82rem", fontWeight: 600,
              padding: "0.4rem 0.85rem", borderRadius: 999, cursor: "pointer",
              border: `1px solid ${ACCENT}`, background: ACCENT, color: "#fff",
              flexShrink: 0,
            }}
          >
            Rank four clips
          </button>
          <span style={{ fontSize: "0.78rem", color: INK.muted, lineHeight: 1.45 }}>
            The <strong style={{ color: INK.secondary }}>Human</strong> column is the one number
            here nobody measured on a machine. Four blind clips, best to worst, up to three
            times &mdash; you never get a clip you have already ranked.
          </span>
        </div>


        <figcaption style={{ marginTop: "0.6rem", fontSize: "0.78rem", color: INK.muted }}>
          {run.caption}{run.caption ? " " : ""}
          Human is reader preference from those rankings, scored 0&ndash;100 by Bradley-Terry and
          updated live; an engine shows a dash until enough people have ranked it.
        </figcaption>

      </figure>

      {/* Fixed, and a sibling of the table rather than a child of the scrolling
          container, which would clip it at exactly the edge the Notes column sits
          against. Inert so it cannot swallow the pointer leaving the icon. */}
      {note && (
        <div
          role="tooltip"
          style={{
            position: "fixed", left: note.x, top: note.y,
            zIndex: 60, width: note.w, pointerEvents: "none",
            background: "#0b1a2e", border: `1px solid ${AXIS}`, borderRadius: 8,
            padding: "0.5rem 0.7rem", fontSize: "0.78rem", lineHeight: 1.45,
            color: INK.secondary, boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            whiteSpace: "normal",
          }}
        >
          {note.text}
        </div>
      )}

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

/** A cell's text, as a link when the data carries one. Opens off-site in a new
 *  tab rather than navigating away from a table the reader is part-way through. */
function CellText({ cell, color }: { cell: Cell; color?: string }) {
  if (!cell.href) return <span style={{ color }}>{cell.v}</span>;
  return (
    <a
      href={cell.href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: color ?? "inherit",
        textDecoration: "underline",
        textUnderlineOffset: "2px",
        textDecorationColor: AXIS,
      }}
    >
      {cell.v}
    </a>
  );
}
