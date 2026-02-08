// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import {
  FileText,
  RefreshCw,
  Loader2,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  User,
  Clock,
  Minimize2,
  Copy,
} from "lucide-react";
import { GoogleFormsIcon } from "@/components/icons";
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
  getFormsIntegration,
  listForms,
  getForm,
  getFormResponses,
  setupFormsMirror,
  unlinkFormsMirror,
  setLinkedForm,
  type FormsIntegration,
  type Form,
  type FormResponse,
} from "@/lib/api/cloudflare";
import { API } from "@/config/env";
import type { DashboardItem } from "@/types/dashboard";

interface FormsData extends Record<string, unknown> {
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

type FormsNode = Node<FormsData, "forms">;

export function FormsBlock({ id, data, selected }: NodeProps<FormsNode>) {
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
      size: savedSize || { width: 320, height: 240 },
    });
  };

  // Integration state
  const [integration, setIntegration] = React.useState<FormsIntegration | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Forms selection state
  const [forms, setForms] = React.useState<Array<{ id: string; name: string }>>([]);
  const [formsLoading, setFormsLoading] = React.useState(false);
  const [currentForm, setCurrentForm] = React.useState<Form | null>(null);

  // Responses state
  const [responses, setResponses] = React.useState<FormResponse[]>([]);
  const [responsesLoading, setResponsesLoading] = React.useState(false);
  const [selectedResponse, setSelectedResponse] = React.useState<FormResponse | null>(null);

  // View mode: "picker" | "detail" - always start on picker
  const [viewMode, setViewMode] = React.useState<"picker" | "detail">("picker");

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
      const integrationData = await getFormsIntegration(dashboardId);
      setIntegration(integrationData);
      initialLoadDone.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Forms");
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  // Load forms list
  const loadForms = React.useCallback(async () => {
    try {
      setFormsLoading(true);
      const response = await listForms();
      setForms(response.forms);
    } catch (err) {
      console.error("Failed to load forms:", err);
    } finally {
      setFormsLoading(false);
    }
  }, []);

  // Load current linked form and responses (but stay on picker - user must click to view detail)
  const loadLinkedForm = React.useCallback(async () => {
    if (!integration?.linked || !integration?.formId || !dashboardId) return;
    try {
      setFormsLoading(true);
      const formData = await getForm(integration.formId);
      setCurrentForm(formData);
      // Don't auto-switch to detail - stay on picker so user can choose

      // Pre-load responses for when user goes to detail view
      setResponsesLoading(true);
      const responsesData = await getFormResponses(dashboardId, integration.formId);
      setResponses(responsesData.responses);
    } catch (err) {
      console.error("Failed to load form:", err);
    } finally {
      setFormsLoading(false);
      setResponsesLoading(false);
    }
  }, [integration, dashboardId]);

  // Initial load - skip duplicate loads in Strict Mode/Fast Refresh
  React.useEffect(() => {
    if (!dashboardId) return;
    if (loadedDashboardRef.current === dashboardId) return;
    loadedDashboardRef.current = dashboardId;
    loadIntegration();
  }, [dashboardId, loadIntegration]);

  // Load forms list when connected (for picker view)
  React.useEffect(() => {
    if (integration?.connected) {
      loadForms();
    }
  }, [integration?.connected, loadForms]);

  // Connect Forms
  const handleConnect = () => {
    if (!dashboardId) return;
    const connectUrl = `${API.cloudflare.base}/integrations/google/forms/connect?dashboard_id=${dashboardId}&mode=popup`;
    const popup = window.open(connectUrl, "forms-connect", "width=600,height=700");

    let completed = false;

    const completeSetup = async () => {
      if (completed) return;
      completed = true;
      window.removeEventListener("message", handleMessage);
      if (pollInterval) clearInterval(pollInterval);
      popup?.close();
      try {
        await setupFormsMirror(dashboardId);
        await loadIntegration();
      } catch (err) {
        console.error("Failed to set up Forms mirror:", err);
        await loadIntegration();
      }
    };

    const handleMessage = async (event: MessageEvent) => {
      if (event.data?.type === "forms-auth-complete") {
        await completeSetup();
      }
    };
    window.addEventListener("message", handleMessage);

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

  // Disconnect Forms
  const handleDisconnect = async () => {
    if (!dashboardId) return;
    try {
      await unlinkFormsMirror(dashboardId);
      setIntegration(null);
      setForms([]);
      setCurrentForm(null);
      setResponses([]);
      setSelectedResponse(null);
      setViewMode("picker");
    } catch (err) {
      console.error("Failed to disconnect Forms:", err);
    }
  };

  // Select form
  const handleSelectForm = async (form: { id: string; name: string }) => {
    if (!dashboardId) return;
    try {
      await setLinkedForm(dashboardId, form.id, form.name);
      await loadIntegration();
      const fullForm = await getForm(form.id);
      setCurrentForm(fullForm);
      setViewMode("detail");

      // Load responses
      setResponsesLoading(true);
      const responsesData = await getFormResponses(dashboardId, form.id);
      setResponses(responsesData.responses);
      setResponsesLoading(false);
    } catch (err) {
      console.error("Failed to link form:", err);
    }
  };

  // Show form picker
  const handleShowPicker = async () => {
    await loadForms();
    setViewMode("picker");
  };

  // View linked form data
  const handleViewData = async () => {
    await loadLinkedForm();
    setViewMode("detail");
  };

  // Refresh responses
  const handleRefresh = async () => {
    if (!dashboardId || !integration?.formId) return;
    try {
      setResponsesLoading(true);
      const responsesData = await getFormResponses(dashboardId, integration.formId);
      setResponses(responsesData.responses);
    } catch (err) {
      console.error("Failed to refresh responses:", err);
    } finally {
      setResponsesLoading(false);
    }
  };

  // Format answer for display
  const formatAnswer = (answer: { questionId: string; textAnswers?: { answers: Array<{ value: string }> } } | undefined) => {
    if (answer?.textAnswers?.answers) {
      return answer.textAnswers.answers.map((a: { value: string }) => a.value).join(", ");
    }
    return "—";
  };

  // Header
  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <GoogleFormsIcon className="w-3.5 h-3.5" />
      <div className="text-xs text-[var(--foreground-muted)] truncate flex-1">
        {integration?.formTitle || integration?.emailAddress || "Forms"}
      </div>
      <div className="flex items-center gap-1">
        {integration?.connected && integration?.linked && viewMode === "detail" && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleRefresh}
            disabled={responsesLoading}
            title="Refresh"
            className="nodrag"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", responsesLoading && "animate-spin")} />
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
          <DropdownMenuContent align="end" className="w-48">
            {integration?.connected && integration?.linked && (
              <DropdownMenuItem onClick={handleShowPicker}>
                <FileText className="w-3.5 h-3.5 mr-2" />
                Change Form
              </DropdownMenuItem>
            )}
            {integration?.connected && (
              <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
                <LogOut className="w-3.5 h-3.5 mr-2" />
                Disconnect Forms
              </DropdownMenuItem>
            )}
            {!integration?.connected && (
              <DropdownMenuItem onClick={handleConnect}>
                <FileText className="w-3.5 h-3.5 mr-2" />
                Connect Forms
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
      <DropdownMenuContent align="end" className="w-48">
        {integration?.connected && integration?.linked && (
          <DropdownMenuItem onClick={handleShowPicker}>
            <FileText className="w-3.5 h-3.5 mr-2" />
            Change Form
          </DropdownMenuItem>
        )}
        {integration?.connected && (
          <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
            <LogOut className="w-3.5 h-3.5 mr-2" />
            Disconnect Forms
          </DropdownMenuItem>
        )}
        {!integration?.connected && (
          <DropdownMenuItem onClick={handleConnect}>
            <FileText className="w-3.5 h-3.5 mr-2" />
            Connect Forms
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
        icon={<GoogleFormsIcon className="w-14 h-14" />}
        label={integration?.formTitle || "Forms"}
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
      <BlockWrapper selected={selected} minWidth={320} minHeight={240} className={expandAnimation || undefined}>
        <ConnectionHandles
          nodeId={id}
          visible={connectorsVisible}
          onConnectorClick={data.onConnectorClick}
        />
        <div className={cn("flex flex-col h-full", isAnimatingMinimize && "animate-content-fade-out")}>
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
      <BlockWrapper selected={selected} minWidth={320} minHeight={240}>
        <ConnectionHandles
          nodeId={id}
          visible={connectorsVisible}
          onConnectorClick={data.onConnectorClick}
        />
        <div className={cn("flex flex-col h-full", isAnimatingMinimize && "animate-content-fade-out")}>
          {header}
          <div className="flex flex-col items-center justify-center h-full p-4">
            <FileText className="w-8 h-8 text-[var(--text-muted)] mb-2" />
            <p className="text-xs text-[var(--text-muted)] text-center mb-3">
              Connect Google Forms to view form responses
            </p>
            <Button size="sm" onClick={handleConnect} className="nodrag">
              Connect Forms
            </Button>
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Not linked state - show picker
  if (!integration?.linked || viewMode === "picker") {
    return (
      <BlockWrapper selected={selected} minWidth={320} minHeight={240}>
        <ConnectionHandles
          nodeId={id}
          visible={connectorsVisible}
          onConnectorClick={data.onConnectorClick}
        />
        <div className={cn("flex flex-col h-full", isAnimatingMinimize && "animate-content-fade-out")}>
          {header}
          <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
            <span className="text-[10px] font-medium text-[var(--text-primary)]">Select Form</span>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={loadForms}
              disabled={formsLoading}
              className="nodrag"
            >
              <RefreshCw className={cn("w-3 h-3", formsLoading && "animate-spin")} />
            </Button>
          </div>
          {/* Show currently linked form with View Data button */}
          {integration?.linked && integration?.formTitle && (
            <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--border)] bg-purple-50 dark:bg-purple-950/30">
              <FileText className="w-3.5 h-3.5 text-purple-500 shrink-0" />
              <span className="text-[10px] text-purple-700 dark:text-purple-400 truncate flex-1">
                {integration.formTitle}
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={handleViewData}
                className="nodrag h-6 text-[10px] px-2"
              >
                View Data
              </Button>
            </div>
          )}
          <div className="flex-1 overflow-y-auto">
            {formsLoading ? (
              <div className="flex items-center justify-center p-4">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
              </div>
            ) : forms.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-4">
                <p className="text-xs text-[var(--text-muted)] text-center mb-2">
                  No forms found
                </p>
                <Button size="sm" variant="secondary" onClick={loadForms} className="nodrag">
                  Reload
                </Button>
              </div>
            ) : (
              forms.map(form => (
                <button
                  key={form.id}
                  onClick={() => handleSelectForm(form)}
                  className="nodrag w-full px-2 py-2 text-left border-b border-[var(--border)] hover:bg-[var(--background)] transition-colors flex items-center gap-2"
                >
                  <FileText className="w-4 h-4 text-purple-500 shrink-0" />
                  <span className="text-[10px] text-[var(--text-primary)] truncate flex-1">
                    {form.name}
                  </span>
                  <ChevronRight className="w-3 h-3 text-[var(--text-muted)]" />
                </button>
              ))
            )}
          </div>
        </div>
      </BlockWrapper>
    );
  }

  // Detail view - show form responses
  return (
    <BlockWrapper selected={selected} minWidth={320} minHeight={240} className={cn(expandAnimation)}>
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
      {/* All content fades during minimize */}
      <div className={cn("flex flex-col h-full", isAnimatingMinimize && "animate-content-fade-out")}>
        {header}

        {/* Two pane layout */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Response list */}
          <div className={cn(
            "flex flex-col overflow-hidden border-r border-[var(--border)]",
            selectedResponse ? "w-1/2" : "w-full"
          )}>
            <div className="flex-1 overflow-y-auto">
              {responsesLoading ? (
                <div className="flex items-center justify-center p-4">
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
                </div>
              ) : responses.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-4">
                  <p className="text-xs text-[var(--text-muted)]">No responses yet</p>
                </div>
              ) : (
                responses.map(response => (
                  <button
                    key={response.responseId}
                    onClick={() => setSelectedResponse(response)}
                    className={cn(
                      "nodrag w-full px-2 py-1.5 text-left border-b border-[var(--border)] hover:bg-[var(--background)] transition-colors",
                      selectedResponse?.responseId === response.responseId && "bg-[var(--background)]"
                    )}
                  >
                    <div className="flex items-center gap-1 text-[10px] text-[var(--text-primary)]">
                      <User className="w-3 h-3" />
                      <span className="truncate">
                        {response.respondentEmail || "Anonymous"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-[9px] text-[var(--text-muted)] mt-0.5">
                      <Clock className="w-2.5 h-2.5" />
                      {new Date(response.submittedAt).toLocaleString([], {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </div>
                  </button>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="px-2 py-1 border-t border-[var(--border)] bg-[var(--background)] flex items-center justify-between">
              <span className="text-[9px] text-[var(--text-muted)]">
                {responses.length} response{responses.length !== 1 ? "s" : ""}
              </span>
              {currentForm?.responderUri && (
                <a
                  href={currentForm.responderUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="nodrag text-[9px] text-[var(--accent-primary)] hover:underline flex items-center gap-0.5"
                >
                  Open form <ExternalLink className="w-2.5 h-2.5" />
                </a>
              )}
            </div>
          </div>

          {/* Response detail */}
          {selectedResponse && (
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              {/* Detail header */}
              <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSelectedResponse(null)}
                  className="nodrag"
                >
                  <ChevronLeft className="w-3 h-3" />
                </Button>
                <span className="text-[10px] text-[var(--text-muted)] truncate">
                  {selectedResponse.respondentEmail || "Anonymous"}
                </span>
              </div>

              {/* Response content */}
              <div className="flex-1 overflow-y-auto p-2">
                <div className="text-[9px] text-[var(--text-muted)] mb-2">
                  Submitted: {new Date(selectedResponse.submittedAt).toLocaleString()}
                </div>

                {currentForm?.items && selectedResponse.answers && (
                  <div className="space-y-2">
                    {currentForm.items
                      .filter(item => item.question)
                      .map(item => {
                        const questionId = item.question?.questionId;
                        const answer = questionId ? selectedResponse.answers?.[questionId] : undefined;
                        return (
                          <div key={item.itemId} className="border border-[var(--border)] rounded p-1.5">
                            <p className="text-[9px] font-medium text-[var(--text-primary)] mb-0.5">
                              {item.title || "Untitled question"}
                            </p>
                            <p className="text-[10px] text-[var(--text-secondary)]">
                              {formatAnswer(answer)}
                            </p>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </BlockWrapper>
  );
}

export default FormsBlock;
