// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Clips play through an <audio> element because Safari would not play Web Audio
// on this page at all - a reader's test tone was silent while the same clip
// through an element played. So these tests are about the element: that it is
// reused rather than recreated (iOS ties its permission to the element), that a
// refusal is reported instead of swallowed, and that the clip is fully fetched
// before it is played, which is the guarantee Web Audio used to provide.
//
// The AudioContext stub is a tripwire rather than a fake: nothing here may
// construct one.

import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSamplePlayer } from "./useSamplePlayer";

let elementPlays: "yes" | "notallowed" | "error" = "yes";
let elements: FakeAudio[] = [];
let fetches: string[] = [];
let pendingFetches: Array<() => void> = [];
let contextsBuilt = 0;

class FakeAudio {
  src = "";
  preload = "";
  currentTime = 0;
  paused = true;
  readyState = 4;
  error: { code: number } | null = null;
  onended: (() => void) | null = null;
  constructor() { elements.push(this); }
  play() {
    if (elementPlays === "notallowed") return Promise.reject(new Error("NotAllowedError: gesture"));
    if (elementPlays === "error") return Promise.reject(new Error("NotSupportedError"));
    this.paused = false;
    this.currentTime = 0.2;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  removeAttribute() {}
}

/** Not a fake so much as a tripwire. Safari will not play Web Audio on this
 *  page, so constructing a context is now a bug by definition. */
class ForbiddenContext {
  constructor() { contextsBuilt++; }
}

function releaseFetches() {
  const q = pendingFetches;
  pendingFetches = [];
  for (const r of q) r();
}

/** One click, then the download completing after it - the real order. */
async function click(play: () => void) {
  act(() => { play(); });
  await act(async () => {
    releaseFetches();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  elementPlays = "yes";
  contextsBuilt = 0;
  elements = [];
  fetches = [];
  pendingFetches = [];
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", ForbiddenContext);
  vi.stubGlobal("webkitAudioContext", ForbiddenContext);
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:clip", revokeObjectURL: () => {} });
  vi.stubGlobal("fetch", (u: string) => {
    fetches.push(u);
    return new Promise((resolve) => {
      pendingFetches.push(() => resolve({ ok: true, status: 200, blob: async () => ({ size: 8 }) }));
    });
  });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("useSamplePlayer", () => {
  it("plays a clip through the element", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("kokoro", "kokoro.mp3"));

    expect(result.current.playing).toBe("kokoro");
    expect(result.current.problem).toBeNull();
    expect(result.current.loading).toBeNull();
    expect(elements.at(-1)?.paused).toBe(false);
  });

  it("fetches the whole clip before playing it", async () => {
    // Web Audio was originally chosen because an element started from a URL can
    // begin before the file has arrived and swallow the first word. Fetching to
    // a blob first keeps that guarantee without Web Audio.
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("kokoro", "kokoro.mp3"));

    expect(fetches).toEqual(["/a/kokoro.mp3"]);
    expect(elements.at(-1)?.src.startsWith("blob:")).toBe(true);
  });

  it("reuses one element across clips", async () => {
    // iOS grants playback to the element the reader started, not to the page.
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("a", "a.mp3"));
    await click(() => void result.current.toggle("b", "b.mp3"));

    expect(elements.length).toBe(1);
    expect(result.current.playing).toBe("b");
  });

  it("fetches each clip once, however often it is played", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("a", "a.mp3"));
    act(() => { result.current.stop(); });
    await click(() => void result.current.toggle("a", "a.mp3"));

    expect(fetches).toEqual(["/a/a.mp3"]);
  });

  it("stops when the sounding clip is clicked again", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("a", "a.mp3"));
    await act(async () => { await result.current.toggle("a", "a.mp3"); });

    expect(result.current.playing).toBeNull();
    expect(elements.at(-1)?.paused).toBe(true);
  });

  it("counts a clip heard only when it runs to the end", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("a", "a.mp3"));
    expect(result.current.heard.has("a")).toBe(false);

    act(() => { elements.at(-1)!.onended?.(); });
    expect(result.current.heard.has("a")).toBe(true);
    expect(result.current.playing).toBeNull();
  });

  it("does not count a clip that was stopped part-way", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("a", "a.mp3"));
    const el = elements.at(-1)!;
    act(() => { result.current.stop(); });
    act(() => { el.onended?.(); });

    expect(result.current.heard.has("a")).toBe(false);
  });

  it("says blocked when the browser refuses to play", async () => {
    elementPlays = "notallowed";
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("a", "a.mp3"));

    expect(result.current.problem).toBe("blocked");
    expect(result.current.playing).toBeNull();
    expect(result.current.loading).toBeNull();
  });

  it("distinguishes a clip that will not load from one that is refused", async () => {
    elementPlays = "error";
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("a", "a.mp3"));

    expect(result.current.problem).toBe("failed");
  });


  it("never touches Web Audio", async () => {
    // The path Safari refuses. Playing, stopping, switching and prefetching must
    // not construct a context, or the failure this replaced comes back.
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("a", "a.mp3"));
    act(() => { result.current.stop(); });
    await click(() => void result.current.toggle("b", "b.mp3"));
    act(() => { result.current.prime("c.mp3"); });

    expect(contextsBuilt).toBe(0);
  });

  it("plays the clip that was clicked last, not the one that loads last", async () => {
    // Both clips are still loading, so neither is "playing" yet - the guard has
    // to be a generation, not a check for whether something is sounding.
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    act(() => { void result.current.toggle("first", "first.mp3"); });
    act(() => { void result.current.toggle("second", "second.mp3"); });
    await act(async () => {
      // Deliberately settle them out of order: the earlier click lands last.
      const [a, b] = pendingFetches;
      pendingFetches = [];
      b(); a();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(result.current.playing).toBe("second");
  });

  it("does not resurrect a clip that was stopped while it was loading", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    act(() => { void result.current.toggle("a", "a.mp3"); });
    act(() => { result.current.stop(); });
    await act(async () => {
      releaseFetches();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(result.current.playing).toBeNull();
  });

  it("claims the gesture before downloading an uncached clip", async () => {
    // Safari grants playback to the element on a play() made while the click is
    // live. An uncached clip has a fetch in the way, so a silent frame is played
    // first to take the grant while it is still there.
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    act(() => { void result.current.toggle("a", "a.mp3"); });

    expect(elements[0]?.src.startsWith("data:audio/mpeg")).toBe(true);
    expect(elements[0]?.paused).toBe(false);

    await act(async () => {
      releaseFetches();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(elements[0]?.src).toBe("blob:clip");
    expect(result.current.playing).toBe("a");
  });

  it("does not spend a silent frame when the clip is already cached", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("a", "a.mp3"));
    act(() => { result.current.stop(); });
    const srcs: string[] = [];
    Object.defineProperty(elements[0], "src", {
      get() { return this._s ?? ""; },
      set(v: string) { this._s = v; srcs.push(v); },
    });
    await click(() => void result.current.toggle("a", "a.mp3"));

    expect(srcs.some((u) => u.startsWith("data:"))).toBe(false);
    expect(result.current.playing).toBe("a");
  });

  it("can take the playback grant from a gesture that is not a play click", async () => {
    // The ranking dialog closes on a click, and the clip the reader originally
    // asked for starts afterwards, from an effect with no activation of its
    // own. unlock() is how that gesture is spent on the reader's behalf.
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    act(() => { result.current.unlock(); });

    expect(elements[0]?.src.startsWith("data:audio/mpeg")).toBe(true);
    expect(elements[0]?.paused).toBe(false);

    const srcs: string[] = [];
    Object.defineProperty(elements[0], "src", {
      get() { return this._s ?? ""; },
      set(v: string) { this._s = v; srcs.push(v); },
    });
    await click(() => void result.current.toggle("a", "a.mp3"));

    // Already granted, so no second silent frame - and the clip still plays.
    expect(srcs.some((u) => u.startsWith("data:"))).toBe(false);
    expect(result.current.playing).toBe("a");
  });

  it("only claims the grant once", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    act(() => { result.current.unlock(); });
    act(() => { result.current.unlock(); });
    act(() => { result.current.unlock(); });

    expect(elements.length).toBe(1);
    expect(elements[0]?.src.startsWith("data:")).toBe(true);
  });
});
