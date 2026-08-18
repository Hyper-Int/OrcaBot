// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Safari suspends an AudioContext that has been silent for a while, and
// interrupts one whose tab is backgrounded. Coming back needs resume() from
// inside a user gesture - and a gesture does not survive an await, so the
// resume has to be issued in the synchronous part of the click, before the
// clip is fetched.
//
// The fake below enforces exactly that rule: resume() succeeds only while
// `gesture` is true, and the test turns it off before releasing the fetch. A
// player that resumes only after decoding therefore fails these tests, which is
// what the real page did - the first plays worked, then Safari suspended the
// context and every later click was refused.

import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSamplePlayer } from "./useSamplePlayer";

/** Stands in for user activation. Safari drops it at the first await. */
let gesture = false;
/** How a refused resume() behaves: "reject" is Chrome, "hang" is WebKit. */
let refuseMode: "reject" | "hang" = "reject";
/** Whether the <audio> fallback is allowed to play. */
let elementPlays = true;
/** A context can report "running" while its clock stands still - iOS does this
 *  when the audio session is held elsewhere, and the clip is inaudible. */
let clockFrozen = false;
let elements: FakeAudio[] = [];

/** jsdom has no working HTMLMediaElement playback, so the fallback needs one. */
class FakeAudio {
  src = "";
  currentTime = 0;
  paused = true;
  onended: (() => void) | null = null;
  constructor() { elements.push(this); }
  play() {
    if (!elementPlays) return Promise.reject(new Error("NotAllowedError"));
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  removeAttribute() {}
}
let contexts: FakeContext[] = [];
/** Fetches resolve only when the test says so, so "during the gesture" and
 *  "after the gesture" are ordering facts rather than timer races. */
let pendingFetches: Array<() => void> = [];

class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  connect() {}
  start() { this.started = true; }
  stop() {}
}

class FakeContext {
  state = "suspended";
  get currentTime() { return clockFrozen ? 0 : performance.now() / 1000; }
  sampleRate = 48000;
  destination = {};
  resumeCalls = 0;
  /** resume() calls that were issued with no gesture behind them. */
  refusedResumes = 0;
  sources: FakeSource[] = [];
  private listeners: Array<() => void> = [];

  constructor() { contexts.push(this); }

  addEventListener(type: string, cb: () => void) {
    if (type === "statechange") this.listeners.push(cb);
  }
  removeEventListener() {}

  /** What WebKit does on its own: silence suspension, or an interruption. */
  setState(s: string) {
    this.state = s;
    for (const l of this.listeners) l();
  }

  /** WebKit does not reject a resume it will not grant - it leaves the promise
   *  pending for good. `refuseMode` picks which browser this fake imitates. */
  resume(): Promise<void> {
    this.resumeCalls++;
    if (!gesture) {
      this.refusedResumes++;
      return refuseMode === "hang"
        ? new Promise<void>(() => { /* never settles, as WebKit does */ })
        : Promise.reject(new Error("NotAllowedError"));
    }
    this.setState("running");
    return Promise.resolve();
  }

  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createBuffer() { return { duration: 0.5 }; }
  async decodeAudioData() { return { fake: true }; }
  async close() { this.setState("closed"); }
}

function releaseFetches() {
  const queued = pendingFetches;
  pendingFetches = [];
  for (const r of queued) r();
}

/** One click: the synchronous part runs under a gesture, then activation is
 *  dropped and the clip download is allowed to complete - the real order. */
async function click(play: () => void) {
  gesture = true;
  act(() => { play(); });
  gesture = false;
  await act(async () => {
    releaseFetches();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  gesture = false;
  refuseMode = "reject";
  elementPlays = true;
  clockFrozen = false;
  elements = [];
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:clip", revokeObjectURL: () => {} });
  contexts = [];
  pendingFetches = [];
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("fetch", () =>
    new Promise((resolve) => {
      pendingFetches.push(() => resolve({ arrayBuffer: async () => new ArrayBuffer(8) }));
    })
  );
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("useSamplePlayer", () => {
  it("plays the first clip", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("kokoro", "kokoro.mp3"));

    expect(result.current.playing).toBe("kokoro");
    expect(result.current.problem).toBeNull();
  });

  it("plays again after WebKit suspends the context between clips", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("kokoro", "kokoro.mp3"));
    act(() => { result.current.stop(); });

    // Minutes pass with nothing sounding; Safari powers the context down.
    act(() => { contexts[0].setState("suspended"); });

    await click(() => void result.current.toggle("piper", "piper.mp3"));

    expect(result.current.problem).toBeNull();
    expect(result.current.playing).toBe("piper");
    expect(contexts[0].sources.at(-1)?.started).toBe(true);
    // The recovery must come from the in-gesture resume, not from a hopeful
    // one issued after the download - that is the call Safari rejects.
    expect(contexts[0].refusedResumes).toBe(0);
  });

  it("survives repeated suspensions, not just the first", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    for (const key of ["a", "b", "c", "d"]) {
      act(() => { contexts[0]?.setState("suspended"); });
      await click(() => void result.current.toggle(key, `${key}.mp3`));
      expect(result.current.playing).toBe(key);
      act(() => { result.current.stop(); });
    }
    expect(contexts[0].refusedResumes).toBe(0);
  });

  it("reports blocked rather than pretending to play when nothing may play", async () => {
    elementPlays = false;
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    // No gesture at all - what a scripted play would look like. The report
    // comes after the grace period, since a resume granted late still counts.
    act(() => { void result.current.toggle("kokoro", "kokoro.mp3"); });
    await act(async () => {
      releaseFetches();
      await new Promise((r) => setTimeout(r, 900));
    });

    expect(result.current.playing).toBeNull();
    expect(result.current.problem).toBe("blocked");
  });

  it("falls back to an element when the context will not run", async () => {
    // Whatever WebKit is refusing the context - autoplay policy, a stuck
    // interruption - a media element answers to a different, lighter policy,
    // and the bytes are already local so the clip still starts whole.
    refuseMode = "hang";
    const { result } = renderHook(() => useSamplePlayer("/a/"));

    act(() => { void result.current.toggle("kokoro", "kokoro.mp3"); });
    await act(async () => {
      releaseFetches();
      await new Promise((r) => setTimeout(r, 900));
    });

    expect(result.current.playing).toBe("kokoro");
    expect(result.current.problem).toBeNull();
    expect(elements.at(-1)?.paused).toBe(false);
    // Nothing was played through Web Audio - the source would have been silent.
    expect(contexts[0].sources.some((s) => s.started && s.buffer)).toBe(false);
  });

  it("counts a clip heard through the fallback, and stops it on demand", async () => {
    refuseMode = "hang";
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    act(() => { void result.current.toggle("kokoro", "kokoro.mp3"); });
    await act(async () => {
      releaseFetches();
      await new Promise((r) => setTimeout(r, 900));
    });

    act(() => { elements.at(-1)!.onended?.(); });
    expect(result.current.heard.has("kokoro")).toBe(true);
    expect(result.current.playing).toBeNull();

    // And a second clip stopped mid-way leaves nothing sounding.
    act(() => { void result.current.toggle("piper", "piper.mp3"); });
    await act(async () => {
      releaseFetches();
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(result.current.playing).toBe("piper");
    act(() => { result.current.stop(); });
    expect(result.current.playing).toBeNull();
    expect(elements.at(-1)?.paused).toBe(true);
  });

  it("switches to the element when the context runs but makes no sound", async () => {
    // The nastiest shape of this: everything reports success and the reader
    // hears nothing. Only the audio clock gives it away.
    clockFrozen = true;
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("kokoro", "kokoro.mp3"));

    // Web Audio was used first - it claimed to be running.
    expect(contexts[0].sources.at(-1)?.started).toBe(true);
    expect(result.current.playing).toBe("kokoro");

    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });

    expect(elements.at(-1)?.paused).toBe(false);
    expect(result.current.playing).toBe("kokoro");
    expect(result.current.problem).toBeNull();
  });

  // The pair below are the WebKit shape of the problem. Safari does not reject
  // a resume it will not grant, it simply never answers - so any code that
  // awaits one stops dead, and the play button does nothing at all rather than
  // failing visibly.
  it("plays on WebKit, where a refused resume never settles", async () => {
    refuseMode = "hang";
    const { result } = renderHook(() => useSamplePlayer("/a/"));

    // Hovering the button first is what a mouse user always does, and it used
    // to leave a permanently pending resume behind for the click to await.
    act(() => { result.current.prime(); });

    let settled = false;
    gesture = true;
    act(() => { void result.current.toggle("kokoro", "kokoro.mp3").then(() => { settled = true; }); });
    gesture = false;
    await act(async () => {
      releaseFetches();
      await Promise.race([
        new Promise((r) => setTimeout(r, 300)),
        new Promise((r) => setTimeout(r, 0)),
      ]);
    });

    expect(settled).toBe(true);
    expect(result.current.playing).toBe("kokoro");
    expect(result.current.loading).toBeNull();
  });

  it("gives up and says blocked rather than hanging on a promise WebKit never answers", async () => {
    refuseMode = "hang";
    // Nothing may play at all, so the only way out of the click is the timeout.
    elementPlays = false;
    const { result } = renderHook(() => useSamplePlayer("/a/"));

    act(() => { void result.current.toggle("kokoro", "kokoro.mp3"); });
    await act(async () => {
      releaseFetches();
      await new Promise((r) => setTimeout(r, 900));
    });

    expect(result.current.problem).toBe("blocked");
    // The spinner has to come back too - the finally clause only runs if the
    // await above ever returned.
    expect(result.current.loading).toBeNull();
    expect(result.current.playing).toBeNull();
  });

  it("clears the playing state when a clip is interrupted mid-flight", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("kokoro", "kokoro.mp3"));
    expect(result.current.playing).toBe("kokoro");

    // Another app takes the audio session. onended will never fire, so without
    // the statechange listener the button stays stuck showing "stop".
    act(() => { contexts[0].setState("interrupted"); });

    expect(result.current.playing).toBeNull();
  });

  it("does not count an interrupted clip as heard", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("kokoro", "kokoro.mp3"));
    const src = contexts[0].sources.at(-1)!;

    act(() => { contexts[0].setState("interrupted"); });
    // A late onended from the abandoned source must not mark it listened to;
    // the ranking dialog gates on `heard`.
    act(() => { src.onended?.(); });

    expect(result.current.heard.has("kokoro")).toBe(false);
  });
});
