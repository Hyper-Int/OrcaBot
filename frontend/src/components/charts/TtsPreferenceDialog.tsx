// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-preference-dialog-v1
// The blind ranking that fills the table's Human column.
//
// Word error rate measures intelligibility and nothing else, so the table is
// structurally blind to the axis the LM-backed engines are actually sold on.
// This is the cheap way to get that axis: ask the reader to rank four clips
// before they start playing with the table, and aggregate the pairwise outcomes
// server-side.
//
// Three things the design is deliberately strict about, because the data is
// worthless otherwise:
//   - The clips are blind. Labels are "Clip A".."Clip D" and the engine names
//     are revealed only after the ranking is locked in, so nobody ranks a
//     familiar name up.
//   - Reordering is buttons, not drag. Drag-and-drop is unusable on touch
//     without a lot of work and degrades to nothing for keyboard users, and
//     this dialog is the one thing standing between a reader and the table.
//   - Submit stays disabled until all four have played through. A ranking of
//     clips nobody listened to is noise dressed as data.
//
// The comparison set comes from the control plane, which seeds a deliberately
// weak engine into a share of ballots as an attention check. The client is not
// told which one, and must not be.

import * as React from "react";
import { fetchTtsBallot, submitTtsBallot } from "@/lib/api/cloudflare/tts";
import type { SamplePlayer } from "./useSamplePlayer";

const MODULE_REVISION = "tts-preference-dialog-v1";
if (typeof window !== "undefined") {
  console.log(`[tts-preference-dialog] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

const INK = { primary: "#e8edf5", secondary: "#c3cee0", muted: "#94a3c0" };
const AXIS = "#2a4570";
const ACCENT = "#d95926";
const LETTERS = ["A", "B", "C", "D", "E", "F"];
const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th"];

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

type Phase = "loading" | "ranking" | "sending" | "revealed" | "error";

export function TtsPreferenceDialog({ player, sampleOf, nameOf, onClose }: TtsPreferenceDialogProps) {
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [ballotId, setBallotId] = React.useState<string | null>(null);
  const [order, setOrder] = React.useState<string[]>([]);
  // Letters are fixed when the ballot is issued, never derived from the current
  // position. Deriving them renames every clip as soon as the reader reorders,
  // and worse, moves the "already played" tick onto different audio.
  const [letters, setLetters] = React.useState<Map<string, string>>(new Map());
  const { stop } = player;

  React.useEffect(() => {
    let live = true;
    fetchTtsBallot()
      .then((b) => {
        if (!live) return;
        // A clip with no audio cannot be ranked by ear, so drop it rather than
        // let it sit unplayable and block the submit gate.
        const items = b.items.filter((c) => sampleOf(c));
        if (items.length < 2) { setPhase("error"); return; }
        setBallotId(b.ballotId);
        setOrder(items);
        setLetters(new Map(items.map((c, i) => [c, LETTERS[i]])));
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

  const move = (i: number, delta: number) =>
    setOrder((o) => {
      const j = i + delta;
      if (j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  // Keyed by clip letter rather than config id so the DOM never carries the
  // engine name before the reveal.
  const letterOf = (config: string) => letters.get(config) ?? "?";
  const keyFor = (config: string) => `ballot:${letterOf(config)}`;
  const allHeard = order.length > 0 && order.every((c) => player.heard.has(keyFor(c)));

  const submit = async () => {
    if (!ballotId) return;
    setPhase("sending");
    stop();
    try {
      await submitTtsBallot(ballotId, order);
      setPhase("revealed");
    } catch {
      // The ranking is lost either way; showing the names is the one thing
      // still worth giving them for the effort.
      setPhase("revealed");
    }
  };

  const dismiss = (submitted: boolean) => { stop(); onClose(submitted); };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Rank four speech samples"
      onClick={(e) => { if (e.target === e.currentTarget) dismiss(phase === "revealed"); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1000, display: "flex",
        alignItems: "center", justifyContent: "center", padding: "1rem",
        background: "rgba(6,10,20,0.72)", backdropFilter: "blur(2px)",
      }}
    >
      <div
        style={{
          width: "min(34rem, 100%)", maxHeight: "90dvh", overflowY: "auto",
          background: "var(--background-elevated, #0d1526)", color: INK.secondary,
          border: `1px solid ${AXIS}`, borderRadius: 12, padding: "1.25rem",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        {phase === "error" ? (
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
              {order.map((c) => (
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
            <p style={{ margin: "0 0 1rem", fontSize: "0.88rem", lineHeight: 1.5 }}>
              The table measures whether speech can be <em>understood</em>, which is not the same
              as whether it sounds any good. Play all four and put them in order, best first.
              They are unlabelled on purpose; the names are revealed once you submit.
            </p>

            {phase === "loading" ? (
              <p style={{ fontSize: "0.88rem", color: INK.muted, padding: "1.5rem 0", textAlign: "center" }}>
                Loading samples…
              </p>
            ) : (
              <ul style={{ listStyle: "none", margin: "0 0 1rem", padding: 0, display: "grid", gap: "0.4rem" }}>
                {order.map((config, i) => {
                  const key = keyFor(config);
                  const file = sampleOf(config);
                  const isPlaying = player.playing === key;
                  const isLoading = player.loading === key;
                  const wasHeard = player.heard.has(key);
                  return (
                    <li
                      key={config}
                      style={{
                        display: "flex", alignItems: "center", gap: "0.6rem",
                        padding: "0.5rem 0.6rem", borderRadius: 8,
                        border: `1px solid ${isPlaying ? ACCENT : AXIS}`,
                        background: "rgba(57,135,229,0.06)",
                      }}
                    >
                      <span style={{ width: "2.2rem", flexShrink: 0, fontSize: "0.78rem", color: INK.muted }}>
                        {ORDINALS[i]}
                      </span>
                      <button
                        type="button"
                        onClick={() => { if (file) void player.toggle(key, file); }}
                        aria-label={`${isPlaying ? "Stop" : "Play"} clip ${letterOf(config)}`}
                        style={{
                          width: 30, height: 30, flexShrink: 0, borderRadius: 999, cursor: "pointer",
                          border: `1px solid ${isPlaying ? ACCENT : AXIS}`,
                          background: isPlaying ? ACCENT : "transparent",
                          color: isPlaying ? "#fff" : INK.secondary,
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                          fontSize: "0.7rem", padding: 0,
                        }}
                      >
                        <span aria-hidden="true">{isLoading ? "…" : isPlaying ? "■" : "▶"}</span>
                      </button>
                      <span style={{ flex: 1, fontSize: "0.9rem", color: INK.primary }}>
                        Clip {letterOf(config)}
                        {wasHeard && (
                          <span aria-hidden="true" style={{ marginLeft: "0.4rem", color: "#6ee7a8", fontSize: "0.8rem" }}>✓</span>
                        )}
                        <span className="sr-only">{wasHeard ? " (played)" : " (not played yet)"}</span>
                      </span>
                      <Nudge onClick={() => move(i, -1)} disabled={i === 0} label={`Move clip ${letterOf(config)} up`}>▲</Nudge>
                      <Nudge onClick={() => move(i, 1)} disabled={i === order.length - 1} label={`Move clip ${letterOf(config)} down`}>▼</Nudge>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Reaching this dialog before the table means a blocked audio
                context shows up here first: four buttons that do nothing and a
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
                onClick={() => void submit()}
                disabled={!allHeard || phase !== "ranking"}
                title={allHeard ? undefined : "Play all four clips first"}
                primary
              >
                {phase === "sending" ? "Submitting…" : allHeard ? "Submit ranking" : "Play all four to submit"}
              </Button>
            </Actions>
          </>
        )}
      </div>
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

function Nudge({
  children, onClick, disabled, label,
}: {
  children: React.ReactNode; onClick: () => void; disabled: boolean; label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      style={{
        width: 28, height: 28, flexShrink: 0, borderRadius: 6, padding: 0,
        border: `1px solid ${AXIS}`, background: "transparent",
        color: disabled ? "rgba(148,163,192,0.3)" : INK.secondary,
        cursor: disabled ? "default" : "pointer", fontSize: "0.65rem",
      }}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}
