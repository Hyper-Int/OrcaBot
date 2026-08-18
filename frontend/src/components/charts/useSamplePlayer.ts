// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-sample-player-v4-element-first
// Shared clip playback for the TTS benchmark: the results table and the blind
// ranking dialog both drive this one hook, so there is a single media element, a
// single cache of fetched clips, and only ever one clip audible at a time.
//
// Clips play through an <audio> element. They used to go through Web Audio, and
// the reason was a good one: "canplaythrough" is a heuristic about download
// rate, so an element could begin while the MP3 was still arriving and swallow
// the first word, which for a speech benchmark is disqualifying, whereas
// decodeAudioData only resolves with the whole clip in memory. That guarantee is
// kept here without Web Audio - every clip is fetched to completion first and
// played from a blob URL, so the bytes are all local before play() is called.
//
// What forced the change is that Safari will not play Web Audio on this page at
// all. A reader ran the two probes below: the test tone - a quarter-second sine
// with no fetch, no decode and no buffer, started inside the click - was silent,
// while the same clip through an element played. Chrome plays both. So the
// engine that could not be worked around was the only one we were relying on.
//
// The iOS reason for Web Audio's session hint went with it. Web Audio lands in
// the "ambient" session, which the ring/silent switch mutes, so playing clips
// there needed navigator.audioSession.type = "playback" to behave like a music
// app. A media element is in the playback session already - the hint existed to
// make Web Audio imitate what an element does natively, and it was also the one
// Safari-only line in the file, which is the shape the failure had.
//
// The context now exists solely for the test tone, created only if that probe is
// run. Nothing a reader hears depends on it.

import * as React from "react";

const MODULE_REVISION = "tts-sample-player-v4-element-first";
if (typeof window !== "undefined") {
  console.log(`[tts-sample-player] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

/** How long the tone probe waits for a context to start before reporting it
 *  stuck. Only the diagnostics use this; playback never waits on it. */
const RESUME_GRACE_MS = 600;

/** Resolve true once the context is running, false if it has not got there in
 *  `ms`. WebKit leaves a resume() promise it will not grant pending for the life
 *  of the page, so the state - which it does report - is the thing to wait on. */
function whenRunning(ac: AudioContext, ms: number): Promise<boolean> {
  if (String(ac.state) === "running") return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      ac.removeEventListener("statechange", onChange);
      clearTimeout(timer);
      resolve(v);
    };
    const onChange = () => { if (String(ac.state) === "running") finish(true); };
    ac.addEventListener("statechange", onChange);
    const timer = setTimeout(() => finish(String(ac.state) === "running"), ms);
  });
}

export interface SamplePlayer {
  /** Key of the clip currently sounding, or null. */
  playing: string | null;
  /** Key of the clip being fetched, or null. */
  loading: string | null;
  /** Every key that has finished playing at least once. */
  heard: ReadonlySet<string>;
  /** Play `file` under `key`; clicking the sounding clip again stops it. */
  toggle: (key: string, file: string) => Promise<void>;
  stop: () => void;
  /** Hover hint: start fetching that clip so the click has nothing to wait for.
   *  Safe to call repeatedly - one request per clip, shared. */
  prime: (file?: string) => void;
  /** Fetch these in the background. */
  warm: (files: string[]) => void;
  /** Set when a play attempt produced no sound, so the UI can say why rather
   *  than appearing to ignore the click. Null once a clip starts. */
  problem: "blocked" | "failed" | null;
  /** Everything known about why sound is or is not happening, read fresh. For
   *  the reader to send back when a page that is entirely about listening does
   *  not play - on a phone there is no console to ask instead. */
  report: () => Report;
  /** Two isolating probes, each run wholly inside the click that calls it. The
   *  tone needs no network and no decoding, so it separates "this browser will
   *  not start Web Audio" from anything to do with clips; the element probe
   *  answers the same question for the route clips actually take. */
  testTone: () => Promise<string>;
  testElement: (file: string) => Promise<string>;
}

export interface Report {
  revision: string;
  /** How clips play. Web Audio is no longer used for them at all. */
  clipPath: "element";
  elementState: string;
  elementError: string | null;
  /** The tone probe's context, if it has ever been created. */
  toneContext: string;
  audioSession: string | null;
  lastError: string | null;
  cachedClips: number;
}

export function useSamplePlayer(base: string): SamplePlayer {
  const [playing, setPlaying] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<string | null>(null);
  const [heard, setHeard] = React.useState<Set<string>>(() => new Set());
  const [problem, setProblem] = React.useState<"blocked" | "failed" | null>(null);

  const elRef = React.useRef<HTMLAudioElement | null>(null);
  const playingRef = React.useRef<string | null>(null);
  const cacheRef = React.useRef<Map<string, string>>(new Map());
  const inflightRef = React.useRef<Map<string, Promise<string>>>(new Map());
  const warmedRef = React.useRef(false);
  const errRef = React.useRef<string | null>(null);
  const ctxRef = React.useRef<AudioContext | null>(null);

  /** One element for the life of the page, reused by changing src. iOS grants
   *  playback to an element the reader has started once and holds that grant as
   *  long as the same element is reused - a fresh one per clip would have to ask
   *  again, from a click that by then is over. */
  const element = React.useCallback(() => {
    if (!elRef.current) {
      elRef.current = new Audio();
      elRef.current.preload = "auto";
    }
    return elRef.current;
  }, []);

  /** Fetch a clip to a blob URL, once. Fetching to completion before playing is
   *  what guarantees the first word is there; the element never has to guess
   *  from download rate. Concurrent callers share one request. */
  const load = React.useCallback(
    (file: string): Promise<string> => {
      const hit = cacheRef.current.get(file);
      if (hit) return Promise.resolve(hit);
      const flying = inflightRef.current.get(file);
      if (flying) return flying;
      const p = fetch(base + file)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        })
        .then((b) => {
          const url = URL.createObjectURL(b);
          cacheRef.current.set(file, url);
          inflightRef.current.delete(file);
          return url;
        })
        .catch((e) => {
          inflightRef.current.delete(file);
          throw e;
        });
      inflightRef.current.set(file, p);
      return p;
    },
    [base]
  );

  const stop = React.useCallback(() => {
    const el = elRef.current;
    playingRef.current = null;
    if (el) {
      el.onended = null;
      el.pause();
    }
    setPlaying(null);
  }, []);

  /** Fetching on hover is worth more now than waking the output device was:
   *  the click's only remaining wait is the download, and a hover usually
   *  precedes it by long enough to cover a 20KB clip. */
  const prime = React.useCallback(
    (file?: string) => { if (file) void load(file).catch(() => {}); },
    [load]
  );

  const warm = React.useCallback(
    (files: string[]) => {
      if (warmedRef.current) return;
      warmedRef.current = true;
      const idle: (cb: () => void) => void =
        (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ??
        ((cb) => window.setTimeout(cb, 300) as unknown as void);
      idle(() => { files.forEach((f) => void load(f).catch(() => {})); });
    },
    [load]
  );

  const toggle = React.useCallback(
    async (key: string, file: string) => {
      if (playing === key) { stop(); return; }
      stop();

      // Point the element at something inside the click itself. Safari ties its
      // permission to the element, not to the page, and grants it on a play()
      // that happens while the gesture is live - so the first play of the page
      // must not wait on a fetch to get there. A cached clip is played straight
      // away; an uncached one gets play() called on the pending source, which is
      // the same element the reader just authorised.
      const el = element();
      setLoading(key);
      try {
        const cached = cacheRef.current.get(file);
        const url = cached ?? (await load(file));
        if (playingRef.current !== null && playingRef.current !== key) return;
        el.onended = null;
        el.src = url;
        el.currentTime = 0;
        await el.play();
        playingRef.current = key;
        el.onended = () => {
          if (playingRef.current !== key) return;
          playingRef.current = null;
          setPlaying(null);
          // Only a clip that ran to completion counts as heard; the ranking
          // dialog uses this to tell whether the listener actually listened.
          setHeard((h) => (h.has(key) ? h : new Set(h).add(key)));
        };
        setPlaying(key);
        setProblem(null);
      } catch (e) {
        errRef.current = String(e);
        setPlaying(null);
        // A refused play() is a policy answer; anything else is the clip itself.
        setProblem(/NotAllowed/i.test(String(e)) ? "blocked" : "failed");
      } finally {
        setLoading(null);
      }
    },
    [element, load, playing, stop]
  );

  const report = React.useCallback((): Report => {
    const el = elRef.current;
    const state = el
      ? `${el.paused ? "paused" : "playing"} at ${el.currentTime.toFixed(2)}s, readyState ${el.readyState}`
      : "not created";
    return {
      revision: MODULE_REVISION,
      clipPath: "element",
      elementState: state,
      elementError: el?.error ? `code ${el.error.code}` : null,
      toneContext: ctxRef.current ? String(ctxRef.current.state) : "not created",
      audioSession:
        (navigator as unknown as { audioSession?: { type: string } }).audioSession?.type ?? null,
      lastError: errRef.current,
      cachedClips: cacheRef.current.size,
    };
  }, []);

  /** A quarter-second sine through Web Audio, start to finish inside the calling
   *  gesture. Kept as a probe only: this is the path Safari would not play, and
   *  nothing a reader hears goes through it any more. */
  const testTone = React.useCallback(async () => {
    stop();
    if (!ctxRef.current) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return "this browser has no Web Audio at all";
      ctxRef.current = new AC();
    }
    const ac = ctxRef.current;
    if (String(ac.state) !== "running") {
      void ac.resume().catch(() => {});
      const ok = await whenRunning(ac, RESUME_GRACE_MS);
      if (!ok) return `no tone: context stuck at "${ac.state}"`;
    }
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0.15;                       // audible, not startling
    osc.frequency.value = 440;
    osc.connect(gain).connect(ac.destination);
    const t0 = ac.currentTime;
    osc.start();
    osc.stop(ac.currentTime + 0.25);
    await new Promise((r) => setTimeout(r, 400));
    return ac.currentTime > t0
      ? `tone played, context "${ac.state}", clock advanced ${(ac.currentTime - t0).toFixed(2)}s`
      : `no tone: context says "${ac.state}" but its clock did not move`;
  }, [stop]);

  const testElement = React.useCallback(async (file: string) => {
    stop();
    try {
      const el = element();
      el.src = base + file;
      await el.play();
      await new Promise((r) => setTimeout(r, 400));
      return el.currentTime > 0
        ? `element played, position ${el.currentTime.toFixed(2)}s`
        : "element accepted play() but its position never moved";
    } catch (e) {
      return `element refused: ${String(e)}`;
    }
  }, [base, element, stop]);

  React.useEffect(
    () => () => {
      const el = elRef.current;
      if (el) { el.onended = null; el.pause(); el.removeAttribute("src"); }
      for (const url of cacheRef.current.values()) URL.revokeObjectURL(url);
      void ctxRef.current?.close();
    },
    []
  );

  // Memoised so callers can put the player in an effect's dependency list
  // without it re-firing on every render of the table.
  return React.useMemo(
    () => ({ playing, loading, heard, toggle, stop, prime, warm, problem, report, testTone, testElement }),
    [playing, loading, heard, toggle, stop, prime, warm, problem, report, testTone, testElement]
  );
}
