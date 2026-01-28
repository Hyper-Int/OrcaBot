// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { StickyNote, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import { Button } from "@/components/ui/button";
import { useDebouncedCallback } from "@/hooks/useDebounce";
import { useConnectionDataFlow } from "@/contexts/ConnectionDataFlowContext";
import type { DashboardItem } from "@/types/dashboard";

type NoteColor = "yellow" | "blue" | "green" | "pink" | "purple";

interface NoteData extends Record<string, unknown> {
  content: string;
  color?: NoteColor;
  size: { width: number; height: number };
  metadata?: { minimized?: boolean; [key: string]: unknown };
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type NoteNode = Node<NoteData, "note">;

const colorClasses: Record<NoteColor, string> = {
  yellow: "bg-amber-100/90 border-amber-200 dark:bg-amber-900/30 dark:border-amber-800/50",
  blue: "bg-blue-100/90 border-blue-200 dark:bg-blue-900/30 dark:border-blue-800/50",
  green: "bg-emerald-100/90 border-emerald-200 dark:bg-emerald-900/30 dark:border-emerald-800/50",
  pink: "bg-pink-100/90 border-pink-200 dark:bg-pink-900/30 dark:border-pink-800/50",
  purple: "bg-violet-100/90 border-violet-200 dark:bg-violet-900/30 dark:border-violet-800/50",
};

export function NoteBlock({ id, data, selected }: NodeProps<NoteNode>) {
  const [content, setContent] = React.useState(data.content || "");
  const color = data.color || "yellow";
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
      size: savedSize || { width: 200, height: 200 },
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

  // Register handlers for incoming data from connections (both left and top inputs)
  const connectionFlow = useConnectionDataFlow();
  React.useEffect(() => {
    if (!connectionFlow) return;

    const handler = (payload: { text: string }) => {
      if (payload.text) {
        handleContentChange(payload.text);
      }
    };

    const cleanupLeft = connectionFlow.registerInputHandler(id, "left-in", handler);
    const cleanupTop = connectionFlow.registerInputHandler(id, "top-in", handler);

    return () => {
      cleanupLeft();
      cleanupTop();
    };
  }, [id, connectionFlow, handleContentChange]);

  // Minimized view - only show when fully minimized (not during animation)
  if (isMinimized && !isAnimatingMinimize) {
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={<StickyNote className="w-14 h-14" style={{ color: color === "yellow" ? "#d97706" : color === "blue" ? "#2563eb" : color === "green" ? "#059669" : color === "pink" ? "#db2777" : "#7c3aed" }} />}
        label="Note"
        onExpand={handleExpand}
        connectorsVisible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
        className={colorClasses[color]}
      />
    );
  }

  return (
    <BlockWrapper
      selected={selected}
      className={cn(
        "p-4 flex flex-col",
        colorClasses[color],
        expandAnimation
      )}
      includeHandles={false}
    >
      {/* All content fades during minimize */}
      <div className={cn("flex flex-col flex-1", isAnimatingMinimize && "animate-content-fade-out")}>
        {/* Minimize button */}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleMinimize}
          title="Minimize"
          className="nodrag absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity h-5 w-5"
        >
          <Minimize2 className="w-3 h-3" />
        </Button>
        <textarea
          value={content}
          onChange={(e) => handleContentChange(e.target.value)}
          placeholder="Write a note..."
          className={cn(
            "w-full flex-1 bg-transparent resize-none",
            "text-sm text-[var(--foreground)] placeholder:text-[var(--foreground-subtle)]",
            "focus:outline-none"
          )}
        />
      </div>
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    </BlockWrapper>
  );
}

export default NoteBlock;
