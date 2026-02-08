// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: discord-block-v1-initial

"use client";

const MODULE_REVISION = "discord-block-v1-initial";
console.log(`[DiscordBlock] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

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
import { DiscordIcon } from "@/components/icons";
import type { DashboardItem } from "@/types/dashboard";

// ============================================
// Discord types
// ============================================

interface DiscordChannel {
  id: string;
  name: string;
  is_private: boolean;
  topic?: string | null;
}

interface DiscordIntegration {
  connected: boolean;
  guildName: string | null;
  guildId: string | null;
  discordUsername?: string | null;
}

interface DiscordStatus {
  channelCount?: number;
  lastActivityAt?: string | null;
}

interface MessagingSubscription {
  id: string;
  dashboard_id: string;
  item_id: string;
  provider: string;
  channel_id: string | null;
  channel_name: string | null;
  status: string;
}

// ============================================
// API helpers
// ============================================

async function getDiscordIntegration(dashboardId: string): Promise<DiscordIntegration> {
  const url = new URL(`${API.cloudflare.base}/integrations/discord`);
  url.searchParams.set("dashboard_id", dashboardId);
  try {
    return await apiGet<DiscordIntegration>(url.toString());
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
      return { connected: false, guildName: null, guildId: null };
    }
    throw err;
  }
}

async function getDiscordStatus(dashboardId: string): Promise<DiscordStatus | null> {
  const url = new URL(`${API.cloudflare.base}/integrations/discord/status`);
  url.searchParams.set("dashboard_id", dashboardId);
  try {
    return await apiGet<DiscordStatus>(url.toString());
  } catch {
    return null;
  }
}

async function disconnectDiscordApi(dashboardId: string): Promise<{ ok: boolean }> {
  const url = new URL(`${API.cloudflare.base}/integrations/discord`);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

async function listDiscordChannels(): Promise<{ channels: DiscordChannel[] }> {
  const url = new URL(`${API.cloudflare.base}/integrations/discord/channels`);
  try {
    return await apiGet<{ channels: DiscordChannel[] }>(url.toString());
  } catch {
    return { channels: [] };
  }
}

async function listSubscriptions(dashboardId: string): Promise<MessagingSubscription[]> {
  const url = new URL(`${API.cloudflare.base}/messaging/subscriptions`);
  url.searchParams.set("dashboard_id", dashboardId);
  try {
    return await apiGet<MessagingSubscription[]>(url.toString());
  } catch {
    return [];
  }
}

async function createSubscription(
  dashboardId: string,
  itemId: string,
  channelId: string,
  channelName: string,
): Promise<{ id: string; webhookId: string }> {
  const url = new URL(`${API.cloudflare.base}/messaging/subscriptions`);
  return apiFetch<{ id: string; webhookId: string }>(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dashboardId,
      itemId,
      provider: "discord",
      channelId,
      channelName,
    }),
  });
}

async function deleteSubscription(subscriptionId: string): Promise<{ ok: boolean }> {
  const url = new URL(`${API.cloudflare.base}/messaging/subscriptions/${subscriptionId}`);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

// ============================================
// Component
// ============================================

const DISCORD_BLURPLE = "#5865F2";

interface DiscordData extends Record<string, unknown> {
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

type DiscordNode = Node<DiscordData, "discord">;

export function DiscordBlock({ id, data, selected }: NodeProps<DiscordNode>) {
  const dashboardId = data.dashboardId;
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const isMinimized = data.metadata?.minimized === true;
  const [expandAnimation, setExpandAnimation] = React.useState<string | null>(null);
  const [isAnimatingMinimize, setIsAnimatingMinimize] = React.useState(false);
  const minimizeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const popupCleanupRef = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    return () => {
      if (minimizeTimeoutRef.current) clearTimeout(minimizeTimeoutRef.current);
      popupCleanupRef.current?.();
      popupCleanupRef.current = null;
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

  // Integration state
  const [integration, setIntegration] = React.useState<DiscordIntegration | null>(null);
  const [status, setStatus] = React.useState<DiscordStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Channels & subscriptions state
  const [availableChannels, setAvailableChannels] = React.useState<DiscordChannel[]>([]);
  const [subscriptions, setSubscriptions] = React.useState<MessagingSubscription[]>([]);
  const [subscribing, setSubscribing] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  const initialLoadDone = React.useRef(false);

  const loadIntegration = React.useCallback(async () => {
    if (!dashboardId) return;
    try {
      if (!initialLoadDone.current) {
        setLoading(true);
      }
      setError(null);
      const [integrationData, statusData] = await Promise.all([
        getDiscordIntegration(dashboardId),
        getDiscordStatus(dashboardId),
      ]);
      setIntegration(integrationData);
      setStatus(statusData);

      if (integrationData.connected) {
        const [channelResult, subs] = await Promise.all([
          listDiscordChannels(),
          listSubscriptions(dashboardId),
        ]);
        setAvailableChannels(channelResult.channels);
        setSubscriptions(subs.filter(s => s.provider === "discord" && s.item_id === id));
      }

      initialLoadDone.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Discord");
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

  const handleConnect = () => {
    if (!dashboardId) return;
    const connectUrl = `${API.cloudflare.base}/integrations/discord/connect?dashboard_id=${dashboardId}&mode=popup`;
    const popup = window.open(connectUrl, "discord-connect", "width=600,height=800");

    if (!popup) {
      console.warn("[DiscordBlock] Popup was blocked by the browser");
      return;
    }

    let completed = false;
    const expectedOrigin = new URL(API.cloudflare.base).origin;

    const cleanup = () => {
      window.removeEventListener("message", handleMessage);
      clearInterval(pollInterval);
      popupCleanupRef.current = null;
    };

    const completeSetup = async () => {
      if (completed) return;
      completed = true;
      cleanup();
      popup.close();
      try {
        await loadIntegration();
      } catch (err) {
        console.error("Failed to load Discord integration after connect:", err);
      }
    };

    const handleMessage = async (event: MessageEvent) => {
      if (event.origin !== expectedOrigin && event.origin !== window.location.origin) return;
      if (event.data?.type === "discord-auth-complete") {
        await completeSetup();
      }
    };
    window.addEventListener("message", handleMessage);

    const pollInterval = setInterval(async () => {
      if (popup.closed) {
        clearInterval(pollInterval);
        setTimeout(async () => {
          if (!completed) {
            await completeSetup();
          }
        }, 500);
      }
    }, 500);

    popupCleanupRef.current = cleanup;
  };

  const handleToggleChannel = async (channel: DiscordChannel) => {
    if (!dashboardId || subscribing) return;
    setSubscribing(channel.id);
    try {
      const existingSub = subscriptions.find(
        s => s.channel_id === channel.id && s.status === "active"
      );
      if (existingSub) {
        await deleteSubscription(existingSub.id);
        setSubscriptions(prev => prev.filter(s => s.id !== existingSub.id));
      } else {
        const result = await createSubscription(dashboardId, id, channel.id, channel.name);
        setSubscriptions(prev => [
          ...prev,
          {
            id: result.id,
            dashboard_id: dashboardId,
            item_id: id,
            provider: "discord",
            channel_id: channel.id,
            channel_name: channel.name,
            status: "active",
          },
        ]);
      }
    } catch (err) {
      console.error("Failed to toggle channel subscription:", err);
    } finally {
      setSubscribing(null);
    }
  };

  const handleDisconnect = async () => {
    if (!dashboardId) return;
    try {
      await disconnectDiscordApi(dashboardId);
      setIntegration(null);
      setStatus(null);
    } catch (err) {
      console.error("Failed to disconnect Discord:", err);
    }
  };

  // Header
  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <DiscordIcon className="w-3.5 h-3.5" />
      <div className="text-xs text-[var(--foreground-muted)] truncate flex-1">
        {integration?.guildName || "Discord"}
      </div>
      <div className="flex items-center gap-1">
        {integration?.connected && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh"
            className="nodrag"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleMinimize}
          title="Minimize"
          className="nodrag"
        >
          <Minimize2 className="w-3.5 h-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Settings"
              className="nodrag"
            >
              <Settings className="w-3.5 h-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {integration?.connected && (
              <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
                <LogOut className="w-3.5 h-3.5 mr-2" />
                Disconnect Discord
              </DropdownMenuItem>
            )}
            {!integration?.connected && (
              <DropdownMenuItem onClick={handleConnect}>
                <DiscordIcon className="w-3.5 h-3.5 mr-2" />
                Connect Discord
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
        <Button
          variant="ghost"
          size="icon-sm"
          title="Settings"
          className="nodrag h-5 w-5"
        >
          <Settings className="w-3 h-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {integration?.connected && (
          <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
            <LogOut className="w-3.5 h-3.5 mr-2" />
            Disconnect Discord
          </DropdownMenuItem>
        )}
        {!integration?.connected && (
          <DropdownMenuItem onClick={handleConnect}>
            <DiscordIcon className="w-3.5 h-3.5 mr-2" />
            Connect Discord
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Minimized view
  if (isMinimized && !isAnimatingMinimize) {
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={<DiscordIcon className="w-14 h-14" />}
        label={integration?.guildName || "Discord"}
        onExpand={handleExpand}
        settingsMenu={settingsMenu}
        connectorsVisible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    );
  }

  // Loading state
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

  // Error state
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

  // Not connected state
  if (!integration?.connected) {
    return (
      <BlockWrapper selected={selected} minWidth={280} minHeight={200}>
        <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
        <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
          {header}
          <div className="flex flex-col items-center justify-center h-full p-4">
            <DiscordIcon className="w-8 h-8 mb-2" />
            <p className="text-xs text-[var(--text-muted)] text-center mb-3">
              Connect Discord to send and receive messages
            </p>
            <Button
              size="sm"
              onClick={handleConnect}
              className="nodrag"
              style={{ backgroundColor: DISCORD_BLURPLE, color: "#fff" }}
            >
              Add to Server
            </Button>
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Connected state - show channels
  const subscribedChannelIds = new Set(
    subscriptions.filter(s => s.status === "active").map(s => s.channel_id)
  );

  return (
    <BlockWrapper selected={selected} minWidth={280} minHeight={200} className={cn(expandAnimation)}>
      <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
      <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
        {header}

        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            {availableChannels.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-4">
                <MessageSquare className="w-6 h-6 text-[var(--text-muted)] mb-2" />
                <p className="text-xs text-[var(--text-muted)] text-center">
                  No channels found
                </p>
                <p className="text-[10px] text-[var(--text-muted)] text-center mt-1">
                  Make sure the bot has access to channels in your server.
                </p>
              </div>
            ) : (
              availableChannels.map((channel) => {
                const isSubscribed = subscribedChannelIds.has(channel.id);
                const isToggling = subscribing === channel.id;
                return (
                  <button
                    key={channel.id}
                    onClick={() => handleToggleChannel(channel)}
                    disabled={isToggling}
                    className={cn(
                      "w-full px-2 py-1.5 border-b border-[var(--border)] transition-colors text-left nodrag",
                      isSubscribed
                        ? `bg-[${DISCORD_BLURPLE}]/5 hover:bg-[${DISCORD_BLURPLE}]/10`
                        : "hover:bg-[var(--background)]",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <Hash className={cn(
                        "w-3 h-3 shrink-0",
                        isSubscribed ? `text-[${DISCORD_BLURPLE}]` : "text-[var(--text-muted)]"
                      )} />
                      <span className={cn(
                        "text-[10px] truncate flex-1 font-medium",
                        isSubscribed ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"
                      )}>
                        {channel.name}
                      </span>
                      {isToggling ? (
                        <Loader2 className="w-3 h-3 animate-spin text-[var(--text-muted)]" />
                      ) : isSubscribed ? (
                        <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
                      ) : null}
                    </div>
                    {channel.topic && (
                      <p className="text-[9px] text-[var(--text-muted)] mt-0.5 ml-[18px] truncate">
                        {channel.topic}
                      </p>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Status footer */}
          <div className="px-2 py-1 border-t border-[var(--border)] bg-[var(--background)]">
            <div className="flex items-center gap-1 text-[9px] text-[var(--text-muted)]">
              <CheckCircle className="w-2.5 h-2.5 text-green-500" />
              <span>Connected</span>
              {subscribedChannelIds.size > 0 && (
                <>
                  <span>·</span>
                  <span>{subscribedChannelIds.size} subscribed</span>
                </>
              )}
              {status?.lastActivityAt && (
                <>
                  <span>·</span>
                  <span>{new Date(status.lastActivityAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </BlockWrapper>
  );
}

export default DiscordBlock;
