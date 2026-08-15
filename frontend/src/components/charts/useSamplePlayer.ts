// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-sample-player-v1
// Shared clip playback for the TTS benchmark: the results table and the blind
// ranking dialog both drive this one hook, so there is a single AudioContext, a
// single decoded-buffer cache, and only ever one clip audible at a time.
//
// Web Audio rather than an <audio> element, matching the original export. Two
// reasons, both learned the hard way there:
//   - "canplaythrough" is a heuristic about download rate, so playback could
//     begin while the MP3 was still decoding and swallow the first word. For a
//     speech benchmark that is disqualifying. decodeAudioData resolves only once
//     the whole clip is PCM in memory, so a source that has started is
//     guaranteed to have every sample.
//   - macOS powers the output device down when idle and the first sound after
//     that loses a couple of hundred ms, below the browser and unaffected by
//     decoding early. A silent buffer pushed on first interaction wakes it.

import * as React from "react";

export interface SamplePlayer {
  /** Key of the clip currently sounding, or null. */
  playing: string | null;
  /** Key of the clip being fetched/decoded, or null. */
  loading: string | null;
  /** Every key that has finished playing at least once. */
  heard: ReadonlySet<string>;
  /** Play `file` under `key`; clicking the sounding clip again stops it. */
  toggle: (key: string, file: string) => Promise<void>;
  stop: () => void;
  /** Wake the output device. Safe to call on hover; only takes on a real gesture. */
  prime: () => void;
  /** Decode these in the background once the context is live. */
  warm: (files: string[]) => void;
  /** Set when a play attempt produced no sound, so the UI can say why rather
   *  than appearing to ignore the click. Null once a clip starts. */
  problem: "blocked" | "failed" | null;
}

export function useSamplePlayer(base: string): SamplePlayer {
  const [playing, setPlaying] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<string | null>(null);
  const [heard, setHeard] = React.useState<Set<string>>(() => new Set());
  const [problem, setProblem] = React.useState<"blocked" | "failed" | null>(null);

  const ctxRef = React.useRef<AudioContext | null>(null);
  const cacheRef = React.useRef<Map<string, AudioBuffer>>(new Map());
  const currentRef = React.useRef<AudioBufferSourceNode | null>(null);
  const primedRef = React.useRef(false);
  const warmedRef = React.useRef(false);

  const ctx = React.useCallback(() => {
    if (!ctxRef.current) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new AC();

      // iOS puts Web Audio in the "ambient" audio session, which the hardware
      // ring/silent switch mutes - while <audio> elements and native apps sit in
      // "playback" and ignore it. So on a phone with the switch flipped these
      // samples are silent while Spotify is audible, which reads as a broken
      // page rather than a muted phone. Declaring playback opts into the same
      // category a music app uses. Safari 16.4+; ignored everywhere else.
      const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (session) {
        try { session.type = "playback"; } catch { /* older WebKit rejects the value */ }
      }
    }
    return ctxRef.current;
  }, []);

  /** Resolve once the context is actually running, or give up.
   *  Every browser needs resume() inside a user gesture, but iOS is the strict
   *  one: a context that is still suspended when start() is called plays
   *  nothing, silently, and the source is spent. */
  const ensureRunning = React.useCallback(async () => {
    const ac = ctx();
    if (ac.state !== "running") {
      try { await ac.resume(); } catch { /* refused outside a gesture */ }
    }
    // Read through String() on purpose: TypeScript narrows ac.state at the
    // branch above and does not know resume() can change it, so a direct
    // comparison is rejected as impossible.
    return String(ac.state) === "running";
  }, [ctx]);

  const prime = React.useCallback(() => {
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
      const res = await fetch(base + file);
      const buf = await ctx().decodeAudioData(await res.arrayBuffer());
      cacheRef.current.set(file, buf);
      return buf;
    },
    [base, ctx]
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

  const warm = React.useCallback(
    (files: string[]) => {
      if (warmedRef.current) return;
      warmedRef.current = true;
      const idle: (cb: () => void) => void =
        (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ??
        ((cb) => window.setTimeout(cb, 300) as unknown as void);
      idle(() => { files.forEach((f) => void decode(f).catch(() => {})); });
    },
    [decode]
  );

  const toggle = React.useCallback(
    async (key: string, file: string) => {
      prime();
      if (playing === key) { stop(); return; }
      stop();
      setLoading(key);
      try {
        const buf = await decode(file);
        // decode() is a network fetch, so the user gesture is long gone by now.
        // Re-assert the context before spending the source on silence.
        const running = await ensureRunning();
        if (!running) {
          // Starting here would consume the source and play nothing at all,
          // which is indistinguishable from a dead button.
          setProblem("blocked");
          return;
        }
        const src = ctx().createBufferSource();
        src.buffer = buf;
        src.connect(ctx().destination);
        src.onended = () => {
          if (currentRef.current !== src) return;
          currentRef.current = null;
          setPlaying(null);
          // Only a clip that ran to completion counts as heard; the ranking
          // dialog uses this to tell whether the listener actually listened.
          setHeard((h) => (h.has(key) ? h : new Set(h).add(key)));
        };
        currentRef.current = src;
        src.start();
        setPlaying(key);
        setProblem(null);
      } catch {
        setPlaying(null);
        setProblem("failed");
      } finally {
        setLoading(null);
      }
    },
    [ctx, decode, ensureRunning, playing, prime, stop]
  );

  React.useEffect(
    () => () => {
      try { currentRef.current?.stop(); } catch { /* already ended */ }
      void ctxRef.current?.close();
    },
    []
  );

  // Memoised so callers can put the player in an effect's dependency list
  // without it re-firing on every render of the table.
  return React.useMemo(
    () => ({ playing, loading, heard, toggle, stop, prime, warm, problem }),
    [playing, loading, heard, toggle, stop, prime, warm, problem]
  );
}
