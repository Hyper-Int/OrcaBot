// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import {
  Mail,
  RefreshCw,
  Archive,
  Trash2,
  MailOpen,
  Mail as MailClosed,
  Clock,
  CheckCircle,
  Loader2,
  ChevronLeft,
  Settings,
  LogOut,
  Minimize2,
  Copy,
} from "lucide-react";
import { GmailIcon } from "@/components/icons";
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
import {
  getGmailIntegration,
  getGmailStatus,
  getGmailMessages,
  syncGmail,
  performGmailAction,
  setupGmailMirror,
  unlinkGmailMirror,
  type GmailIntegration,
  type GmailStatus,
  type GmailMessage,
  type GmailActionType,
} from "@/lib/api/cloudflare";
import { API } from "@/config/env";
import type { DashboardItem } from "@/types/dashboard";

interface GmailData extends Record<string, unknown> {
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

type GmailNode = Node<GmailData, "gmail">;

export function GmailBlock({ id, data, selected }: NodeProps<GmailNode>) {
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

  // Integration state
  const [integration, setIntegration] = React.useState<GmailIntegration | null>(null);
  const [status, setStatus] = React.useState<GmailStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tokenRevoked, setTokenRevoked] = React.useState(false);
  const [enabling, setEnabling] = React.useState(false);

  // Messages state
  const [messages, setMessages] = React.useState<GmailMessage[]>([]);
  const [messagesTotal, setMessagesTotal] = React.useState(0);
  const [messagesLoading, setMessagesLoading] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);

  // Selected message state
  const [selectedMessage, setSelectedMessage] = React.useState<GmailMessage | null>(null);
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);

  // Track if initial load is done (per dashboard to handle Fast Refresh/Strict Mode)
  const initialLoadDone = React.useRef(false);
  const loadedDashboardRef = React.useRef<string | null>(null);

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
        getGmailIntegration(dashboardId),
        getGmailStatus(dashboardId).catch(() => null),
      ]);
      setIntegration(integrationData);
      setStatus(statusData);
      initialLoadDone.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Gmail");
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  // Load messages
  const loadMessages = React.useCallback(async () => {
    if (!dashboardId) return;
    try {
      setMessagesLoading(true);
      const response = await getGmailMessages(dashboardId, { limit: 20 });
      setMessages(response.messages);
      setMessagesTotal(response.total);
    } catch {
      // Silently fail - user can retry via sync button
    } finally {
      setMessagesLoading(false);
    }
  }, [dashboardId]);

  // Initial load - skip duplicate loads in Strict Mode/Fast Refresh
  React.useEffect(() => {
    if (!dashboardId) return;
    if (loadedDashboardRef.current === dashboardId) return;
    loadedDashboardRef.current = dashboardId;
    loadIntegration();
  }, [dashboardId, loadIntegration]);

  // Load messages when integration is ready (use booleans to avoid flicker from object reference changes)
  const gmailReady = Boolean(integration?.connected && integration?.linked);
  React.useEffect(() => {
    if (gmailReady) {
      loadMessages();
    }
  }, [gmailReady, loadMessages]);

  // Sync handler
  const handleSync = async () => {
    if (!dashboardId) return;
    try {
      setSyncing(true);
      await syncGmail(dashboardId);
      await loadMessages();
      await loadIntegration();
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setSyncing(false);
    }
  };

  // Connect Gmail
  const handleConnect = () => {
    if (!dashboardId) return;
    const connectUrl = `${API.cloudflare.base}/integrations/google/gmail/connect?dashboard_id=${dashboardId}&mode=popup`;
    const popup = window.open(connectUrl, "gmail-connect", "width=600,height=700");

    let completed = false;

    const completeSetup = async () => {
      if (completed) return;
      completed = true;
      window.removeEventListener("message", handleMessage);
      if (pollInterval) clearInterval(pollInterval);
      popup?.close();
      try {
        await setupGmailMirror(dashboardId);
        await loadIntegration();
        await loadMessages();
      } catch (err) {
        console.error("Failed to set up Gmail mirror:", err);
        // Still reload integration state even if setup fails
        await loadIntegration();
      }
    };

    const handleMessage = async (event: MessageEvent) => {
      if (event.data?.type === "gmail-auth-complete") {
        await completeSetup();
      }
    };
    window.addEventListener("message", handleMessage);

    // Also poll for popup close (backup in case postMessage fails due to origin mismatch)
    const pollInterval = setInterval(async () => {
      if (popup?.closed) {
        clearInterval(pollInterval);
        // Give a moment for postMessage to arrive, then check integration status
        setTimeout(async () => {
          if (!completed) {
            await completeSetup();
          }
        }, 500);
      }
    }, 500);
  };

  // Disconnect Gmail
  const handleDisconnect = async () => {
    if (!dashboardId) return;
    try {
      await unlinkGmailMirror(dashboardId);
      setIntegration(null);
      setStatus(null);
      setMessages([]);
      setSelectedMessage(null);
    } catch (err) {
      console.error("Failed to disconnect Gmail:", err);
    }
  };

  // Perform action on message
  const handleAction = async (action: GmailActionType) => {
    if (!selectedMessage || !dashboardId) return;
    try {
      setActionLoading(action);
      const result = await performGmailAction(dashboardId, selectedMessage.messageId, action);
      setMessages(prev =>
        prev.map(m =>
          m.messageId === selectedMessage.messageId
            ? { ...m, labels: result.labels }
            : m
        )
      );
      setSelectedMessage(prev =>
        prev ? { ...prev, labels: result.labels } : null
      );
      if (action === "archive" || action === "trash") {
        setSelectedMessage(null);
        await loadMessages();
      }
    } catch (err) {
      console.error("Action failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  // Format date
  const formatDate = (dateStr: string) => {
    const date = new Date(parseInt(dateStr));
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } else if (days < 7) {
      return date.toLocaleDateString([], { weekday: "short" });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  const extractSender = (from: string | null) => {
    if (!from) return "Unknown";
    const match = from.match(/^([^<]+)/);
    return match ? match[1].trim() : from;
  };

  const isUnread = (message: GmailMessage) => message.labels.includes("UNREAD");

  // Header
  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <GmailIcon className="w-3.5 h-3.5" />
      <div className="text-xs text-[var(--foreground-muted)] truncate flex-1">
        {integration?.emailAddress || status?.emailAddress || "Gmail"}
      </div>
      <div className="flex items-center gap-1">
        {integration?.connected && integration?.linked && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleSync}
            disabled={syncing}
            title="Sync"
            className="nodrag"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", syncing && "animate-spin")} />
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
                Disconnect Gmail
              </DropdownMenuItem>
            )}
            {!integration?.connected && (
              <DropdownMenuItem onClick={handleConnect}>
                <Mail className="w-3.5 h-3.5 mr-2" />
                Connect Gmail
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
            Disconnect Gmail
          </DropdownMenuItem>
        )}
        {!integration?.connected && (
          <DropdownMenuItem onClick={handleConnect}>
            <Mail className="w-3.5 h-3.5 mr-2" />
            Connect Gmail
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
        icon={<GmailIcon className="w-14 h-14" />}
        label={integration?.emailAddress || "Gmail"}
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
            <Mail className="w-8 h-8 text-[var(--text-muted)] mb-2" />
            <p className="text-xs text-[var(--text-muted)] text-center mb-3">
              Connect Gmail to view emails
            </p>
            <Button size="sm" onClick={handleConnect} className="nodrag">
              Connect Gmail
            </Button>
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Not linked state
  if (!integration?.linked) {
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
            <Mail className="w-8 h-8 text-[var(--text-muted)] mb-2" />
            <p className="text-xs text-[var(--text-muted)] text-center mb-3">
              Enable Gmail sync for this dashboard
            </p>
            <Button
              size="sm"
              disabled={enabling}
              onClick={async () => {
                if (!dashboardId || enabling) return;
                try {
                  setEnabling(true);
                  setTokenRevoked(false);
                  await setupGmailMirror(dashboardId);
                  await loadIntegration();
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  if (msg.includes("TOKEN_REVOKED") || msg.includes("revoked")) {
                    setTokenRevoked(true);
                  } else {
                    console.error("Failed to setup Gmail:", err);
                  }
                } finally {
                  setEnabling(false);
                }
              }}
              className="nodrag"
            >
              {enabling ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  Syncing...
                </>
              ) : (
                "Enable Sync"
              )}
            </Button>
            {tokenRevoked && (
              <p className="text-[10px] text-red-500 text-center mt-2">
                Access was revoked. Please disconnect and reconnect Gmail.
              </p>
            )}
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Main view with messages
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

        {/* Two pane layout */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Message list */}
          <div className={cn(
            "flex flex-col overflow-hidden border-r border-[var(--border)]",
            selectedMessage ? "w-1/2" : "w-full"
          )}>
            <div className="flex-1 overflow-y-auto">
              {messagesLoading ? (
                <div className="flex items-center justify-center p-4">
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-4">
                  <p className="text-xs text-[var(--text-muted)]">No messages</p>
                </div>
              ) : (
                messages.map(message => (
                  <button
                    key={message.messageId}
                    onClick={() => setSelectedMessage(message)}
                    className={cn(
                      "nodrag w-full px-2 py-1.5 text-left border-b border-[var(--border)] hover:bg-[var(--background)] transition-colors",
                      selectedMessage?.messageId === message.messageId && "bg-[var(--background)]",
                      isUnread(message) && "bg-blue-50/5"
                    )}
                  >
                    <div className="flex items-center gap-1">
                      <span className={cn(
                        "text-[10px] truncate flex-1",
                        isUnread(message) ? "font-semibold" : "text-[var(--text-secondary)]"
                      )}>
                        {extractSender(message.from)}
                      </span>
                      <span className="text-[9px] text-[var(--text-muted)]">
                        {formatDate(message.internalDate)}
                      </span>
                    </div>
                    <p className={cn(
                      "text-[10px] truncate",
                      isUnread(message) ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"
                    )}>
                      {message.subject || "(no subject)"}
                    </p>
                  </button>
                ))
              )}
            </div>

            {/* Status footer */}
            <div className="px-2 py-1 border-t border-[var(--border)] bg-[var(--background)]">
              <div className="flex items-center gap-1 text-[9px] text-[var(--text-muted)]">
                <CheckCircle className="w-2.5 h-2.5 text-green-500" />
                <span>{messagesTotal} messages</span>
                {status?.lastSyncedAt && (
                  <>
                    <span>·</span>
                    <Clock className="w-2.5 h-2.5" />
                    <span>{new Date(status.lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Message preview */}
          {selectedMessage && (
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              {/* Preview header with actions */}
              <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSelectedMessage(null)}
                  className="nodrag"
                >
                  <ChevronLeft className="w-3 h-3" />
                </Button>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleAction("archive")}
                  disabled={!!actionLoading}
                  title="Archive"
                  className="nodrag"
                >
                  {actionLoading === "archive" ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Archive className="w-3 h-3" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleAction("trash")}
                  disabled={!!actionLoading}
                  title="Delete"
                  className="nodrag"
                >
                  {actionLoading === "trash" ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Trash2 className="w-3 h-3" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleAction(isUnread(selectedMessage) ? "mark_read" : "mark_unread")}
                  disabled={!!actionLoading}
                  title={isUnread(selectedMessage) ? "Mark read" : "Mark unread"}
                  className="nodrag"
                >
                  {actionLoading?.startsWith("mark") ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : isUnread(selectedMessage) ? (
                    <MailOpen className="w-3 h-3" />
                  ) : (
                    <MailClosed className="w-3 h-3" />
                  )}
                </Button>
              </div>

              {/* Message content */}
              <div className="flex-1 overflow-y-auto p-2">
                <h3 className="text-xs font-medium text-[var(--text-primary)] mb-1">
                  {selectedMessage.subject || "(no subject)"}
                </h3>
                <p className="text-[10px] text-[var(--text-secondary)] mb-2">
                  {selectedMessage.from}
                </p>
                <p className="text-[10px] text-[var(--text-secondary)] whitespace-pre-wrap">
                  {selectedMessage.snippet}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </BlockWrapper>
  );
}

export default GmailBlock;
