// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: connectors-v4-stable-secondary-handles
const MODULE_REVISION = "connectors-v4-stable-secondary-handles";
console.log(`[ConnectionHandles] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";
import { useConnectedHandles } from "@/contexts/ConnectedHandlesContext";

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

// Handle styling override for React Flow positioning
const HANDLE_RESET = "!relative !transform-none !left-auto !top-auto !-translate-x-0 !-translate-y-0 pointer-events-none";

// Vertical offset (px) for paired handles on left/right sides
const PAIR_OFFSET = 12;
// Horizontal offset (px) for paired handles on top/bottom sides
const H_PAIR_OFFSET = 12;

export function ConnectionHandles({
  nodeId,
  visible,
  onConnectorClick,
  topMode = "target",
  bottomMode = "source",
}: ConnectionHandlesProps) {
  const connectedHandles = useConnectedHandles(nodeId);

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

  // Show paired handles when ANY handle on that side is connected.
  // This prevents unmounting secondary handles that an existing edge depends on.
  const leftConnected = connectedHandles.has("left-in") || connectedHandles.has("left-out");
  const rightConnected = connectedHandles.has("right-out") || connectedHandles.has("right-in");

  // Top/bottom: show paired when mode is single-direction and any handle on that side is connected
  const topConnected = topMode === "target" && (connectedHandles.has("top-in") || connectedHandles.has("top-out"));
  const bottomConnected = bottomMode === "source" && (connectedHandles.has("bottom-out") || connectedHandles.has("bottom-in"));

  return (
    <div className={containerClass}>
      {/* ===== LEFT SIDE ===== */}
      {leftConnected ? (
        // Paired: left-out (secondary, above) + left-in (primary, below)
        <>
          <div
            className="absolute left-0 -translate-x-1/2 pointer-events-auto group"
            style={{ top: `calc(50% - ${PAIR_OFFSET}px)`, transform: "translateX(-50%) translateY(-50%)" }}
          >
            <button
              type="button"
              className={hitAreaClass}
              onClick={() => onConnectorClick?.(nodeId, "left-out", "source")}
              data-connector="true"
            >
              <Handle
                type="source"
                id="left-out"
                position={Position.Left}
                className={cn(markerClass, HANDLE_RESET)}
              />
            </button>
            <span className={cn(labelClass, "right-full mr-4 top-1/2 -translate-y-1/2")}>
              Output
            </span>
          </div>
          <div
            className="absolute left-0 -translate-x-1/2 pointer-events-auto group"
            style={{ top: `calc(50% + ${PAIR_OFFSET}px)`, transform: "translateX(-50%) translateY(-50%)" }}
          >
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
                className={cn(markerClass, HANDLE_RESET)}
              />
            </button>
            <span className={cn(labelClass, "right-full mr-4 top-1/2 -translate-y-1/2")}>
              Input
            </span>
          </div>
        </>
      ) : (
        // Single: left-in at center
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
              className={cn(markerClass, HANDLE_RESET)}
            />
          </button>
          <span className={cn(labelClass, "right-full mr-4 top-1/2 -translate-y-1/2")}>
            Input
          </span>
        </div>
      )}

      {/* ===== RIGHT SIDE ===== */}
      {rightConnected ? (
        // Paired: right-in (secondary, above) + right-out (primary, below)
        <>
          <div
            className="absolute right-0 translate-x-1/2 pointer-events-auto group"
            style={{ top: `calc(50% - ${PAIR_OFFSET}px)`, transform: "translateX(50%) translateY(-50%)" }}
          >
            <button
              type="button"
              className={hitAreaClass}
              onClick={() => onConnectorClick?.(nodeId, "right-in", "target")}
              data-connector="true"
            >
              <Handle
                type="target"
                id="right-in"
                position={Position.Right}
                className={cn(markerClass, HANDLE_RESET)}
              />
            </button>
            <span className={cn(labelClass, "left-full ml-4 top-1/2 -translate-y-1/2")}>
              Input
            </span>
          </div>
          <div
            className="absolute right-0 translate-x-1/2 pointer-events-auto group"
            style={{ top: `calc(50% + ${PAIR_OFFSET}px)`, transform: "translateX(50%) translateY(-50%)" }}
          >
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
                className={cn(markerClass, HANDLE_RESET)}
              />
            </button>
            <span className={cn(labelClass, "left-full ml-4 top-1/2 -translate-y-1/2")}>
              Output
            </span>
          </div>
        </>
      ) : (
        // Single: right-out at center
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
              className={cn(markerClass, HANDLE_RESET)}
            />
          </button>
          <span className={cn(labelClass, "left-full ml-4 top-1/2 -translate-y-1/2")}>
            Output
          </span>
        </div>
      )}

      {/* ===== TOP SIDE ===== */}
      {topMode !== "none" && (
        topConnected ? (
          // Paired: top-out (secondary, left) + top-in (primary, right)
          <div className="absolute top-0 -translate-y-1/2 pointer-events-auto group"
            style={{ left: "50%" }}
          >
            <div className="flex -translate-x-1/2" style={{ gap: "4px" }}>
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
                  className={cn(markerClass, HANDLE_RESET)}
                />
              </button>
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
                  className={cn(markerClass, HANDLE_RESET)}
                />
              </button>
            </div>
            <span className={cn(labelClass, "left-1/2 -translate-x-1/2 top-full mt-4")}>
              Output / Input
            </span>
          </div>
        ) : (
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
                  className={cn(markerClass, HANDLE_RESET)}
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
                  className={cn(markerClass, HANDLE_RESET)}
                />
              </button>
            )}
            <span className={cn(labelClass, "left-1/2 -translate-x-1/2 top-full mt-4")}>
              {topMode === "both" ? "Input/Output" : topMode === "source" ? "Output" : "Input"}
            </span>
          </div>
        )
      )}

      {/* ===== BOTTOM SIDE ===== */}
      {bottomMode !== "none" && (
        bottomConnected ? (
          // Paired: bottom-in (secondary, left) + bottom-out (primary, right)
          <div className="absolute bottom-0 translate-y-1/2 pointer-events-auto group"
            style={{ left: "50%" }}
          >
            <div className="flex -translate-x-1/2" style={{ gap: "4px" }}>
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
                  className={cn(markerClass, HANDLE_RESET)}
                />
              </button>
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
                  className={cn(markerClass, HANDLE_RESET)}
                />
              </button>
            </div>
            <span className={cn(labelClass, "left-1/2 -translate-x-1/2 bottom-full mb-4")}>
              Input / Output
            </span>
          </div>
        ) : (
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
                  className={cn(markerClass, HANDLE_RESET)}
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
                  className={cn(markerClass, HANDLE_RESET)}
                />
              </button>
            )}
            <span className={cn(labelClass, "left-1/2 -translate-x-1/2 bottom-full mb-4")}>
              {bottomMode === "both" ? "Input/Output" : bottomMode === "source" ? "Output" : "Input"}
            </span>
          </div>
        )
      )}
    </div>
  );
}

export default ConnectionHandles;
