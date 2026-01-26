// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { useDebouncedCallback } from "@/hooks/useDebounce";
import { useConnectionDataFlow } from "@/contexts/ConnectionDataFlowContext";

interface PromptData extends Record<string, unknown> {
  content: string;
  size: { width: number; height: number };
  onContentChange?: (content: string) => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type PromptNode = Node<PromptData, "prompt">;

export function PromptBlock({ id, data, selected }: NodeProps<PromptNode>) {
  const [content, setContent] = React.useState(data.content || "");
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const connectionFlow = useConnectionDataFlow();

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

  // Register input handlers to receive data (both left and top inputs)
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

  // Fire prompt to connected blocks (both right and bottom outputs)
  const handleGo = React.useCallback(() => {
    if (!content.trim()) return;

    const payload = { text: content, execute: true };
    connectionFlow?.fireOutput(id, "right-out", payload);
    connectionFlow?.fireOutput(id, "bottom-out", payload);
  }, [id, content, connectionFlow]);

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

  return (
    <BlockWrapper
      selected={selected}
      className={cn(
        "p-3 flex flex-col gap-2",
        "bg-slate-100/90 border-slate-200 dark:bg-slate-800/90 dark:border-slate-700"
      )}
      includeHandles={false}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-[var(--foreground-subtle)]">
        <span>Prompt</span>
      </div>
      <textarea
        value={content}
        onChange={(e) => handleContentChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Enter a prompt..."
        className={cn(
          "w-full flex-1 bg-transparent resize-none",
          "text-sm text-[var(--foreground)] placeholder:text-[var(--foreground-subtle)]",
          "focus:outline-none"
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
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    </BlockWrapper>
  );
}

export default PromptBlock;
