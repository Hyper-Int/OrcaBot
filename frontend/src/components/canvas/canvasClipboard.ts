// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: canvas-clipboard-v1
const MODULE_REVISION = "canvas-clipboard-v1";
console.log(`[canvas-clipboard] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Copy and paste of canvas blocks (Cmd/Ctrl+C, Cmd/Ctrl+V), like the block menu's
 * Duplicate but for a whole selection: the copies keep their layout and the links
 * among them. Links to blocks that weren't copied are left out, and so is any link
 * with an integration block at either end: a terminal's link to Gmail or GitHub is
 * what grants it that access, so a paste must never grant it on its own.
 *
 * The clipboard is the system one (JSON with a marker, so a copy can be pasted in
 * another dashboard or tab), with an in-memory copy for browsers that don't fire the
 * paste event outside a text field. Keys typed into a terminal, a text field or a page
 * text selection keep their usual meaning.
 */

import * as React from "react";
import type { DashboardEdge, DashboardItem, Position, Size } from "@/types/dashboard";

export const CLIPBOARD_MARKER = "orcabot-canvas-clipboard-v1";
export const MAX_CLIPBOARD_ITEMS = 50;
const PASTE_OFFSET = 40;

export interface ClipboardBlock {
  key: string; // the copied item's id, to rebuild the links among the copies
  type: DashboardItem["type"];
  content: string;
  position: Position;
  size: Size;
  metadata?: Record<string, unknown>;
}

export interface ClipboardLink {
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface ClipboardPayload {
  marker: typeof CLIPBOARD_MARKER;
  blocks: ClipboardBlock[];
  links: ClipboardLink[];
}

/** The selected blocks and the links among them (none touching an integration block). */
export function buildClipboard(
  items: DashboardItem[],
  edges: DashboardEdge[],
  selectedIds: Iterable<string>,
  isIntegration: (type: string) => boolean,
): ClipboardPayload | null {
  const wanted = new Set(selectedIds);
  const blocks = items
    .filter((i) => wanted.has(i.id) || (i._stableKey !== undefined && wanted.has(i._stableKey)))
    .slice(0, MAX_CLIPBOARD_ITEMS)
    .map((i) => ({
      key: i.id,
      type: i.type,
      content: i.content,
      position: { ...i.position },
      size: { ...i.size },
      metadata: i.metadata ? { ...i.metadata, minimized: false } : undefined,
    }));
  if (blocks.length === 0) return null;
  const byKey = new Map(blocks.map((b) => [b.key, b]));
  const links = edges
    .filter((e) => byKey.has(e.sourceItemId) && byKey.has(e.targetItemId) && e.sourceItemId !== e.targetItemId)
    .filter((e) => !isIntegration(byKey.get(e.sourceItemId)!.type) && !isIntegration(byKey.get(e.targetItemId)!.type))
    .map((e) => ({ source: e.sourceItemId, target: e.targetItemId, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle }));
  return { marker: CLIPBOARD_MARKER, blocks, links };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** A clipboard text this dashboard can paste, or null (anything else is left alone). */
export function parseClipboard(text: string | null | undefined): ClipboardPayload | null {
  if (!text || !text.includes(CLIPBOARD_MARKER)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.marker !== CLIPBOARD_MARKER || !Array.isArray(raw.blocks)) return null;
  const blocks: ClipboardBlock[] = [];
  for (const b of raw.blocks.slice(0, MAX_CLIPBOARD_ITEMS)) {
    if (!isObj(b) || typeof b.key !== "string" || typeof b.type !== "string" || typeof b.content !== "string") continue;
    if (!isObj(b.position) || !num(b.position.x) || !num(b.position.y)) continue;
    if (!isObj(b.size) || !num(b.size.width) || !num(b.size.height)) continue;
    blocks.push({
      key: b.key,
      type: b.type as DashboardItem["type"],
      content: b.content,
      position: { x: b.position.x, y: b.position.y },
      size: { width: b.size.width, height: b.size.height },
      metadata: isObj(b.metadata) ? b.metadata : undefined,
    });
  }
  if (blocks.length === 0) return null;
  const keys = new Set(blocks.map((b) => b.key));
  const links = (Array.isArray(raw.links) ? raw.links : [])
    .filter((l): l is Record<string, unknown> => isObj(l))
    .filter((l) => typeof l.source === "string" && typeof l.target === "string" && keys.has(l.source) && keys.has(l.target))
    .map((l) => ({
      source: l.source as string,
      target: l.target as string,
      sourceHandle: typeof l.sourceHandle === "string" ? l.sourceHandle : undefined,
      targetHandle: typeof l.targetHandle === "string" ? l.targetHandle : undefined,
    }));
  return { marker: CLIPBOARD_MARKER, blocks, links };
}

/**
 * Where each pasted block goes: with the group's top-left at the pointer if there is one,
 * else offset from the originals (further for each repeated paste), keeping the layout.
 */
export function pastePositions(payload: ClipboardPayload, at: Position | null, nth: number): Position[] {
  const minX = Math.min(...payload.blocks.map((b) => b.position.x));
  const minY = Math.min(...payload.blocks.map((b) => b.position.y));
  const dx = at ? at.x - minX : PASTE_OFFSET * Math.max(1, nth);
  const dy = at ? at.y - minY : PASTE_OFFSET * Math.max(1, nth);
  return payload.blocks.map((b) => ({ x: Math.round(b.position.x + dx), y: Math.round(b.position.y + dy) }));
}

/** Focus is somewhere keys mean text (a terminal's input, a field, an editor). */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const h = el as HTMLElement;
  return h.tagName === "INPUT" || h.tagName === "TEXTAREA" || h.tagName === "SELECT" || h.isContentEditable
    || !!h.closest?.(".xterm, [contenteditable='true'], [role='dialog'], [role='menu']");
}

function hasTextSelection(): boolean {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
}

export interface CanvasClipboardOptions {
  enabled: boolean;
  /** Ids (or stable keys) of the selected canvas blocks */
  getSelectedIds: () => string[];
  getItems: () => DashboardItem[];
  getEdges: () => DashboardEdge[];
  isIntegration: (type: string) => boolean;
  /** The pointer's position on the canvas, or null if it isn't over the canvas */
  getPointerPosition: () => Position | null;
  paste: (payload: ClipboardPayload, positions: Position[]) => void | Promise<void>;
  onCopied?: (count: number) => void;
}

export function useCanvasClipboard(opts: CanvasClipboardOptions): void {
  const optsRef = React.useRef(opts);
  React.useLayoutEffect(() => {
    optsRef.current = opts;
  });

  React.useEffect(() => {
    if (!opts.enabled) return;
    let memory: ClipboardPayload | null = null;
    let memoryText = "";
    let pastes = 0; // repeated pastes of one copy step further away
    let pendingKeyPaste: number | null = null;

    const doPaste = (payload: ClipboardPayload) => {
      const o = optsRef.current;
      const text = JSON.stringify(payload);
      if (text !== memoryText) {
        memoryText = text;
        pastes = 0;
      }
      pastes += 1;
      void o.paste(payload, pastePositions(payload, o.getPointerPosition(), pastes));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== "c" && key !== "v") return;
      if (isTypingTarget(document.activeElement)) return;
      const o = optsRef.current;
      if (key === "c") {
        if (hasTextSelection()) return; // copying page text: the browser's
        const payload = buildClipboard(o.getItems(), o.getEdges(), o.getSelectedIds(), o.isIntegration);
        if (!payload) return;
        e.preventDefault();
        memory = payload;
        memoryText = JSON.stringify(payload);
        pastes = 0;
        void navigator.clipboard?.writeText(memoryText).catch(() => {
          /* the in-memory copy still works in this tab */
        });
        o.onCopied?.(payload.blocks.length);
        return;
      }
      // Cmd+V: the paste event below reads the system clipboard (it works across tabs).
      // Some browsers don't fire it outside a text field: then paste the in-memory copy.
      if (pendingKeyPaste !== null) window.clearTimeout(pendingKeyPaste);
      pendingKeyPaste = window.setTimeout(() => {
        pendingKeyPaste = null;
        if (memory) doPaste(memory);
      }, 60);
    };

    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(document.activeElement)) return;
      const payload = parseClipboard(e.clipboardData?.getData("text/plain"));
      if (pendingKeyPaste !== null) {
        window.clearTimeout(pendingKeyPaste);
        pendingKeyPaste = null;
      }
      if (!payload) {
        // Something else is on the system clipboard; a canvas copy made in this tab still pastes.
        if (memory && !e.clipboardData?.getData("text/plain")) doPaste(memory);
        return;
      }
      e.preventDefault();
      doPaste(payload);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onPaste);
      if (pendingKeyPaste !== null) window.clearTimeout(pendingKeyPaste);
    };
  }, [opts.enabled]);
}
