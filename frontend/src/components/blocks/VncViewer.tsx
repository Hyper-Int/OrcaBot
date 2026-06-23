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
}

export function VncViewer({
  wsUrl,
  reloadKey = 0,
  viewOnly = false,
  qualityLevel = 6,
  compressionLevel = 3,
  onConnectionState,
  className,
}: VncViewerProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Keep latest callbacks/options in refs so the connect effect only re-runs when
  // the URL or reloadKey changes — not on every parent re-render.
  const onStateRef = React.useRef(onConnectionState);
  onStateRef.current = onConnectionState;
  const optsRef = React.useRef({ viewOnly, qualityLevel, compressionLevel });
  optsRef.current = { viewOnly, qualityLevel, compressionLevel };

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
      const { viewOnly: vo, qualityLevel: q, compressionLevel: c } = optsRef.current;
      r.scaleViewport = true; // fit the 1280x720 framebuffer to the (resizable) node
      r.resizeSession = false;
      r.background = "#ffffff";
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
