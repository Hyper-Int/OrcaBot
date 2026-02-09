// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { Play, Check, Circle, Loader2, AlertCircle, GitMerge, Minimize2, Settings, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import {
  Button,
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import { ConnectionHandles } from "./ConnectionHandles";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import { BlockSettingsFooter } from "./BlockSettingsFooter";
import type { DashboardItem } from "@/types/dashboard";

type StepStatus = "pending" | "running" | "completed" | "failed";

interface RecipeStep {
  id: string;
  name: string;
  status: StepStatus;
}

interface RecipeData extends Record<string, unknown> {
  content: string; // JSON stringified recipe data
  title?: string;
  size: { width: number; height: number };
  metadata?: { minimized?: boolean; [key: string]: unknown };
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  onDuplicate?: () => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type RecipeNode = Node<RecipeData, "recipe">;

const statusIcons: Record<StepStatus, React.ReactNode> = {
  pending: <span title="Pending"><Circle className="w-4 h-4 text-[var(--foreground-subtle)]" /></span>,
  running: <span title="Running"><Loader2 className="w-4 h-4 text-[var(--accent-primary)] animate-spin" /></span>,
  completed: <span title="Completed"><Check className="w-4 h-4 text-[var(--status-success)]" /></span>,
  failed: <span title="Failed"><AlertCircle className="w-4 h-4 text-[var(--status-error)]" /></span>,
};

export function RecipeBlock({ id, data, selected }: NodeProps<RecipeNode>) {
  const [title, setTitle] = React.useState(data.title || "Recipe");
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
      size: savedSize || { width: 280, height: 300 },
    });
  };

  const [steps, setSteps] = React.useState<RecipeStep[]>(() => {
    try {
      const parsed = JSON.parse(data.content || "{}");
      return parsed.steps || [
        { id: "1", name: "Initialize environment", status: "pending" },
        { id: "2", name: "Run tests", status: "pending" },
        { id: "3", name: "Deploy changes", status: "pending" },
      ];
    } catch {
      return [];
    }
  });

  const isRunning = steps.some((step) => step.status === "running");
  const completedCount = steps.filter((step) => step.status === "completed").length;
  const connectorsVisible = selected || Boolean(data.connectorMode);

  const handleRun = () => {
    // This would trigger the actual recipe execution via API
    console.log("Running recipe:", title);
  };

  // Minimized view - only show when fully minimized (not during animation)
  if (isMinimized && !isAnimatingMinimize) {
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={<GitMerge className="w-14 h-14 text-[var(--accent-primary)]" />}
        label={`${title} (${completedCount}/${steps.length})`}
        onExpand={handleExpand}
        connectorsVisible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    );
  }

  return (
    <BlockWrapper
      selected={selected}
      className={cn("p-0 overflow-hidden flex flex-col", expandAnimation)}
    >
      {/* All content fades during minimize */}
      <div className={cn("flex flex-col flex-1 overflow-hidden", isAnimatingMinimize && "animate-content-fade-out")}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-[var(--background)] shrink-0">
          <div className="flex items-center gap-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="text-sm font-medium text-[var(--foreground)] bg-transparent focus:outline-none"
              title="Edit recipe title"
            />
            <Badge
              variant={isRunning ? "warning" : completedCount === steps.length ? "success" : "secondary"}
              size="sm"
              title={isRunning ? "Recipe is running" : `${completedCount} of ${steps.length} steps completed`}
            >
              {isRunning ? "Running" : `${completedCount}/${steps.length}`}
            </Badge>
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
          </div>
        </div>
        {/* Steps */}
        <div className="p-3 space-y-2 flex-1 overflow-y-auto">
          {steps.map((step, index) => (
            <div
              key={step.id}
              className={cn(
                "flex items-center gap-3 px-2 py-1.5 rounded",
                step.status === "running" && "bg-[var(--accent-primary)]/10",
                step.status === "failed" && "bg-[var(--status-error)]/10"
              )}
            >
              <span className="text-xs text-[var(--foreground-subtle)] w-4">
                {index + 1}.
              </span>
              {statusIcons[step.status]}
              <span
                className={cn(
                  "flex-1 text-sm",
                  step.status === "completed" && "text-[var(--foreground-muted)]",
                  step.status === "failed" && "text-[var(--status-error)]",
                  step.status === "running" && "text-[var(--accent-primary)]",
                  step.status === "pending" && "text-[var(--foreground)]"
                )}
              >
                {step.name}
              </span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-3 py-2 border-t border-[var(--border)] bg-[var(--background)] shrink-0">
          <Button
            variant={isRunning ? "secondary" : "primary"}
            size="sm"
            onClick={handleRun}
            disabled={isRunning}
            leftIcon={isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            className="w-full"
            title={isRunning ? "Recipe is currently running" : "Execute all recipe steps"}
          >
            {isRunning ? "Running..." : "Run Recipe"}
          </Button>
        </div>
      </div>
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    </BlockWrapper>
  );
}

export default RecipeBlock;
