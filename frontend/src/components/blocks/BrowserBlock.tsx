// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { Globe, RefreshCw, X } from "lucide-react";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { Button } from "@/components/ui";
import { API, DEV_MODE_ENABLED } from "@/config/env";
import { ApiError } from "@/lib/api/client";
import { getDashboardBrowserStatus, openDashboardBrowser, startDashboardBrowser, stopDashboardBrowser } from "@/lib/api/cloudflare/dashboards";
import { useAuthStore } from "@/stores/auth-store";
import type { DashboardItem } from "@/types/dashboard";

interface BrowserData extends Record<string, unknown> {
  content: string;
  size: { width: number; height: number };
  dashboardId?: string;
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
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
  const [status, setStatus] = React.useState<"idle" | "starting" | "running" | "error">("idle");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const lastOpenedRef = React.useRef<string | null>(null);
  const user = useAuthStore((state) => state.user);

  const dashboardId = data.dashboardId;

  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <span title="Browser icon">
        <Globe className="w-3.5 h-3.5 text-[var(--foreground-subtle)]" />
      </span>
      <div className="text-xs text-[var(--foreground-muted)]">
        {status === "running" ? "Browser" : status === "starting" ? "Starting browser..." : "Browser stopped"}
      </div>
      <div className="ml-auto flex items-center gap-1">
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
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            if (!dashboardId) return;
            stopDashboardBrowser(dashboardId).finally(() => {
              setStatus("idle");
            });
          }}
          disabled={!dashboardId || status === "idle"}
          title="Stop browser"
          className="nodrag"
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );

  React.useEffect(() => {
    if (!dashboardId) {
      setStatus("error");
      setErrorMessage("Missing dashboard id.");
      return;
    }

    let cancelled = false;
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
        let attempts = 0;
        const poll = async () => {
          attempts += 1;
          if (attempts % 6 === 0) {
            startDashboardBrowser(dashboardId).catch(() => {});
          }
          const statusResponse = await getDashboardBrowserStatus(dashboardId);
          if (cancelled) return;
          if (statusResponse?.running && statusResponse?.ready !== false) {
            setStatus("running");
            setErrorMessage(null);
            return;
          }
          if (attempts >= 40) {
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
      releaseBrowser(dashboardId);
    };
  }, [dashboardId]);

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

  const browserUrl = React.useMemo(() => {
    if (!dashboardId) return "";
    const baseUrl = `${API.cloudflare.dashboards}/${dashboardId}/browser/`;
    const params = new URLSearchParams({
      autoconnect: "1",
      resize: "scale",
      show_dot: "true",
      path: `dashboards/${dashboardId}/browser/websockify`,
    });
    if (DEV_MODE_ENABLED && user) {
      params.set("user_id", user.id);
      params.set("user_email", user.email);
      params.set("user_name", user.name);
    }
    return `${baseUrl}?${params.toString()}`;
  }, [dashboardId, user]);

  return (
    <BlockWrapper
      selected={selected}
      className="p-0 flex flex-col overflow-visible"
      minWidth={200}
      minHeight={30}
      includeHandles={false}
    >
      {header}

      <div className="relative flex-1 min-h-0 bg-white flex flex-col">
        {status === "running" && browserUrl ? (
          <div className="flex-1 min-h-0">
            <iframe
              key={refreshKey}
              title="Browser"
              src={browserUrl}
              className="w-full h-full"
            />
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--foreground-muted)]">
            {errorMessage || "Starting browser..."}
          </div>
        )}
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
