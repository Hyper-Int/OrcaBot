// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-sample-player-v3-no-await-resume
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
//
// Two WebKit rules follow from that, and breaking either one produces a play
// button that does nothing at all:
//   - Never await a resume() promise. Chrome settles one it will not grant;
//     WebKit leaves it pending for the lifetime of the page, so an await on it
//     is a deadlock. Wait on the "statechange" event and a timeout instead.
//   - Never ask to resume without activation to spend - a hover, say. It cannot
//     be granted, and it is what leaves those pending promises lying around.

import * as React from "react";

const MODULE_REVISION = "tts-sample-player-v3-no-await-resume";
if (typeof window !== "undefined") {
  console.log(`[tts-sample-player] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

/** A clip in both playable forms. `buffer` is null only if decoding failed, in
 *  which case the element fallback is the sole way to hear it. */
interface Clip {
  buffer: AudioBuffer | null;
  url: string;
}

/** How long a play waits for a resumed context before calling it blocked. Long
 *  enough for the real thing (tens of ms), short enough that a refusal reaches
 *  the reader as a message rather than as a button that never comes back. */
const RESUME_GRACE_MS = 600;

/** How long after starting a clip to check that the audio clock actually moved.
 *  Long enough to be unambiguous, short enough that the swap is barely heard. */
const SILENT_CLOCK_MS = 350;

/** Resolve true once the context is running, false if it has not got there in
 *  `ms`. The statechange event is the only signal WebKit reports reliably: it
 *  will happily leave the resume() promise pending forever instead. */
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
  /** Key of the clip being fetched/decoded, or null. */
  loading: string | null;
  /** Every key that has finished playing at least once. */
  heard: ReadonlySet<string>;
  /** Play `file` under `key`; clicking the sounding clip again stops it. */
  toggle: (key: string, file: string) => Promise<void>;
  stop: () => void;
  /** Hover hint that wakes the output device early. Never resumes the context;
   *  the click does that, because only the click carries user activation. */
  prime: () => void;
  /** Decode these in the background once the context is live. */
  warm: (files: string[]) => void;
  /** Set when a play attempt produced no sound, so the UI can say why rather
   *  than appearing to ignore the click. Null once a clip starts. */
  problem: "blocked" | "failed" | null;
  /** Everything known about why sound is or is not happening, read fresh. For
   *  the reader to send back when a page that is entirely about listening does
   *  not play - on a phone there is no console to ask instead. */
  report: () => Report;
  /** Two isolating probes, each run wholly inside the click that calls it.
   *  A tone needs no network and no decoding, so it separates "this browser
   *  will not start Web Audio" from "our fetch or decode path is broken"; the
   *  element probe answers the same question for the fallback route. */
  testTone: () => Promise<string>;
  testElement: (file: string) => Promise<string>;
}

export interface Report {
  revision: string;
  contextState: string;
  sampleRate: number | null;
  /** Whether the audio clock is advancing - the one signal that distinguishes
   *  a context that is really running from one that only says so. */
  clockMoving: boolean | null;
  audioSession: string | null;
  lastPath: "web-audio" | "element" | null;
  lastError: string | null;
  cachedClips: number;
}

export function useSamplePlayer(base: string): SamplePlayer {
  const [playing, setPlaying] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<string | null>(null);
  const [heard, setHeard] = React.useState<Set<string>>(() => new Set());
  const [problem, setProblem] = React.useState<"blocked" | "failed" | null>(null);

  const ctxRef = React.useRef<AudioContext | null>(null);
  const cacheRef = React.useRef<Map<string, Clip>>(new Map());
  const elRef = React.useRef<HTMLAudioElement | null>(null);
  const elPlayingRef = React.useRef<string | null>(null);
  const currentRef = React.useRef<AudioBufferSourceNode | null>(null);
  const primedRef = React.useRef(false);
  const warmedRef = React.useRef(false);
  const pathRef = React.useRef<"web-audio" | "element" | null>(null);
  const lastClockRef = React.useRef<number | null>(null);
  const errRef = React.useRef<string | null>(null);

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
    // Read through String() on purpose: TypeScript narrows ac.state and does
    // not know resume() can change it, so a direct comparison is rejected as
    // impossible.
    if (String(ac.state) === "running") return true;
    // Nudge it again, but never await the promise. Chrome settles a refused
    // resume(); WebKit leaves it pending indefinitely, so awaiting one here
    // deadlocks the play - the button sits on "loading" forever and no sound
    // ever comes, which is worse than an honest failure. Wait on the state
    // instead, which WebKit does report.
    void ac.resume().catch(() => { /* refused outside a gesture */ });
    return whenRunning(ac, RESUME_GRACE_MS);
  }, [ctx]);

  /** Push a half-second of silence to wake the output device. No-op unless the
   *  context is already running, and only ever done once. */
  const pushSilence = React.useCallback(() => {
    const ac = ctx();
    if (primedRef.current || String(ac.state) !== "running") return;
    primedRef.current = true;
    const s = ac.createBufferSource();
    s.buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * 0.5), ac.sampleRate);
    s.connect(ac.destination);
    s.start();
  }, [ctx]);

  /** Wake the context. Must be called synchronously from the click, before any
   *  await, because that is the only moment the gesture is still spendable. */
  const wake = React.useCallback(() => {
    const ac = ctx();
    if (String(ac.state) === "running") { pushSilence(); return; }
    // Anything else - "suspended", or WebKit's non-standard "interrupted" -
    // needs resuming. Deliberately not awaited anywhere: see ensureRunning.
    void ac.resume().then(pushSilence, () => { /* refused */ });
  }, [ctx, pushSilence]);

  /** Hover hint. Only wakes the output device, never asks for the context to
   *  resume: a hover carries no activation, so that request cannot be granted,
   *  and on WebKit it leaves a promise pending for the rest of the page's life. */
  const prime = React.useCallback(() => { pushSilence(); }, [pushSilence]);

  /** Fetch a clip once and keep both playable forms of it: the decoded PCM for
   *  Web Audio, and a blob URL for the media-element fallback. The blob is made
   *  before decodeAudioData, which detaches the ArrayBuffer it is handed. A
   *  decode failure is not fatal - the element can still play the bytes. */
  const load = React.useCallback(
    async (file: string): Promise<Clip> => {
      const hit = cacheRef.current.get(file);
      if (hit) return hit;
      const res = await fetch(base + file);
      const bytes = await res.arrayBuffer();
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      let buffer: AudioBuffer | null = null;
      try { buffer = await ctx().decodeAudioData(bytes); } catch { /* element path remains */ }
      const clip: Clip = { buffer, url };
      cacheRef.current.set(file, clip);
      return clip;
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
    const el = elRef.current;
    if (el) {
      el.onended = null;
      el.pause();
    }
    elPlayingRef.current = null;
    setPlaying(null);
  }, []);

  /** The same clip through an <audio> element. WebKit governs media elements
   *  with a much lighter policy than an AudioContext - no suspend-after-silence,
   *  no interruption to recover from, and a play() that rejects honestly when it
   *  is refused instead of leaving a promise pending. The bytes are already
   *  local by this point, so the clip still starts whole, which is the reason
   *  Web Audio was chosen in the first place. */
  const playElement = React.useCallback(async (key: string, url: string) => {
    const el = elRef.current ?? (elRef.current = new Audio());
    el.onended = null;
    el.pause();
    el.src = url;
    el.currentTime = 0;
    await el.play();
    elPlayingRef.current = key;
    pathRef.current = "element";
    el.onended = () => {
      if (elPlayingRef.current !== key) return;
      elPlayingRef.current = null;
      setPlaying(null);
      setHeard((h) => (h.has(key) ? h : new Set(h).add(key)));
    };
    setPlaying(key);
    setProblem(null);
  }, []);

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
      // First statement in the click, before any await: the activation that
      // authorises the resume exists only here.
      wake();
      if (playing === key) { stop(); return; }
      stop();
      setLoading(key);
      try {
        const clip = await load(file);
        // load() is a network fetch, so the user gesture is long gone by now.
        // Re-assert the context before spending the source on silence.
        const running = await ensureRunning();
        if (!running || !clip.buffer) {
          // Starting a source here would consume it and play nothing at all,
          // which is indistinguishable from a dead button. The element does not
          // answer to whatever refused the context, so try that before giving up.
          console.log(
            `[tts-sample-player] REVISION: ${MODULE_REVISION} context ${ctx().state}` +
              `, falling back to <audio> at ${new Date().toISOString()}`
          );
          try {
            await playElement(key, clip.url);
          } catch (e) {
            errRef.current = String(e);
            setProblem("blocked");
          }
          return;
        }
        const src = ctx().createBufferSource();
        src.buffer = clip.buffer;
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
        pathRef.current = "web-audio";
        const clockAtStart = ctx().currentTime;
        src.start();
        setPlaying(key);
        setProblem(null);

        // "running" is a claim, not a guarantee: WebKit will report it while the
        // audio session is held by something else, and the clip plays to an
        // audience of nobody. currentTime is the honest signal - it is the
        // hardware's own clock and only advances while samples are being pulled.
        // If it has not moved at all by now, nothing was heard, so hand this
        // clip to the element instead of leaving the reader with a moving
        // progress state and silence.
        window.setTimeout(() => {
          if (currentRef.current !== src) return;
          if (ctx().currentTime > clockAtStart) return;
          console.log(
            `[tts-sample-player] REVISION: ${MODULE_REVISION} context claims ` +
              `${ctx().state} but its clock is frozen; switching to <audio> at ${new Date().toISOString()}`
          );
          currentRef.current = null;
          src.onended = null;
          try { src.stop(); } catch { /* already ended */ }
          void playElement(key, clip.url).catch(() => setProblem("blocked"));
        }, SILENT_CLOCK_MS);
      } catch (e) {
        errRef.current = String(e);
        setPlaying(null);
        setProblem("failed");
      } finally {
        setLoading(null);
      }
    },
    [ctx, load, ensureRunning, playElement, playing, wake, stop]
  );

  /** Read fresh on every call - a snapshot taken at render would be stale by
   *  the time anyone read it. */
  const report = React.useCallback((): Report => {
    const ac = ctxRef.current;
    let clockMoving: boolean | null = null;
    if (ac) {
      // Two reads a moment apart is the only honest test, but a synchronous
      // report cannot wait: compare against the last one instead.
      const t = ac.currentTime;
      clockMoving = lastClockRef.current === null ? null : t > lastClockRef.current;
      lastClockRef.current = t;
    }
    return {
      revision: MODULE_REVISION,
      contextState: ac ? String(ac.state) : "not created",
      sampleRate: ac?.sampleRate ?? null,
      clockMoving,
      audioSession:
        (navigator as unknown as { audioSession?: { type: string } }).audioSession?.type ?? null,
      lastPath: pathRef.current,
      lastError: errRef.current,
      cachedClips: cacheRef.current.size,
    };
  }, []);

  /** A quarter-second sine, start to finish inside the calling gesture. No
   *  fetch, no decode, no buffer - if this is silent, the browser is refusing
   *  Web Audio outright rather than objecting to anything we do with clips. */
  const testTone = React.useCallback(async () => {
    stop();
    const ac = ctx();
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
    const moved = ac.currentTime > t0;
    return moved
      ? `tone played, context "${ac.state}", clock advanced ${(ac.currentTime - t0).toFixed(2)}s`
      : `no tone: context says "${ac.state}" but its clock did not move`;
  }, [ctx, stop]);

  /** The same question for the fallback route, which answers to a different
   *  policy in WebKit than the context does. */
  const testElement = React.useCallback(async (file: string) => {
    stop();
    try {
      const el = elRef.current ?? (elRef.current = new Audio());
      el.src = base + file;
      await el.play();
      await new Promise((r) => setTimeout(r, 400));
      return el.currentTime > 0
        ? `element played, position ${el.currentTime.toFixed(2)}s`
        : "element accepted play() but its position never moved";
    } catch (e) {
      return `element refused: ${String(e)}`;
    }
  }, [base, stop]);

  // Coming back to a backgrounded tab is the common way to find the context
  // interrupted. The page has sticky activation from the play that started all
  // this, so this resume often succeeds and the next click is instant; when it
  // does not, the click resumes it anyway and nothing is lost by trying.
  React.useEffect(() => {
    const onVisible = () => {
      const ac = ctxRef.current;
      if (!ac || document.visibilityState !== "visible" || ac.state === "running") return;
      // Fire and forget, like every other resume here - nothing waits on it.
      void ac.resume().catch(() => { /* needs a gesture; the play supplies one */ });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  React.useEffect(
    () => () => {
      try { currentRef.current?.stop(); } catch { /* already ended */ }
      const el = elRef.current;
      if (el) { el.onended = null; el.pause(); el.removeAttribute("src"); }
      for (const clip of cacheRef.current.values()) URL.revokeObjectURL(clip.url);
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
