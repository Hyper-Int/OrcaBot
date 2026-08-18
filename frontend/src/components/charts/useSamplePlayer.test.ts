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

  async resume() {
    this.resumeCalls++;
    if (!gesture) {
      this.refusedResumes++;
      throw new Error("NotAllowedError");
    }
    this.setState("running");
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

  it("reports blocked rather than pretending to play when resume is refused", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    // No gesture at all - what a scripted play would look like.
    act(() => { void result.current.toggle("kokoro", "kokoro.mp3"); });
    await act(async () => {
      releaseFetches();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.playing).toBeNull();
    expect(result.current.problem).toBe("blocked");
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
