// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

type ConnectorKind = "source" | "target";
type VerticalHandleMode = "both" | "source" | "target" | "none";

interface ConnectionHandlesProps {
  nodeId: string;
  visible: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: ConnectorKind) => void;
  topMode?: VerticalHandleMode;
  bottomMode?: VerticalHandleMode;
}

// Visual handle - small dot
const HANDLE_CLASSES =
  "h-3 w-3 rounded-full border-2 border-[var(--border-strong)] bg-[var(--background)] shadow-sm";

// Invisible hit area wrapper - larger clickable zone
const HIT_AREA_CLASSES =
  "flex items-center justify-center h-8 w-8 -m-2.5 cursor-pointer hover:scale-110 transition-transform";

export function ConnectionHandles({
  nodeId,
  visible,
  onConnectorClick,
  topMode = "target",
  bottomMode = "source",
}: ConnectionHandlesProps) {
  const containerClass = cn(
    "absolute inset-0 pointer-events-none z-20",
    visible ? "opacity-100" : "opacity-0"
  );

  const handleClass = cn(HANDLE_CLASSES);
  const hitAreaClass = cn(HIT_AREA_CLASSES, visible ? "pointer-events-auto" : "pointer-events-none");

  const labelClass = cn(
    "absolute text-[10px] text-[var(--foreground-muted)] whitespace-nowrap opacity-0",
    "group-hover:opacity-100 transition-opacity"
  );

  return (
    <div className={containerClass}>
      {/* Left input */}
      <div className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 group">
        <div
          className={hitAreaClass}
          onClick={() => onConnectorClick?.(nodeId, "left-in", "target")}
          data-connector="true"
        >
          <Handle
            type="target"
            id="left-in"
            position={Position.Left}
            className={cn(handleClass, "!relative !transform-none !left-0 !top-0")}
          />
        </div>
        <span className={cn(labelClass, "right-full mr-4 top-1/2 -translate-y-1/2")}>
          Input
        </span>
      </div>

      {/* Right output */}
      <div className="absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 group">
        <div
          className={hitAreaClass}
          onClick={() => onConnectorClick?.(nodeId, "right-out", "source")}
          data-connector="true"
        >
          <Handle
            type="source"
            id="right-out"
            position={Position.Right}
            className={cn(handleClass, "!relative !transform-none !left-0 !top-0")}
          />
        </div>
        <span className={cn(labelClass, "left-full ml-4 top-1/2 -translate-y-1/2")}>
          Output
        </span>
      </div>

      {/* Top connectors */}
      {topMode !== "none" && (
        <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 group">
          {(topMode === "both" || topMode === "target") && (
            <div
              className={hitAreaClass}
              onClick={() => onConnectorClick?.(nodeId, "top-in", "target")}
              data-connector="true"
            >
              <Handle
                type="target"
                id="top-in"
                position={Position.Top}
                className={cn(handleClass, "!relative !transform-none !left-0 !top-0")}
              />
            </div>
          )}
          {(topMode === "both" || topMode === "source") && (
            <div
              className={hitAreaClass}
              onClick={() => onConnectorClick?.(nodeId, "top-out", "source")}
              data-connector="true"
            >
              <Handle
                type="source"
                id="top-out"
                position={Position.Top}
                className={cn(handleClass, "!relative !transform-none !left-0 !top-0")}
              />
            </div>
          )}
          <span className={cn(labelClass, "left-1/2 -translate-x-1/2 top-full mt-4")}>
            {topMode === "both" ? "Input/Output" : topMode === "source" ? "Output" : "Input"}
          </span>
        </div>
      )}

      {/* Bottom connectors */}
      {bottomMode !== "none" && (
        <div className="absolute left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 group">
          {(bottomMode === "both" || bottomMode === "target") && (
            <div
              className={hitAreaClass}
              onClick={() => onConnectorClick?.(nodeId, "bottom-in", "target")}
              data-connector="true"
            >
              <Handle
                type="target"
                id="bottom-in"
                position={Position.Bottom}
                className={cn(handleClass, "!relative !transform-none !left-0 !top-0")}
              />
            </div>
          )}
          {(bottomMode === "both" || bottomMode === "source") && (
            <div
              className={hitAreaClass}
              onClick={() => onConnectorClick?.(nodeId, "bottom-out", "source")}
              data-connector="true"
            >
              <Handle
                type="source"
                id="bottom-out"
                position={Position.Bottom}
                className={cn(handleClass, "!relative !transform-none !left-0 !top-0")}
              />
            </div>
          )}
          <span className={cn(labelClass, "left-1/2 -translate-x-1/2 bottom-full mb-4")}>
            {bottomMode === "both" ? "Input/Output" : bottomMode === "source" ? "Output" : "Input"}
          </span>
        </div>
      )}
    </div>
  );
}

export default ConnectionHandles;
