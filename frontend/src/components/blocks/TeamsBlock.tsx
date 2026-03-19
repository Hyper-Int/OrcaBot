// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: teams-block-v8-stale-team-reset-popup-cleanup

"use client";

const MODULE_REVISION = "teams-block-v7-stable-team-selection";
console.log(`[TeamsBlock] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

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
import { TeamsIcon } from "@/components/icons";
import { BlockSettingsFooter } from "./BlockSettingsFooter";
import type { DashboardItem } from "@/types/dashboard";
import { HelpButton } from "@/components/help/HelpDialog";
import { teamsDoc } from "@/docs/content/teams";

// ============================================
// Teams types
// ============================================

interface TeamsChannel {
  id: string;
  name: string;
  type: string;
  topic?: string | null;
}

interface TeamsIntegration {
  connected: boolean;
  accountName: string | null;
  tenantId: string | null;
  metadata?: { auth_type?: string; [key: string]: unknown };
}

interface TeamsStatus {
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
  webhook_id?: string | null;
  status: string;
}

// ============================================
// API helpers
// ============================================

async function getTeamsIntegration(dashboardId: string): Promise<TeamsIntegration> {
  const url = new URL(`${API.cloudflare.base}/integrations/teams`);
  url.searchParams.set("dashboard_id", dashboardId);
  try {
    return await apiGet<TeamsIntegration>(url.toString());
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
      return { connected: false, accountName: null, tenantId: null, metadata: undefined };
    }
    throw err;
  }
}

async function getTeamsStatus(dashboardId: string): Promise<TeamsStatus | null> {
  const url = new URL(`${API.cloudflare.base}/integrations/teams/status`);
  url.searchParams.set("dashboard_id", dashboardId);
  try {
    return await apiGet<TeamsStatus>(url.toString());
  } catch {
    return null;
  }
}

async function disconnectTeamsApi(dashboardId: string): Promise<{ ok: boolean }> {
  const url = new URL(`${API.cloudflare.base}/integrations/teams`);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

interface TeamsTeamInfo { id: string; name: string }
interface TeamsChannelsResponse {
  channels: TeamsChannel[];
  teams?: TeamsTeamInfo[];
  team_id?: string;
}

async function listTeamsChannels(teamId?: string): Promise<TeamsChannelsResponse> {
  const url = new URL(`${API.cloudflare.base}/integrations/teams/channels`);
  if (teamId) url.searchParams.set("team_id", teamId);
  try {
    return await apiGet<TeamsChannelsResponse>(url.toString());
  } catch {
    return { channels: [] };
  }
}

async function connectWithToken(
  dashboardId: string,
  token: string,
  metadata?: Record<string, unknown>,
): Promise<{ connected: boolean; accountName: string }> {
  const url = new URL(`${API.cloudflare.base}/integrations/teams/connect-token`);
  return apiFetch<{ connected: boolean; accountName: string }>(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, dashboardId, metadata }),
  });
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
  teamId?: string | null,
): Promise<{ id: string; webhookId: string }> {
  const url = new URL(`${API.cloudflare.base}/messaging/subscriptions`);
  return apiFetch<{ id: string; webhookId: string }>(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dashboardId,
      itemId,
      provider: "teams",
      channelId,
      channelName,
      teamId: teamId || undefined,
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

const TEAMS_PURPLE = "#6264A7";

interface TeamsData extends Record<string, unknown> {
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

type TeamsNode = Node<TeamsData, "teams">;

function WebhookUrlDisplay({ webhookId }: { webhookId: string }) {
  const [copied, setCopied] = React.useState(false);
  const webhookUrl = `${API.cloudflare.base.replace(/\/+$/, "")}/webhooks/teams/${webhookId}`;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard API unavailable */ }
  };

  return (
    <div className="px-2 py-1 bg-[var(--background)] border-t border-dashed border-[var(--border)]">
      <p className="text-[8px] text-[var(--text-muted)] mb-0.5">
        Set this as your Azure Bot messaging endpoint:
      </p>
      <div className="flex items-center gap-1">
        <code className="text-[8px] text-[var(--text-secondary)] truncate flex-1 select-all">
          {webhookUrl}
        </code>
        <button
          onClick={handleCopy}
          className="shrink-0 p-0.5 rounded hover:bg-[var(--background)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] nodrag"
          title="Copy webhook URL"
        >
          {copied
            ? <CheckCircle className="w-2.5 h-2.5 text-green-500" />
            : <Copy className="w-2.5 h-2.5" />
          }
        </button>
      </div>
    </div>
  );
}

export function TeamsBlock({ id, data, selected }: NodeProps<TeamsNode>) {
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

  const [integration, setIntegration] = React.useState<TeamsIntegration | null>(null);
  const [status, setStatus] = React.useState<TeamsStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [availableChannels, setAvailableChannels] = React.useState<TeamsChannel[]>([]);
  const [subscriptions, setSubscriptions] = React.useState<MessagingSubscription[]>([]);
  const [subscribing, setSubscribing] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [tokenInput, setTokenInput] = React.useState("");
  const [appIdInput, setAppIdInput] = React.useState("");
  const [connecting, setConnecting] = React.useState(false);
  const [availableTeams, setAvailableTeams] = React.useState<TeamsTeamInfo[]>([]);
  const [selectedTeamId, setSelectedTeamId] = React.useState<string | null>(null);

  const initialLoadDone = React.useRef(false);
  // Use a ref for selectedTeamId so loadIntegration always reads the current value
  // without needing it in the dependency array (which would re-create the callback on every team switch).
  const selectedTeamIdRef = React.useRef(selectedTeamId);
  selectedTeamIdRef.current = selectedTeamId;

  const loadIntegration = React.useCallback(async () => {
    if (!dashboardId) return;
    try {
      if (!initialLoadDone.current) setLoading(true);
      setError(null);
      const [integrationData, statusData] = await Promise.all([
        getTeamsIntegration(dashboardId),
        getTeamsStatus(dashboardId),
      ]);
      setIntegration(integrationData);
      setStatus(statusData);
      if (integrationData.connected) {
        const currentTeamId = selectedTeamIdRef.current;
        const [channelResult, subs] = await Promise.all([
          listTeamsChannels(currentTeamId ?? undefined),
          listSubscriptions(dashboardId),
        ]);
        setAvailableChannels(channelResult.channels);
        if (channelResult.teams?.length) {
          setAvailableTeams(channelResult.teams);
          // Reset stale team selection: if the current team ID doesn't appear in
          // the server's team list (e.g. after reconnecting a different account),
          // fall back to the server-provided default so we don't stick on an
          // invalid team with empty channels.
          const teamStillValid = currentTeamId && channelResult.teams.some(t => t.id === currentTeamId);
          if (!teamStillValid && channelResult.team_id) {
            setSelectedTeamId(channelResult.team_id);
          }
        }
        setSubscriptions(subs.filter(s => s.provider === "teams" && s.item_id === id));
      }
      initialLoadDone.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Teams");
    } finally {
      setLoading(false);
    }
  }, [dashboardId, id]);

  const handleTeamChange = React.useCallback(async (teamId: string) => {
    setSelectedTeamId(teamId);
    try {
      const result = await listTeamsChannels(teamId);
      setAvailableChannels(result.channels);
    } catch { /* keep current channels */ }
  }, []);

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

  const handleConnectOAuth = () => {
    if (!dashboardId) return;
    const base = API.cloudflare.base.replace(/\/$/, "");
    const url = `${base}/integrations/teams/connect?dashboard_id=${dashboardId}&mode=popup`;
    const popup = window.open(url, "teams-auth", "width=600,height=700");
    if (!popup) return;
    let completed = false;
    const cleanup = () => {
      if (completed) return;
      completed = true;
      window.removeEventListener("message", onMessage);
      clearInterval(pollTimer);
      popup.close();
      loadIntegration();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "teams-auth-complete") {
        cleanup();
      }
    };
    window.addEventListener("message", onMessage);
    const pollTimer = setInterval(() => {
      if (popup.closed) {
        cleanup();
      }
    }, 500);
  };

  const [showManualToken, setShowManualToken] = React.useState(false);

  const handleConnect = async () => {
    if (!tokenInput.trim() || !dashboardId) return;
    setConnecting(true);
    try {
      const metadata = appIdInput.trim()
        ? { app_id: appIdInput.trim() }
        : undefined;
      await connectWithToken(dashboardId, tokenInput.trim(), metadata);
      await loadIntegration();
      setTokenInput("");
      setAppIdInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setConnecting(false);
    }
  };

  const handleToggleChannel = async (channel: TeamsChannel) => {
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
        const result = await createSubscription(dashboardId, id, channel.id, channel.name, selectedTeamId);
        setSubscriptions(prev => [
          ...prev,
          {
            id: result.id,
            dashboard_id: dashboardId,
            item_id: id,
            provider: "teams",
            channel_id: channel.id,
            channel_name: channel.name,
            webhook_id: result.webhookId,
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
      await disconnectTeamsApi(dashboardId);
      setIntegration(null);
      setStatus(null);
    } catch (err) {
      console.error("Failed to disconnect Teams:", err);
    }
  };

  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <TeamsIcon className="w-3.5 h-3.5" />
      <div className="text-xs text-[var(--foreground-muted)] truncate flex-1">
        {integration?.accountName || "Teams"}
      </div>
      <div className="flex items-center gap-1">
        <HelpButton doc={teamsDoc} />
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
          <DropdownMenuContent align="end" className="w-44">
            {integration?.connected && (
              <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
                <LogOut className="w-3.5 h-3.5 mr-2" />
                Disconnect Teams
              </DropdownMenuItem>
            )}
            {!integration?.connected && (
              <DropdownMenuItem onClick={() => { /* focus token input */ }}>
                <TeamsIcon className="w-3.5 h-3.5 mr-2" />
                Connect Teams
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
      <DropdownMenuContent align="end" className="w-44">
        {integration?.connected && (
          <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
            <LogOut className="w-3.5 h-3.5 mr-2" />
            Disconnect Teams
          </DropdownMenuItem>
        )}
        {!integration?.connected && (
          <DropdownMenuItem onClick={() => { /* focus token input */ }}>
            <TeamsIcon className="w-3.5 h-3.5 mr-2" />
            Connect Teams
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
        icon={<TeamsIcon className="w-14 h-14" />}
        label={integration?.accountName || "Teams"}
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
            <TeamsIcon className="w-8 h-8 mb-2" />
            <p className="text-xs text-[var(--text-muted)] text-center mb-3">
              Connect Microsoft Teams to send and receive messages
            </p>
            <div className="w-full space-y-2 nodrag">
              <Button
                size="sm"
                onClick={handleConnectOAuth}
                className="nodrag w-full"
                style={{ backgroundColor: TEAMS_PURPLE, color: "#fff" }}
              >
                Connect with Microsoft
              </Button>

              <button
                onClick={() => setShowManualToken(!showManualToken)}
                className="text-[9px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] text-center w-full"
              >
                {showManualToken ? "Hide manual token" : "Or use manual token"}
              </button>

              {showManualToken && (
                <>
                  <input
                    type="text"
                    value={appIdInput}
                    onChange={(e) => setAppIdInput(e.target.value)}
                    placeholder="Bot App ID (from Azure Bot Service)"
                    className="w-full px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--background)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[#6264A7]"
                  />
                  <input
                    type="password"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="Bot App Secret"
                    className="w-full px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--background)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[#6264A7]"
                  />
                  <Button
                    size="sm"
                    onClick={handleConnect}
                    disabled={!tokenInput.trim() || !appIdInput.trim() || connecting}
                    className="nodrag w-full"
                    variant="ghost"
                  >
                    {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                    Connect Bot
                  </Button>
                </>
              )}
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
          {availableTeams.length > 1 && (
            <div className="px-2 py-1.5 border-b border-[var(--border)] nodrag">
              <select
                value={selectedTeamId || ""}
                onChange={(e) => handleTeamChange(e.target.value)}
                className="w-full text-[10px] px-1.5 py-1 rounded border border-[var(--border)] bg-[var(--background)] text-[var(--text-primary)]"
              >
                {availableTeams.map((team) => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              </select>
            </div>
          )}
          {/* Show webhook URL once for bot_framework integrations (Azure Bot has one endpoint per bot).
              OAuth-connected users don't have a bot registration, so the webhook URL is not applicable. */}
          {(() => {
            if (integration?.metadata?.auth_type !== 'bot_framework') return null;
            const activeWebhookId = subscriptions.find(s => s.status === "active" && s.webhook_id)?.webhook_id;
            return activeWebhookId ? <WebhookUrlDisplay webhookId={activeWebhookId} /> : null;
          })()}
          <div className="flex-1 overflow-y-auto">
            {/* Inbound subscriptions require Bot Framework credentials */}
            {integration?.metadata?.auth_type !== 'bot_framework' && availableChannels.length > 0 && (
              <div className="px-2 py-1.5 bg-amber-500/10 border-b border-[var(--border)]">
                <p className="text-[9px] text-amber-600 dark:text-amber-400">
                  Inbound messages require Bot Framework credentials. Reconnect with App ID + Secret to subscribe to channels.
                </p>
              </div>
            )}
            {availableChannels.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-4">
                <MessageSquare className="w-6 h-6 text-[var(--text-muted)] mb-2" />
                <p className="text-xs text-[var(--text-muted)] text-center">No channels found</p>
                <p className="text-[10px] text-[var(--text-muted)] text-center mt-1">
                  Make sure the bot has been added to teams and channels.
                </p>
              </div>
            ) : (
              availableChannels.map((channel) => {
                const sub = subscriptions.find(
                  s => s.channel_id === channel.id && s.status === "active"
                );
                const isSubscribed = !!sub;
                const isToggling = subscribing === channel.id;
                const isBotFramework = integration?.metadata?.auth_type === 'bot_framework';
                return (
                  <div key={channel.id} className="border-b border-[var(--border)]">
                    <button
                      onClick={() => isBotFramework && handleToggleChannel(channel)}
                      disabled={!isBotFramework || isToggling}
                      className={cn(
                        "w-full px-2 py-1.5 transition-colors text-left nodrag",
                        !isBotFramework && "opacity-60 cursor-default",
                        isSubscribed
                          ? "bg-[#6264A7]/5 hover:bg-[#6264A7]/10"
                          : isBotFramework ? "hover:bg-[var(--background)]" : "",
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <Hash className={cn(
                          "w-3 h-3 shrink-0",
                          isSubscribed ? "text-[#6264A7]" : "text-[var(--text-muted)]"
                        )} />
                        <span className={cn(
                          "text-[10px] truncate flex-1 font-medium",
                          isSubscribed ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"
                        )}>
                          {channel.name}
                        </span>
                        {isToggling && <Loader2 className="w-3 h-3 animate-spin text-[var(--text-muted)]" />}
                        {!isToggling && isSubscribed && (
                          <CheckCircle className="w-3 h-3 text-[#6264A7]" />
                        )}
                      </div>
                      {channel.topic && (
                        <p className="text-[9px] text-[var(--text-muted)] mt-0.5 ml-[18px] truncate">
                          {channel.topic}
                        </p>
                      )}
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="px-2 py-1 border-t border-[var(--border)] bg-[var(--background)]">
            <div className="flex items-center gap-1 text-[9px] text-[var(--text-muted)]">
              <CheckCircle className="w-2.5 h-2.5 text-green-500" />
              <span>Connected</span>
              {subscriptions.filter(s => s.status === "active").length > 0 && (
                <>
                  <span>&middot;</span>
                  <span>{subscriptions.filter(s => s.status === "active").length} subscribed</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </BlockWrapper>
  );
}

export default TeamsBlock;
