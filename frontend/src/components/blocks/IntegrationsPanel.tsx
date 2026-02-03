// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: integrations-panel-v2-attach-refetch
console.log(`[IntegrationsPanel] REVISION: integrations-panel-v2-attach-refetch loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  X,
  Plus,
  Settings,
  Trash2,
  Mail,
  Calendar,
  Users,
  Table,
  FileText,
  FolderOpen,
  Cloud,
  Box,
  Github,
  Globe,
  Plug,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  listTerminalIntegrations,
  listAvailableIntegrations,
  attachIntegration,
  detachIntegration,
  createReadOnlyPolicy,
  type TerminalIntegration,
  type AvailableIntegration,
  type IntegrationProvider,
  type SecurityLevel,
  type AnyPolicy,
  type BrowserPolicy,
  getProviderDisplayName,
  getSecurityLevelIcon,
  getSecurityLevelText,
  getSecurityLevelColor,
  HIGH_RISK_CAPABILITIES,
} from "@/lib/api/cloudflare/integration-policies";
import { PolicyEditorDialog } from "./PolicyEditorDialog";
import { AuditLogViewer } from "./AuditLogViewer";
import { API } from "@/config/env";

// OAuth connect URLs by provider
function getOAuthConnectUrl(provider: IntegrationProvider, dashboardId: string): string | null {
  const base = API.cloudflare.base;
  switch (provider) {
    case "gmail":
      return `${base}/integrations/google/gmail/connect?dashboard_id=${dashboardId}&mode=popup`;
    case "google_calendar":
      return `${base}/integrations/google/calendar/connect?dashboard_id=${dashboardId}&mode=popup`;
    case "google_contacts":
      return `${base}/integrations/google/contacts/connect?dashboard_id=${dashboardId}&mode=popup`;
    case "google_sheets":
      return `${base}/integrations/google/sheets/connect?dashboard_id=${dashboardId}&mode=popup`;
    case "google_forms":
      return `${base}/integrations/google/forms/connect?dashboard_id=${dashboardId}&mode=popup`;
    case "google_drive":
      return `${base}/integrations/google/drive/connect?dashboard_id=${dashboardId}&mode=popup`;
    case "github":
      return `${base}/integrations/github/connect?dashboard_id=${dashboardId}&mode=popup`;
    case "onedrive":
      return `${base}/integrations/onedrive/connect?dashboard_id=${dashboardId}&mode=popup`;
    case "box":
      return `${base}/integrations/box/connect?dashboard_id=${dashboardId}&mode=popup`;
    case "browser":
      return null; // Browser doesn't need OAuth
    default:
      return null;
  }
}

// Icons for providers
const ProviderIcon: React.FC<{ provider: IntegrationProvider; className?: string }> = ({
  provider,
  className = "w-4 h-4",
}) => {
  switch (provider) {
    case "gmail":
      return <Mail className={className} />;
    case "google_calendar":
      return <Calendar className={className} />;
    case "google_contacts":
      return <Users className={className} />;
    case "google_sheets":
      return <Table className={className} />;
    case "google_forms":
      return <FileText className={className} />;
    case "google_drive":
      return <FolderOpen className={className} />;
    case "onedrive":
      return <Cloud className={className} />;
    case "box":
      return <Box className={className} />;
    case "github":
      return <Github className={className} />;
    case "browser":
      return <Globe className={className} />;
    default:
      return <Plug className={className} />;
  }
};

// Security level badge
const SecurityBadge: React.FC<{ level: SecurityLevel }> = ({ level }) => (
  <span
    className={cn(
      "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium",
      getSecurityLevelColor(level)
    )}
  >
    {getSecurityLevelIcon(level)} {getSecurityLevelText(level)}
  </span>
);

// Attach dialog for a specific integration
interface AttachDialogProps {
  integration: AvailableIntegration;
  dashboardId: string;
  terminalId: string;
  onClose: () => void;
  onSuccess: (provider: IntegrationProvider, securityLevel: SecurityLevel) => Promise<void> | void;
}

const AttachDialog: React.FC<AttachDialogProps> = ({
  integration,
  dashboardId,
  terminalId,
  onClose,
  onSuccess,
}) => {
  const [urlPatterns, setUrlPatterns] = React.useState<string[]>([""]);
  const [newPattern, setNewPattern] = React.useState("");
  const [highRiskConfirmed, setHighRiskConfirmed] = React.useState<Set<string>>(new Set());

  const attachMutation = useMutation({
    mutationFn: (data: Parameters<typeof attachIntegration>[2]) =>
      attachIntegration(dashboardId, terminalId, data),
    onSuccess: async (result) => {
      await onSuccess(integration.provider, result.securityLevel);
      onClose();
    },
  });

  const isBrowser = integration.provider === "browser";
  const highRiskCapabilities = HIGH_RISK_CAPABILITIES[integration.provider] || [];

  const handleAttach = (readOnly: boolean) => {
    let policy: AnyPolicy | undefined;

    if (isBrowser) {
      // Browser requires URL patterns
      const patterns = urlPatterns.filter((p) => p.trim().length > 0);
      if (patterns.length === 0) return;

      policy = {
        canNavigate: true,
        urlFilter: { mode: "allowlist" as const, patterns },
        canClick: !readOnly,
        canType: !readOnly,
        canScroll: true,
        canScreenshot: true,
        canExtractText: true,
        canFillForms: false,
        canSubmitForms: false,
        canDownload: false,
        canUpload: false,
        canExecuteJs: false,
        canUseStoredCredentials: false,
        canInputCredentials: false,
        canReadCookies: false,
        canInspectNetwork: false,
        canModifyRequests: false,
      } as BrowserPolicy;
    } else if (readOnly) {
      // Non-browser read-only: use restricted policy
      policy = createReadOnlyPolicy(integration.provider);
    }
    // If not browser and not readOnly, policy stays undefined -> backend uses full access default

    attachMutation.mutate({
      provider: integration.provider,
      userIntegrationId: integration.userIntegrationId,
      policy,
      highRiskConfirmations: readOnly ? undefined : Array.from(highRiskConfirmed),
    });
  };

  const addUrlPattern = () => {
    if (newPattern.trim()) {
      setUrlPatterns([...urlPatterns.filter((p) => p), newPattern.trim()]);
      setNewPattern("");
    }
  };

  const removeUrlPattern = (index: number) => {
    setUrlPatterns(urlPatterns.filter((_, i) => i !== index));
  };

  const toggleHighRisk = (cap: string) => {
    const newSet = new Set(highRiskConfirmed);
    if (newSet.has(cap)) {
      newSet.delete(cap);
    } else {
      newSet.add(cap);
    }
    setHighRiskConfirmed(newSet);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-[var(--background-elevated)] rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <ProviderIcon provider={integration.provider} className="w-5 h-5" />
            <span className="font-medium">
              Attach {getProviderDisplayName(integration.provider)}
            </span>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="p-4 space-y-4">
          {integration.accountEmail && (
            <div className="text-sm text-[var(--foreground-muted)]">
              Account: {integration.accountEmail}
            </div>
          )}

          {isBrowser ? (
            <>
              {/* Browser requires URL patterns */}
              <div className="flex items-center gap-2 p-2 rounded bg-yellow-100/20 border border-yellow-500/30">
                <AlertTriangle className="w-5 h-5 text-yellow-600 flex-shrink-0" />
                <div className="text-xs text-yellow-700">
                  Browser requires URL limits. Specify which URLs this terminal can access.
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium">Allowed URL Patterns</label>
                {urlPatterns.map(
                  (pattern, index) =>
                    pattern && (
                      <div key={index} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={pattern}
                          onChange={(e) => {
                            const newPatterns = [...urlPatterns];
                            newPatterns[index] = e.target.value;
                            setUrlPatterns(newPatterns);
                          }}
                          className="flex-1 px-2 py-1 text-sm rounded border border-[var(--border)] bg-[var(--background)]"
                          placeholder="https://example.com/*"
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => removeUrlPattern(index)}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    )
                )}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newPattern}
                    onChange={(e) => setNewPattern(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addUrlPattern();
                      }
                    }}
                    className="flex-1 px-2 py-1 text-sm rounded border border-[var(--border)] bg-[var(--background)]"
                    placeholder="https://example.com/*"
                  />
                  <Button variant="secondary" size="sm" onClick={addUrlPattern}>
                    <Plus className="w-3 h-3" />
                  </Button>
                </div>
                <div className="text-[10px] text-[var(--foreground-muted)]">
                  Examples: https://docs.google.com/*, https://*.github.com/*
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Non-browser integrations: show capabilities */}
              <div className="text-sm">
                With full access, this terminal can interact with your{" "}
                {getProviderDisplayName(integration.provider)} account.
              </div>

              {highRiskCapabilities.length > 0 && (
                <div className="space-y-2 p-2 rounded border border-yellow-500/30 bg-yellow-100/10">
                  <div className="flex items-center gap-2 text-xs font-medium text-yellow-700">
                    <AlertTriangle className="w-4 h-4" />
                    High-Risk Capabilities
                  </div>
                  <div className="text-xs text-[var(--foreground-muted)]">
                    Check to enable these sensitive permissions:
                  </div>
                  {highRiskCapabilities.map((cap) => (
                    <label key={cap} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={highRiskConfirmed.has(cap)}
                        onChange={() => toggleHighRisk(cap)}
                        className="rounded"
                      />
                      <span>
                        {cap.replace(/^can/, "Allow ").replace(/([A-Z])/g, " $1").trim()}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border)]">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {!isBrowser && (
            <Button variant="secondary" onClick={() => handleAttach(true)}>
              Attach (Read Only)
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => handleAttach(false)}
            disabled={
              attachMutation.isPending ||
              (isBrowser && urlPatterns.filter((p) => p.trim()).length === 0)
            }
          >
            {attachMutation.isPending
              ? "Attaching..."
              : isBrowser
                ? "Attach Browser"
                : "Attach Full Access"}
          </Button>
        </div>
      </div>
    </div>
  );
};

// Main IntegrationsPanel component
interface IntegrationsPanelProps {
  dashboardId: string;
  terminalId: string;
  onClose: () => void;
  /** Called when a policy is updated, allowing parent to sync edge data */
  onPolicyUpdate?: (provider: IntegrationProvider, securityLevel: SecurityLevel) => void;
  /** Called after attaching integration, to create integration block on canvas if needed */
  onIntegrationAttached?: (provider: IntegrationProvider, securityLevel: SecurityLevel) => void;
  /** Called after detaching integration, to remove integration block + edge from canvas */
  onIntegrationDetached?: (provider: IntegrationProvider) => void;
}

export const IntegrationsPanel: React.FC<IntegrationsPanelProps> = ({
  dashboardId,
  terminalId,
  onClose,
  onPolicyUpdate,
  onIntegrationAttached,
  onIntegrationDetached,
}) => {
  const queryClient = useQueryClient();
  const [showAttachDialog, setShowAttachDialog] = React.useState<AvailableIntegration | null>(
    null
  );
  const [editingIntegration, setEditingIntegration] = React.useState<TerminalIntegration | null>(
    null
  );
  const [auditLogIntegration, setAuditLogIntegration] = React.useState<TerminalIntegration | null>(
    null
  );
  const [expandedIntegration, setExpandedIntegration] = React.useState<string | null>(null);

  // Query attached integrations
  const attachedQuery = useQuery({
    queryKey: ["terminal-integrations", dashboardId, terminalId],
    queryFn: () => listTerminalIntegrations(dashboardId, terminalId),
    staleTime: 30000,
  });

  // Query available integrations
  const availableQuery = useQuery({
    queryKey: ["available-integrations", dashboardId, terminalId],
    queryFn: () => listAvailableIntegrations(dashboardId, terminalId),
    staleTime: 60000,
  });

  // Detach mutation
  const detachMutation = useMutation({
    mutationFn: (provider: IntegrationProvider) =>
      detachIntegration(dashboardId, terminalId, provider),
    onSuccess: (_data, provider) => {
      queryClient.invalidateQueries({
        queryKey: ["terminal-integrations", dashboardId, terminalId],
      });
      queryClient.invalidateQueries({
        queryKey: ["available-integrations", dashboardId, terminalId],
      });
      // Notify parent to remove the canvas block + edge
      onIntegrationDetached?.(provider);
    },
  });

  // Handle OAuth connect flow
  const handleConnect = (provider: IntegrationProvider) => {
    const connectUrl = getOAuthConnectUrl(provider, dashboardId);
    if (!connectUrl) return;

    const popup = window.open(connectUrl, `${provider}-connect`, "width=600,height=700");
    if (!popup) return;

    // Poll for popup close and refresh integrations list
    const pollInterval = setInterval(() => {
      if (popup.closed) {
        clearInterval(pollInterval);
        // Small delay to let the OAuth callback store the token before we refetch
        setTimeout(() => {
          queryClient.invalidateQueries({
            queryKey: ["available-integrations", dashboardId, terminalId],
          });
        }, 1000);
      }
    }, 500);
  };

  const handleAttachSuccess = async (provider: IntegrationProvider, securityLevel: SecurityLevel) => {
    // Invalidate + refetch all active queries so the panel shows updated data.
    // Using invalidateQueries with refetchType 'all' ensures even "fresh" queries refetch.
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["terminal-integrations", dashboardId, terminalId],
        refetchType: "all",
      }),
      queryClient.invalidateQueries({
        queryKey: ["available-integrations", dashboardId, terminalId],
        refetchType: "all",
      }),
    ]);
    // Notify parent to create integration block on canvas if needed
    onIntegrationAttached?.(provider, securityLevel);
  };

  const attached = attachedQuery.data || [];
  const available = (availableQuery.data || []).filter((a) => !a.attached);

  return (
    <>
      <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md w-80">
        <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
          <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--foreground)]">
            <Plug className="w-3 h-3" />
            <span>Integrations</span>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} className="h-5 w-5 nodrag">
            <X className="w-3 h-3" />
          </Button>
        </div>

        <div className="p-2 space-y-3 text-xs max-h-[400px] overflow-auto">
          {/* Attached Integrations */}
          <div>
            <div className="text-[10px] font-medium text-[var(--foreground-muted)] uppercase mb-1">
              Attached
            </div>
            {attachedQuery.isLoading ? (
              <div className="text-[var(--foreground-muted)]">Loading...</div>
            ) : attached.length === 0 ? (
              <div className="text-[var(--foreground-muted)]">No integrations attached</div>
            ) : (
              <div className="space-y-1">
                {attached.map((integration) => (
                  <div
                    key={integration.id}
                    className="rounded border border-[var(--border)] bg-[var(--background)]"
                  >
                    <div
                      className="flex items-center justify-between px-2 py-1.5 cursor-pointer"
                      onClick={() =>
                        setExpandedIntegration(
                          expandedIntegration === integration.id ? null : integration.id
                        )
                      }
                    >
                      <div className="flex items-center gap-2">
                        <ProviderIcon provider={integration.provider} className="w-4 h-4" />
                        <div>
                          <div className="font-medium">
                            {getProviderDisplayName(integration.provider)}
                          </div>
                          {integration.accountEmail && (
                            <div className="text-[10px] text-[var(--foreground-muted)]">
                              {integration.accountEmail}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {integration.securityLevel && (
                          <SecurityBadge level={integration.securityLevel} />
                        )}
                        {expandedIntegration === integration.id ? (
                          <ChevronDown className="w-3 h-3" />
                        ) : (
                          <ChevronRight className="w-3 h-3" />
                        )}
                      </div>
                    </div>

                    {expandedIntegration === integration.id && (
                      <div className="px-2 py-1.5 border-t border-[var(--border)] space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[var(--foreground-muted)]">Policy version</span>
                          <span>{integration.policyVersion ?? "—"}</span>
                        </div>
                        <div className="flex items-center gap-1 pt-1 flex-wrap">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-[10px] h-6 px-2"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingIntegration(integration);
                            }}
                          >
                            <Settings className="w-3 h-3 mr-1" />
                            Edit Policy
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-[10px] h-6 px-2"
                            onClick={(e) => {
                              e.stopPropagation();
                              setAuditLogIntegration(integration);
                            }}
                          >
                            <History className="w-3 h-3 mr-1" />
                            Audit Log
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-[10px] h-6 px-2 text-red-600 hover:text-red-700"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (
                                confirm(
                                  `Detach ${getProviderDisplayName(integration.provider)}?`
                                )
                              ) {
                                detachMutation.mutate(integration.provider);
                              }
                            }}
                            disabled={detachMutation.isPending}
                          >
                            <Trash2 className="w-3 h-3 mr-1" />
                            Detach
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Available Integrations */}
          <div>
            <div className="text-[10px] font-medium text-[var(--foreground-muted)] uppercase mb-1">
              Available to Attach
            </div>
            {availableQuery.isLoading ? (
              <div className="text-[var(--foreground-muted)]">Loading...</div>
            ) : available.length === 0 ? (
              <div className="text-[var(--foreground-muted)]">
                All integrations attached or no accounts connected
              </div>
            ) : (
              <div className="space-y-1">
                {available.map((integration) => (
                  <div
                    key={`${integration.provider}-${integration.userIntegrationId || "browser"}`}
                    className="flex items-center justify-between rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <ProviderIcon provider={integration.provider} className="w-4 h-4" />
                      <div>
                        <div className="font-medium">
                          {getProviderDisplayName(integration.provider)}
                        </div>
                        {integration.accountEmail && (
                          <div className="text-[10px] text-[var(--foreground-muted)]">
                            {integration.accountEmail}
                          </div>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="text-[10px] h-6 px-2"
                      onClick={() => {
                        if (integration.connected) {
                          setShowAttachDialog(integration);
                        } else {
                          handleConnect(integration.provider);
                        }
                      }}
                    >
                      {integration.connected ? (
                        <>
                          <Plus className="w-3 h-3 mr-1" />
                          Attach
                        </>
                      ) : (
                        "Connect"
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Attach Dialog */}
      {showAttachDialog && (
        <AttachDialog
          integration={showAttachDialog}
          dashboardId={dashboardId}
          terminalId={terminalId}
          onClose={() => setShowAttachDialog(null)}
          onSuccess={handleAttachSuccess}
        />
      )}

      {/* Policy Editor Dialog */}
      {editingIntegration && (
        <PolicyEditorDialog
          integration={editingIntegration}
          dashboardId={dashboardId}
          terminalId={terminalId}
          onClose={() => setEditingIntegration(null)}
          onSuccess={() => {
            queryClient.invalidateQueries({
              queryKey: ["terminal-integrations", dashboardId, terminalId],
            });
            setEditingIntegration(null);
          }}
          onPolicyUpdate={onPolicyUpdate}
        />
      )}

      {/* Audit Log Viewer */}
      {auditLogIntegration && (
        <AuditLogViewer
          dashboardId={dashboardId}
          terminalId={terminalId}
          provider={auditLogIntegration.provider}
          onClose={() => setAuditLogIntegration(null)}
        />
      )}
    </>
  );
};

export default IntegrationsPanel;
