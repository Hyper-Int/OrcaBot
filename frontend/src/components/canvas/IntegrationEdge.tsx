// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
// Shield icons removed - using text-only labels now
import { cn } from "@/lib/utils";
import type { SecurityLevel } from "@/lib/api/cloudflare/integration-policies";

export interface IntegrationEdgeData {
  securityLevel?: SecurityLevel;
  provider?: string;
}

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
          bg: "bg-green-500/20 border-green-500/50 text-green-700",
          label: "Read-only",
        };
      case "elevated":
        return {
          bg: "bg-yellow-500/20 border-yellow-500/50 text-yellow-700",
          label: "Elevated",
        };
      case "full":
        return {
          bg: "bg-red-500/20 border-red-500/50 text-red-700",
          label: "Full access",
        };
      default:
        return null;
    }
  };

  const badgeStyle = getBadgeStyle(securityLevel);

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
                "px-2 py-0.5 rounded-full border text-[9px] font-medium",
                "bg-[var(--background)] shadow-sm",
                badgeStyle.bg
              )}
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
