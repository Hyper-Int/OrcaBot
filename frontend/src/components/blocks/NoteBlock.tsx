"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { useDebouncedCallback } from "@/hooks/useDebounce";

type NoteColor = "yellow" | "blue" | "green" | "pink" | "purple";

interface NoteData extends Record<string, unknown> {
  content: string;
  color?: NoteColor;
  size: { width: number; height: number };
  onContentChange?: (content: string) => void;
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

  return (
    <BlockWrapper
      selected={selected}
      className={cn(
        "p-4 flex flex-col",
        colorClasses[color]
      )}
      includeHandles={false}
    >
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
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    </BlockWrapper>
  );
}

export default NoteBlock;
