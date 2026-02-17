// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: integration-edge-v16-channel-name-label
const INTEGRATION_EDGE_REVISION = "integration-edge-v16-channel-name-label";
console.log(`[IntegrationEdge] REVISION: ${INTEGRATION_EDGE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import {
  EdgeLabelRenderer,
  getSmoothStepPath,
  useEdges,
  type EdgeProps,
} from "@xyflow/react";
import { X, ArrowLeftRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SecurityLevel } from "@/lib/api/cloudflare/integration-policies";

export interface IntegrationEdgeData {
  securityLevel?: SecurityLevel;
  provider?: string;
  /** For messaging edges: direction relative to the terminal */
  messagingDirection?: "send" | "receive";
  /** For messaging edges: subscribed channel name (e.g., "#general") */
  channelName?: string;
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

/**
 * Context for creating reverse edges.
 * Provided by Canvas, consumed by IntegrationEdge.
 */
export const EdgeReverseContext = React.createContext<
  ((edgeId: string) => void) | null
>(null);

/** Standard handle ID pattern — excludes decision block handles like bottomleft-out */
const STANDARD_HANDLE_RE = /^(left|right|top|bottom)-(in|out)$/;

export function IntegrationEdge({
  id,
  source,
  target,
  sourceHandleId,
  targetHandleId,
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
  const channelName = edgeData?.channelName;
  const onLabelClick = React.useContext(EdgeLabelClickContext);
  const onDelete = React.useContext(EdgeDeleteContext);
  const onReverse = React.useContext(EdgeReverseContext);
  const connectorMode = React.useContext(EdgeConnectorModeContext);
  const [hovered, setHovered] = React.useState(false);
  const showActions = hovered || connectorMode;
  const highlighted = hovered; // Edge color only changes on hover, not connector mode

  // Check if reverse edge exists
  const allEdges = useEdges();
  const canReverse = Boolean(
    sourceHandleId && targetHandleId &&
    STANDARD_HANDLE_RE.test(sourceHandleId) &&
    STANDARD_HANDLE_RE.test(targetHandleId)
  );
  const hasReverse = React.useMemo(() => {
    if (!canReverse || !sourceHandleId || !targetHandleId) return true;
    const revSourceHandle = targetHandleId.replace("-in", "-out");
    const revTargetHandle = sourceHandleId.replace("-out", "-in");
    return allEdges.some(
      (e) =>
        e.source === target &&
        e.target === source &&
        e.sourceHandle === revSourceHandle &&
        e.targetHandle === revTargetHandle
    );
  }, [allEdges, canReverse, source, target, sourceHandleId, targetHandleId]);

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

  // Append channel name to messaging badge label (e.g., "Send · #general")
  const badgeLabel = badgeStyle
    ? (channelName ? `${badgeStyle.label} · ${channelName}` : badgeStyle.label)
    : undefined;

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

  const handleReverse = React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onReverse) {
        onReverse(id);
      }
    },
    [onReverse, id]
  );

  // Guard: if source/target node is missing, coordinates are NaN — don't render
  if (isNaN(sourceX) || isNaN(sourceY) || isNaN(targetX) || isNaN(targetY)) {
    return null;
  }

  const baseStroke = highlighted ? "var(--accent-primary)" : "var(--edge-base)";
  const chevronStroke = highlighted ? "var(--edge-hover-chevron)" : "var(--edge-chevron)";

  return (
    <>
      {/* Invisible wider path for easier hover detection */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={24}
        style={{ pointerEvents: "all" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {/* Base pipe — solid grey, rounded caps */}
      <path
        d={edgePath}
        fill="none"
        strokeLinecap="round"
        style={{
          stroke: baseStroke,
          strokeWidth: Number(style?.strokeWidth ?? 4),
          transition: "stroke 0.2s ease",
          pointerEvents: "none",
        }}
      />
      {/* Chevron overlay — animated flowing dots */}
      <path
        d={edgePath}
        fill="none"
        strokeLinecap="round"
        strokeDasharray="2 10"
        className="metro-edge-chevrons"
        style={{
          stroke: chevronStroke,
          strokeWidth: Number(style?.strokeWidth ?? 4) + 1,
          pointerEvents: "none",
          transition: "stroke 0.2s ease",
        }}
      />
      <EdgeLabelRenderer>
        {/* Stop pointer event propagation so React Flow doesn't intercept
            clicks as pane clicks / selection / dragging. Without this,
            pointerdown/pointerup are consumed by React Flow and the
            button onClick never fires. */}
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: "all",
          }}
          className="nodrag nopan"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <div className="flex items-center gap-0.5">
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
                {badgeLabel}
              </div>
            )}
            {canReverse && !hasReverse && onReverse && (
              <button
                onClick={handleReverse}
                className={cn(
                  "flex items-center justify-center w-7 h-7 cursor-pointer",
                  "transition-opacity",
                  showActions ? "opacity-100" : "opacity-0 pointer-events-none"
                )}
                title="Create reverse connection"
              >
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[var(--background)] border border-blue-500/50 shadow-sm text-blue-500 hover:bg-blue-500/20">
                  <ArrowLeftRight className="w-3 h-3" />
                </span>
              </button>
            )}
            {onDelete && (
              <button
                onClick={handleDelete}
                className={cn(
                  "flex items-center justify-center w-7 h-7 cursor-pointer",
                  "transition-opacity",
                  showActions ? "opacity-100" : "opacity-0 pointer-events-none"
                )}
                title="Delete connection"
              >
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[var(--background)] border border-red-500/50 shadow-sm text-red-500 hover:bg-red-500/20">
                  <X className="w-3 h-3" />
                </span>
              </button>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export default IntegrationEdge;
