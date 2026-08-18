// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-preference-dialog-v3-slots
// The blind ranking that fills the table's Human column.
//
// Word error rate measures intelligibility and nothing else, so the table is
// structurally blind to the axis the LM-backed engines are actually sold on.
// This is the cheap way to get that axis: ask the reader to rank four clips
// before they start playing with the table, and aggregate the pairwise outcomes
// server-side.
//
// The layout is a tray of clips above four empty, labelled slots - BEST, 2nd,
// 3rd, WORST - and that emptiness is the point. The previous version presented
// the clips already in an order, so the path of least resistance was to play
// 1, 2, 3, 4 and press submit, which records the order the server happened to
// shuffle them into rather than an opinion. With nothing pre-placed there is no
// default to accept: every ballot is four deliberate placements or it does not
// exist.
//
// Placing works three ways, because one way would exclude someone:
//   - Drag a clip onto a slot. Built on pointer events, NOT HTML5 drag and
//     drop, which does not fire on iOS at all - and iOS is most of the traffic
//     this dialog sees.
//   - Tap a clip, then tap a slot. The same two taps drag costs, and the only
//     option that works reliably with assistive touch.
//   - Keyboard: focus a clip, Enter to pick up, then Enter on a slot.
//
// The rest is unchanged and still deliberate: clips stay blind until the ballot
// is recorded, so nobody ranks a familiar name up; submit stays shut until all
// four have played to the end, because a ranking of clips nobody heard is noise
// dressed as data; and the comparison set comes from the control plane, which
// seeds a deliberately weak engine as an attention check and does not tell the
// client which one.

import * as React from "react";
import { fetchTtsBallot, submitTtsBallot } from "@/lib/api/cloudflare/tts";
import type { SamplePlayer } from "./useSamplePlayer";

const MODULE_REVISION = "tts-preference-dialog-v3-slots";
if (typeof window !== "undefined") {
  console.log(`[tts-preference-dialog] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

const INK = { primary: "#e8edf5", secondary: "#c3cee0", muted: "#94a3c0" };
const AXIS = "#2a4570";
const ACCENT = "#d95926";
const GOOD = "#6ee7a8";
const LETTERS = ["A", "B", "C", "D", "E", "F"];
const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th"];

/** Slot captions. The ends are named rather than numbered because "BEST" and
 *  "WORST" state the task; "1st" and "4th" only state a position. */
function slotLabel(i: number, n: number): string {
  if (i === 0) return "BEST";
  if (i === n - 1) return "WORST";
  return ORDINALS[i];
}

export interface TtsPreferenceDialogProps {
  /** Shared with the results table so only one clip is ever audible. */
  player: SamplePlayer;
  /** config id -> audio filename. */
  sampleOf: (config: string) => string | null;
  /** config id -> human-readable engine name, revealed after submitting. */
  nameOf: (config: string) => string;
  /** Called with whether a ranking was actually recorded. */
  onClose: (submitted: boolean) => void;
}

type Phase = "loading" | "ranking" | "confirm" | "sending" | "revealed" | "error" | "exhausted";

interface Drag {
  config: string;
  /** Where the press started. `moved` is measured from here - measuring from
   *  the previous move event instead means a slow drag never crosses the
   *  threshold and is forever treated as a tap. */
  x0: number;
  y0: number;
  /** Current pointer position, for the ghost. */
  x: number;
  y: number;
  /** Grab offset so the ghost does not jump to its own centre on pick-up. */
  dx: number;
  dy: number;
  /** Set once the pointer has moved far enough to be a drag and not a tap. */
  moved: boolean;
  /** Whether a tap on this chip means "pick up". True in the tray; false for a
   *  placed chip, where the tap belongs to the slot underneath and means
   *  "put it back". Without the split, tapping a placed clip both selected it
   *  and removed it, and the two cancelled out. */
  pickable: boolean;
}

const DRAG_THRESHOLD = 6;

export function TtsPreferenceDialog({ player, sampleOf, nameOf, onClose }: TtsPreferenceDialogProps) {
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [ballotId, setBallotId] = React.useState<string | null>(null);
  /** The issued clips, in the order the server shuffled them. Never re-ordered:
   *  this is identity, not ranking. */
  const [items, setItems] = React.useState<string[]>([]);
  /** Letters are fixed when the ballot is issued, never derived from position,
   *  so moving a clip never renames it or moves its "played" tick. */
  const [letters, setLetters] = React.useState<Map<string, string>>(new Map());
  /** The ranking under construction. Index 0 is best. */
  const [slots, setSlots] = React.useState<(string | null)[]>([]);
  /** Picked up by tap or keyboard, waiting for a slot. */
  const [held, setHeld] = React.useState<string | null>(null);
  const [drag, setDrag] = React.useState<Drag | null>(null);
  const [overSlot, setOverSlot] = React.useState<number | null>(null);
  const [announcement, setAnnouncement] = React.useState("");
  /** How many of this voter's allowance is used, for the exhausted message. */
  const [quota, setQuota] = React.useState<{ submitted: number; max: number } | null>(null);
  const { stop } = player;

  const slotRefs = React.useRef<(HTMLElement | null)[]>([]);

  React.useEffect(() => {
    let live = true;
    fetchTtsBallot()
      .then((b) => {
        if (!live) return;
        if (b.exhausted || !b.ballotId || !b.items) {
          setQuota({ submitted: b.submitted ?? 0, max: b.max ?? 0 });
          setPhase("exhausted");
          return;
        }
        // A clip with no audio cannot be ranked by ear, so drop it rather than
        // let it sit unplayable and block the submit gate.
        const usable = b.items.filter((c) => sampleOf(c));
        if (usable.length < 2) { setPhase("error"); return; }
        setBallotId(b.ballotId);
        setItems(usable);
        setLetters(new Map(usable.map((c, i) => [c, LETTERS[i]])));
        setSlots(new Array(usable.length).fill(null));
        setPhase("ranking");
      })
      .catch(() => { if (live) setPhase("error"); });
    return () => { live = false; };
    // sampleOf is derived from a module-level constant; re-running on identity
    // change would refetch a fresh ballot and orphan this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whatever is sounding belongs to this dialog; do not leave it playing behind
  // the reader once the dialog is gone.
  React.useEffect(() => () => stop(), [stop]);

  const letterOf = (config: string) => letters.get(config) ?? "?";
  const keyFor = (config: string) => `ballot:${letterOf(config)}`;
  const unplaced = items.filter((c) => !slots.includes(c));
  const allPlaced = slots.length > 0 && slots.every(Boolean);
  const allHeard = items.length > 0 && items.every((c) => player.heard.has(keyFor(c)));

  /** Put `config` in slot `i`.
   *
   *  Dropping onto an occupied slot swaps: the occupant takes the slot the
   *  dragged clip just left. Evicting it to the tray instead - which is what
   *  this did - punished the most ordinary correction there is. Deciding two
   *  clips are the wrong way round meant dragging one over the other, watching
   *  the other fly back to the top, and then having to place it again, so a
   *  swap cost two moves and undid work the reader had already done.
   *
   *  A clip dragged in from the tray still displaces the occupant to the tray,
   *  because there is no slot to swap it into. */
  const place = React.useCallback(
    (config: string, i: number) => {
      setSlots((prev) => {
        const from = prev.indexOf(config); // -1 when it comes from the tray
        const next = [...prev];
        const occupant = next[i];
        next[i] = config;
        // Assigning occupant (which may be null) also clears the source slot
        // when the target was empty, so a plain move needs no special case.
        if (from >= 0) next[from] = occupant;

        setAnnouncement(
          `Clip ${letterOf(config)} placed ${slotLabel(i, prev.length)}.` +
            (occupant
              ? from >= 0
                ? ` Swapped with clip ${letterOf(occupant)}, now ${slotLabel(from, prev.length)}.`
                : ` Clip ${letterOf(occupant)} returned to the tray.`
              : "")
        );
        return next;
      });
      setHeld(null);
    },
    // letterOf reads state that changes only at ballot load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [letters]
  );

  const unplace = React.useCallback(
    (config: string) => {
      setSlots((prev) => prev.map((c) => (c === config ? null : c)));
      setAnnouncement(`Clip ${letterOf(config)} returned to the tray.`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [letters]
  );

  /** Which slot is under this point, by hit-testing the slot boxes. Simpler and
   *  steadier than elementFromPoint, which would hit the drag ghost. */
  const slotAt = (x: number, y: number): number | null => {
    for (let i = 0; i < slotRefs.current.length; i++) {
      const el = slotRefs.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
    }
    return null;
  };

  // Pointer drag, via setPointerCapture on the chip rather than window
  // listeners bound in an effect. The effect version attached one render after
  // pointerdown, so a quick tap - the common case on a phone - could send its
  // pointerup before anything was listening, and the press did nothing at all.
  // Capture routes every later event for this pointer to the chip, however far
  // outside it the finger goes.
  const dragRef = React.useRef<Drag | null>(null);
  const setDragBoth = (d: Drag | null) => { dragRef.current = d; setDrag(d); };

  const onChipDown = (config: string, pickable: boolean) => (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
    const r = el.getBoundingClientRect();
    setDragBoth({
      config, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, pickable,
    });
  };

  const onChipMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const moved = d.moved || Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > DRAG_THRESHOLD;
    setDragBoth({ ...d, x: e.clientX, y: e.clientY, moved });
    setOverSlot(moved ? slotAt(e.clientX, e.clientY) : null);
  };

  const onChipUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    setDragBoth(null);
    setOverSlot(null);
    if (!d) return;
    if (d.moved) {
      const target = slotAt(e.clientX, e.clientY);
      // A drag that lands nowhere is a cancel, not a selection.
      if (target !== null) place(d.config, target);

      // Swallow the click this gesture is about to produce. Pointer capture
      // sends it to the chip we grabbed - which sits in the slot we dragged
      // *away from* - so it bubbles to that slot's handler and reads as a tap,
      // putting the clip that just swapped in straight back to the tray. The
      // drag looked like it evicted rather than swapped; it did swap, and then
      // undid half of it a moment later.
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      // If no click follows (some pointer types), take the listener back out
      // rather than leaving it to eat the next real one.
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 300);
    } else if (d.pickable) {
      // Never moved, and from the tray: a tap picks up or puts down.
      setHeld((h) => (h === d.config ? null : d.config));
    }
    // A tap on a placed chip does nothing here; the slot beneath handles it.
  };

  const onSlotActivate = (i: number) => {
    if (held) { place(held, i); return; }
    const occupant = slots[i];
    if (occupant) unplace(occupant);
  };

  const submit = async () => {
    if (!ballotId) return;
    setPhase("sending");
    stop();
    const ranking = slots.filter((c): c is string => !!c);
    try {
      await submitTtsBallot(ballotId, ranking);
      setPhase("revealed");
    } catch {
      // The ranking is lost either way; showing the names is the one thing
      // still worth giving them for the effort.
      setPhase("revealed");
    }
  };

  const dismiss = (submitted: boolean) => { stop(); onClose(submitted); };

  const ranked = slots.filter((c): c is string => !!c);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Rank speech samples"
      onClick={(e) => { if (e.target === e.currentTarget) dismiss(phase === "revealed"); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1000, display: "flex",
        alignItems: "center", justifyContent: "center", padding: "1rem",
        background: "rgba(6,10,20,0.72)", backdropFilter: "blur(2px)",
      }}
    >
      <div
        style={{
          width: "min(34rem, 100%)", maxHeight: "92dvh", overflowY: "auto",
          background: "var(--background-elevated, #0d1526)", color: INK.secondary,
          border: `1px solid ${AXIS}`, borderRadius: 12, padding: "1rem",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        {phase === "exhausted" ? (
          <>
            <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem", color: INK.primary }}>
              That is your lot — thank you
            </h2>
            <p style={{ margin: "0 0 1rem", fontSize: "0.88rem", lineHeight: 1.5 }}>
              You have ranked {quota?.max ?? 3} sets, which is the most one person can
              contribute. The cap exists so no single pair of ears can move a rating on its
              own; the scores in the table are the pooled result of everyone&apos;s.
            </p>
            <Actions>
              <Button onClick={() => dismiss(false)} primary>Back to the results</Button>
            </Actions>
          </>
        ) : phase === "error" ? (
          <>
            <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem", color: INK.primary }}>
              Ranking is unavailable
            </h2>
            <p style={{ margin: "0 0 1rem", fontSize: "0.88rem", lineHeight: 1.5 }}>
              The comparison could not be loaded, which changes nothing about the table.
            </p>
            <Actions>
              <Button onClick={() => dismiss(false)} primary>Go to the results</Button>
            </Actions>
          </>
        ) : phase === "confirm" || phase === "sending" ? (
          <>
            <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem", color: INK.primary }}>
              Is this your order?
            </h2>
            <p style={{ margin: "0 0 1rem", fontSize: "0.88rem", lineHeight: 1.5 }}>
              Nothing has been submitted yet — go back if this is not what you meant.
            </p>
            <ol style={{ margin: "0 0 1.25rem", padding: 0, listStyle: "none", display: "grid", gap: "0.4rem" }}>
              {ranked.map((c, i) => {
                const file = sampleOf(c);
                const isPlaying = player.playing === keyFor(c);
                return (
                  <li
                    key={c}
                    style={{
                      display: "flex", alignItems: "center", gap: "0.6rem",
                      padding: "0.5rem 0.6rem", borderRadius: 8,
                      border: `1px solid ${isPlaying ? ACCENT : AXIS}`,
                      background: "rgba(57,135,229,0.06)",
                    }}
                  >
                    <span style={{ width: "3.2rem", flexShrink: 0, fontSize: "0.72rem", fontWeight: 700, color: INK.muted, letterSpacing: "0.04em" }}>
                      {slotLabel(i, ranked.length)}
                    </span>
                    {/* Playable here too: checking an order you cannot re-hear
                        is not much of a check. */}
                    <button
                      type="button"
                      onClick={() => { if (file) void player.toggle(keyFor(c), file); }}
                      aria-label={`${isPlaying ? "Stop" : "Play"} clip ${letterOf(c)}`}
                      style={playButton(isPlaying)}
                    >
                      <span aria-hidden="true">{isPlaying ? "■" : "▶"}</span>
                    </button>
                    <span style={{ flex: 1, fontSize: "0.9rem", color: INK.primary }}>Clip {letterOf(c)}</span>
                  </li>
                );
              })}
            </ol>
            <Actions>
              <Button onClick={() => { stop(); setPhase("ranking"); }} disabled={phase === "sending"}>
                Go back
              </Button>
              <Button onClick={() => void submit()} disabled={phase === "sending"} primary>
                {phase === "sending" ? "Submitting…" : "Confirm ranking"}
              </Button>
            </Actions>
          </>
        ) : phase === "revealed" ? (
          <>
            <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem", color: INK.primary }}>
              Thank you — that is one ballot
            </h2>
            <p style={{ margin: "0 0 1rem", fontSize: "0.88rem", lineHeight: 1.5 }}>
              Here is what you ranked. Every engine needs a handful of ballots before a
              number appears in the table&apos;s Human column.
            </p>
            <ol style={{ margin: "0 0 1.25rem", paddingLeft: "1.25rem", fontSize: "0.9rem", lineHeight: 1.9 }}>
              {ranked.map((c) => (
                <li key={c}>
                  <span style={{ color: INK.muted }}>Clip {letterOf(c)} was </span>
                  <strong style={{ color: INK.primary }}>{nameOf(c)}</strong>
                </li>
              ))}
            </ol>
            <Actions>
              <Button onClick={() => dismiss(true)} primary>Go to the results</Button>
            </Actions>
          </>
        ) : (
          <>
            <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem", color: INK.primary }}>
              Which of these sounds best?
            </h2>
            {/* Kept short on purpose: every line here pushes the WORST slot off
                a phone screen, and not seeing the ends of the scale is the one
                thing that would make the task unclear. */}
            <p style={{ margin: "0 0 0.6rem", fontSize: "0.85rem", lineHeight: 1.45 }}>
              The table measures whether speech is <em>understood</em>, not whether it sounds good.
              Clips are unlabelled; names are revealed after you submit.
            </p>
            <p style={{ margin: "0 0 0.8rem", fontSize: "0.82rem", color: INK.muted, lineHeight: 1.45 }}>
              Play each clip, then <strong style={{ color: INK.secondary }}>drag it into a slot</strong>{" "}
              — or tap the clip, then tap the slot.
            </p>

            <style
              dangerouslySetInnerHTML={{
                __html:
                  ".tts-tray{display:grid;gap:.4rem;grid-template-columns:repeat(4,minmax(0,1fr));align-items:center}" +
                  ".tts-tray .tts-empty{grid-column:1/-1;text-align:center}" +
                  "@media (max-width:560px){.tts-tray{grid-template-columns:repeat(2,minmax(0,1fr))}}",
              }}
            />
            {phase === "loading" ? (
              <p style={{ fontSize: "0.88rem", color: INK.muted, padding: "1.5rem 0", textAlign: "center" }}>
                Loading samples…
              </p>
            ) : (
              <>
                {/* The tray. Empties as clips are placed; when it is empty the
                    ranking is complete, which is its own progress indicator. */}
                <div
                  className="tts-tray"
                  style={{
                    minHeight: 50, padding: "0.4rem", marginBottom: "0.7rem",
                    border: `1px dashed ${unplaced.length ? AXIS : "transparent"}`, borderRadius: 10,
                  }}
                >
                  {unplaced.length === 0 ? (
                    <span className="tts-empty" style={{ fontSize: "0.8rem", color: GOOD }}>
                      All placed — check the order below.
                    </span>
                  ) : (
                    unplaced.map((c) => (
                      <Chip
                        key={c}
                        letter={letterOf(c)}
                        held={held === c}
                        dragging={drag?.config === c && drag.moved}
                        playing={player.playing === keyFor(c)}
                        loading={player.loading === keyFor(c)}
                        heard={player.heard.has(keyFor(c))}
                        inTray
                        onPointerDown={onChipDown(c, true)}
                        onPointerMove={onChipMove}
                        onPointerUp={onChipUp}
                        onPlay={() => { const f = sampleOf(c); if (f) void player.toggle(keyFor(c), f); }}
                        onKeyPick={() => setHeld((h) => (h === c ? null : c))}
                      />
                    ))
                  )}
                </div>

                <ul style={{ listStyle: "none", margin: "0 0 0.7rem", padding: 0, display: "grid", gap: "0.3rem" }}>
                  {slots.map((occupant, i) => {
                    const isOver = overSlot === i && drag?.moved;
                    const isTarget = !!held;
                    return (
                      <li
                        key={i}
                        ref={(el) => { slotRefs.current[i] = el; }}
                        onClick={() => onSlotActivate(i)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSlotActivate(i); }
                        }}
                        aria-label={
                          occupant
                            ? `${slotLabel(i, slots.length)}: clip ${letterOf(occupant)}. Activate to remove.`
                            : `${slotLabel(i, slots.length)}: empty.${held ? ` Activate to place clip ${letterOf(held)}.` : ""}`
                        }
                        style={{
                          display: "flex", alignItems: "center", gap: "0.6rem",
                          minHeight: 46, padding: "0.3rem 0.55rem", borderRadius: 8,
                          cursor: isTarget || occupant ? "pointer" : "default",
                          border: `${isOver || (isTarget && !occupant) ? 2 : 1}px ${occupant ? "solid" : "dashed"} ${
                            isOver ? ACCENT : isTarget && !occupant ? GOOD : AXIS
                          }`,
                          background: isOver ? "rgba(217,89,38,0.12)" : occupant ? "rgba(57,135,229,0.06)" : "transparent",
                          transition: "border-color 140ms, background 140ms",
                        }}
                      >
                        <span
                          style={{
                            width: "2.9rem", flexShrink: 0, fontSize: "0.7rem", fontWeight: 700,
                            letterSpacing: "0.03em",
                            color: i === 0 ? GOOD : i === slots.length - 1 ? "#f0908a" : INK.muted,
                          }}
                        >
                          {slotLabel(i, slots.length)}
                        </span>
                        {occupant ? (
                          <Chip
                            letter={letterOf(occupant)}
                            held={held === occupant}
                            dragging={drag?.config === occupant && drag.moved}
                            playing={player.playing === keyFor(occupant)}
                            loading={player.loading === keyFor(occupant)}
                            heard={player.heard.has(keyFor(occupant))}
                            onPointerDown={onChipDown(occupant, false)}
                            onPointerMove={onChipMove}
                            onPointerUp={onChipUp}
                            onPlay={() => { const f = sampleOf(occupant); if (f) void player.toggle(keyFor(occupant), f); }}
                          />
                        ) : (
                          <span style={{ fontSize: "0.8rem", color: INK.muted }}>
                            {held ? `Tap to place clip ${letterOf(held)}` : "Drop a clip here"}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

            {/* Reaching this dialog before the table means a blocked audio
                context shows up here first: buttons that do nothing and a
                submit that can never enable, with no way to tell why. */}
            {player.problem && (
              <p role="status" style={{ margin: "0 0 1rem", fontSize: "0.82rem", color: "#e0b25e", lineHeight: 1.5 }}>
                {player.problem === "blocked"
                  ? "Your browser blocked audio playback, so these cannot be ranked. On iPhone, check the ring/silent switch and tap play again — or skip, and the table is all still there."
                  : "A clip could not be loaded. Try again, or skip — the table is all still there."}
              </p>
            )}

            <Actions>
              <Button onClick={() => dismiss(false)}>Skip</Button>
              <Button
                onClick={() => { stop(); setPhase("confirm"); }}
                disabled={!allPlaced || !allHeard || phase !== "ranking"}
                primary
              >
                {!allHeard ? "Play every clip first" : !allPlaced ? "Fill every slot first" : "Review order"}
              </Button>
            </Actions>
          </>
        )}
      </div>

      {/* The dragged clip, following the pointer. Rendered at the dialog root so
          no ancestor's overflow can clip it, and inert so hit-testing sees the
          slots underneath rather than the ghost. */}
      {drag?.moved && (
        <div
          aria-hidden="true"
          style={{
            position: "fixed", left: drag.x - drag.dx, top: drag.y - drag.dy,
            pointerEvents: "none", zIndex: 1001, opacity: 0.95,
            transform: "scale(1.04)",
          }}
        >
          <Chip letter={letterOf(drag.config)} held playing={false} loading={false}
                heard={player.heard.has(keyFor(drag.config))} dragging />
        </div>
      )}
    </div>
  );
}

function playButton(isPlaying: boolean): React.CSSProperties {
  return {
    width: 30, height: 30, flexShrink: 0, borderRadius: 999, cursor: "pointer",
    border: `1px solid ${isPlaying ? ACCENT : AXIS}`,
    background: isPlaying ? ACCENT : "transparent",
    color: isPlaying ? "#fff" : INK.secondary,
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    fontSize: "0.7rem", padding: 0,
  };
}

/** A draggable clip. The play control is a real button inside it, so a tap on
 *  the triangle plays and a tap anywhere else picks the clip up. */
function Chip({
  letter, held, dragging, playing, loading, heard, inTray, onPointerDown, onPointerMove, onPointerUp, onPlay, onKeyPick,
}: {
  letter: string;
  held: boolean;
  dragging: boolean;
  playing: boolean;
  loading: boolean;
  heard: boolean;
  inTray?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerMove?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
  onPlay?: () => void;
  onKeyPick?: () => void;
}) {
  return (
    <div
      data-tray={inTray ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role={onKeyPick ? "button" : undefined}
      tabIndex={onKeyPick ? 0 : undefined}
      aria-pressed={onKeyPick ? held : undefined}
      aria-label={onKeyPick ? `Clip ${letter}${heard ? ", played" : ", not played yet"}${held ? ", picked up" : ""}` : undefined}
      onKeyDown={
        onKeyPick
          ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onKeyPick(); } }
          : undefined
      }
      style={{
        display: "inline-flex", alignItems: "center", gap: "0.45rem",
        justifyContent: inTray ? "center" : undefined,
        width: inTray ? "100%" : undefined,
        boxSizing: "border-box",
        padding: "0.35rem 0.6rem 0.35rem 0.4rem", borderRadius: 999,
        border: `${held ? 2 : 1}px solid ${held ? GOOD : playing ? ACCENT : AXIS}`,
        background: held ? "rgba(110,231,168,0.10)" : "var(--background-elevated, #0d1526)",
        // Without this the browser scrolls the dialog instead of dragging.
        touchAction: "none",
        cursor: dragging ? "grabbing" : "grab",
        opacity: dragging && !held ? 0.4 : 1,
        userSelect: "none",
      }}
    >
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()} // playing is not dragging
        onClick={(e) => { e.stopPropagation(); onPlay?.(); }}
        aria-label={`${playing ? "Stop" : "Play"} clip ${letter}`}
        tabIndex={onPlay ? 0 : -1}
        style={playButton(playing)}
      >
        <span aria-hidden="true">{loading ? "…" : playing ? "■" : "▶"}</span>
      </button>
      <span style={{ fontSize: "0.9rem", color: INK.primary, whiteSpace: "nowrap" }}>
        Clip {letter}
        {heard && <span aria-hidden="true" style={{ marginLeft: "0.3rem", color: GOOD, fontSize: "0.78rem" }}>✓</span>}
      </span>
    </div>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", flexWrap: "wrap" }}>{children}</div>;
}

function Button({
  children, onClick, primary, disabled, title,
}: {
  children: React.ReactNode; onClick: () => void; primary?: boolean; disabled?: boolean; title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        font: "inherit", fontSize: "0.88rem", fontWeight: 600, padding: "0.5rem 0.9rem",
        borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
        border: `1px solid ${primary ? ACCENT : AXIS}`,
        background: primary ? ACCENT : "transparent",
        color: primary ? "#fff" : INK.secondary,
      }}
    >
      {children}
    </button>
  );
}
