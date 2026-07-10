// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: browser-v8-bringtofront-loop-fix

"use client";

import * as React from "react";
import { type NodeProps, type Node, useReactFlow, useStore } from "@xyflow/react";
import { Globe, RefreshCw, X, Minimize2, Settings, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import { BlockSettingsFooter } from "./BlockSettingsFooter";
import { VncViewer, type VncConnectionState } from "./VncViewer";
import { useTerminalOverlay } from "@/components/terminal";
import { HelpButton } from "@/components/help/HelpDialog";
import { browserDoc } from "@/docs/content/browser";
import { API, DEV_MODE_ENABLED } from "@/config/env";
import { ensureSurfaceToken, getCachedSurfaceToken } from "@/lib/tauri-bridge";
import { ApiError } from "@/lib/api/client";
import { perfStart, perfMark, perfEnd, perfCancel, perfActive } from "@/lib/perf";
import { getDashboardBrowserStatus, openDashboardBrowser, startDashboardBrowser, stopDashboardBrowser } from "@/lib/api/cloudflare/dashboards";
import { useAuthStore } from "@/stores/auth-store";
import type { DashboardItem } from "@/types/dashboard";

interface BrowserData extends Record<string, unknown> {
  content: string;
  size: { width: number; height: number };
  dashboardId?: string;
  metadata?: { minimized?: boolean; [key: string]: unknown };
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  onDuplicate?: () => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type BrowserNode = Node<BrowserData, "browser">;

type BrowserLease = {
  count: number;
  stopTimer?: number;
};

const browserLeases = new Map<string, BrowserLease>();

function retainBrowser(dashboardId: string) {
  const lease = browserLeases.get(dashboardId) || { count: 0 };
  lease.count += 1;
  if (lease.stopTimer) {
    window.clearTimeout(lease.stopTimer);
    lease.stopTimer = undefined;
  }
  browserLeases.set(dashboardId, lease);
  if (lease.count === 1) {
    return startDashboardBrowser(dashboardId);
  }
  return Promise.resolve();
}

function releaseBrowser(dashboardId: string) {
  const lease = browserLeases.get(dashboardId);
  if (!lease) return;
  lease.count = Math.max(0, lease.count - 1);
  if (lease.count === 0 && !lease.stopTimer) {
    lease.stopTimer = window.setTimeout(() => {
      const current = browserLeases.get(dashboardId);
      if (!current || current.count > 0) return;
      stopDashboardBrowser(dashboardId).catch(() => {});
      browserLeases.delete(dashboardId);
    }, 5000);
  }
  browserLeases.set(dashboardId, lease);
}

export function BrowserBlock({ id, data, selected }: NodeProps<BrowserNode>) {
  const { deleteElements } = useReactFlow();
  const [status, setStatus] = React.useState<"idle" | "starting" | "running" | "error">("idle");
  const [vncState, setVncState] = React.useState<VncConnectionState>("connecting");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const lastOpenedRef = React.useRef<string | null>(null);
  const user = useAuthStore((state) => state.user);
  // Live canvas zoom (React Flow transform scale) — passed to VncViewer so it can
  // correct noVNC's pointer mapping under zoom (clicks otherwise drift when not 100%).
  const canvasZoom = useStore((s) => s.transform[2]);
  // Desktop surface token for the VNC WS. Resolve it async (the sync cache can be
  // null on an early load); when it arrives the vncWsUrl memo recomputes and the
  // RFB reconnects with `&surface=`. Cross-origin WS gets no session cookie, so
  // this is the only dev-auth proof the control plane accepts.
  const [surfaceToken, setSurfaceToken] = React.useState<string | null>(
    getCachedSurfaceToken()
  );
  React.useEffect(() => {
    let active = true;
    void ensureSurfaceToken().then((t) => {
      if (active) setSurfaceToken(t);
    });
    return () => {
      active = false;
    };
  }, []);
  const isMinimized = data.metadata?.minimized === true;
  const overlay = useTerminalOverlay();
  // IMPORTANT: depend on the stable `bringToFront` callback, NOT the whole `overlay`
  // object. The overlay context value is rebuilt on every zIndexVersion change, so
  // depending on `overlay` here makes the effect re-fire → bringToFront → version
  // bump → re-fire → infinite loop (React #185 "max update depth"). bringToFront is
  // a useCallback([]) so it's stable.
  const bringToFront = overlay?.bringToFront;

  // Bring the browser block to front like any other component. Two paths:
  // 1) when it becomes selected (keyboard/click on chrome), mirror TerminalBlock; and
  // 2) a capture-phase pointerdown, because the noVNC canvas consumes the event for
  //    VNC input before React Flow can select the node (the old iframe had the same
  //    issue, which is why the browser historically couldn't pop to front).
  React.useEffect(() => {
    if (selected) bringToFront?.(id);
  }, [selected, id, bringToFront]);
  const handleBringToFront = React.useCallback(() => {
    bringToFront?.(id);
  }, [bringToFront, id]);
  const [expandAnimation, setExpandAnimation] = React.useState<string | null>(null);
  const [isAnimatingMinimize, setIsAnimatingMinimize] = React.useState(false);
  const minimizeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return () => {
      if (minimizeTimeoutRef.current) clearTimeout(minimizeTimeoutRef.current);
    };
  }, []);

  const handleMinimize = () => {
    const expandedSize = data.size; // Capture before resize
    setIsAnimatingMinimize(true);
    data.onItemChange?.({
      metadata: { ...data.metadata, expandedSize },
      size: MINIMIZED_SIZE,
    });
    minimizeTimeoutRef.current = setTimeout(() => {
      setIsAnimatingMinimize(false);
      data.onItemChange?.({
        metadata: { ...data.metadata, minimized: true, expandedSize },
      });
    }, 350);
  };

  const handleExpand = () => {
    const savedSize = data.metadata?.expandedSize as { width: number; height: number } | undefined;
    setExpandAnimation("animate-expand-bounce");
    setTimeout(() => setExpandAnimation(null), 300);
    data.onItemChange?.({
      metadata: { ...data.metadata, minimized: false },
      size: savedSize || { width: 900, height: 650 },
    });
  };

  const dashboardId = data.dashboardId;

  // All hooks must be called before any early return to satisfy React's rules of hooks
  React.useEffect(() => {
    if (isMinimized) return; // Skip browser lifecycle when minimized
    if (!dashboardId) {
      setStatus("error");
      setErrorMessage("Missing dashboard id.");
      return;
    }

    let cancelled = false;
    // Perf: time browser start → ready (dominated by chromium cold-boot when the
    // VM isn't pre-warmed). perfEnd fires when the sandbox reports running+ready.
    perfStart(`browser:${dashboardId}`);
    setStatus("starting");
    setErrorMessage(null);

    retainBrowser(dashboardId)
      .catch((err) => {
        if (!cancelled) {
          const message = err instanceof ApiError && err.message
            ? err.message
            : "Failed to start browser.";
          setErrorMessage(message);
        }
      })
      .finally(() => {
        if (cancelled) return;
        perfMark(`browser:${dashboardId}`, "retained");
        let attempts = 0;
        const poll = async () => {
          attempts += 1;
          if (attempts % 6 === 0) {
            startDashboardBrowser(dashboardId).catch(() => {});
          }
          const statusResponse = await getDashboardBrowserStatus(dashboardId);
          if (cancelled) return;
          if (statusResponse?.running && statusResponse?.ready !== false) {
            perfEnd(`browser:${dashboardId}`, `ready (after ${attempts} polls)`);
            setStatus("running");
            setErrorMessage(null);
            return;
          }
          if (attempts >= 40) {
            perfCancel(`browser:${dashboardId}`);
            setStatus("error");
            setErrorMessage("Browser failed to start.");
            return;
          }
          setTimeout(poll, 500);
        };
        void poll();
      });

    return () => {
      cancelled = true;
      perfCancel(`browser:${dashboardId}`);
      releaseBrowser(dashboardId);
    };
  }, [dashboardId, isMinimized]);

  React.useEffect(() => {
    if (!dashboardId || status !== "running") {
      return;
    }
    const url = typeof data.content === "string" ? data.content.trim() : "";
    if (!url || url === lastOpenedRef.current) {
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      return;
    }
    lastOpenedRef.current = url;
    openDashboardBrowser(dashboardId, url).catch(() => {});
  }, [dashboardId, status, data.content]);

  // WebSocket URL to the sandbox's websockify (VNC pixel stream), proxied via the
  // control plane. Only the WS goes to the sandbox now — the noVNC client itself is
  // bundled in the frontend (VncViewer), not served through the proxy.
  const vncWsUrl = React.useMemo(() => {
    if (!dashboardId) return "";
    const httpUrl = `${API.cloudflare.dashboards}/${dashboardId}/browser/websockify`;
    const wsUrl = httpUrl.replace(/^http/i, "ws"); // https→wss, http→ws
    const params = new URLSearchParams();
    if (DEV_MODE_ENABLED && user) {
      params.set("user_id", user.id);
      params.set("user_email", user.email);
      params.set("user_name", user.name);
    }
    // Desktop gates dev-auth on the surface token; a WS can't send the header, so
    // pass it as a query param (null on web / non-surface builds → omitted).
    if (surfaceToken) {
      params.set("surface", surfaceToken);
    }
    const qs = params.toString();
    return qs ? `${wsUrl}?${qs}` : wsUrl;
  }, [dashboardId, user, surfaceToken]);

  // Times the VNC client phase (WS handshake → first frame), i.e. the part this
  // native-noVNC change actually targets — separate from chromium cold-boot.
  // Emits: [perf] vnc:<dashboardId> total=<ms> painted=+<ms>
  const handleVncState = React.useCallback(
    (state: VncConnectionState) => {
      setVncState(state);
      const key = `vnc:${dashboardId}`;
      if (state === "connecting" && !perfActive(key)) perfStart(key);
      if (state === "connected") perfEnd(key, "painted");
    },
    [dashboardId]
  );

  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <span title="Browser icon">
        <Globe className="w-3.5 h-3.5 text-[var(--foreground-subtle)]" />
      </span>
      <div className="text-xs text-[var(--foreground-muted)]">
        {status === "running"
          ? vncState === "connected"
            ? "Browser"
            : vncState === "disconnected"
              ? "Reconnecting…"
              : "Connecting…"
          : status === "starting"
            ? "Starting browser..."
            : "Browser stopped"}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <HelpButton doc={browserDoc} />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setRefreshKey((prev) => prev + 1)}
          disabled={status !== "running"}
          title="Reload browser"
          className="nodrag"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="nodrag" title="Settings">
              <Settings className="w-3.5 h-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem onClick={() => data.onDuplicate?.()} className="gap-2">
              <Copy className="w-3 h-3" />
              <span>Duplicate</span>
            </DropdownMenuItem>
            <BlockSettingsFooter nodeId={id} onMinimize={handleMinimize} />
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleMinimize}
          title="Minimize"
          className="nodrag"
        >
          <Minimize2 className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            deleteElements({ nodes: [{ id }] });
          }}
          title="Close browser"
          className="nodrag"
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );

  // Minimized view - only show when fully minimized (not during animation)
  if (isMinimized && !isAnimatingMinimize) {
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={<Globe className="w-14 h-14 text-[var(--foreground-subtle)]" />}
        label={status === "running" ? "Browser" : status === "starting" ? "Starting..." : "Stopped"}
        onExpand={handleExpand}
        connectorsVisible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    );
  }

  return (
    <BlockWrapper
      selected={selected}
      className={cn("p-0 flex flex-col overflow-visible", expandAnimation)}
      minWidth={200}
      minHeight={30}
      includeHandles={false}
    >
      {/* All content fades during minimize */}
      <div
        className={cn("flex flex-col flex-1 min-h-0", isAnimatingMinimize && "animate-content-fade-out")}
        onPointerDownCapture={handleBringToFront}
      >
        {header}

        <div className="relative flex-1 min-h-0 bg-white flex flex-col">
          {/* Native noVNC (RFB) — no iframe. Remote→host clipboard is bridged in
              VncViewer (ServerCutText → navigator.clipboard.writeText). Host→remote
              paste still needs wiring (rfb.clipboardPasteFrom on host copy). */}
          {status === "running" && vncWsUrl ? (
            <div className="relative flex-1 min-h-0">
              <VncViewer
                wsUrl={vncWsUrl}
                reloadKey={refreshKey}
                onConnectionState={handleVncState}
                zoom={canvasZoom}
                className="w-full h-full"
              />
              {vncState !== "connected" && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--foreground-muted)] bg-white/70 pointer-events-none">
                  {vncState === "disconnected" ? "Reconnecting to browser…" : "Connecting to browser…"}
                </div>
              )}
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--foreground-muted)]">
              {errorMessage || "Starting browser..."}
            </div>
          )}
        </div>
      </div>
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    </BlockWrapper>
  );
}

export default BrowserBlock;
