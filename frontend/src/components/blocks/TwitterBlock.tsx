// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: twitter-block-v3-rename-to-x

"use client";

const MODULE_REVISION = "twitter-block-v3-rename-to-x";
console.log(`[TwitterBlock] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import {
  RefreshCw,
  Loader2,
  Settings,
  LogOut,
  Minimize2,
  Copy,
  CheckCircle,
  Eye,
  EyeOff,
} from "lucide-react";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { API } from "@/config/env";
import { apiGet, apiDelete, apiPost } from "@/lib/api/client";
import type { DashboardItem } from "@/types/dashboard";
import { BlockSettingsFooter } from "./BlockSettingsFooter";

// ============================================
// Types
// ============================================

interface TwitterIntegration {
  connected: boolean;
  username: string | null;
}

// ============================================
// API helpers
// ============================================

async function getTwitterIntegration(dashboardId: string): Promise<TwitterIntegration> {
  const url = new URL(`${API.cloudflare.base}/integrations/twitter`);
  url.searchParams.set("dashboard_id", dashboardId);
  try {
    return await apiGet<TwitterIntegration>(url.toString());
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
      return { connected: false, username: null };
    }
    throw err;
  }
}

async function saveTwitterCredentials(bearerToken: string): Promise<{ username: string }> {
  return apiPost<{ username: string }>(`${API.cloudflare.base}/integrations/twitter/credentials`, {
    bearer_token: bearerToken,
  });
}

async function disconnectTwitter(dashboardId: string): Promise<{ ok: boolean }> {
  const url = new URL(`${API.cloudflare.base}/integrations/twitter`);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiDelete<{ ok: boolean }>(url.toString());
}

// ============================================
// X logo
// ============================================

function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-label="X">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

// ============================================
// Component
// ============================================

interface TwitterData extends Record<string, unknown> {
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

type TwitterNode = Node<TwitterData, "twitter">;

export function TwitterBlock({ id, data, selected }: NodeProps<TwitterNode>) {
  const dashboardId = data.dashboardId;
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const isMinimized = data.metadata?.minimized === true;
  const [expandAnimation, setExpandAnimation] = React.useState<string | null>(null);
  const [isAnimatingMinimize, setIsAnimatingMinimize] = React.useState(false);
  const minimizeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (minimizeTimeoutRef.current) clearTimeout(minimizeTimeoutRef.current);
    };
  }, []);

  const handleMinimize = () => {
    const expandedSize = data.size;
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
      size: savedSize || { width: 320, height: 300 },
    });
  };

  // Integration state
  const [connected, setConnected] = React.useState(false);
  const [username, setUsername] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  // Credentials form state
  const [bearerToken, setBearerToken] = React.useState("");
  const [showToken, setShowToken] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const initialLoadDone = React.useRef(false);
  const loadedKeyRef = React.useRef<string | null>(null);

  const loadIntegration = React.useCallback(async () => {
    if (!dashboardId) return;
    try {
      if (!initialLoadDone.current) setLoading(true);
      setError(null);
      const data = await getTwitterIntegration(dashboardId);
      setConnected(data.connected);
      setUsername(data.username);
      initialLoadDone.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load X");
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  React.useEffect(() => {
    if (!dashboardId) return;
    const key = `${dashboardId}:${id}`;
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    initialLoadDone.current = false;
    loadIntegration();
  }, [dashboardId, id, loadIntegration]);

  const handleRefresh = async () => {
    if (!dashboardId) return;
    setRefreshing(true);
    try { await loadIntegration(); } finally { setRefreshing(false); }
  };

  const handleSave = async () => {
    if (!bearerToken.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveTwitterCredentials(bearerToken.trim());
      setConnected(true);
      setUsername(null);
      setBearerToken("");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Invalid Bearer Token");
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!dashboardId) return;
    try {
      await disconnectTwitter(dashboardId);
      setConnected(false);
      setUsername(null);
    } catch (err) {
      console.error("Failed to disconnect X:", err);
    }
  };

  // Header
  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <XLogo className="w-3.5 h-3.5 text-[var(--foreground)]" />
      <div className="text-xs text-[var(--foreground-muted)] truncate flex-1">
        {username ? `@${username}` : "X"}
      </div>
      <div className="flex items-center gap-1">
        {connected && (
          <Button variant="ghost" size="icon-sm" onClick={handleRefresh} disabled={refreshing} title="Refresh" className="nodrag">
            <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" onClick={handleMinimize} title="Minimize" className="nodrag">
          <Minimize2 className="w-3.5 h-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="Settings" className="nodrag">
              <Settings className="w-3.5 h-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {connected && (
              <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
                <LogOut className="w-3.5 h-3.5 mr-2" />
                Disconnect X
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => data.onDuplicate?.()} className="gap-2">
              <Copy className="w-3 h-3" />
              Duplicate
            </DropdownMenuItem>
            <BlockSettingsFooter nodeId={id} onMinimize={handleMinimize} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  const settingsMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="Settings" className="nodrag h-5 w-5">
          <Settings className="w-3 h-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {connected && (
          <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
            <LogOut className="w-3.5 h-3.5 mr-2" />
            Disconnect X
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (isMinimized && !isAnimatingMinimize) {
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={<XLogo className="w-14 h-14 text-[var(--foreground)]" />}
        label={username ? `@${username}` : "X"}
        onExpand={handleExpand}
        settingsMenu={settingsMenu}
        connectorsVisible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    );
  }

  if (loading) {
    return (
      <BlockWrapper selected={selected} minWidth={280} minHeight={200} className={expandAnimation || undefined}>
        <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
        <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
          {header}
          <div className="flex items-center justify-center h-full p-4">
            <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
          </div>
        </div>
      </BlockWrapper>
    );
  }

  if (error) {
    return (
      <BlockWrapper selected={selected} minWidth={280} minHeight={200}>
        <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
        <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
          {header}
          <div className="flex flex-col items-center justify-center h-full p-4">
            <p className="text-xs text-red-500 text-center mb-2">{error}</p>
            <Button size="sm" onClick={loadIntegration} className="nodrag">Retry</Button>
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Not connected — show bearer token form
  if (!connected) {
    return (
      <BlockWrapper selected={selected} minWidth={280} minHeight={240}>
        <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
        <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
          {header}
          <div className="flex flex-col p-3 gap-3">
            <div className="flex items-center gap-2">
              <XLogo className="w-5 h-5 text-[var(--text-muted)] shrink-0" />
              <p className="text-[11px] text-[var(--text-muted)] leading-tight">
                Enter your X API Bearer Token from{" "}
                <span className="font-mono">developer.x.com</span>
              </p>
            </div>
            <div className="relative">
              <Input
                type={showToken ? "text" : "password"}
                placeholder="AAAA...token"
                value={bearerToken}
                onChange={(e) => { setBearerToken(e.target.value); setSaveError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
                className="nodrag text-xs pr-8 font-mono"
                disabled={saving}
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--foreground)] nodrag"
              >
                {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            {saveError && (
              <p className="text-[11px] text-red-500 leading-tight">{saveError}</p>
            )}
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || !bearerToken.trim()}
              className="nodrag w-full"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
              {saving ? "Verifying…" : "Connect"}
            </Button>
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Connected
  return (
    <BlockWrapper selected={selected} minWidth={280} minHeight={200} className={cn(expandAnimation)}>
      <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
      <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
        {header}
        <div className="flex flex-col items-center justify-center flex-1 p-4">
          <XLogo className="w-10 h-10 text-[var(--foreground)] mb-3" />
          {username && (
            <p className="text-sm font-medium text-[var(--text-primary)] mb-1">@{username}</p>
          )}
          <p className="text-[10px] text-[var(--text-muted)] text-center">
            Connected. Wire to a terminal to enable X tools.
          </p>
        </div>
        <div className="px-2 py-1 border-t border-[var(--border)] bg-[var(--background)]">
          <div className="flex items-center gap-1 text-[9px] text-[var(--text-muted)]">
            <CheckCircle className="w-2.5 h-2.5 text-green-500" />
            <span>Connected</span>
            {username && <><span>·</span><span>@{username}</span></>}
          </div>
        </div>
      </div>
    </BlockWrapper>
  );
}

export default TwitterBlock;
