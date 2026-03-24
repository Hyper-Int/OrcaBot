// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: outlook-mirror-v1-email-sync

"use client";

const MODULE_REVISION = "outlook-mirror-v1-email-sync";
console.log(`[OutlookBlock] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import {
  Mail,
  RefreshCw,
  Archive,
  Trash2,
  Eye,
  EyeOff,
  Clock,
  CheckCircle,
  Loader2,
  ChevronLeft,
  Settings,
  LogOut,
  Minimize2,
  Copy,
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
import {
  setupOutlookMirror,
  getOutlookMirrorStatus,
  syncOutlook,
  getOutlookMessages,
  performOutlookAction,
  disconnectOutlook,
  type OutlookMirrorStatus,
  type OutlookMessage,
  type OutlookActionType,
} from "@/lib/api/cloudflare";
import { API } from "@/config/env";
import { apiGet } from "@/lib/api/client";
import { OutlookIcon } from "@/components/icons/MessagingIcons";
import { BlockSettingsFooter } from "./BlockSettingsFooter";
import type { DashboardItem } from "@/types/dashboard";
import { HelpButton } from "@/components/help/HelpDialog";
import { outlookDoc } from "@/docs/content/outlook";

// ============================================
// Outlook types
// ============================================

const OUTLOOK_BLUE = "#0078D4";

interface OutlookIntegration {
  connected: boolean;
  linked?: boolean;
  emailAddress: string | null;
  accountName: string | null;
}

// ============================================
// API helpers
// ============================================

async function getOutlookIntegration(dashboardId: string): Promise<OutlookIntegration> {
  const url = new URL(`${API.cloudflare.base}/integrations/outlook`);
  url.searchParams.set("dashboard_id", dashboardId);
  try {
    return await apiGet<OutlookIntegration>(url.toString());
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
      return { connected: false, emailAddress: null, accountName: null };
    }
    throw err;
  }
}

// ============================================
// Helpers
// ============================================

function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function extractSender(message: OutlookMessage): string {
  if (message.fromName) return message.fromName;
  if (message.fromAddress) return message.fromAddress;
  return "Unknown";
}

// ============================================
// Component
// ============================================

interface OutlookData extends Record<string, unknown> {
  content: string;
  size: { width: number; height: number };
  dashboardId?: string;
  metadata?: { minimized?: boolean; expandedSize?: { width: number; height: number }; [key: string]: unknown };
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  onDuplicate?: () => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type OutlookNode = Node<OutlookData, "outlook">;

export function OutlookBlock({ id, data, selected }: NodeProps<OutlookNode>) {
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
  const [integration, setIntegration] = React.useState<OutlookIntegration | null>(null);
  const [status, setStatus] = React.useState<OutlookMirrorStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tokenRevoked, setTokenRevoked] = React.useState(false);
  const [enabling, setEnabling] = React.useState(false);

  // Messages state
  const [messages, setMessages] = React.useState<OutlookMessage[]>([]);
  const [messagesTotal, setMessagesTotal] = React.useState(0);
  const [messagesLoading, setMessagesLoading] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);

  // Selected message state
  const [selectedMessage, setSelectedMessage] = React.useState<OutlookMessage | null>(null);
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);

  // Track if initial load is done (per dashboard to handle Fast Refresh/Strict Mode)
  const initialLoadDone = React.useRef(false);
  const loadedDashboardRef = React.useRef<string | null>(null);

  // Load integration status
  const loadIntegration = React.useCallback(async () => {
    if (!dashboardId) return;
    try {
      if (!initialLoadDone.current) {
        setLoading(true);
      }
      setError(null);
      const [integrationData, statusData] = await Promise.all([
        getOutlookIntegration(dashboardId),
        getOutlookMirrorStatus(dashboardId).catch(() => null),
      ]);
      setIntegration(integrationData);
      setStatus(statusData);
      initialLoadDone.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Outlook");
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  // Load messages
  const loadMessages = React.useCallback(async () => {
    if (!dashboardId) return;
    try {
      setMessagesLoading(true);
      const response = await getOutlookMessages(dashboardId, 20, 0);
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

  // Load messages when mirror is ready
  const outlookReady = Boolean(integration?.connected && status?.connected);
  React.useEffect(() => {
    if (outlookReady) {
      loadMessages();
    }
  }, [outlookReady, loadMessages]);

  // Sync handler
  const handleSync = async () => {
    if (!dashboardId) return;
    try {
      setSyncing(true);
      await syncOutlook(dashboardId);
      await loadMessages();
      await loadIntegration();
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setSyncing(false);
    }
  };

  // Connect Outlook via OAuth popup
  const handleConnect = () => {
    if (!dashboardId) return;
    const connectUrl = `${API.cloudflare.base}/integrations/outlook/connect?dashboard_id=${dashboardId}&mode=popup`;
    const popup = window.open(connectUrl, "outlook-connect", "width=600,height=700");

    let completed = false;

    const completeSetup = async () => {
      if (completed) return;
      completed = true;
      window.removeEventListener("message", handleMessage);
      if (pollInterval) clearInterval(pollInterval);
      popup?.close();
      try {
        await setupOutlookMirror(dashboardId);
        await loadIntegration();
        await loadMessages();
      } catch (err) {
        console.error("Failed to set up Outlook mirror:", err);
        await loadIntegration();
      }
    };

    const handleMessage = async (event: MessageEvent) => {
      if (event.data?.type === "outlook-auth-complete") {
        await completeSetup();
      }
    };
    window.addEventListener("message", handleMessage);

    // Also poll for popup close (backup in case postMessage fails due to origin mismatch)
    const pollInterval = setInterval(async () => {
      if (popup?.closed) {
        clearInterval(pollInterval);
        setTimeout(async () => {
          if (!completed) {
            await completeSetup();
          }
        }, 500);
      }
    }, 500);
  };

  // Disconnect Outlook
  const handleDisconnect = async () => {
    if (!dashboardId) return;
    try {
      await disconnectOutlook();
      setIntegration(null);
      setStatus(null);
      setMessages([]);
      setSelectedMessage(null);
    } catch (err) {
      console.error("Failed to disconnect Outlook:", err);
    }
  };

  // Perform action on message
  const handleAction = async (action: OutlookActionType) => {
    if (!selectedMessage || !dashboardId) return;
    try {
      setActionLoading(action);
      await performOutlookAction(dashboardId, selectedMessage.messageId, action);
      // Update local state
      if (action === "mark_read") {
        setMessages(prev =>
          prev.map(m =>
            m.messageId === selectedMessage.messageId ? { ...m, isRead: true } : m
          )
        );
        setSelectedMessage(prev => prev ? { ...prev, isRead: true } : null);
      } else if (action === "mark_unread") {
        setMessages(prev =>
          prev.map(m =>
            m.messageId === selectedMessage.messageId ? { ...m, isRead: false } : m
          )
        );
        setSelectedMessage(prev => prev ? { ...prev, isRead: false } : null);
      } else if (action === "archive" || action === "delete") {
        setSelectedMessage(null);
        await loadMessages();
      }
    } catch (err) {
      console.error("Action failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  // Header
  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <OutlookIcon className="w-3.5 h-3.5" />
      <div className="text-xs text-[var(--foreground-muted)] truncate flex-1">
        {integration?.emailAddress || status?.emailAddress || integration?.accountName || "Outlook"}
      </div>
      <div className="flex items-center gap-1">
        <HelpButton doc={outlookDoc} />
        {integration?.connected && status?.connected && (
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
          <DropdownMenuContent align="end" className="w-44">
            {integration?.connected && (
              <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
                <LogOut className="w-3.5 h-3.5 mr-2" />
                Disconnect Outlook
              </DropdownMenuItem>
            )}
            {!integration?.connected && (
              <DropdownMenuItem onClick={handleConnect}>
                <Mail className="w-3.5 h-3.5 mr-2" />
                Connect Outlook
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
      <DropdownMenuContent align="end" className="w-44">
        {integration?.connected && (
          <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
            <LogOut className="w-3.5 h-3.5 mr-2" />
            Disconnect Outlook
          </DropdownMenuItem>
        )}
        {!integration?.connected && (
          <DropdownMenuItem onClick={handleConnect}>
            <Mail className="w-3.5 h-3.5 mr-2" />
            Connect Outlook
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
        icon={<OutlookIcon className="w-14 h-14" />}
        label={integration?.emailAddress || integration?.accountName || "Outlook"}
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
            <OutlookIcon className="w-8 h-8 mb-2" />
            <p className="text-xs text-[var(--text-muted)] text-center mb-3">
              Connect your Microsoft Outlook account to manage emails
            </p>
            <Button
              size="sm"
              onClick={handleConnect}
              className="nodrag"
              style={{ backgroundColor: OUTLOOK_BLUE, color: "#fff" }}
            >
              Connect Microsoft Outlook
            </Button>
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Connected but not linked (mirror not set up)
  if (!status?.connected) {
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
              Enable Outlook sync for this dashboard
            </p>
            <Button
              size="sm"
              disabled={enabling}
              onClick={async () => {
                if (!dashboardId || enabling) return;
                try {
                  setEnabling(true);
                  setTokenRevoked(false);
                  await setupOutlookMirror(dashboardId);
                  await loadIntegration();
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  if (msg.includes("TOKEN_REVOKED") || msg.includes("revoked")) {
                    setTokenRevoked(true);
                  } else {
                    console.error("Failed to setup Outlook:", err);
                  }
                } finally {
                  setEnabling(false);
                }
              }}
              className="nodrag"
              style={{ backgroundColor: OUTLOOK_BLUE, color: "#fff" }}
            >
              {enabling ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  Syncing...
                </>
              ) : (
                "Enable Outlook Sync"
              )}
            </Button>
            {tokenRevoked && (
              <p className="text-[10px] text-red-500 text-center mt-2">
                Access was revoked. Please disconnect and reconnect Outlook.
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
                      !message.isRead && "bg-blue-50/5"
                    )}
                  >
                    <div className="flex items-center gap-1">
                      <span className={cn(
                        "text-[10px] truncate flex-1",
                        !message.isRead ? "font-semibold" : "text-[var(--text-secondary)]"
                      )}>
                        {extractSender(message)}
                      </span>
                      <span className="text-[9px] text-[var(--text-muted)]">
                        {formatDate(message.receivedDate)}
                      </span>
                    </div>
                    <p className={cn(
                      "text-[10px] truncate",
                      !message.isRead ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"
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
                    <span>&middot;</span>
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
                  onClick={() => handleAction("delete")}
                  disabled={!!actionLoading}
                  title="Delete"
                  className="nodrag"
                >
                  {actionLoading === "delete" ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Trash2 className="w-3 h-3" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleAction(selectedMessage.isRead ? "mark_unread" : "mark_read")}
                  disabled={!!actionLoading}
                  title={selectedMessage.isRead ? "Mark unread" : "Mark read"}
                  className="nodrag"
                >
                  {actionLoading?.startsWith("mark") ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : selectedMessage.isRead ? (
                    <EyeOff className="w-3 h-3" />
                  ) : (
                    <Eye className="w-3 h-3" />
                  )}
                </Button>
              </div>

              {/* Message content */}
              <div className="flex-1 overflow-y-auto p-2">
                <h3 className="text-xs font-medium text-[var(--text-primary)] mb-1">
                  {selectedMessage.subject || "(no subject)"}
                </h3>
                <p className="text-[10px] text-[var(--text-secondary)] mb-2">
                  {selectedMessage.fromName
                    ? `${selectedMessage.fromName} <${selectedMessage.fromAddress || ""}>`
                    : selectedMessage.fromAddress || "Unknown"}
                </p>
                <p className="text-[10px] text-[var(--text-secondary)] whitespace-pre-wrap">
                  {selectedMessage.bodyPreview}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </BlockWrapper>
  );
}

export default OutlookBlock;
