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
} from "lucide-react";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type GmailNode = Node<GmailData, "gmail">;

export function GmailBlock({ id, data, selected }: NodeProps<GmailNode>) {
  const dashboardId = data.dashboardId;
  const connectorsVisible = selected || Boolean(data.connectorMode);

  // Integration state
  const [integration, setIntegration] = React.useState<GmailIntegration | null>(null);
  const [status, setStatus] = React.useState<GmailStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Messages state
  const [messages, setMessages] = React.useState<GmailMessage[]>([]);
  const [messagesTotal, setMessagesTotal] = React.useState(0);
  const [messagesLoading, setMessagesLoading] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);

  // Selected message state
  const [selectedMessage, setSelectedMessage] = React.useState<GmailMessage | null>(null);
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);

  // Track if initial load is done
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

  // Initial load
  React.useEffect(() => {
    loadIntegration();
  }, [loadIntegration]);

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
      <Mail className="w-3.5 h-3.5 text-red-500" />
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
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  // Loading state
  if (loading) {
    return (
      <BlockWrapper selected={selected} minWidth={280} minHeight={200}>
        <ConnectionHandles
          nodeId={id}
          visible={connectorsVisible}
          onConnectorClick={data.onConnectorClick}
        />
        {header}
        <div className="flex items-center justify-center h-full p-4">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
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
        {header}
        <div className="flex flex-col items-center justify-center h-full p-4">
          <Mail className="w-8 h-8 text-[var(--text-muted)] mb-2" />
          <p className="text-xs text-[var(--text-muted)] text-center mb-3">
            Enable Gmail sync for this dashboard
          </p>
          <Button
            size="sm"
            onClick={() => dashboardId && setupGmailMirror(dashboardId).then(() => loadIntegration())}
            className="nodrag"
          >
            Enable Sync
          </Button>
        </div>
      </BlockWrapper>
    );
  }

  // Main view with messages
  return (
    <BlockWrapper selected={selected} minWidth={280} minHeight={200}>
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
      <div className="flex flex-col h-full">
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
