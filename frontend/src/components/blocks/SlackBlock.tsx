// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: slack-block-v9-channels-no-dashboard-id

"use client";

const MODULE_REVISION = "slack-block-v9-channels-no-dashboard-id";
console.log(`[SlackBlock] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

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
  Users,
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
import type { DashboardItem } from "@/types/dashboard";

// ============================================
// Slack types
// ============================================

interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  num_members?: number;
  topic?: string;
  purpose?: string;
}

interface SlackIntegration {
  connected: boolean;
  teamName: string | null;
  teamId: string | null;
  channels?: SlackChannel[];
}

interface SlackStatus {
  // connected is NOT returned by the status endpoint (GET /integrations/slack/status).
  // Connection state comes from getSlackIntegration (SlackIntegration.connected).
  // This field is optional to match the actual API response contract.
  connected?: boolean;
  teamName?: string;
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
// API helpers (inline until controlplane endpoints exist)
// ============================================

async function getSlackIntegration(dashboardId: string): Promise<SlackIntegration> {
  const url = new URL(`${API.cloudflare.base}/integrations/slack`);
  url.searchParams.set("dashboard_id", dashboardId);
  try {
    return await apiGet<SlackIntegration>(url.toString());
  } catch (err) {
    // Gracefully handle 404 if endpoint does not exist yet
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
      return { connected: false, teamName: null, teamId: null };
    }
    throw err;
  }
}

async function getSlackStatus(dashboardId: string): Promise<SlackStatus | null> {
  const url = new URL(`${API.cloudflare.base}/integrations/slack/status`);
  url.searchParams.set("dashboard_id", dashboardId);
  try {
    return await apiGet<SlackStatus>(url.toString());
  } catch {
    // Gracefully handle 404 if endpoint does not exist yet
    return null;
  }
}

async function disconnectSlack(dashboardId: string): Promise<{ ok: boolean }> {
  const url = new URL(`${API.cloudflare.base}/integrations/slack`);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

async function listSlackChannels(
  cursor?: string,
): Promise<{ channels: SlackChannel[]; nextCursor: string | null }> {
  const url = new URL(`${API.cloudflare.base}/integrations/slack/channels`);
  if (cursor) url.searchParams.set("cursor", cursor);
  try {
    const data = await apiGet<{ channels: SlackChannel[]; next_cursor: string | null }>(url.toString());
    return { channels: data.channels || [], nextCursor: data.next_cursor || null };
  } catch {
    return { channels: [], nextCursor: null };
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
      provider: "slack",
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

interface SlackData extends Record<string, unknown> {
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

type SlackNode = Node<SlackData, "slack">;

export function SlackBlock({ id, data, selected }: NodeProps<SlackNode>) {
  const dashboardId = data.dashboardId;
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const isMinimized = data.metadata?.minimized === true;
  const [expandAnimation, setExpandAnimation] = React.useState<string | null>(null);
  const [isAnimatingMinimize, setIsAnimatingMinimize] = React.useState(false);
  const minimizeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track popup-related cleanup so we can tear down on unmount
  const popupCleanupRef = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    return () => {
      if (minimizeTimeoutRef.current) clearTimeout(minimizeTimeoutRef.current);
      // Clean up any dangling popup listener/interval if component unmounts mid-connect
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
  const [integration, setIntegration] = React.useState<SlackIntegration | null>(null);
  const [status, setStatus] = React.useState<SlackStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Channels & subscriptions state
  const [availableChannels, setAvailableChannels] = React.useState<SlackChannel[]>([]);
  const [subscriptions, setSubscriptions] = React.useState<MessagingSubscription[]>([]);
  const [subscribing, setSubscribing] = React.useState<string | null>(null); // channel id being toggled
  const [channelCursor, setChannelCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  // Track if initial load is done (per block instance to handle Fast Refresh/Strict Mode)
  const initialLoadDone = React.useRef(false);

  // Load integration status
  const loadIntegration = React.useCallback(async () => {
    if (!dashboardId) return;
    try {
      // Only show loading spinner on initial load, not refreshes
      if (!initialLoadDone.current) {
        setLoading(true);
      }
      setError(null);
      const [integrationData, statusData] = await Promise.all([
        getSlackIntegration(dashboardId),
        getSlackStatus(dashboardId),
      ]);
      setIntegration(integrationData);
      setStatus(statusData);

      // If connected, also load available channels and active subscriptions
      if (integrationData.connected) {
        const [channelResult, subs] = await Promise.all([
          listSlackChannels(),
          listSubscriptions(dashboardId),
        ]);
        setAvailableChannels(channelResult.channels);
        setChannelCursor(channelResult.nextCursor);
        setSubscriptions(subs.filter(s => s.provider === "slack" && s.item_id === id));
      }

      initialLoadDone.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Slack");
    } finally {
      setLoading(false);
    }
  }, [dashboardId, id]);

  // Initial load - skip duplicate loads in Strict Mode/Fast Refresh.
  // Track both dashboardId and block id so duplicate/rehydrate triggers a reload.
  const loadedKeyRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!dashboardId) return;
    const key = `${dashboardId}:${id}`;
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    initialLoadDone.current = false;
    loadIntegration();
  }, [dashboardId, id, loadIntegration]);

  // Refresh handler
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

  // Connect Slack
  const handleConnect = () => {
    if (!dashboardId) return;
    const connectUrl = `${API.cloudflare.base}/integrations/slack/connect?dashboard_id=${dashboardId}&mode=popup`;
    const popup = window.open(connectUrl, "slack-connect", "width=600,height=700");

    // If popup was blocked by the browser, bail immediately — no interval leak
    if (!popup) {
      console.warn("[SlackBlock] Popup was blocked by the browser");
      return;
    }

    let completed = false;

    // Derive expected origin for postMessage validation
    const expectedOrigin = new URL(API.cloudflare.base).origin;

    // Cleanup function — removes listener and interval, closes popup
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
        console.error("Failed to load Slack integration after connect:", err);
      }
    };

    const handleMessage = async (event: MessageEvent) => {
      // Validate origin to prevent spoofed postMessage from other windows
      if (event.origin !== expectedOrigin && event.origin !== window.location.origin) return;
      if (event.data?.type === "slack-auth-complete") {
        await completeSetup();
      }
    };
    window.addEventListener("message", handleMessage);

    // Also poll for popup close (backup in case postMessage fails due to origin mismatch)
    const pollInterval = setInterval(async () => {
      if (popup.closed) {
        clearInterval(pollInterval);
        // Give a moment for postMessage to arrive, then check integration status
        setTimeout(async () => {
          if (!completed) {
            await completeSetup();
          }
        }, 500);
      }
    }, 500);

    // Store cleanup so useEffect teardown can call it on unmount
    popupCleanupRef.current = cleanup;
  };

  // Load more channels (pagination)
  const handleLoadMore = async () => {
    if (!dashboardId || !channelCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await listSlackChannels(channelCursor);
      setAvailableChannels(prev => [...prev, ...result.channels]);
      setChannelCursor(result.nextCursor);
    } catch (err) {
      console.error("Failed to load more channels:", err);
    } finally {
      setLoadingMore(false);
    }
  };

  // Toggle channel subscription
  const handleToggleChannel = async (channel: SlackChannel) => {
    if (!dashboardId || subscribing) return;
    setSubscribing(channel.id);
    try {
      const existingSub = subscriptions.find(
        s => s.channel_id === channel.id && s.status === "active"
      );
      if (existingSub) {
        // Unsubscribe
        await deleteSubscription(existingSub.id);
        setSubscriptions(prev => prev.filter(s => s.id !== existingSub.id));
      } else {
        // Subscribe — itemId is this block's ID on the canvas
        const result = await createSubscription(dashboardId, id, channel.id, channel.name);
        setSubscriptions(prev => [
          ...prev,
          {
            id: result.id,
            dashboard_id: dashboardId,
            item_id: id,
            provider: "slack",
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

  // Disconnect Slack
  const handleDisconnect = async () => {
    if (!dashboardId) return;
    try {
      await disconnectSlack(dashboardId);
      setIntegration(null);
      setStatus(null);
    } catch (err) {
      console.error("Failed to disconnect Slack:", err);
    }
  };

  // Header
  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <Hash className="w-3.5 h-3.5 text-[#611f69]" />
      <div className="text-xs text-[var(--foreground-muted)] truncate flex-1">
        {integration?.teamName || status?.teamName || "Slack"}
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
          <DropdownMenuContent align="end" className="w-40">
            {integration?.connected && (
              <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
                <LogOut className="w-3.5 h-3.5 mr-2" />
                Disconnect Slack
              </DropdownMenuItem>
            )}
            {!integration?.connected && (
              <DropdownMenuItem onClick={handleConnect}>
                <Hash className="w-3.5 h-3.5 mr-2" />
                Connect Slack
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

  // Settings menu for minimized view
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
      <DropdownMenuContent align="end" className="w-40">
        {integration?.connected && (
          <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
            <LogOut className="w-3.5 h-3.5 mr-2" />
            Disconnect Slack
          </DropdownMenuItem>
        )}
        {!integration?.connected && (
          <DropdownMenuItem onClick={handleConnect}>
            <Hash className="w-3.5 h-3.5 mr-2" />
            Connect Slack
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Minimized view - only show when fully minimized (not during animation)
  if (isMinimized && !isAnimatingMinimize) {
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={<Hash className="w-14 h-14 text-[#611f69]" />}
        label={integration?.teamName || "Slack"}
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
        <ConnectionHandles
          nodeId={id}
          visible={connectorsVisible}
          onConnectorClick={data.onConnectorClick}
        />
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
        <ConnectionHandles
          nodeId={id}
          visible={connectorsVisible}
          onConnectorClick={data.onConnectorClick}
        />
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
        <ConnectionHandles
          nodeId={id}
          visible={connectorsVisible}
          onConnectorClick={data.onConnectorClick}
        />
        <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
          {header}
          <div className="flex flex-col items-center justify-center h-full p-4">
            <Hash className="w-8 h-8 text-[var(--text-muted)] mb-2" />
            <p className="text-xs text-[var(--text-muted)] text-center mb-3">
              Connect Slack to send and receive messages
            </p>
            <Button size="sm" onClick={handleConnect} className="nodrag">
              Connect Slack
            </Button>
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Connected state - show channels with subscription toggles
  const subscribedChannelIds = new Set(
    subscriptions.filter(s => s.status === "active").map(s => s.channel_id)
  );

  return (
    <BlockWrapper selected={selected} minWidth={280} minHeight={200} className={cn(expandAnimation)}>
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
      {/* All content fades during minimize */}
      <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
        {header}

        {/* Channel list with subscription toggles */}
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            {availableChannels.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-4">
                <MessageSquare className="w-6 h-6 text-[var(--text-muted)] mb-2" />
                <p className="text-xs text-[var(--text-muted)] text-center">
                  No channels found
                </p>
                <p className="text-[10px] text-[var(--text-muted)] text-center mt-1">
                  Invite the Slack bot to a channel, then refresh.
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
                        ? "bg-[#611f69]/5 hover:bg-[#611f69]/10"
                        : "hover:bg-[var(--background)]",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <Hash className={cn(
                        "w-3 h-3 shrink-0",
                        isSubscribed ? "text-[#611f69]" : "text-[var(--text-muted)]"
                      )} />
                      <span className={cn(
                        "text-[10px] truncate flex-1 font-medium",
                        isSubscribed ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"
                      )}>
                        {channel.name}
                      </span>
                      {channel.is_private && (
                        <span className="text-[8px] px-1 py-0.5 rounded bg-[var(--background)] text-[var(--text-muted)]">
                          Private
                        </span>
                      )}
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
                    {channel.num_members !== undefined && (
                      <div className="flex items-center gap-1 mt-0.5 ml-[18px]">
                        <Users className="w-2.5 h-2.5 text-[var(--text-muted)]" />
                        <span className="text-[9px] text-[var(--text-muted)]">
                          {channel.num_members} member{channel.num_members !== 1 ? "s" : ""}
                        </span>
                      </div>
                    )}
                  </button>
                );
              })
            )}
            {channelCursor && (
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="w-full px-2 py-1.5 text-[10px] text-[#611f69] hover:bg-[var(--background)] transition-colors nodrag flex items-center justify-center gap-1"
              >
                {loadingMore ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  "Load more channels"
                )}
              </button>
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

export default SlackBlock;
