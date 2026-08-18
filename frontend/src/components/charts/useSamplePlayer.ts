// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-sample-player-v2-safari-resume
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
//
// The other side of that same power saving is why resume() is attempted on
// every play rather than once: WebKit suspends a context that has been silent
// for a while, and interrupts one whose tab is backgrounded or whose audio
// session another app has taken. Coming back needs resume() from inside a user
// gesture, so it has to happen synchronously at the top of the click - past the
// first await the activation is gone and Safari refuses.

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
  const resumeRef = React.useRef<Promise<void> | null>(null);

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

      // A context that leaves "running" has taken every scheduled source with
      // it, so onended will never fire for the clip that was sounding. Without
      // this the button stays showing "stop" for audio that is not audible.
      // Clearing primedRef also makes the next gesture do the full wake-up
      // again, silent buffer included, rather than assuming the device is up.
      ctxRef.current.addEventListener("statechange", () => {
        const ac = ctxRef.current;
        if (!ac || ac.state === "running") return;
        primedRef.current = false;
        if (currentRef.current) {
          currentRef.current = null;
          setPlaying(null);
        }
      });
    }
    return ctxRef.current;
  }, []);

  /** Resolve once the context is actually running, or give up.
   *  Every browser needs resume() inside a user gesture, but iOS is the strict
   *  one: a context that is still suspended when start() is called plays
   *  nothing, silently, and the source is spent. */
  const ensureRunning = React.useCallback(async () => {
    const ac = ctx();
    // The resume that matters was started by prime(), inside the gesture. Wait
    // on that one: a fresh resume() from here is issued after the decode and so
    // has no activation behind it, which WebKit rejects.
    if (resumeRef.current) {
      try { await resumeRef.current; } catch { /* settled by prime()'s handler */ }
    }
    if (ac.state !== "running") {
      try { await ac.resume(); } catch { /* refused outside a gesture */ }
    }
    // Read through String() on purpose: TypeScript narrows ac.state at the
    // branch above and does not know resume() can change it, so a direct
    // comparison is rejected as impossible.
    return String(ac.state) === "running";
  }, [ctx]);

  /** Wake the context, and the output device behind it. Called synchronously at
   *  the top of every play so the resume lands while the gesture is still live;
   *  the work inside is idempotent, so calling it on hover as well is free. */
  const prime = React.useCallback(() => {
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
    if (ac.state === "running") { push(); return; }
    // Anything else - "suspended", or WebKit's non-standard "interrupted" -
    // needs resuming. Kept on a ref so the play that triggered it can await
    // this exact attempt instead of racing a second, gesture-less one.
    resumeRef.current = ac.resume().then(push, () => { /* refused outside a gesture */ });
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

  // Coming back to a backgrounded tab is the common way to find the context
  // interrupted. The page has sticky activation from the play that started all
  // this, so this resume often succeeds and the next click is instant; when it
  // does not, the click resumes it anyway and nothing is lost by trying.
  React.useEffect(() => {
    const onVisible = () => {
      const ac = ctxRef.current;
      if (!ac || document.visibilityState !== "visible" || ac.state === "running") return;
      resumeRef.current = ac.resume().then(
        () => {},
        () => { /* needs a gesture; the play button will supply one */ }
      );
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

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
