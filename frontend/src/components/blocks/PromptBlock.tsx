// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { Play, MessageSquare, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import { Button } from "@/components/ui/button";
import { useDebouncedCallback } from "@/hooks/useDebounce";
import { useConnectionDataFlow } from "@/contexts/ConnectionDataFlowContext";
import { useThemeStore } from "@/stores/theme-store";
import type { DashboardItem } from "@/types/dashboard";

interface PromptData extends Record<string, unknown> {
  content: string;
  size: { width: number; height: number };
  metadata?: { minimized?: boolean; [key: string]: unknown };
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type PromptNode = Node<PromptData, "prompt">;

export function PromptBlock({ id, data, selected }: NodeProps<PromptNode>) {
  const [content, setContent] = React.useState(data.content || "");
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const connectionFlow = useConnectionDataFlow();
  const theme = useThemeStore((s) => s.theme);
  const isDark = theme === "dark";
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
      size: savedSize || { width: 300, height: 150 },
    });
  };

  // Sync content from server
  React.useEffect(() => {
    setContent(data.content || "");
  }, [data.content]);

  // Debounced server update
  const debouncedUpdate = useDebouncedCallback(
    (newContent: string) => {
      data.onContentChange?.(newContent);
    },
    500
  );

  // Handle content change with debounce
  const handleContentChange = React.useCallback(
    (newContent: string) => {
      setContent(newContent);
      debouncedUpdate(newContent);
    },
    [debouncedUpdate]
  );

  // Fire prompt to connected blocks (both right and bottom outputs)
  const handleGo = React.useCallback(() => {
    if (!content.trim()) return;

    const payload = { text: content, execute: true };
    connectionFlow?.fireOutput(id, "right-out", payload);
    connectionFlow?.fireOutput(id, "bottom-out", payload);
  }, [id, content, connectionFlow]);

  // Register input handlers to receive data (both left and top inputs)
  React.useEffect(() => {
    if (!connectionFlow) return;

    const handler = (payload: { text?: string; execute?: boolean }) => {
      if (payload.text) {
        handleContentChange(payload.text);
      }
      // When receiving execute signal, fire current content to outputs
      if (payload.execute) {
        handleGo();
      }
    };

    const cleanupLeft = connectionFlow.registerInputHandler(id, "left-in", handler);
    const cleanupTop = connectionFlow.registerInputHandler(id, "top-in", handler);

    return () => {
      cleanupLeft();
      cleanupTop();
    };
  }, [id, connectionFlow, handleContentChange, handleGo]);

  // Handle Ctrl/Cmd+Enter to fire
  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleGo();
      }
    },
    [handleGo]
  );

  // Minimized view - only show when fully minimized (not during animation)
  if (isMinimized && !isAnimatingMinimize) {
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={<MessageSquare className="w-14 h-14 text-slate-600 dark:text-slate-400" />}
        label="Prompt"
        onExpand={handleExpand}
        connectorsVisible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
        className="bg-slate-100/90 border-slate-200 dark:bg-slate-800/90 dark:border-slate-700"
      />
    );
  }

  return (
    <BlockWrapper
      selected={selected}
      className={cn(
        "p-3 flex flex-col gap-2",
        "bg-slate-100/90 border-slate-200 dark:bg-slate-800/90 dark:border-slate-700",
        expandAnimation
      )}
      includeHandles={false}
    >
      {/* All content fades during minimize */}
      <div className={cn("flex flex-col gap-2 flex-1", isAnimatingMinimize && "animate-content-fade-out")}>
        <div
          className="flex items-center justify-between text-xs font-medium"
          style={{ color: isDark ? "var(--foreground-subtle)" : "black" }}
        >
          <span>Prompt</span>
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
        <textarea
          value={content}
          onChange={(e) => handleContentChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter a prompt..."
          style={{
            backgroundColor: isDark ? "black" : "white",
            color: isDark ? "white" : "black"
          }}
          className={cn(
            "w-full flex-1 resize-none rounded-md p-2",
            "border border-slate-300",
            "text-sm placeholder:text-slate-400",
            "focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]",
            "dark:border-slate-600"
          )}
        />
        <button
          onClick={handleGo}
          disabled={!content.trim()}
          className={cn(
            "flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md",
            "text-sm font-medium transition-colors",
            "bg-emerald-600 text-white hover:bg-emerald-700",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "dark:bg-emerald-500 dark:hover:bg-emerald-600"
          )}
        >
          <Play className="w-3.5 h-3.5" />
          Go
        </button>
      </div>
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    </BlockWrapper>
  );
}

export default PromptBlock;
