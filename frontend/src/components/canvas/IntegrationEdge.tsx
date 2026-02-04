// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

const INTEGRATION_EDGE_REVISION = "integration-edge-v1-clickable-labels";
console.log(`[IntegrationEdge] REVISION: ${INTEGRATION_EDGE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { SecurityLevel } from "@/lib/api/cloudflare/integration-policies";

export interface IntegrationEdgeData {
  securityLevel?: SecurityLevel;
  provider?: string;
}

/**
 * Context for edge label click handlers.
 * Provided by Canvas, consumed by IntegrationEdge.
 */
export const EdgeLabelClickContext = React.createContext<
  ((edgeId: string, provider: string) => void) | null
>(null);

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
  const onLabelClick = React.useContext(EdgeLabelClickContext);

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

  const badgeStyle = getBadgeStyle(securityLevel);

  const handleClick = React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onLabelClick && provider) {
        onLabelClick(id, provider);
      }
    },
    [onLabelClick, id, provider]
  );

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      {badgeStyle && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: "all",
            }}
            className="nodrag nopan"
          >
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
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export default IntegrationEdge;
