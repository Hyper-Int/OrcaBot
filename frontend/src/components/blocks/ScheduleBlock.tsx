// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: server-side-cron-v1-backend-schedules

"use client";

const MODULE_REVISION = 'server-side-cron-v1-backend-schedules';
console.log(`[ScheduleBlock] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { Play, ChevronDown, ChevronRight, Clock, Minimize2, Settings, Copy, Loader2, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import { useDebouncedCallback } from "@/hooks/useDebounce";
import { BlockSettingsFooter } from "./BlockSettingsFooter";
import type { DashboardItem } from "@/types/dashboard";
import {
  getScheduleByItem,
  createSchedule,
  updateSchedule,
  triggerSchedule,
  listScheduleExecutions,
  type Schedule,
  type ScheduleExecution,
} from "@/lib/api/cloudflare/schedules";

type TimeUnit = "minutes" | "hours";

interface ScheduleConfig {
  enabled: boolean;
  mode: "simple" | "cron";
  // Simple mode
  interval: number;
  unit: TimeUnit;
  // Command to execute
  command: string;
  // Cron mode (minute granularity minimum)
  cronMinute: string;
  cronHour: string;
  cronDayOfMonth: string;
  cronMonth: string;
  cronDayOfWeek: string;
}

const DEFAULT_CONFIG: ScheduleConfig = {
  enabled: false,
  mode: "simple",
  interval: 5,
  unit: "minutes",
  command: "",
  cronMinute: "*/5",
  cronHour: "*",
  cronDayOfMonth: "*",
  cronMonth: "*",
  cronDayOfWeek: "*",
};

interface ScheduleData extends Record<string, unknown> {
  content: string; // JSON stringified ScheduleConfig
  size: { width: number; height: number };
  dashboardId?: string;
  itemId?: string;
  metadata?: { minimized?: boolean; [key: string]: unknown };
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  onDuplicate?: () => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type ScheduleNode = Node<ScheduleData, "schedule">;

function parseConfig(content: string): ScheduleConfig {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(content || "{}") };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// Generate cron expression from simple interval
function intervalToCron(config: ScheduleConfig): string {
  const { interval, unit } = config;
  if (unit === "minutes") {
    return `*/${interval} * * * *`;
  }
  if (unit === "hours") {
    return `0 */${interval} * * *`;
  }
  return `*/${interval} * * * *`;
}

// Format a cron expression into a human-readable schedule description
function cronToHuman(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;
  const [minute, hour] = parts;

  if (minute.startsWith("*/") && hour === "*") {
    const n = parseInt(minute.slice(2), 10);
    if (!isNaN(n)) return `Every ${n} minute${n !== 1 ? "s" : ""}`;
  }
  if (minute === "0" && hour.startsWith("*/")) {
    const n = parseInt(hour.slice(2), 10);
    if (!isNaN(n)) return `Every ${n} hour${n !== 1 ? "s" : ""}`;
  }
  return cron;
}

// Format relative time until next run
function formatTimeUntil(dateStr: string): string {
  const ms = new Date(dateStr).getTime() - Date.now();
  if (ms <= 0) return "now";
  if (ms < 60000) return `in ${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `in ${Math.round(ms / 60000)}m`;
  return `in ${Math.round(ms / 3600000)}h`;
}

// Format absolute time for display
function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ScheduleBlock({ id, data, selected }: NodeProps<ScheduleNode>) {
  const [config, setConfig] = React.useState<ScheduleConfig>(() => parseConfig(data.content));
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [showExecutions, setShowExecutions] = React.useState(false);
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const isMinimized = data.metadata?.minimized === true;
  const [expandAnimation, setExpandAnimation] = React.useState<string | null>(null);
  const [isAnimatingMinimize, setIsAnimatingMinimize] = React.useState(false);
  const minimizeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Backend schedule state
  const [backendSchedule, setBackendSchedule] = React.useState<Schedule | null>(null);
  const [executions, setExecutions] = React.useState<ScheduleExecution[]>([]);
  const [isTriggering, setIsTriggering] = React.useState(false);
  const [isSyncing, setIsSyncing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [nextRunDisplay, setNextRunDisplay] = React.useState<string | null>(null);

  const dashboardId = data.dashboardId as string | undefined;
  const itemId = data.itemId as string | undefined;

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
      size: savedSize || { width: 280, height: 220 },
    });
  };

  // Sync config from dashboard item content (multiplayer sync)
  React.useEffect(() => {
    const serverConfig = parseConfig(data.content);
    setConfig(serverConfig);
  }, [data.content]);

  // Debounced content update (persists to dashboard item)
  const debouncedContentUpdate = useDebouncedCallback(
    (newConfig: ScheduleConfig) => {
      data.onContentChange?.(JSON.stringify(newConfig));
    },
    500
  );

  // Update local config and persist to dashboard
  const updateConfig = React.useCallback(
    (updates: Partial<ScheduleConfig>) => {
      setConfig((prev) => {
        const next = { ...prev, ...updates };
        debouncedContentUpdate(next);
        return next;
      });
    },
    [debouncedContentUpdate]
  );

  // Load backend schedule on mount
  React.useEffect(() => {
    if (!dashboardId || !itemId) return;
    let cancelled = false;

    (async () => {
      try {
        const schedule = await getScheduleByItem(dashboardId, itemId);
        if (!cancelled) {
          setBackendSchedule(schedule);
        }
      } catch (err) {
        console.warn('[ScheduleBlock] Failed to load backend schedule:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [dashboardId, itemId]);

  // Poll for nextRunAt updates and load executions
  React.useEffect(() => {
    if (!backendSchedule?.id) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const schedule = await getScheduleByItem(dashboardId!, itemId!);
        if (!cancelled && schedule) {
          setBackendSchedule(schedule);
        }
        const execs = await listScheduleExecutions(backendSchedule.id);
        if (!cancelled) {
          setExecutions(execs);
        }
      } catch {
        // Silently ignore poll errors
      }
    };

    const interval = setInterval(poll, 30000);
    // Load executions immediately
    poll();

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [backendSchedule?.id, dashboardId, itemId]);

  // Update next run countdown display
  React.useEffect(() => {
    const nextRunAt = backendSchedule?.nextRunAt;
    if (!nextRunAt || !backendSchedule?.enabled) {
      setNextRunDisplay(null);
      return;
    }

    const update = () => setNextRunDisplay(formatTimeUntil(nextRunAt));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [backendSchedule?.nextRunAt, backendSchedule?.enabled]);

  // Sync config to backend schedule (debounced)
  const debouncedBackendSync = useDebouncedCallback(
    async (newConfig: ScheduleConfig, schedule: Schedule | null) => {
      if (!dashboardId || !itemId) return;
      setIsSyncing(true);
      setError(null);

      try {
        const cron = newConfig.mode === "cron"
          ? `${newConfig.cronMinute} ${newConfig.cronHour} ${newConfig.cronDayOfMonth} ${newConfig.cronMonth} ${newConfig.cronDayOfWeek}`
          : intervalToCron(newConfig);

        if (schedule) {
          // Update existing
          const updated = await updateSchedule(schedule.id, {
            cron,
            command: newConfig.command ?? '',
            enabled: newConfig.enabled,
          });
          setBackendSchedule(updated);
        } else {
          // Create new
          const created = await createSchedule({
            dashboardId,
            dashboardItemId: itemId,
            name: `Schedule ${itemId.slice(0, 8)}`,
            cron,
            command: newConfig.command ?? '',
            enabled: newConfig.enabled,
          });
          setBackendSchedule(created);
        }
      } catch (err) {
        console.error('[ScheduleBlock] Failed to sync schedule:', err);
        setError(err instanceof Error ? err.message : 'Failed to save schedule');
      } finally {
        setIsSyncing(false);
      }
    },
    1000
  );

  // When config changes that affect the backend, sync it
  const prevConfigRef = React.useRef<string>("");
  React.useEffect(() => {
    const key = JSON.stringify({
      enabled: config.enabled,
      mode: config.mode,
      interval: config.interval,
      unit: config.unit,
      command: config.command,
      cronMinute: config.cronMinute,
      cronHour: config.cronHour,
      cronDayOfMonth: config.cronDayOfMonth,
      cronMonth: config.cronMonth,
      cronDayOfWeek: config.cronDayOfWeek,
    });
    if (key !== prevConfigRef.current && prevConfigRef.current !== "") {
      debouncedBackendSync(config, backendSchedule);
    }
    prevConfigRef.current = key;
  }, [config, backendSchedule, debouncedBackendSync]);

  // Toggle enabled state
  const handleToggleEnabled = React.useCallback(async () => {
    const newEnabled = !config.enabled;
    updateConfig({ enabled: newEnabled });
    // Backend sync happens via the effect above
  }, [config.enabled, updateConfig]);

  // Run Now — trigger server-side
  const handleTrigger = React.useCallback(async () => {
    if (!backendSchedule?.id) {
      setError("Schedule not saved yet — configure and save first");
      return;
    }
    setIsTriggering(true);
    setError(null);
    try {
      const result = await triggerSchedule(backendSchedule.id);
      setBackendSchedule(result.schedule);
      if (result.execution) {
        setExecutions((prev) => [result.execution!, ...prev].slice(0, 10));
      }
    } catch (err) {
      console.error('[ScheduleBlock] Trigger failed:', err);
      setError(err instanceof Error ? err.message : 'Trigger failed');
    } finally {
      setIsTriggering(false);
    }
  }, [backendSchedule?.id]);

  const cronExpression = config.mode === "cron"
    ? `${config.cronMinute} ${config.cronHour} ${config.cronDayOfMonth} ${config.cronMonth} ${config.cronDayOfWeek}`
    : intervalToCron(config);

  // Minimized view
  if (isMinimized && !isAnimatingMinimize) {
    const label = backendSchedule?.enabled
      ? cronToHuman(backendSchedule.cron || cronExpression)
      : "Off";
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={<Clock className="w-14 h-14 text-yellow-600 dark:text-yellow-400" />}
        label={label.length > 8 ? label.slice(0, 7) + "\u2026" : label}
        onExpand={handleExpand}
        connectorsVisible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
        className="bg-yellow-100/90 border-yellow-300 dark:bg-yellow-900/30 dark:border-yellow-700/50"
      />
    );
  }

  return (
    <BlockWrapper
      selected={selected}
      autoHeight
      className={cn(
        "p-3 flex flex-col gap-2",
        "bg-yellow-100/90 border-yellow-300 dark:bg-yellow-900/30 dark:border-yellow-700/50",
        expandAnimation
      )}
      includeHandles={false}
    >
      <div className={cn("flex flex-col gap-2 flex-1", isAnimatingMinimize && "animate-content-fade-out")}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-medium text-[var(--foreground-subtle)]">
            <span>Schedule</span>
            {isSyncing && <Loader2 className="w-3 h-3 animate-spin text-[var(--foreground-muted)]" />}
          </div>
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="nodrag h-5 w-5" title="Settings">
                  <Settings className="w-3 h-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuItem onClick={() => data.onDuplicate?.()} className="gap-2">
                  <Copy className="w-3 h-3" />
                  <span>Duplicate</span>
                </DropdownMenuItem>
                <BlockSettingsFooter nodeId={id} onMinimize={handleMinimize} />
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleMinimize}
              title="Minimize"
              className="nodrag h-5 w-5"
            >
              <Minimize2 className="w-3 h-3" />
            </Button>
            <button
              onClick={handleToggleEnabled}
              className={cn(
                "px-2 py-0.5 text-xs font-medium rounded transition-colors",
                config.enabled
                  ? "bg-emerald-500 text-white"
                  : "bg-[var(--background-hover)] text-[var(--foreground-muted)]"
              )}
            >
              {config.enabled ? "ON" : "OFF"}
            </button>
          </div>
        </div>

        {/* Simple interval editor */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-[var(--foreground-subtle)]">Every</span>
          <input
            type="number"
            min={1}
            value={config.interval}
            onChange={(e) => updateConfig({ interval: Math.max(1, parseInt(e.target.value) || 1) })}
            className={cn(
              "w-14 px-2 py-1 rounded border border-[var(--border)] nodrag",
              "bg-[var(--background)] text-[var(--foreground)]",
              "focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
            )}
          />
          <select
            value={config.unit}
            onChange={(e) => updateConfig({ unit: e.target.value as TimeUnit })}
            className={cn(
              "px-2 py-1 rounded border border-[var(--border)] nodrag",
              "bg-[var(--background)] text-[var(--foreground)]",
              "focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
            )}
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
          </select>
        </div>

        {/* Command field */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-[var(--foreground-muted)]">Command</label>
          <input
            type="text"
            placeholder="e.g. npm run build"
            value={config.command}
            onChange={(e) => updateConfig({ command: e.target.value })}
            className={cn(
              "w-full px-2 py-1 rounded border border-[var(--border)] text-xs nodrag",
              "bg-[var(--background)] text-[var(--foreground)]",
              "focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]",
              "font-mono"
            )}
          />
        </div>

        {/* Cron expression display */}
        <div className="text-xs text-[var(--foreground-muted)]">
          Cron: <code className="px-1 bg-[var(--background-hover)] rounded">{cronExpression}</code>
        </div>

        {/* Advanced toggle */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1 text-xs text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors"
        >
          {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {showAdvanced ? "Hide" : "Show"} advanced (cron)
        </button>

        {/* Advanced cron editor */}
        {showAdvanced && (
          <div className="p-2 bg-[var(--background)] rounded border border-[var(--border)] space-y-2">
            <div className="grid grid-cols-5 gap-1 text-xs">
              <div className="text-center text-[var(--foreground-muted)]">Min</div>
              <div className="text-center text-[var(--foreground-muted)]">Hour</div>
              <div className="text-center text-[var(--foreground-muted)]">Day</div>
              <div className="text-center text-[var(--foreground-muted)]">Mon</div>
              <div className="text-center text-[var(--foreground-muted)]">DoW</div>
              <input
                value={config.cronMinute}
                onChange={(e) => updateConfig({ cronMinute: e.target.value, mode: "cron" })}
                className="w-full px-1 py-0.5 text-center rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:outline-none nodrag"
              />
              <input
                value={config.cronHour}
                onChange={(e) => updateConfig({ cronHour: e.target.value, mode: "cron" })}
                className="w-full px-1 py-0.5 text-center rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:outline-none nodrag"
              />
              <input
                value={config.cronDayOfMonth}
                onChange={(e) => updateConfig({ cronDayOfMonth: e.target.value, mode: "cron" })}
                className="w-full px-1 py-0.5 text-center rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:outline-none nodrag"
              />
              <input
                value={config.cronMonth}
                onChange={(e) => updateConfig({ cronMonth: e.target.value, mode: "cron" })}
                className="w-full px-1 py-0.5 text-center rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:outline-none nodrag"
              />
              <input
                value={config.cronDayOfWeek}
                onChange={(e) => updateConfig({ cronDayOfWeek: e.target.value, mode: "cron" })}
                className="w-full px-1 py-0.5 text-center rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:outline-none nodrag"
              />
            </div>
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
            <AlertCircle className="w-3 h-3 flex-shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        )}

        {/* Status and Run Now button */}
        <div className="flex items-center justify-between mt-1">
          <div className="text-xs text-[var(--foreground-muted)]">
            {backendSchedule?.enabled && nextRunDisplay ? (
              <span>Next: {nextRunDisplay}</span>
            ) : backendSchedule?.lastRunAt ? (
              <span>Last: {formatTime(backendSchedule.lastRunAt)}</span>
            ) : (
              <span>{config.enabled ? "Saving\u2026" : "Disabled"}</span>
            )}
          </div>
          <button
            onClick={handleTrigger}
            disabled={isTriggering}
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors",
              "bg-yellow-600 text-white hover:bg-yellow-700",
              "dark:bg-yellow-500 dark:hover:bg-yellow-600",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {isTriggering ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Play className="w-3 h-3" />
            )}
            Run Now
          </button>
        </div>

        {/* Execution history toggle */}
        {executions.length > 0 && (
          <>
            <button
              onClick={() => setShowExecutions(!showExecutions)}
              className="flex items-center gap-1 text-xs text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors"
            >
              {showExecutions ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Recent runs ({executions.length})
            </button>

            {showExecutions && (
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {executions.slice(0, 5).map((exec) => (
                  <div
                    key={exec.id}
                    className="flex items-center gap-2 text-xs px-1 py-0.5 rounded bg-[var(--background)]"
                  >
                    {exec.status === "completed" && <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />}
                    {exec.status === "failed" && <XCircle className="w-3 h-3 text-red-500 flex-shrink-0" />}
                    {exec.status === "running" && <Loader2 className="w-3 h-3 text-blue-500 animate-spin flex-shrink-0" />}
                    {exec.status === "timed_out" && <AlertCircle className="w-3 h-3 text-orange-500 flex-shrink-0" />}
                    <span className="text-[var(--foreground-muted)]">
                      {formatTime(exec.startedAt)}
                    </span>
                    <span className="text-[var(--foreground-subtle)] capitalize">{exec.triggeredBy}</span>
                    <span className={cn(
                      "ml-auto capitalize",
                      exec.status === "completed" && "text-emerald-600 dark:text-emerald-400",
                      exec.status === "failed" && "text-red-600 dark:text-red-400",
                      exec.status === "running" && "text-blue-600 dark:text-blue-400",
                      exec.status === "timed_out" && "text-orange-600 dark:text-orange-400",
                    )}>
                      {exec.status === "timed_out" ? "timeout" : exec.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
        topMode="none"
        bottomMode="source"
      />
    </BlockWrapper>
  );
}

export default ScheduleBlock;
