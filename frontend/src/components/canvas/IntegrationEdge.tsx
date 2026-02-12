// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

const INTEGRATION_EDGE_REVISION = "integration-edge-v6-messaging-direction";
console.log(`[IntegrationEdge] REVISION: ${INTEGRATION_EDGE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SecurityLevel } from "@/lib/api/cloudflare/integration-policies";

export interface IntegrationEdgeData {
  securityLevel?: SecurityLevel;
  provider?: string;
  /** For messaging edges: direction relative to the terminal */
  messagingDirection?: "send" | "receive";
}

/**
 * Context for edge label click handlers.
 * Provided by Canvas, consumed by IntegrationEdge.
 */
export const EdgeLabelClickContext = React.createContext<
  ((edgeId: string, provider: string) => void) | null
>(null);

/**
 * Context for edge delete handlers.
 * Provided by Canvas, consumed by IntegrationEdge.
 */
export const EdgeDeleteContext = React.createContext<
  ((edgeId: string) => void) | null
>(null);

/**
 * Context for connector mode state.
 * When true, delete buttons are shown on all edges.
 */
export const EdgeConnectorModeContext = React.createContext<boolean>(false);

export function IntegrationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  data,
}: EdgeProps) {
  const edgeData = data as IntegrationEdgeData | undefined;
  const securityLevel = edgeData?.securityLevel;
  const provider = edgeData?.provider;
  const messagingDirection = edgeData?.messagingDirection;
  const onLabelClick = React.useContext(EdgeLabelClickContext);
  const onDelete = React.useContext(EdgeDeleteContext);
  const connectorMode = React.useContext(EdgeConnectorModeContext);
  const [hovered, setHovered] = React.useState(false);
  const showDelete = hovered || connectorMode;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // Security level badge colors (text-only labels)
  const getBadgeStyle = (level: SecurityLevel | undefined) => {
    switch (level) {
      case "restricted":
        return {
          bg: "bg-green-500/20 border-green-500/50 text-green-700 hover:bg-green-500/30",
          label: "Read-only",
        };
      case "elevated":
        return {
          bg: "bg-yellow-500/20 border-yellow-500/50 text-yellow-700 hover:bg-yellow-500/30",
          label: "Elevated",
        };
      case "full":
        return {
          bg: "bg-red-500/20 border-red-500/50 text-red-700 hover:bg-red-500/30",
          label: "Full access",
        };
      default:
        return null;
    }
  };

  // Messaging edges show direction labels instead of security levels
  const getMessagingBadgeStyle = (direction: "send" | "receive" | undefined) => {
    switch (direction) {
      case "send":
        return {
          bg: "bg-blue-500/20 border-blue-500/50 text-blue-700",
          label: "Send",
        };
      case "receive":
        return {
          bg: "bg-green-500/20 border-green-500/50 text-green-700",
          label: "Receive",
        };
      default:
        return null;
    }
  };

  const badgeStyle = messagingDirection
    ? getMessagingBadgeStyle(messagingDirection)
    : getBadgeStyle(securityLevel);

  const handleClick = React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onLabelClick && provider) {
        onLabelClick(id, provider);
      }
    },
    [onLabelClick, id, provider]
  );

  const handleDelete = React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onDelete) {
        onDelete(id);
      }
    },
    [onDelete, id]
  );

  // Guard: if source/target node is missing, coordinates are NaN — don't render
  if (isNaN(sourceX) || isNaN(sourceY) || isNaN(targetX) || isNaN(targetY)) {
    return null;
  }

  return (
    <>
      {/* Invisible wider path for easier hover detection.
          pointer-events:all overrides React Flow's visibleStroke default
          so the transparent stroke still captures mouse events. */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={24}
        style={{ pointerEvents: "all" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: showDelete ? "var(--accent-primary)" : style?.stroke,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: "all",
          }}
          className="nodrag nopan"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <div className="flex items-center gap-1">
            {badgeStyle && (
              <div
                className={cn(
                  "px-2 py-0.5 rounded-full border text-[9px] font-medium transition-colors",
                  "bg-[var(--background)] shadow-sm",
                  onLabelClick ? "cursor-pointer" : "",
                  badgeStyle.bg
                )}
                onClick={handleClick}
                title={onLabelClick ? "Click to edit policy" : undefined}
              >
                {badgeStyle.label}
              </div>
            )}
            {onDelete && (
              <button
                onClick={handleDelete}
                className={cn(
                  "flex items-center justify-center rounded-full transition-all",
                  showDelete
                    ? "w-5 h-5 opacity-100 bg-[var(--background)] border border-red-500/50 shadow-sm text-red-500 hover:bg-red-500/20 cursor-pointer"
                    : "w-5 h-5 opacity-0 pointer-events-none"
                )}
                title="Delete connection"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export default IntegrationEdge;
