// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { Play, ChevronDown, ChevronRight, Clock, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import { Button } from "@/components/ui/button";
import { useDebouncedCallback } from "@/hooks/useDebounce";
import { useConnectionDataFlow } from "@/contexts/ConnectionDataFlowContext";
import type { DashboardItem } from "@/types/dashboard";

type TimeUnit = "seconds" | "minutes" | "hours";

interface ScheduleConfig {
  enabled: boolean;
  mode: "simple" | "cron";
  // Simple mode
  interval: number;
  unit: TimeUnit;
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
  interval: 10,
  unit: "seconds",
  cronMinute: "*",
  cronHour: "*",
  cronDayOfMonth: "*",
  cronMonth: "*",
  cronDayOfWeek: "*",
};

interface ScheduleData extends Record<string, unknown> {
  content: string; // JSON stringified ScheduleConfig
  size: { width: number; height: number };
  metadata?: { minimized?: boolean; [key: string]: unknown };
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
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

// Calculate interval in milliseconds
function getIntervalMs(config: ScheduleConfig): number {
  const { interval, unit } = config;
  switch (unit) {
    case "seconds":
      return interval * 1000;
    case "minutes":
      return interval * 60 * 1000;
    case "hours":
      return interval * 60 * 60 * 1000;
    default:
      return interval * 1000;
  }
}

// Generate cron expression from simple interval (for display)
function intervalToCron(config: ScheduleConfig): string | null {
  const { interval, unit } = config;
  if (unit === "seconds") {
    return null; // Cron doesn't support sub-minute intervals
  }
  if (unit === "minutes") {
    return `*/${interval} * * * *`;
  }
  if (unit === "hours") {
    return `0 */${interval} * * *`;
  }
  return null;
}

// Format next run time
function formatNextRun(ms: number): string {
  if (ms < 1000) return "now";
  if (ms < 60000) return `in ${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `in ${Math.round(ms / 60000)}m`;
  return `in ${Math.round(ms / 3600000)}h`;
}

export function ScheduleBlock({ id, data, selected }: NodeProps<ScheduleNode>) {
  const [config, setConfig] = React.useState<ScheduleConfig>(() => parseConfig(data.content));
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [nextRunIn, setNextRunIn] = React.useState<number | null>(null);
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const connectionFlow = useConnectionDataFlow();
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
      size: savedSize || { width: 250, height: 180 },
    });
  };

  const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTriggerRef = React.useRef<number>(Date.now());

  // Sync config from server
  React.useEffect(() => {
    const serverConfig = parseConfig(data.content);
    setConfig(serverConfig);
  }, [data.content]);

  // Debounced server update
  const debouncedUpdate = useDebouncedCallback(
    (newConfig: ScheduleConfig) => {
      data.onContentChange?.(JSON.stringify(newConfig));
    },
    500
  );

  // Update config and persist
  const updateConfig = React.useCallback(
    (updates: Partial<ScheduleConfig>) => {
      setConfig((prev) => {
        const next = { ...prev, ...updates };
        debouncedUpdate(next);
        return next;
      });
    },
    [debouncedUpdate]
  );

  // Trigger output to connected blocks
  const handleTrigger = React.useCallback(() => {
    connectionFlow?.fireOutput(id, "right-out", { text: "", execute: true });
    connectionFlow?.fireOutput(id, "bottom-out", { text: "", execute: true });
    lastTriggerRef.current = Date.now();
  }, [id, connectionFlow]);

  // Manage timer based on enabled state
  React.useEffect(() => {
    // Clear existing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (!config.enabled) {
      setNextRunIn(null);
      return;
    }

    const intervalMs = getIntervalMs(config);
    lastTriggerRef.current = Date.now();

    // Start interval
    intervalRef.current = setInterval(() => {
      handleTrigger();
    }, intervalMs);

    // Update countdown display
    const countdownInterval = setInterval(() => {
      const elapsed = Date.now() - lastTriggerRef.current;
      const remaining = Math.max(0, intervalMs - elapsed);
      setNextRunIn(remaining);
    }, 100);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      clearInterval(countdownInterval);
    };
  }, [config.enabled, config.interval, config.unit, handleTrigger]);

  const cronExpression = intervalToCron(config);

  // Minimized view - only show when fully minimized (not during animation)
  if (isMinimized && !isAnimatingMinimize) {
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={<Clock className="w-14 h-14 text-yellow-600 dark:text-yellow-400" />}
        label={config.enabled ? `${config.interval}${config.unit[0]}` : "Off"}
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
      {/* All content fades during minimize */}
      <div className={cn("flex flex-col gap-2 flex-1", isAnimatingMinimize && "animate-content-fade-out")}>
        {/* Header with enable toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-medium text-[var(--foreground-subtle)]">
            <span>Schedule (Preview)</span>
          </div>
          <div className="flex items-center gap-1">
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
            onClick={() => updateConfig({ enabled: !config.enabled })}
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
          <span className="text-[var(--foreground-subtle)]">Run every</span>
          <input
            type="number"
            min={1}
            value={config.interval}
            onChange={(e) => updateConfig({ interval: Math.max(1, parseInt(e.target.value) || 1) })}
            className={cn(
              "w-14 px-2 py-1 rounded border border-[var(--border)]",
              "bg-[var(--background)] text-[var(--foreground)]",
              "focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
            )}
          />
          <select
            value={config.unit}
            onChange={(e) => updateConfig({ unit: e.target.value as TimeUnit })}
            className={cn(
              "px-2 py-1 rounded border border-[var(--border)]",
              "bg-[var(--background)] text-[var(--foreground)]",
              "focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
            )}
          >
            <option value="seconds">seconds</option>
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
          </select>
        </div>

        {/* Cron expression display (for non-seconds intervals) */}
        {cronExpression && (
          <div className="text-xs text-[var(--foreground-muted)]">
            Cron: <code className="px-1 bg-[var(--background-hover)] rounded">{cronExpression}</code>
          </div>
        )}

        {/* Advanced toggle */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1 text-xs text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors"
        >
          {showAdvanced ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
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
                className="w-full px-1 py-0.5 text-center rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:outline-none"
              />
              <input
                value={config.cronHour}
                onChange={(e) => updateConfig({ cronHour: e.target.value, mode: "cron" })}
                className="w-full px-1 py-0.5 text-center rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:outline-none"
              />
              <input
                value={config.cronDayOfMonth}
                onChange={(e) => updateConfig({ cronDayOfMonth: e.target.value, mode: "cron" })}
                className="w-full px-1 py-0.5 text-center rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:outline-none"
              />
              <input
                value={config.cronMonth}
                onChange={(e) => updateConfig({ cronMonth: e.target.value, mode: "cron" })}
                className="w-full px-1 py-0.5 text-center rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:outline-none"
              />
              <input
                value={config.cronDayOfWeek}
                onChange={(e) => updateConfig({ cronDayOfWeek: e.target.value, mode: "cron" })}
                className="w-full px-1 py-0.5 text-center rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:outline-none"
              />
            </div>
            <div className="text-xs text-[var(--foreground-muted)]">
              Expression:{" "}
              <code className="px-1 bg-[var(--background-hover)] rounded">
                {config.cronMinute} {config.cronHour} {config.cronDayOfMonth} {config.cronMonth}{" "}
                {config.cronDayOfWeek}
              </code>
            </div>
          </div>
        )}

        {/* Status and Run Now button */}
        <div className="flex items-center justify-between mt-1">
          <div className="text-xs text-[var(--foreground-muted)]">
            {config.enabled && nextRunIn !== null ? (
              <span>Next: {formatNextRun(nextRunIn)}</span>
            ) : (
              <span>Disabled</span>
            )}
          </div>
          <button
            onClick={handleTrigger}
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors",
              "bg-yellow-600 text-white hover:bg-yellow-700",
              "dark:bg-yellow-500 dark:hover:bg-yellow-600"
            )}
          >
            <Play className="w-3 h-3" />
            Run Now
          </button>
        </div>
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
