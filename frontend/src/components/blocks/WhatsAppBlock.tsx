// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: whatsapp-block-v16-reconnect-status

"use client";

const MODULE_REVISION = "whatsapp-block-v16-reconnect-status";
console.log(`[WhatsAppBlock] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import {
  RefreshCw,
  CheckCircle,
  Loader2,
  Settings,
  LogOut,
  Minimize2,
  Copy,
  Smartphone,
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
import { QRCodeSVG } from "qrcode.react";
import { WhatsAppIcon } from "@/components/icons";
import { BlockSettingsFooter } from "./BlockSettingsFooter";
import { useConnectionDataFlow } from "@/contexts/ConnectionDataFlowContext";
import type { DashboardItem } from "@/types/dashboard";

// ============================================
// WhatsApp types
// ============================================

interface WhatsAppIntegration {
  connected: boolean;
  accountName: string | null;
  phoneNumber: string | null;
  metadata?: Record<string, unknown>;
}

interface MessagingSubscription {
  id: string;
  dashboard_id: string;
  item_id: string;
  provider: string;
  channel_id: string | null;
  channel_name: string | null;
  chat_id: string | null;
  status: string;
}

// ============================================
// API helpers
// ============================================

interface WhatsAppPlatformConfig {
  configured: boolean;
  phoneNumberId?: string;
  displayPhone?: string | null;
  verifiedName?: string | null;
}

async function getWhatsAppPlatformConfig(): Promise<WhatsAppPlatformConfig> {
  const url = new URL(`${API.cloudflare.base}/integrations/whatsapp/platform-config`);
  try {
    return await apiGet<WhatsAppPlatformConfig>(url.toString());
  } catch {
    return { configured: false };
  }
}

async function getWhatsAppIntegration(dashboardId: string): Promise<WhatsAppIntegration> {
  const url = new URL(`${API.cloudflare.base}/integrations/whatsapp`);
  url.searchParams.set("dashboard_id", dashboardId);
  try {
    const result = await apiGet<{ connected: boolean; accountName?: string; metadata?: Record<string, unknown> }>(url.toString());
    const meta = result.metadata || {};
    const phoneNumber = (meta.display_phone_number as string) || null;
    return {
      connected: result.connected,
      accountName: result.accountName || null,
      phoneNumber,
      metadata: meta,
    };
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
      return { connected: false, accountName: null, phoneNumber: null };
    }
    throw err;
  }
}

async function disconnectWhatsAppApi(dashboardId: string): Promise<{ ok: boolean }> {
  const url = new URL(`${API.cloudflare.base}/integrations/whatsapp`);
  url.searchParams.set("dashboard_id", dashboardId);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

async function connectWithToken(
  dashboardId: string,
  token: string,
  metadata?: Record<string, unknown>,
): Promise<{ connected: boolean; accountName: string }> {
  const url = new URL(`${API.cloudflare.base}/integrations/whatsapp/connect-token`);
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

async function ensureWhatsAppSubscription(
  dashboardId: string,
  itemId: string,
): Promise<{ id: string; webhookId: string }> {
  const url = new URL(`${API.cloudflare.base}/messaging/subscriptions`);
  return apiFetch<{ id: string; webhookId: string }>(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dashboardId,
      itemId,
      provider: "whatsapp",
      // No chatId = catch-all subscription (receives all messages to the business number)
    }),
  });
}

async function deleteSubscription(subscriptionId: string): Promise<{ ok: boolean }> {
  const url = new URL(`${API.cloudflare.base}/messaging/subscriptions/${subscriptionId}`);
  return apiFetch<{ ok: boolean }>(url.toString(), { method: "DELETE" });
}

// --- Personal WhatsApp (Bridge/Baileys) ---

async function connectWhatsAppPersonal(
  dashboardId: string,
  itemId: string,
): Promise<{ subscriptionId: string; webhookId: string; status: string; qrCode: string | null }> {
  const url = new URL(`${API.cloudflare.base}/integrations/whatsapp/connect-personal`);
  return apiFetch<{ subscriptionId: string; webhookId: string; status: string; qrCode: string | null }>(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dashboardId, itemId }),
  });
}

async function pollWhatsAppQr(
  subscriptionId: string,
): Promise<{ status: string; qrCode: string | null; reconnectAttempts?: number; error?: string | null }> {
  const url = new URL(`${API.cloudflare.base}/integrations/whatsapp/qr`);
  url.searchParams.set("subscription_id", subscriptionId);
  return apiGet<{ status: string; qrCode: string | null; reconnectAttempts?: number; error?: string | null }>(url.toString());
}

// ============================================
// Component
// ============================================

const WHATSAPP_GREEN = "#25D366";

/** Small inline toggle for message filtering (OrcaBot chat only vs everyone) */
function MessageFilterToggle({
  value,
  onChange,
}: {
  value: "orcabot" | "everyone";
  onChange: (v: "orcabot" | "everyone") => void;
}) {
  return (
    <div className="flex items-center gap-1 text-[10px] nodrag">
      <span className="text-[var(--text-muted)]">Messages:</span>
      <button
        onClick={() => onChange(value === "orcabot" ? "everyone" : "orcabot")}
        className="px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--background)] text-[var(--text-primary)] hover:bg-[var(--hover)] transition-colors"
      >
        {value === "orcabot" ? "OrcaBot chat" : "Everyone"}
      </button>
    </div>
  );
}

interface WhatsAppData extends Record<string, unknown> {
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

type WhatsAppNode = Node<WhatsAppData, "whatsapp">;

export function WhatsAppBlock({ id, data, selected }: NodeProps<WhatsAppNode>) {
  const dashboardId = data.dashboardId;
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const isMinimized = data.metadata?.minimized === true;
  const messageFilter = (data.metadata?.messageFilter as "orcabot" | "everyone") || "orcabot";
  const handleFilterChange = React.useCallback((v: "orcabot" | "everyone") => {
    data.onItemChange?.({ metadata: { ...data.metadata, messageFilter: v } });
  }, [data]);
  const [expandAnimation, setExpandAnimation] = React.useState<string | null>(null);
  const [isAnimatingMinimize, setIsAnimatingMinimize] = React.useState(false);
  const minimizeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const connectionFlow = useConnectionDataFlow();

  React.useEffect(() => {
    return () => {
      if (minimizeTimeoutRef.current) clearTimeout(minimizeTimeoutRef.current);
      if (qrPollRef.current) clearInterval(qrPollRef.current);
    };
  }, []);

  // Register input handlers for outbound message sending
  React.useEffect(() => {
    if (!connectionFlow || !dashboardId) return;

    const handler = async (payload: { text?: string }) => {
      if (!payload.text?.trim()) return;
      try {
        await apiFetch(`${API.cloudflare.base}/messaging/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dashboardId, itemId: id, text: payload.text }),
        });
      } catch (err) {
        console.error("[WhatsAppBlock] Outbound send failed:", err);
      }
    };

    const c1 = connectionFlow.registerInputHandler(id, "left-in", handler);
    const c2 = connectionFlow.registerInputHandler(id, "top-in", handler);
    return () => { c1(); c2(); };
  }, [id, connectionFlow, dashboardId]);

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

  const [platformConfig, setPlatformConfig] = React.useState<WhatsAppPlatformConfig | null>(null);
  const [integration, setIntegration] = React.useState<WhatsAppIntegration | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [subscriptions, setSubscriptions] = React.useState<MessagingSubscription[]>([]);
  const [refreshing, setRefreshing] = React.useState(false);
  const [tokenInput, setTokenInput] = React.useState("");
  const [phoneNumberIdInput, setPhoneNumberIdInput] = React.useState("");
  const [connecting, setConnecting] = React.useState(false);
  // Connection mode state — default to business API
  const [connectMode, setConnectMode] = React.useState<"choose" | "business" | "personal">("business");
  const [personalQrCode, setPersonalQrCode] = React.useState<string | null>(null);
  const [personalStatus, setPersonalStatus] = React.useState<string | null>(null);
  const [personalSubId, setPersonalSubId] = React.useState<string | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = React.useState<number>(0);
  const [connectionError, setConnectionError] = React.useState<string | null>(null);
  const qrPollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const initialLoadDone = React.useRef(false);

  const loadIntegration = React.useCallback(async () => {
    if (!dashboardId) return;
    try {
      if (!initialLoadDone.current) setLoading(true);
      setError(null);

      // Fetch platform config, per-user integration, and subscriptions in parallel
      const [platformCfg, integrationData, subs] = await Promise.all([
        getWhatsAppPlatformConfig(),
        getWhatsAppIntegration(dashboardId),
        listSubscriptions(dashboardId),
      ]);
      setPlatformConfig(platformCfg);
      setIntegration(integrationData);

      const mySubs = subs.filter(s => s.provider === "whatsapp" && s.item_id === id);
      setSubscriptions(mySubs);

      // If platform WhatsApp is configured, auto-create catch-all subscription for this block
      if (platformCfg.configured) {
        const hasCatchAll = mySubs.some(
          s => !s.chat_id && s.status === "active",
        );
        if (!hasCatchAll) {
          try {
            const newSub = await ensureWhatsAppSubscription(dashboardId, id);
            setSubscriptions(prev => [...prev, {
              id: newSub.id,
              dashboard_id: dashboardId,
              item_id: id,
              provider: "whatsapp",
              channel_id: platformCfg.phoneNumberId || null,
              channel_name: null,
              chat_id: null,
              status: "active",
            }]);
          } catch (err) {
            console.warn("[WhatsAppBlock] Auto-subscription failed:", err);
          }
        }
      }

      // Detect existing personal subscription (bridge connection with webhook_id starting with 'bridge_')
      // Works for both pure bridge mode and hybrid mode (platform configured + bridge linked)
      const personalSub = mySubs.find(
        s => !s.channel_id && !s.chat_id && (s.status === "pending" || s.status === "active"),
      );
      if (personalSub) {
        setPersonalSubId(personalSub.id);
        setPersonalStatus(personalSub.status === "active" ? "connected" : "connecting");
      }

      initialLoadDone.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load WhatsApp");
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

  const startQrPolling = React.useCallback((subId: string) => {
    if (qrPollRef.current) clearInterval(qrPollRef.current);
    qrPollRef.current = setInterval(async () => {
      try {
        const poll = await pollWhatsAppQr(subId);
        setPersonalStatus(poll.status);
        if (poll.qrCode) setPersonalQrCode(poll.qrCode);
        if (typeof poll.reconnectAttempts === "number") setReconnectAttempts(poll.reconnectAttempts);
        if (poll.error) setConnectionError(poll.error);

        if (poll.status === "connected") {
          if (qrPollRef.current) clearInterval(qrPollRef.current);
          qrPollRef.current = null;
          setPersonalQrCode(null);
          setConnectionError(null);
          await loadIntegration();
        } else if (poll.status === "error") {
          // Bridge reported an error — stop polling, let user retry
          if (qrPollRef.current) clearInterval(qrPollRef.current);
          qrPollRef.current = null;
        }
      } catch {
        // Transient polling error — keep trying
      }
    }, 2500);
  }, [loadIntegration]);

  // Resume QR polling for rehydrated pending personal subscriptions.
  // Must be before all conditional returns to satisfy Rules of Hooks.
  React.useEffect(() => {
    if (personalSubId && personalStatus === "connecting" && !qrPollRef.current) {
      startQrPolling(personalSubId);
    }
  }, [personalSubId, personalStatus, startQrPolling]);

  // Auto-start bridge connection when platform is configured (hybrid mode)
  const autoConnectTriggered = React.useRef(false);
  React.useEffect(() => {
    if (
      platformConfig?.configured &&
      !personalSubId &&
      !connecting &&
      !loading &&
      dashboardId &&
      !autoConnectTriggered.current
    ) {
      autoConnectTriggered.current = true;
      handleConnectPersonal();
    }
  }, [platformConfig, personalSubId, connecting, loading, dashboardId]);

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
    if (!tokenInput.trim() || !phoneNumberIdInput.trim() || !dashboardId) return;
    setConnecting(true);
    try {
      await connectWithToken(dashboardId, tokenInput.trim(), { phone_number_id: phoneNumberIdInput.trim() });
      await loadIntegration();
      setTokenInput("");
      setPhoneNumberIdInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setConnecting(false);
    }
  };

  const handleConnectPersonal = async () => {
    if (!dashboardId) return;
    setConnecting(true);
    setError(null);
    try {
      const result = await connectWhatsAppPersonal(dashboardId, id);
      setPersonalSubId(result.subscriptionId);
      setPersonalQrCode(result.qrCode);
      setPersonalStatus(result.status);

      // Start polling for QR code / connection status
      startQrPolling(result.subscriptionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start personal WhatsApp connection");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!dashboardId) return;
    try {
      await disconnectWhatsAppApi(dashboardId);
      setIntegration(null);
    } catch (err) {
      console.error("Failed to disconnect WhatsApp:", err);
    }
  };

  const handleDisconnectPersonal = async () => {
    if (!personalSubId) return;
    try {
      if (qrPollRef.current) {
        clearInterval(qrPollRef.current);
        qrPollRef.current = null;
      }
      await deleteSubscription(personalSubId);
      setPersonalSubId(null);
      setPersonalStatus(null);
      setPersonalQrCode(null);
      setConnectMode("choose");
    } catch (err) {
      console.error("Failed to disconnect personal WhatsApp:", err);
    }
  };

  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <WhatsAppIcon className="w-3.5 h-3.5" />
      <div className="text-xs text-[var(--foreground-muted)] truncate flex-1">
        {integration?.accountName || "WhatsApp"}
      </div>
      <div className="flex items-center gap-1">
        {(integration?.connected || (personalSubId && personalStatus === "connected")) && (
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
                Disconnect WhatsApp
              </DropdownMenuItem>
            )}
            {personalSubId && personalStatus === "connected" && (
              <DropdownMenuItem onClick={handleDisconnectPersonal} className="text-red-500">
                <Smartphone className="w-3.5 h-3.5 mr-2" />
                Unlink Phone
              </DropdownMenuItem>
            )}
            {!integration?.connected && !personalSubId && (
              <DropdownMenuItem onClick={() => { /* focus token input */ }}>
                <WhatsAppIcon className="w-3.5 h-3.5 mr-2" />
                Connect WhatsApp
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
            Disconnect WhatsApp
          </DropdownMenuItem>
        )}
        {!integration?.connected && (
          <DropdownMenuItem onClick={() => { /* focus token input */ }}>
            <WhatsAppIcon className="w-3.5 h-3.5 mr-2" />
            Connect WhatsApp
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
        icon={<WhatsAppIcon className="w-14 h-14" />}
        label={integration?.accountName || "WhatsApp"}
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

  // Platform WhatsApp configured — hybrid-aware UI
  if (platformConfig?.configured) {
    // Hybrid mode: personal phone linked + Business API configured
    if (personalSubId && personalStatus === "connected") {
      return (
        <BlockWrapper selected={selected} minWidth={280} minHeight={200} className={cn(expandAnimation)}>
          <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
          <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
            {header}
            <div className="flex flex-col items-center justify-center flex-1 p-4">
              <div className="w-10 h-10 rounded-full flex items-center justify-center mb-3" style={{ backgroundColor: `${WHATSAPP_GREEN}15` }}>
                <CheckCircle className="w-5 h-5" style={{ color: WHATSAPP_GREEN }} />
              </div>
              <p className="text-xs font-medium text-[var(--text-primary)] mb-0.5">Hybrid Mode Active</p>
              <p className="text-[10px] text-[var(--text-muted)] mb-1">
                {platformConfig.verifiedName || "OrcaBot"}{platformConfig.displayPhone ? ` \u00b7 ${platformConfig.displayPhone}` : ""}
              </p>
              <p className="text-[10px] text-[var(--text-muted)] text-center mb-2">
                Reply on your phone. Agent sends via Business API.
              </p>
              <MessageFilterToggle value={messageFilter} onChange={handleFilterChange} />
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleDisconnectPersonal}
                  className="nodrag gap-1.5 text-[var(--text-muted)] hover:text-red-500"
                >
                  <LogOut className="w-3 h-3" />
                  Unlink Phone
                </Button>
              </div>
            </div>
          </div>
        </BlockWrapper>
      );
    }

    // Hybrid QR scanning in progress — falls through to the QR scanning state below
    // If no personalSubId yet, the auto-connect effect will trigger it
  }

  if (!integration?.connected && !personalSubId) {
    // When platform is configured, auto-connect to personal/hybrid will fire shortly.
    // Show a connecting spinner instead of the Business API form to avoid a brief flash.
    if (platformConfig?.configured) {
      return (
        <BlockWrapper selected={selected} minWidth={280} minHeight={200}>
          <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
          <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
            {header}
            <div className="flex flex-col items-center justify-center h-full p-4">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)] mb-2" />
              <p className="text-xs text-[var(--text-muted)]">Connecting...</p>
            </div>
          </div>
        </BlockWrapper>
      );
    }

    return (
      <BlockWrapper selected={selected} minWidth={280} minHeight={200}>
        <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
        <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
          {header}
          <div className="flex flex-col items-center justify-center h-full p-4">
            <WhatsAppIcon className="w-8 h-8 mb-2" />

            {connectMode === "business" && (
              <div className="w-full space-y-2 nodrag">
                <p className="text-xs text-[var(--text-muted)] text-center mb-1">
                  Connect WhatsApp Business API
                </p>
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Access token"
                  className="w-full px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--background)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[#25D366]"
                />
                <input
                  type="text"
                  value={phoneNumberIdInput}
                  onChange={(e) => setPhoneNumberIdInput(e.target.value)}
                  placeholder="Phone Number ID"
                  className="w-full px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--background)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[#25D366]"
                />
                <Button
                  size="sm"
                  onClick={handleConnect}
                  disabled={!tokenInput.trim() || !phoneNumberIdInput.trim() || connecting}
                  className="nodrag w-full"
                  style={{ backgroundColor: WHATSAPP_GREEN, color: "#fff" }}
                >
                  {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                  Connect
                </Button>
              </div>
            )}

            {connectMode === "personal" && (
              <div className="w-full space-y-2 nodrag">
                <p className="text-xs text-[var(--text-muted)] text-center mb-1">
                  Pair via QR code (dev/testing only)
                </p>
                <Button
                  size="sm"
                  onClick={handleConnectPersonal}
                  disabled={connecting}
                  className="nodrag w-full gap-2"
                  style={{ backgroundColor: WHATSAPP_GREEN, color: "#fff" }}
                >
                  {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Smartphone className="w-3.5 h-3.5" />}
                  {connecting ? "Starting..." : "Connect via QR"}
                </Button>
                <button
                  onClick={() => setConnectMode("business")}
                  className="text-[9px] text-[var(--text-muted)] hover:underline w-full text-center"
                >
                  &larr; Use Business API instead
                </button>
              </div>
            )}
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Personal WhatsApp QR code scanning state
  if (personalSubId && personalStatus !== "connected" && !integration?.connected) {
    return (
      <BlockWrapper selected={selected} minWidth={280} minHeight={320}>
        <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
        <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
          {header}
          <div className="flex flex-col items-center justify-center h-full p-4">
            {personalStatus === "error" ? (
              <>
                <p className="text-xs text-red-500 text-center mb-2">Connection failed</p>
                {connectionError && (
                  <p className="text-[10px] text-[var(--text-muted)] text-center mb-2 max-w-[200px]">{connectionError}</p>
                )}
                <Button
                  size="sm"
                  onClick={() => { setConnectionError(null); setReconnectAttempts(0); void handleConnectPersonal(); }}
                  className="nodrag gap-2"
                  style={{ backgroundColor: WHATSAPP_GREEN, color: "#fff" }}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Retry
                </Button>
              </>
            ) : personalQrCode ? (
              <>
                <p className="text-xs font-medium text-[var(--text-primary)] mb-2">Scan with WhatsApp</p>
                <div className="rounded-lg overflow-hidden border border-[var(--border)] mb-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={personalQrCode} alt="WhatsApp QR Code" className="w-48 h-48" />
                </div>
                <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                  <Smartphone className="w-3 h-3" />
                  <span>WhatsApp &rarr; Linked Devices &rarr; Link a Device</span>
                </div>
              </>
            ) : (
              <>
                <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)] mb-2" />
                <p className="text-xs text-[var(--text-muted)]">
                  {reconnectAttempts > 0
                    ? `Reconnecting... (${reconnectAttempts}/8)`
                    : "Connecting to WhatsApp..."}
                </p>
                {reconnectAttempts >= 4 && (
                  <p className="text-[10px] text-[var(--text-muted)] text-center mt-1 max-w-[200px]">
                    Taking longer than expected. WhatsApp may be rate limiting this connection.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Personal WhatsApp connected — all messages forwarded, no chat picker needed
  if (personalSubId && personalStatus === "connected" && !integration?.connected) {
    return (
      <BlockWrapper selected={selected} minWidth={280} minHeight={200} className={cn(expandAnimation)}>
        <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
        <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
          {header}
          <div className="flex flex-col items-center justify-center flex-1 p-4">
            <div className="w-10 h-10 rounded-full flex items-center justify-center mb-3" style={{ backgroundColor: `${WHATSAPP_GREEN}15` }}>
              <CheckCircle className="w-5 h-5" style={{ color: WHATSAPP_GREEN }} />
            </div>
            <p className="text-xs font-medium text-[var(--text-primary)] mb-1">OrcaBot WhatsApp</p>
            <p className="text-[10px] text-[var(--text-muted)] text-center mb-2">
              Users message this number on WhatsApp. Connect a terminal to read and reply.
            </p>
            <MessageFilterToggle value={messageFilter} onChange={handleFilterChange} />
            <div className="mt-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleDisconnectPersonal}
                className="nodrag gap-1.5 text-[var(--text-muted)] hover:text-red-500"
              >
                <LogOut className="w-3 h-3" />
                Disconnect
              </Button>
            </div>
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Business API connected — show wa.me QR code for end users
  const waPhoneNumber = integration?.phoneNumber;
  // Strip non-digits for wa.me link (e.g. "+1 555-012-3456" → "15550123456")
  const waDigits = waPhoneNumber ? waPhoneNumber.replace(/\D/g, "") : null;
  const waLink = waDigits ? `https://wa.me/${waDigits}` : null;

  return (
    <BlockWrapper selected={selected} minWidth={280} minHeight={200} className={cn(expandAnimation)}>
      <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
      <div className={cn("flex flex-col h-full relative z-10", isAnimatingMinimize && "animate-content-fade-out")}>
        {header}

        <div className="flex flex-col items-center justify-center flex-1 p-4">
          {waLink ? (
            <>
              <div className="rounded-lg overflow-hidden border border-[var(--border)] mb-3 p-2 bg-white">
                <QRCodeSVG value={waLink} size={140} level="M" />
              </div>
              <p className="text-xs font-medium text-[var(--text-primary)] mb-0.5">
                {integration?.accountName || "OrcaBot"}
              </p>
              <p className="text-[10px] text-[var(--text-muted)] mb-1">{waPhoneNumber}</p>
              <p className="text-[10px] text-[var(--text-muted)] text-center mb-2">
                Scan to chat on WhatsApp. Connect a terminal to read and reply.
              </p>
            </>
          ) : (
            <>
              <div className="w-10 h-10 rounded-full flex items-center justify-center mb-3" style={{ backgroundColor: `${WHATSAPP_GREEN}15` }}>
                <CheckCircle className="w-5 h-5" style={{ color: WHATSAPP_GREEN }} />
              </div>
              <p className="text-xs font-medium text-[var(--text-primary)] mb-1">
                {integration?.accountName || "WhatsApp Connected"}
              </p>
              <p className="text-[10px] text-[var(--text-muted)] text-center mb-2">
                Connect a terminal to read and reply to messages.
              </p>
            </>
          )}
          <MessageFilterToggle value={messageFilter} onChange={handleFilterChange} />
        </div>
      </div>
    </BlockWrapper>
  );
}

export default WhatsAppBlock;
