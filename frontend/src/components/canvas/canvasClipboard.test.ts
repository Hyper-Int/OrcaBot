// REVISION: canvas-clipboard-v1
import { describe, expect, it } from "vitest";
import { buildClipboard, CLIPBOARD_MARKER, isTypingTarget, parseClipboard, pastePositions } from "./canvasClipboard";
import type { DashboardEdge, DashboardItem } from "@/types/dashboard";

const item = (id: string, type: string, x: number, y: number, extra: Partial<DashboardItem> = {}): DashboardItem => ({
  id, dashboardId: "d", type: type as DashboardItem["type"], content: `{"name":"${id}"}`,
  position: { x, y }, size: { width: 400, height: 300 }, createdAt: "", updatedAt: "", ...extra,
});
const edge = (s: string, t: string): DashboardEdge => ({
  id: `${s}-${t}`, dashboardId: "d", sourceItemId: s, targetItemId: t, sourceHandle: "right-out", targetHandle: "left-in",
  createdAt: "", updatedAt: "",
});
const isIntegration = (t: string) => t === "gmail" || t === "github";

// A PokerBench-like canvas: an engine, two agent terminals linked to it, a Gmail block on one.
const items = [
  item("engine", "terminal", 0, 0),
  item("codex", "terminal", 500, 0, { metadata: { minimized: true } }),
  item("claude", "terminal", 500, 400, { _stableKey: "temp-claude" }),
  item("gmail", "gmail", 1000, 0),
];
const edges = [edge("codex", "engine"), edge("claude", "engine"), edge("gmail", "codex")];

describe("canvas clipboard", () => {
  it("copies the selected blocks and only the links among them", () => {
    const p = buildClipboard(items, edges, ["codex", "temp-claude", "gmail"], isIntegration)!;
    expect(p.blocks.map((b) => b.key)).toEqual(["codex", "claude", "gmail"]);
    expect(p.blocks[0].metadata).toEqual({ minimized: false }); // pasted open
    // codex→engine: engine not copied; gmail→codex: an integration link (grants access) — both left out
    expect(p.links).toEqual([]);
    const withEngine = buildClipboard(items, edges, ["engine", "codex", "claude"], isIntegration)!;
    expect(withEngine.links.map((l) => `${l.source}>${l.target}`)).toEqual(["codex>engine", "claude>engine"]);
    expect(buildClipboard(items, edges, [], isIntegration)).toBeNull();
  });

  it("round-trips through the system clipboard text and rejects anything else", () => {
    const p = buildClipboard(items, edges, ["engine", "codex"], isIntegration)!;
    expect(parseClipboard(JSON.stringify(p))).toEqual(p);
    expect(parseClipboard("hello")).toBeNull();
    expect(parseClipboard(`{"marker":"${CLIPBOARD_MARKER}"`)).toBeNull(); // broken JSON
    const tampered = parseClipboard(JSON.stringify({
      marker: CLIPBOARD_MARKER,
      blocks: [{ key: "a", type: "note", content: "x", position: { x: 1, y: 2 }, size: { width: 3, height: 4 } },
               { key: "b", type: "note", content: 5, position: { x: 1, y: 2 }, size: { width: 3, height: 4 } }],
      links: [{ source: "a", target: "zzz" }, { source: "a", target: "a", sourceHandle: 7 }],
    }))!;
    expect(tampered.blocks.map((b) => b.key)).toEqual(["a"]);
    expect(tampered.links).toEqual([{ source: "a", target: "a", sourceHandle: undefined, targetHandle: undefined }]);
  });

  it("pastes at the pointer keeping the layout, else offset further each time", () => {
    const p = buildClipboard(items, edges, ["codex", "claude"], isIntegration)!;
    expect(pastePositions(p, { x: 100, y: 50 }, 1)).toEqual([{ x: 100, y: 50 }, { x: 100, y: 450 }]);
    expect(pastePositions(p, null, 1)).toEqual([{ x: 540, y: 40 }, { x: 540, y: 440 }]);
    expect(pastePositions(p, null, 2)).toEqual([{ x: 580, y: 80 }, { x: 580, y: 480 }]);
  });

  it("leaves keys alone while typing in a terminal or a field", () => {
    const term = document.createElement("div");
    term.className = "xterm";
    const helper = document.createElement("textarea");
    term.appendChild(helper);
    const inXterm = document.createElement("span");
    term.appendChild(inXterm);
    expect(isTypingTarget(helper)).toBe(true);
    expect(isTypingTarget(inXterm)).toBe(true);
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
