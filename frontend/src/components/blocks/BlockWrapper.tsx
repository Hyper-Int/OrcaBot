"use client";

import * as React from "react";
import { NodeResizer, Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

interface BlockWrapperProps {
  children: React.ReactNode;
  selected?: boolean;
  selectedBy?: { id: string; name: string; color: string } | null;
  className?: string;
  style?: React.CSSProperties;
  /** Minimum width for resize */
  minWidth?: number;
  /** Minimum height for resize */
  minHeight?: number;
  /** Whether resize is enabled */
  resizable?: boolean;
  /** Whether to include connection handles (default: true) */
  includeHandles?: boolean;
}

export function BlockWrapper({
  children,
  selected = false,
  selectedBy,
  className,
  style,
  minWidth = 100,
  minHeight = 60,
  resizable = true,
  includeHandles = true,
}: BlockWrapperProps) {
  return (
    <>
      {/* Resize handles - only show when selected */}
      {resizable && (
        <NodeResizer
          isVisible={selected}
          minWidth={minWidth}
          minHeight={minHeight}
          lineClassName="border-[var(--accent-primary)]"
          handleClassName="bg-[var(--accent-primary)] w-2 h-2 rounded-sm border-none"
        />
      )}
      <div
        className={cn(
          "relative rounded-[var(--radius-card)] transition-shadow w-full h-full",
          "bg-[var(--background-elevated)] border border-[var(--border)]",
          // Shadow states
          "shadow-sm hover:shadow-md",
          // Selection states
          selected && "ring-2 ring-[var(--accent-primary)] shadow-lg",
          selectedBy && "ring-2 shadow-lg",
          className
        )}
        style={{
          // Don't set width/height here - let w-full h-full inherit from React Flow node
          // Only pass through non-dimension styles
          borderColor: style?.borderColor,
          borderWidth: style?.borderWidth,
          // Apply user's presence color if selected by another user
          ...(selectedBy && {
            "--tw-ring-color": selectedBy.color,
          } as React.CSSProperties),
        }}
      >
        {/* Selection indicator for other users */}
        {selectedBy && (
          <div
            className="absolute -top-6 left-2 px-2 py-0.5 rounded text-xs font-medium text-white"
            style={{ backgroundColor: selectedBy.color }}
          >
            {selectedBy.name}
          </div>
        )}
        {children}
      </div>
      {/* Hidden handles for potential future connections */}
      {includeHandles && (
        <>
          <Handle type="source" position={Position.Right} className="opacity-0" />
          <Handle type="target" position={Position.Left} className="opacity-0" />
        </>
      )}
    </>
  );
}

export default BlockWrapper;
