"use client";

// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: vnc-viewer-v1-native-rfb
//
// Native noVNC (RFB) viewer — no iframe. Renders the remote framebuffer onto a
// canvas inside a plain <div> that lives directly in the React Flow node, so the
// browser block is a first-class canvas citizen: pan/zoom and pointer events are
// handled by React (no cross-origin iframe swallowing events), connection state is
// available to the parent (drives the status indicator), and clipboard bridges
// straight to navigator.clipboard.
//
// Only the noVNC *client* lives here; the WebSocket still connects to the sandbox's
// websockify (proxied via the control plane), which is the actual VNC pixel stream.
//
// RFB is imported dynamically inside the effect so it never runs during SSR (it
// touches window/document/WebSocket at construction).

import * as React from "react";

const MODULE_REVISION = "vnc-viewer-v1-native-rfb";
if (typeof console !== "undefined") {
  console.log(`[VncViewer] REVISION: ${MODULE_REVISION} loaded`);
}

export type VncConnectionState = "connecting" | "connected" | "disconnected";

interface VncViewerProps {
  /** Full ws(s):// URL to the websockify endpoint (incl. any auth query params). */
  wsUrl: string;
  /** Bump to force a fresh reconnect (e.g. the reload button). */
  reloadKey?: number;
  viewOnly?: boolean;
  /** noVNC quality 0-9 (higher = better image, more bandwidth). */
  qualityLevel?: number;
  /** noVNC compression 0-9. */
  compressionLevel?: number;
  onConnectionState?: (state: VncConnectionState) => void;
  className?: string;
  /** Current React Flow canvas zoom (transform scale). noVNC maps pointer events
   *  via getBoundingClientRect (which includes this ancestor CSS transform) but
   *  divides by an internal scale that does NOT — its ResizeObserver never fires on
   *  an ancestor `transform`. That makes clicks land off by the zoom factor (only
   *  correct at 100%). We use this to compensate the coordinate conversion. */
  zoom?: number;
}

export function VncViewer({
  wsUrl,
  reloadKey = 0,
  viewOnly = false,
  qualityLevel = 6,
  compressionLevel = 3,
  onConnectionState,
  className,
  zoom = 1,
}: VncViewerProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Keep latest callbacks/options in refs so the connect effect only re-runs when
  // the URL or reloadKey changes — not on every parent re-render.
  const onStateRef = React.useRef(onConnectionState);
  onStateRef.current = onConnectionState;
  const optsRef = React.useRef({ viewOnly, qualityLevel, compressionLevel });
  optsRef.current = { viewOnly, qualityLevel, compressionLevel };
  // Live zoom, read by the patched pointer-coordinate conversion below. Updated
  // without reconnecting the RFB.
  const zoomRef = React.useRef(zoom);
  zoomRef.current = zoom || 1;

  React.useEffect(() => {
    const container = containerRef.current;
    if (!wsUrl || !container) return;

    let cancelled = false;
    let rfb: import("@novnc/novnc").default | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    const emit = (state: VncConnectionState) => {
      if (!cancelled) onStateRef.current?.(state);
    };

    const connect = async () => {
      const { default: RFB } = await import("@novnc/novnc");
      if (cancelled || !containerRef.current) return;
      emit("connecting");

      const r = new RFB(containerRef.current, wsUrl, { wsProtocols: ["binary"] });
      rfb = r;

      // Compensate for React Flow's CSS zoom on pointer input. noVNC's Display
      // converts an element-relative coordinate to a framebuffer coordinate via
      // `absX(x) = x / _scale`. `x` comes from getBoundingClientRect and so includes
      // the ancestor `transform: scale(zoom)`, but `_scale` does not (noVNC's
      // ResizeObserver doesn't fire on ancestor transforms), so clicks land off by
      // `zoom`. Pre-dividing the input by the live zoom cancels it: at zoom=1 this is
      // a no-op. Guarded + best-effort so a noVNC internals change can't break input.
      try {
        const disp = (r as unknown as { _display?: {
          absX: (x: number) => number;
          absY: (y: number) => number;
        } })._display;
        if (disp && typeof disp.absX === "function" && typeof disp.absY === "function") {
          const origAbsX = disp.absX.bind(disp);
          const origAbsY = disp.absY.bind(disp);
          disp.absX = (x: number) => origAbsX(x / (zoomRef.current || 1));
          disp.absY = (y: number) => origAbsY(y / (zoomRef.current || 1));
        }
      } catch {
        /* noVNC internals changed — leave input mapping as-is */
      }
      const { viewOnly: vo, qualityLevel: q, compressionLevel: c } = optsRef.current;
      // Ask the server (x11vnc/Xvfb) to resize its framebuffer to the node so the
      // page FILLS the block. Falls back to scaleViewport (aspect-fit) when the
      // server can't resize — in which case the leftover is painted with `background`
      // (a neutral dark, NOT the old jarring #ffffff that read as a big white border).
      r.scaleViewport = true;
      r.resizeSession = true;
      r.background = "#0d1117";
      r.qualityLevel = q;
      r.compressionLevel = c;
      r.viewOnly = vo;
      r.showDotCursor = true;

      r.addEventListener("connect", () => {
        attempts = 0;
        emit("connected");
      });

      r.addEventListener("disconnect", () => {
        emit("disconnected");
        if (cancelled) return;
        // Auto-reconnect with light backoff — websockify/x11vnc may still be coming
        // up, or the VM may have briefly suspended. Capped so it stays responsive.
        attempts += 1;
        const delay = Math.min(1000 * attempts, 5000);
        reconnectTimer = setTimeout(() => {
          if (!cancelled) void connect();
        }, delay);
      });

      // Bridge the remote clipboard to the host — no iframe/postMessage needed.
      r.addEventListener("clipboard", (e: Event) => {
        const text = (e as CustomEvent<{ text?: string }>).detail?.text;
        if (text && navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).catch(() => {});
        }
      });
    };

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        rfb?.disconnect();
      } catch {
        /* already torn down */
      }
    };
  }, [wsUrl, reloadKey]);

  return <div ref={containerRef} className={className} />;
}

export default VncViewer;
