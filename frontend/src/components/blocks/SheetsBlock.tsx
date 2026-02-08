// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import {
  Table,
  RefreshCw,
  Loader2,
  Settings,
  LogOut,
  ChevronLeft,
  FileSpreadsheet,
  ChevronRight,
  ExternalLink,
  Minimize2,
  Copy,
} from "lucide-react";
import { GoogleSheetsIcon } from "@/components/icons";
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
  getSheetsIntegration,
  listSpreadsheets,
  getSpreadsheet,
  readSheetValues,
  setupSheetsMirror,
  unlinkSheetsMirror,
  setLinkedSpreadsheet,
  type SheetsIntegration,
  type Spreadsheet,
  type SheetValues,
} from "@/lib/api/cloudflare";
import { API } from "@/config/env";
import type { DashboardItem } from "@/types/dashboard";

interface SheetsData extends Record<string, unknown> {
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

type SheetsNode = Node<SheetsData, "sheets">;

export function SheetsBlock({ id, data, selected }: NodeProps<SheetsNode>) {
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
  const [integration, setIntegration] = React.useState<SheetsIntegration | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Spreadsheet selection state
  const [spreadsheets, setSpreadsheets] = React.useState<Array<{ id: string; name: string }>>([]);
  const [spreadsheetLoading, setSpreadsheetLoading] = React.useState(false);
  const [currentSpreadsheet, setCurrentSpreadsheet] = React.useState<Spreadsheet | null>(null);

  // Sheet data state
  const [selectedSheetTitle, setSelectedSheetTitle] = React.useState<string | null>(null);
  const [sheetData, setSheetData] = React.useState<SheetValues | null>(null);
  const [dataLoading, setDataLoading] = React.useState(false);

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
      const integrationData = await getSheetsIntegration(dashboardId);
      setIntegration(integrationData);
      initialLoadDone.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Sheets");
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  // Load spreadsheets list
  const loadSpreadsheets = React.useCallback(async () => {
    try {
      setSpreadsheetLoading(true);
      const response = await listSpreadsheets();
      setSpreadsheets(response.spreadsheets);
    } catch (err) {
      console.error("Failed to load spreadsheets:", err);
    } finally {
      setSpreadsheetLoading(false);
    }
  }, []);

  // Load current linked spreadsheet (but stay on picker - user must click to view detail)
  const loadLinkedSpreadsheet = React.useCallback(async () => {
    if (!dashboardId || !integration?.linked || !integration?.spreadsheetId) return;
    try {
      setSpreadsheetLoading(true);
      const spreadsheet = await getSpreadsheet(dashboardId, integration.spreadsheetId);
      setCurrentSpreadsheet(spreadsheet);
      // Auto-select first sheet for when user goes to detail view
      if (spreadsheet.sheets.length > 0 && !selectedSheetTitle) {
        setSelectedSheetTitle(spreadsheet.sheets[0].title);
      }
    } catch (err) {
      console.error("Failed to load spreadsheet:", err);
    } finally {
      setSpreadsheetLoading(false);
    }
  }, [dashboardId, integration, selectedSheetTitle]);

  // Load sheet data
  const loadSheetData = React.useCallback(async () => {
    if (!dashboardId || !currentSpreadsheet || !selectedSheetTitle) return;
    try {
      setDataLoading(true);
      // Read first 100 rows and columns A-Z
      const values = await readSheetValues(dashboardId, currentSpreadsheet.spreadsheetId, `'${selectedSheetTitle}'!A1:Z100`);
      setSheetData(values);
    } catch (err) {
      console.error("Failed to load sheet data:", err);
      setSheetData(null);
    } finally {
      setDataLoading(false);
    }
  }, [dashboardId, currentSpreadsheet, selectedSheetTitle]);

  // Initial load - skip duplicate loads in Strict Mode/Fast Refresh
  React.useEffect(() => {
    if (!dashboardId) return;
    if (loadedDashboardRef.current === dashboardId) return;
    loadedDashboardRef.current = dashboardId;
    loadIntegration();
  }, [dashboardId, loadIntegration]);

  // Load spreadsheets list when connected (for picker view)
  React.useEffect(() => {
    if (integration?.connected) {
      loadSpreadsheets();
    }
  }, [integration?.connected, loadSpreadsheets]);

  // Load sheet data when sheet is selected
  React.useEffect(() => {
    if (selectedSheetTitle && currentSpreadsheet) {
      loadSheetData();
    }
  }, [selectedSheetTitle, currentSpreadsheet, loadSheetData]);

  // Connect Sheets
  const handleConnect = () => {
    if (!dashboardId) return;
    const connectUrl = `${API.cloudflare.base}/integrations/google/sheets/connect?dashboard_id=${dashboardId}&mode=popup`;
    const popup = window.open(connectUrl, "sheets-connect", "width=600,height=700");

    let completed = false;

    const completeSetup = async () => {
      if (completed) return;
      completed = true;
      window.removeEventListener("message", handleMessage);
      if (pollInterval) clearInterval(pollInterval);
      popup?.close();
      try {
        await setupSheetsMirror(dashboardId);
        await loadIntegration();
      } catch (err) {
        console.error("Failed to set up Sheets mirror:", err);
        await loadIntegration();
      }
    };

    const handleMessage = async (event: MessageEvent) => {
      if (event.data?.type === "sheets-auth-complete") {
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

  // Disconnect Sheets
  const handleDisconnect = async () => {
    if (!dashboardId) return;
    try {
      await unlinkSheetsMirror(dashboardId);
      setIntegration(null);
      setSpreadsheets([]);
      setCurrentSpreadsheet(null);
      setSheetData(null);
      setViewMode("picker");
    } catch (err) {
      console.error("Failed to disconnect Sheets:", err);
    }
  };

  // Select spreadsheet
  const handleSelectSpreadsheet = async (spreadsheet: { id: string; name: string }) => {
    if (!dashboardId) return;
    try {
      await setLinkedSpreadsheet(dashboardId, spreadsheet.id, spreadsheet.name);
      await loadIntegration();
      const fullSpreadsheet = await getSpreadsheet(dashboardId, spreadsheet.id);
      setCurrentSpreadsheet(fullSpreadsheet);
      setSelectedSheetTitle(fullSpreadsheet.sheets[0]?.title || null);
      setViewMode("detail");
    } catch (err) {
      console.error("Failed to link spreadsheet:", err);
    }
  };

  // Show spreadsheet picker
  const handleShowPicker = async () => {
    await loadSpreadsheets();
    setViewMode("picker");
  };

  // View linked spreadsheet data
  const handleViewData = async () => {
    await loadLinkedSpreadsheet();
    setViewMode("detail");
  };

  // Refresh data
  const handleRefresh = async () => {
    if (viewMode === "detail" && currentSpreadsheet) {
      await loadSheetData();
    } else if (viewMode === "picker") {
      await loadSpreadsheets();
    }
  };

  // Header
  const header = (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
      <GoogleSheetsIcon className="w-3.5 h-3.5" />
      <div className="text-xs text-[var(--foreground-muted)] truncate flex-1">
        {integration?.spreadsheetName || integration?.emailAddress || "Sheets"}
      </div>
      <div className="flex items-center gap-1">
        {integration?.connected && integration?.linked && viewMode === "detail" && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleRefresh}
            disabled={dataLoading}
            title="Refresh"
            className="nodrag"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", dataLoading && "animate-spin")} />
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
                <FileSpreadsheet className="w-3.5 h-3.5 mr-2" />
                Change Spreadsheet
              </DropdownMenuItem>
            )}
            {integration?.connected && (
              <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
                <LogOut className="w-3.5 h-3.5 mr-2" />
                Disconnect Sheets
              </DropdownMenuItem>
            )}
            {!integration?.connected && (
              <DropdownMenuItem onClick={handleConnect}>
                <Table className="w-3.5 h-3.5 mr-2" />
                Connect Sheets
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
            <FileSpreadsheet className="w-3.5 h-3.5 mr-2" />
            Change Spreadsheet
          </DropdownMenuItem>
        )}
        {integration?.connected && (
          <DropdownMenuItem onClick={handleDisconnect} className="text-red-500">
            <LogOut className="w-3.5 h-3.5 mr-2" />
            Disconnect Sheets
          </DropdownMenuItem>
        )}
        {!integration?.connected && (
          <DropdownMenuItem onClick={handleConnect}>
            <Table className="w-3.5 h-3.5 mr-2" />
            Connect Sheets
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
        icon={<GoogleSheetsIcon className="w-14 h-14" />}
        label={integration?.spreadsheetName || "Sheets"}
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
            <Table className="w-8 h-8 text-[var(--text-muted)] mb-2" />
            <p className="text-xs text-[var(--text-muted)] text-center mb-3">
              Connect Google Sheets to view and edit spreadsheets
            </p>
            <Button size="sm" onClick={handleConnect} className="nodrag">
              Connect Sheets
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
            <span className="text-[10px] font-medium text-[var(--text-primary)]">Select Spreadsheet</span>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={loadSpreadsheets}
              disabled={spreadsheetLoading}
              className="nodrag"
            >
              <RefreshCw className={cn("w-3 h-3", spreadsheetLoading && "animate-spin")} />
            </Button>
          </div>
          {/* Show currently linked spreadsheet with View Data button */}
          {integration?.linked && integration?.spreadsheetName && (
            <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--border)] bg-green-50 dark:bg-green-950/30">
              <FileSpreadsheet className="w-3.5 h-3.5 text-green-600 shrink-0" />
              <span className="text-[10px] text-green-700 dark:text-green-400 truncate flex-1">
                {integration.spreadsheetName}
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
            {spreadsheetLoading ? (
              <div className="flex items-center justify-center p-4">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
              </div>
            ) : spreadsheets.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-4">
                <p className="text-xs text-[var(--text-muted)] text-center mb-2">
                  No spreadsheets found
                </p>
                <Button size="sm" variant="secondary" onClick={loadSpreadsheets} className="nodrag">
                  Reload
                </Button>
              </div>
            ) : (
              spreadsheets.map(spreadsheet => (
                <button
                  key={spreadsheet.id}
                  onClick={() => handleSelectSpreadsheet(spreadsheet)}
                  className="nodrag w-full px-2 py-2 text-left border-b border-[var(--border)] hover:bg-[var(--background)] transition-colors flex items-center gap-2"
                >
                  <FileSpreadsheet className="w-4 h-4 text-green-600 shrink-0" />
                  <span className="text-[10px] text-[var(--text-primary)] truncate flex-1">
                    {spreadsheet.name}
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

  // Detail view - show spreadsheet data
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

        {/* Content */}
        <div className="flex flex-col flex-1 min-h-0">
          {/* Sheet tabs */}
          {currentSpreadsheet && currentSpreadsheet.sheets.length > 1 && (
            <div className="flex items-center gap-0.5 px-1 py-1 border-b border-[var(--border)] bg-[var(--background)] overflow-x-auto">
            {currentSpreadsheet.sheets.map(sheet => (
              <button
                key={sheet.sheetId}
                onClick={() => setSelectedSheetTitle(sheet.title)}
                className={cn(
                  "nodrag px-2 py-0.5 text-[9px] rounded transition-colors shrink-0",
                  selectedSheetTitle === sheet.title
                    ? "bg-[var(--accent-primary)] text-white"
                    : "text-[var(--text-secondary)] hover:bg-[var(--background-highlight)]"
                )}
              >
                {sheet.title}
              </button>
            ))}
          </div>
        )}

        {/* Data table */}
        <div className="flex-1 overflow-auto min-h-0">
          {dataLoading ? (
            <div className="flex items-center justify-center h-full p-4">
              <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
            </div>
          ) : !sheetData || !sheetData.values || sheetData.values.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full p-4">
              <p className="text-xs text-[var(--text-muted)]">No data in this sheet</p>
            </div>
          ) : (
            <table className="w-full text-[9px] border-collapse">
              <thead>
                {sheetData.values[0] && (
                  <tr className="bg-[var(--background)]">
                    {sheetData.values[0].map((cell, colIndex) => (
                      <th
                        key={colIndex}
                        className="px-1.5 py-1 text-left border border-[var(--border)] font-medium text-[var(--text-primary)] whitespace-nowrap"
                      >
                        {String(cell ?? "")}
                      </th>
                    ))}
                  </tr>
                )}
              </thead>
              <tbody>
                {sheetData.values.slice(1).map((row, rowIndex) => (
                  <tr key={rowIndex} className="hover:bg-[var(--background)]">
                    {row.map((cell, colIndex) => (
                      <td
                        key={colIndex}
                        className="px-1.5 py-1 border border-[var(--border)] text-[var(--text-secondary)] whitespace-nowrap max-w-[150px] truncate"
                      >
                        {String(cell ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="px-2 py-1 border-t border-[var(--border)] bg-[var(--background)] flex items-center justify-between">
          <span className="text-[9px] text-[var(--text-muted)]">
            {sheetData?.values ? `${sheetData.values.length} rows` : ""}
          </span>
          {currentSpreadsheet?.url && (
            <a
              href={currentSpreadsheet.url}
              target="_blank"
              rel="noopener noreferrer"
              className="nodrag text-[9px] text-[var(--accent-primary)] hover:underline flex items-center gap-0.5"
            >
              Open in Sheets <ExternalLink className="w-2.5 h-2.5" />
            </a>
          )}
        </div>
        </div>
      </div>
    </BlockWrapper>
  );
}

export default SheetsBlock;
