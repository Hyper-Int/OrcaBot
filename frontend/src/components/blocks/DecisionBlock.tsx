// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: decision-v3-fix-handle-positions
const MODULE_REVISION = "decision-v3-fix-handle-positions";
console.log(`[DecisionBlock] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { type NodeProps, type Node, Handle, Position, useEdges } from "@xyflow/react";
import { GitBranch, Settings, Copy, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import { useDebouncedCallback } from "@/hooks/useDebounce";
import { useConnectionDataFlow } from "@/contexts/ConnectionDataFlowContext";
import { useThemeStore } from "@/stores/theme-store";
import { BlockSettingsFooter } from "./BlockSettingsFooter";
import type { DashboardItem } from "@/types/dashboard";

type Operator = "contains" | "equals" | "greater_than" | "less_than";

const OPERATOR_LABELS: Record<Operator, string> = {
  contains: "Contains",
  equals: "Equals",
  greater_than: ">",
  less_than: "<",
};

function evaluate(text: string, operator: Operator, parameter: string): boolean {
  switch (operator) {
    case "contains":
      return text.toLowerCase().includes(parameter.toLowerCase());
    case "equals":
      return text.trim() === parameter.trim();
    case "greater_than": {
      const num = parseFloat(text);
      const target = parseFloat(parameter);
      return !isNaN(num) && !isNaN(target) && num > target;
    }
    case "less_than": {
      const num = parseFloat(text);
      const target = parseFloat(parameter);
      return !isNaN(num) && !isNaN(target) && num < target;
    }
    default:
      return false;
  }
}

interface DecisionData extends Record<string, unknown> {
  content: string;
  size: { width: number; height: number };
  metadata?: { minimized?: boolean; [key: string]: unknown };
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  onDuplicate?: () => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type DecisionNode = Node<DecisionData, "decision">;

// Handle dot style — matches ConnectionHandles marker appearance
const HANDLE_DOT =
  "!h-2.5 !w-2.5 !rounded-full !border !border-[var(--border-strong)] !bg-[var(--background)] !shadow-sm";

export function DecisionBlock({ id, data, selected }: NodeProps<DecisionNode>) {
  const edges = useEdges();

  // Parse persisted content
  const parsed = React.useMemo(() => {
    try {
      const obj = JSON.parse(data.content || "{}");
      return {
        operator: (obj.operator as Operator) || "contains",
        parameter: (obj.parameter as string) || "",
      };
    } catch {
      return { operator: "contains" as Operator, parameter: "" };
    }
  }, [data.content]);

  const [operator, setOperator] = React.useState<Operator>(parsed.operator);
  const [parameter, setParameter] = React.useState(parsed.parameter);
  const [lastResult, setLastResult] = React.useState<boolean | null>(null);
  const [flashKey, setFlashKey] = React.useState(0);
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const connectionFlow = useConnectionDataFlow();
  const theme = useThemeStore((s) => s.theme);
  const isDark = theme === "dark" || theme === "midnight";
  const isMinimized = data.metadata?.minimized === true;
  const [isAnimatingMinimize, setIsAnimatingMinimize] = React.useState(false);
  const minimizeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Determine bottom-right gate role based on connections.
  // Default: NO. Flips to YES if bottomleft-out has no connection AND topright-out has a connection.
  const bottomRightIsYes = React.useMemo(() => {
    const hasBottomLeftConn = edges.some(
      (e) => e.source === id && e.sourceHandle === "bottomleft-out"
    );
    const hasTopRightConn = edges.some(
      (e) => e.source === id && e.sourceHandle === "topright-out"
    );
    return !hasBottomLeftConn && hasTopRightConn;
  }, [id, edges]);

  React.useEffect(() => {
    return () => {
      if (minimizeTimeoutRef.current) clearTimeout(minimizeTimeoutRef.current);
    };
  }, []);

  // Sync from server
  React.useEffect(() => {
    setOperator(parsed.operator);
    setParameter(parsed.parameter);
  }, [parsed.operator, parsed.parameter]);

  // Debounced persistence
  const debouncedUpdate = useDebouncedCallback(
    (op: Operator, param: string) => {
      data.onContentChange?.(JSON.stringify({ operator: op, parameter: param }));
    },
    500
  );

  const handleOperatorChange = React.useCallback(
    (newOp: Operator) => {
      setOperator(newOp);
      debouncedUpdate(newOp, parameter);
    },
    [parameter, debouncedUpdate]
  );

  const handleParameterChange = React.useCallback(
    (newParam: string) => {
      setParameter(newParam);
      debouncedUpdate(operator, newParam);
    },
    [operator, debouncedUpdate]
  );

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
    data.onItemChange?.({
      metadata: { ...data.metadata, minimized: false },
      size: savedSize || { width: 220, height: 220 },
    });
  };

  // Stable ref for evaluation + gate logic used in input handler
  const evaluateRef = React.useRef({ operator, parameter });
  React.useEffect(() => {
    evaluateRef.current = { operator, parameter };
  }, [operator, parameter]);

  const bottomRightIsYesRef = React.useRef(bottomRightIsYes);
  React.useEffect(() => {
    bottomRightIsYesRef.current = bottomRightIsYes;
  }, [bottomRightIsYes]);

  // Register input handlers
  React.useEffect(() => {
    if (!connectionFlow) return;

    const handler = (payload: { text?: string; execute?: boolean; newSession?: boolean }) => {
      const text = payload.text || "";
      const { operator: op, parameter: param } = evaluateRef.current;
      const result = evaluate(text, op, param);

      setLastResult(result);
      setFlashKey((k) => k + 1);

      const outPayload = { text, execute: payload.execute, newSession: payload.newSession };
      if (result) {
        // YES → bottomleft-out always, bottomright-out if it's acting as YES
        connectionFlow.fireOutput(id, "bottomleft-out", outPayload);
        if (bottomRightIsYesRef.current) {
          connectionFlow.fireOutput(id, "bottomright-out", outPayload);
        }
      } else {
        // NO → topright-out always, bottomright-out if it's acting as NO
        connectionFlow.fireOutput(id, "topright-out", outPayload);
        if (!bottomRightIsYesRef.current) {
          connectionFlow.fireOutput(id, "bottomright-out", outPayload);
        }
      }
    };

    const cleanupLeft = connectionFlow.registerInputHandler(id, "left-in", handler);
    const cleanupTop = connectionFlow.registerInputHandler(id, "top-in", handler);

    return () => {
      cleanupLeft();
      cleanupTop();
    };
  }, [id, connectionFlow]);

  // Minimized view
  if (isMinimized && !isAnimatingMinimize) {
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={<GitBranch className="w-14 h-14 text-amber-600 dark:text-amber-400" />}
        label="Decision"
        onExpand={handleExpand}
        connectorsVisible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
        className="bg-amber-50/90 border-amber-200 dark:bg-amber-900/30 dark:border-amber-800"
      />
    );
  }

  const w = data.size?.width || 220;
  const h = data.size?.height || 220;

  return (
    <div
      className="relative"
      style={{ width: w, height: h }}
    >
      {/* Diamond shape - rotated square */}
      <div
        className={cn(
          "absolute inset-0 rounded-lg border-2 transition-shadow",
          isDark
            ? "bg-amber-800/70 border-amber-500/80"
            : "bg-amber-200 border-amber-400",
          selected && "ring-2 ring-[var(--accent-primary)] shadow-lg",
          isAnimatingMinimize && "animate-content-fade-out"
        )}
        style={{
          clipPath: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
        }}
      />

      {/* Content overlay - centered in diamond, not rotated */}
      <div
        className={cn(
          "absolute inset-0 flex flex-col items-center justify-center pointer-events-none",
          isAnimatingMinimize && "animate-content-fade-out"
        )}
        style={{
          // Inner usable area is roughly 50% of the diamond
          padding: `${h * 0.25}px ${w * 0.25}px`,
        }}
      >
        <div className="pointer-events-auto flex flex-col items-center gap-1 w-full">
          {/* Header row */}
          <div className="flex items-center gap-1 text-[10px] font-medium w-full justify-center"
            style={{ color: isDark ? "white" : "var(--foreground)" }}
          >
            <GitBranch className="w-3 h-3 shrink-0" />
            <span className="truncate">Decision</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="nodrag h-4 w-4 shrink-0" title="Settings">
                  <Settings className="w-2.5 h-2.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => data.onDuplicate?.()} className="gap-2">
                  <Copy className="w-3 h-3" />
                  <span>Duplicate</span>
                </DropdownMenuItem>
                <BlockSettingsFooter nodeId={id} onMinimize={handleMinimize} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Operator + Parameter - stacked for compact fit */}
          <select
            value={operator}
            onChange={(e) => handleOperatorChange(e.target.value as Operator)}
            className={cn(
              "nodrag text-[10px] rounded px-1.5 py-0.5 border w-full text-center",
              "focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]",
              isDark
                ? "bg-black text-white border-amber-700"
                : "bg-white text-black border-amber-300"
            )}
          >
            {(Object.keys(OPERATOR_LABELS) as Operator[]).map((op) => (
              <option key={op} value={op}>
                {OPERATOR_LABELS[op]}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={parameter}
            onChange={(e) => handleParameterChange(e.target.value)}
            placeholder="value..."
            className={cn(
              "nodrag text-[10px] rounded px-1.5 py-0.5 border w-full text-center",
              "focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]",
              "placeholder:text-slate-400",
              isDark
                ? "bg-black text-white border-amber-700"
                : "bg-white text-black border-amber-300"
            )}
          />

          {/* Last evaluation result */}
          {lastResult !== null && (
            <div
              key={flashKey}
              className={cn(
                "flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded animate-fade-in",
                lastResult
                  ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
                  : "bg-red-500/20 text-red-700 dark:text-red-300"
              )}
            >
              {lastResult ? <Check className="w-2.5 h-2.5" /> : <X className="w-2.5 h-2.5" />}
              <span>{lastResult ? "YES" : "NO"}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── React Flow Handles ──
          Placed as direct children so React Flow can read their DOM position.
          Positioned via style={{ left, top }} which React Flow uses for edge paths.
          Diamond points: top(50%,0%), right(100%,50%), bottom(50%,100%), left(0%,50%).
          Edge midpoints: top-right(75%,25%), bottom-right(75%,75%), bottom-left(25%,75%).
      */}

      {/* INPUT: Top point */}
      <Handle type="target" id="top-in" position={Position.Top}
        className={cn(HANDLE_DOT, connectorsVisible ? "!opacity-100" : "!opacity-0")}
        style={{ left: "50%", top: "0%" }}
        onClick={() => data.onConnectorClick?.(id, "top-in", "target")}
      />
      {/* INPUT: Left point */}
      <Handle type="target" id="left-in" position={Position.Left}
        className={cn(HANDLE_DOT, connectorsVisible ? "!opacity-100" : "!opacity-0")}
        style={{ left: "0%", top: "50%" }}
        onClick={() => data.onConnectorClick?.(id, "left-in", "target")}
      />
      {/* OUTPUT: Bottom-left — always YES */}
      <Handle type="source" id="bottomleft-out" position={Position.Bottom}
        className={cn(HANDLE_DOT, "!border-emerald-500", connectorsVisible ? "!opacity-100" : "!opacity-0")}
        style={{ left: "25%", top: "75%" }}
        onClick={() => data.onConnectorClick?.(id, "bottomleft-out", "source")}
      />
      {/* OUTPUT: Top-right — always NO */}
      <Handle type="source" id="topright-out" position={Position.Right}
        className={cn(HANDLE_DOT, "!border-red-400", connectorsVisible ? "!opacity-100" : "!opacity-0")}
        style={{ left: "75%", top: "25%" }}
        onClick={() => data.onConnectorClick?.(id, "topright-out", "source")}
      />
      {/* OUTPUT: Bottom-right — dynamic YES/NO */}
      <Handle type="source" id="bottomright-out" position={Position.Bottom}
        className={cn(HANDLE_DOT, bottomRightIsYes ? "!border-emerald-500" : "!border-red-400", connectorsVisible ? "!opacity-100" : "!opacity-0")}
        style={{ left: "75%", top: "75%" }}
        onClick={() => data.onConnectorClick?.(id, "bottomright-out", "source")}
      />

      {/* Handle labels — overlay, only visible when connectors shown */}
      {connectorsVisible && (
        <div className="absolute inset-0 pointer-events-none z-20">
          <span className="absolute text-[9px] text-[var(--foreground-muted)] whitespace-nowrap" style={{ left: "50%", top: "-14px", transform: "translateX(-50%)" }}>In</span>
          <span className="absolute text-[9px] text-[var(--foreground-muted)] whitespace-nowrap" style={{ left: "-16px", top: "50%", transform: "translateY(-50%)" }}>In</span>
          <span className="absolute text-[9px] text-emerald-600 dark:text-emerald-400 font-medium whitespace-nowrap" style={{ left: "25%", top: "75%", transform: "translate(-50%, 8px)" }}>YES</span>
          <span className="absolute text-[9px] text-red-500 dark:text-red-400 font-medium whitespace-nowrap" style={{ left: "75%", top: "25%", transform: "translate(8px, -50%)" }}>NO</span>
          <span className={cn("absolute text-[9px] font-medium whitespace-nowrap", bottomRightIsYes ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400")} style={{ left: "75%", top: "75%", transform: "translate(8px, -50%)" }}>
            {bottomRightIsYes ? "YES" : "NO"}
          </span>
        </div>
      )}
    </div>
  );
}

export default DecisionBlock;
