// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Clips play through an <audio> element because Safari would not play Web Audio
// on this page at all - a reader's test tone was silent while the same clip
// through an element played. So these tests are about the element: that it is
// reused rather than recreated (iOS ties its permission to the element), that a
// refusal is reported instead of swallowed, and that the clip is fully fetched
// before it is played, which is the guarantee Web Audio used to provide.
//
// The tone probe still exercises Web Audio, and its fake keeps the WebKit rule
// that a resume it will not grant never settles - so a probe that awaited one
// would hang the very diagnostics that exist to explain a hang.

import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSamplePlayer } from "./useSamplePlayer";

let elementPlays: "yes" | "notallowed" | "error" = "yes";
let elements: FakeAudio[] = [];
let fetches: string[] = [];
let pendingFetches: Array<() => void> = [];
/** Whether a resume the fake context refuses hangs (WebKit) or rejects. */
let resumeHangs = false;

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

class FakeContext {
  state = "suspended";
  currentTime = 0;
  destination = {};
  private listeners: Array<() => void> = [];
  addEventListener(t: string, cb: () => void) { if (t === "statechange") this.listeners.push(cb); }
  removeEventListener() {}
  resume(): Promise<void> {
    if (resumeHangs) return new Promise<void>(() => { /* WebKit: never answers */ });
    this.state = "running";
    for (const l of this.listeners) l();
    return Promise.resolve();
  }
  createOscillator() { return { frequency: { value: 0 }, connect: (n: unknown) => n, start() {}, stop() {} }; }
  createGain() { return { gain: { value: 0 }, connect: (n: unknown) => n }; }
  async close() {}
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
  resumeHangs = false;
  elements = [];
  fetches = [];
  pendingFetches = [];
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", FakeContext);
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

  it("reports what it knows, without needing a console", async () => {
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("a", "a.mp3"));
    const r = result.current.report();

    expect(r.clipPath).toBe("element");
    expect(r.revision).toContain("element-first");
    expect(r.elementState).toContain("playing");
    expect(r.cachedClips).toBe(1);
  });

  it("keeps the tone probe out of playback entirely", async () => {
    // Safari would not play the tone. Nothing a reader hears may depend on it,
    // so a context must not even exist until the probe is run.
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    await click(() => void result.current.toggle("a", "a.mp3"));
    expect(result.current.report().toneContext).toBe("not created");

    await act(async () => { await result.current.testTone(); });
    expect(result.current.report().toneContext).toBe("running");
  });

  it("the tone probe answers rather than hanging when WebKit will not resume", async () => {
    resumeHangs = true;
    const { result } = renderHook(() => useSamplePlayer("/a/"));
    let answer = "";
    await act(async () => { answer = await result.current.testTone(); });

    expect(answer).toContain("stuck at");
  });
});
