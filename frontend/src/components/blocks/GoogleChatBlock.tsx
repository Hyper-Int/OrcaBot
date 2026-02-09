// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: google-chat-block-v2-readonly-spaces

"use client";

const MODULE_REVISION = "google-chat-block-v2-readonly-spaces";
console.log(`[GoogleChatBlock] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import {
  Hash,
  RefreshCw,
  CheckCircle,
  Loader2,
  Settings,
  LogOut,
  Minimize2,
  Copy,
  MessageSquare,
} from "lucide-react";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { API } from "@/config/env";
import { apiFetch, apiGet } from "@/lib/api/client";
import { GoogleChatIcon } from "@/components/icons";
import type { DashboardItem } from "@/types/dashboard";

// ============================================
// Google Chat types
// ============================================

interface GoogleChatSpace {
  id: string;
  name: string;
  type: string;
  topic?: string | null;
}

interface GoogleChatIntegration {
  connected: boolean;
  accountName: string | null;
  serviceAccountEmail: string | null;
}

interface GoogleChatStatus {
  spaceCount?: number;
  lastActivityAt?: string | null;
}

// ============================================
// API helpers
// ============================================

async function getGoogleChatIntegration(dashboardId: string): Promise<GoogleChatIntegration> {
  const url = new URL(`${API.cloudflare.base}/integrations/google_chat`);
  url.searchParams.set("dashboard_id", dashboardId);
  try {
    return await apiGet<GoogleChatIntegration>(url.toString());
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
      return { connected: false, accountName: null, serviceAccountEmail: null };
    }
    throw err;
  }
}

async function getGoogleChatStatus(dashboardId: string): Promise<GoogleChatStatus | null> {
  const url = new URL(`${API.cloudflare.base}/integrations/google_chat/status`);
  url.searchParams.set("dashboard_id", dashboardId);
  try {
    return await apiGet<GoogleChatStatus>(url.toString());
  } catch {
    return null;
  }
}

async function disconnectGoogleChatApi(dashboardId: string): Promise<{ ok: boolean }> {
  const url = new URL(`${API.cloudflare.base}/integrations/google_chat`);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

async function listGoogleChatSpaces(): Promise<{ channels: GoogleChatSpace[] }> {
  const url = new URL(`${API.cloudflare.base}/integrations/google_chat/spaces`);
  try {
    return await apiGet<{ channels: GoogleChatSpace[] }>(url.toString());
  } catch {
    return { channels: [] };
  }
}

async function connectWithToken(
  dashboardId: string,
  token: string,
  metadata?: Record<string, unknown>,
): Promise<{ connected: boolean; accountName: string }> {
  const url = new URL(`${API.cloudflare.base}/integrations/google_chat/connect-token`);
  return apiFetch<{ connected: boolean; accountName: string }>(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, dashboardId, metadata }),
  });
}


// ============================================
// Component
// ============================================

const GOOGLE_CHAT_GREEN = "#00A67E";

interface GoogleChatData extends Record<string, unknown> {
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

type GoogleChatNode = Node<GoogleChatData, "google_chat">;

export function GoogleChatBlock({ id, data, selected }: NodeProps<GoogleChatNode>) {
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
      size: savedSize || { width: 320, height: 400 },
    });
  };

  const [integration, setIntegration] = React.useState<GoogleChatIntegration | null>(null);
  const [status, setStatus] = React.useState<GoogleChatStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [availableSpaces, setAvailableSpaces] = React.useState<GoogleChatSpace[]>([]);
  const [refreshing, setRefreshing] = React.useState(false);
  const [tokenInput, setTokenInput] = React.useState("");
  const [connecting, setConnecting] = React.useState(false);

  const initialLoadDone = React.useRef(false);

  const loadIntegration = React.useCallback(async () => {
    if (!dashboardId) return;
    try {
      if (!initialLoadDone.current) setLoading(true);
      setError(null);
      const [integrationData, statusData] = await Promise.all([
        getGoogleChatIntegration(dashboardId),
        getGoogleChatStatus(dashboardId),
      ]);
      setIntegration(integrationData);
      setStatus(statusData);
      if (integrationData.connected) {
        const spaceResult = await listGoogleChatSpaces();
        setAvailableSpaces(spaceResult.channels);
      }
      initialLoadDone.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Google Chat");
    } finally {
      setLoading(false);
    }
  }, [dashboardId, id]);

  const loadedKeyRef = React.useRef<string | null>(null);

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
    try {
      setRefreshing(true);
      await loadIntegration();
    } catch (err) {
      console.error("Refresh failed:", err);
    } finally {
      setRefreshing(false);
    }
  };

  const handleConnect = async () => {
    if (!tokenInput.trim() || !dashboardId) return;
    setConnecting(true);
    try {
      await connectWithToken(dashboardId, tokenInput.trim());
      await loadIntegration();
      setTokenInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setConnecting(false);
    }
  };


  const handleDisconnect = async () => {
    if (!dashboardId) return;
    try {
      await disconnectGoogleChatApi(dashboardId);
      setIntegration(null);
      setStatus(null);
    } catch (err) {
      console.error("Failed to disconnect Google Chat:", err);
    }
  };

  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <GoogleChatIcon className="w-3.5 h-3.5" />
      <div className="text-xs text-[var(--foreground-muted)] truncate flex-1">
        {integration?.accountName || "Google Chat"}
      </div>
      <div className="flex items-center gap-1">
        {integration?.connected && (
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
          <DropdownMenuContent align="end" className="w-48">
            {integration?.connected && (
              <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
                <LogOut className="w-3.5 h-3.5 mr-2" />
                Disconnect Google Chat
              </DropdownMenuItem>
            )}
            {!integration?.connected && (
              <DropdownMenuItem onClick={() => { /* focus token input */ }}>
                <GoogleChatIcon className="w-3.5 h-3.5 mr-2" />
                Connect Google Chat
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => data.onDuplicate?.()} className="gap-2">
              <Copy className="w-3 h-3" />
              Duplicate
            </DropdownMenuItem>
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
      <DropdownMenuContent align="end" className="w-48">
        {integration?.connected && (
          <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
            <LogOut className="w-3.5 h-3.5 mr-2" />
            Disconnect Google Chat
          </DropdownMenuItem>
        )}
        {!integration?.connected && (
          <DropdownMenuItem onClick={() => { /* focus token input */ }}>
            <GoogleChatIcon className="w-3.5 h-3.5 mr-2" />
            Connect Google Chat
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
        icon={<GoogleChatIcon className="w-14 h-14" />}
        label={integration?.accountName || "Google Chat"}
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
            <Button size="sm" onClick={loadIntegration} className="nodrag">
              Retry
            </Button>
          </div>
        </div>
      </BlockWrapper>
    );
  }

  if (!integration?.connected) {
    return (
      <BlockWrapper selected={selected} minWidth={280} minHeight={200}>
        <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
        <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
          {header}
          <div className="flex flex-col items-center justify-center h-full p-4">
            <GoogleChatIcon className="w-8 h-8 mb-2" />
            <p className="text-xs text-[var(--text-muted)] text-center mb-3">
              Connect Google Chat to send and receive messages
            </p>
            <div className="w-full space-y-2 nodrag">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Paste your OAuth2 access token"
                className="w-full px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--background)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[#00A67E]"
              />
              <Button
                size="sm"
                onClick={handleConnect}
                disabled={!tokenInput.trim() || connecting}
                className="nodrag w-full"
                style={{ backgroundColor: GOOGLE_CHAT_GREEN, color: "#fff" }}
              >
                {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                Connect
              </Button>
              <p className="text-[9px] text-[var(--text-muted)] text-center">
                Google Cloud Console &rarr; OAuth2 access token
              </p>
            </div>
          </div>
        </div>
      </BlockWrapper>
    );
  }

  return (
    <BlockWrapper selected={selected} minWidth={280} minHeight={200} className={cn(expandAnimation)}>
      <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
      <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
        {header}

        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            {availableSpaces.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-4">
                <MessageSquare className="w-6 h-6 text-[var(--text-muted)] mb-2" />
                <p className="text-xs text-[var(--text-muted)] text-center">No spaces found</p>
                <p className="text-[10px] text-[var(--text-muted)] text-center mt-1">
                  Add the bot to Google Chat spaces first.
                </p>
              </div>
            ) : (
              availableSpaces.map((space) => (
                <div
                  key={space.id}
                  className="w-full px-2 py-1.5 border-b border-[var(--border)] text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <Hash className="w-3 h-3 shrink-0 text-[var(--text-muted)]" />
                    <span className="text-[10px] truncate flex-1 font-medium text-[var(--text-muted)]">
                      {space.name}
                    </span>
                  </div>
                  {space.topic && (
                    <p className="text-[9px] text-[var(--text-muted)] mt-0.5 ml-[18px] truncate">
                      {space.topic}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="px-2 py-1 border-t border-[var(--border)] bg-[var(--background)]">
            <div className="flex items-center gap-1 text-[9px] text-[var(--text-muted)]">
              <CheckCircle className="w-2.5 h-2.5 text-green-500" />
              <span>Connected</span>
              <span>&middot;</span>
              <span>Inbound webhooks coming soon</span>
            </div>
          </div>
        </div>
      </div>
    </BlockWrapper>
  );
}

export default GoogleChatBlock;
