// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: connectors-v2-fix-color-and-position
const MODULE_REVISION = "connectors-v2-fix-color-and-position";
console.log(`[ConnectionHandles] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

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

// Visual marker - matches terminal ConnectionMarkers style
// Uses !important to override React Flow's default Handle styles (dark background, positioning)
const MARKER_CLASSES =
  "!h-2.5 !w-2.5 !rounded-full !border !border-[var(--border-strong)] !bg-[var(--background)] !shadow-sm";

// Invisible hit area - enlarged clickable zone centered around the marker
const HIT_AREA_CLASSES =
  "flex items-center justify-center h-8 w-8 cursor-pointer";

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

  const markerClass = cn(MARKER_CLASSES);
  const hitAreaClass = cn(HIT_AREA_CLASSES, visible ? "pointer-events-auto" : "pointer-events-none");

  const labelClass = cn(
    "absolute text-[10px] text-[var(--foreground-muted)] whitespace-nowrap opacity-0 pointer-events-none",
    "group-hover:opacity-100 transition-opacity"
  );

  return (
    <div className={containerClass}>
      {/* Left input */}
      <div className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-auto group">
        <button
          type="button"
          className={hitAreaClass}
          onClick={() => onConnectorClick?.(nodeId, "left-in", "target")}
          data-connector="true"
        >
          <Handle
            type="target"
            id="left-in"
            position={Position.Left}
            className={cn(markerClass, "!relative !transform-none !left-auto !top-auto !-translate-x-0 !-translate-y-0 pointer-events-none")}
          />
        </button>
        <span className={cn(labelClass, "right-full mr-4 top-1/2 -translate-y-1/2")}>
          Input
        </span>
      </div>

      {/* Right output */}
      <div className="absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 pointer-events-auto group">
        <button
          type="button"
          className={hitAreaClass}
          onClick={() => onConnectorClick?.(nodeId, "right-out", "source")}
          data-connector="true"
        >
          <Handle
            type="source"
            id="right-out"
            position={Position.Right}
            className={cn(markerClass, "!relative !transform-none !left-auto !top-auto !-translate-x-0 !-translate-y-0 pointer-events-none")}
          />
        </button>
        <span className={cn(labelClass, "left-full ml-4 top-1/2 -translate-y-1/2")}>
          Output
        </span>
      </div>

      {/* Top connectors */}
      {topMode !== "none" && (
        <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 pointer-events-auto group">
          {(topMode === "both" || topMode === "target") && (
            <button
              type="button"
              className={hitAreaClass}
              onClick={() => onConnectorClick?.(nodeId, "top-in", "target")}
              data-connector="true"
            >
              <Handle
                type="target"
                id="top-in"
                position={Position.Top}
                className={cn(markerClass, "!relative !transform-none !left-auto !top-auto !-translate-x-0 !-translate-y-0 pointer-events-none")}
              />
            </button>
          )}
          {(topMode === "both" || topMode === "source") && (
            <button
              type="button"
              className={hitAreaClass}
              onClick={() => onConnectorClick?.(nodeId, "top-out", "source")}
              data-connector="true"
            >
              <Handle
                type="source"
                id="top-out"
                position={Position.Top}
                className={cn(markerClass, "!relative !transform-none !left-auto !top-auto !-translate-x-0 !-translate-y-0 pointer-events-none")}
              />
            </button>
          )}
          <span className={cn(labelClass, "left-1/2 -translate-x-1/2 top-full mt-4")}>
            {topMode === "both" ? "Input/Output" : topMode === "source" ? "Output" : "Input"}
          </span>
        </div>
      )}

      {/* Bottom connectors */}
      {bottomMode !== "none" && (
        <div className="absolute left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 pointer-events-auto group">
          {(bottomMode === "both" || bottomMode === "target") && (
            <button
              type="button"
              className={hitAreaClass}
              onClick={() => onConnectorClick?.(nodeId, "bottom-in", "target")}
              data-connector="true"
            >
              <Handle
                type="target"
                id="bottom-in"
                position={Position.Bottom}
                className={cn(markerClass, "!relative !transform-none !left-auto !top-auto !-translate-x-0 !-translate-y-0 pointer-events-none")}
              />
            </button>
          )}
          {(bottomMode === "both" || bottomMode === "source") && (
            <button
              type="button"
              className={hitAreaClass}
              onClick={() => onConnectorClick?.(nodeId, "bottom-out", "source")}
              data-connector="true"
            >
              <Handle
                type="source"
                id="bottom-out"
                position={Position.Bottom}
                className={cn(markerClass, "!relative !transform-none !left-auto !top-auto !-translate-x-0 !-translate-y-0 pointer-events-none")}
              />
            </button>
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
