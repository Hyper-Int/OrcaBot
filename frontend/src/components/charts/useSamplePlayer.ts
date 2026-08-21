// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-sample-player-v7-unlock-from-any-gesture
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
// No AudioContext is constructed at all any more. The probes that established
// the above have served their purpose and are gone with it.

import * as React from "react";

/** A single silent MP3 frame, inline so claiming the gesture costs no request.
 *  Played only to spend the activation on the element before a clip download. */
const SILENT_MP3 =
  "data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA" +
  "gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID/////////////////////" +
  "//////////////////////////////8AAAA5TEFNRTMuOTlyAc0AAAAAAAAAABSAJAJAQgAAgAAAAnGMHkkIAAAA";

const MODULE_REVISION = "tts-sample-player-v7-unlock-from-any-gesture";
if (typeof window !== "undefined") {
  console.log(`[tts-sample-player] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
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
  /** Claim playback permission for the element. Must be called from inside a
   *  user gesture; needed by anything that will start a clip later, after the
   *  activation that authorised it has expired. */
  unlock: () => void;
  /** Set when a play attempt produced no sound, so the UI can say why rather
   *  than appearing to ignore the click. Null once a clip starts. */
  problem: "blocked" | "failed" | null;
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
  /** Bumped on every toggle and every stop, so a fetch that lands after the
   *  reader has moved on knows it is stale. Without it two clips loading at
   *  once both pass the check - neither is playing yet - and whichever
   *  resolves last takes the element, which may be the earlier click. */
  const genRef = React.useRef(0);
  /** Whether this element has ever played. The first play is the only one that
   *  needs a live gesture; after it the element keeps the grant. */
  const unlockedRef = React.useRef(false);

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
    genRef.current++;
    playingRef.current = null;
    if (el) {
      el.onended = null;
      el.pause();
    }
    setPlaying(null);
  }, []);

  /** Claim playback permission for the element while a gesture is live.
   *
   *  Safari ties the permission to the element rather than to the page, and
   *  grants it on a play() made during a user gesture. Anything that waits -
   *  a download, a dialog closing, a React effect - happens after the
   *  activation is gone, so the grant has to be taken first. Half a
   *  millisecond of silence does it, and every later play inherits it.
   *
   *  Callable from any gesture, not just a play click: the ranking dialog
   *  calls it as it closes, so the clip the reader originally asked for can
   *  still start once the dialog is out of the way. */
  const unlock = React.useCallback(() => {
    if (unlockedRef.current) return;
    const el = element();
    unlockedRef.current = true;
    el.src = SILENT_MP3;
    void el.play().catch(() => { unlockedRef.current = false; });
  }, [element]);

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

      const el = element();
      const gen = ++genRef.current;

      // Nothing to wait for on a cached clip, so the grant can be taken by the
      // real play(). Otherwise claim it before the download starts.
      if (!cacheRef.current.has(file)) unlock();

      setLoading(key);
      try {
        const url = cacheRef.current.get(file) ?? (await load(file));
        // Stale: the reader clicked something else, or stopped, while this was
        // in flight. Checking a generation rather than "is anything playing"
        // catches the case where neither clip has started yet.
        if (genRef.current !== gen) return;
        el.onended = null;
        el.src = url;
        el.currentTime = 0;
        await el.play();
        if (genRef.current !== gen) { el.pause(); return; }
        unlockedRef.current = true;
        playingRef.current = key;
        el.onended = () => {
          if (genRef.current !== gen || playingRef.current !== key) return;
          playingRef.current = null;
          setPlaying(null);
          // Only a clip that ran to completion counts as heard; the ranking
          // dialog uses this to tell whether the listener actually listened.
          setHeard((h) => (h.has(key) ? h : new Set(h).add(key)));
        };
        setPlaying(key);
        setProblem(null);
      } catch (e) {
        // Logged as well as shown: the message on the page tells the reader
        // what happened, this tells whoever they report it to.
        console.warn(`[tts-sample-player] REVISION: ${MODULE_REVISION} play failed:`, e);
        setPlaying(null);
        // A refused play() is a policy answer; anything else is the clip itself.
        setProblem(/NotAllowed/i.test(String(e)) ? "blocked" : "failed");
      } finally {
        setLoading(null);
      }
    },
    [element, load, playing, stop, unlock]
  );

  React.useEffect(
    () => () => {
      const el = elRef.current;
      if (el) { el.onended = null; el.pause(); el.removeAttribute("src"); }
      for (const url of cacheRef.current.values()) URL.revokeObjectURL(url);
    },
    []
  );

  // Memoised so callers can put the player in an effect's dependency list
  // without it re-firing on every render of the table.
  return React.useMemo(
    () => ({ playing, loading, heard, toggle, stop, prime, warm, unlock, problem }),
    [playing, loading, heard, toggle, stop, prime, warm, unlock, problem]
  );
}
