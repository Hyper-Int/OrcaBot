// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import {
  BaseEdge,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";

export interface AnimatedEdgeData {
  animating?: boolean;
  label?: string;
}

/**
 * Custom edge with packet animation capability.
 * When data.animating becomes true, shows a dot traveling from source to target.
 */
export function AnimatedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const edgeData = data as AnimatedEdgeData | undefined;
  const isAnimating = edgeData?.animating ?? false;

  // Track animation internally so it completes even if prop changes
  const [animationKey, setAnimationKey] = React.useState(0);
  const [isRunning, setIsRunning] = React.useState(false);
  const prevAnimatingRef = React.useRef(false);

  // Get the edge path
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });

  // Detect rising edge of isAnimating to trigger animation
  React.useEffect(() => {
    if (isAnimating && !prevAnimatingRef.current) {
      // Rising edge - start animation
      setAnimationKey((k) => k + 1);
      setIsRunning(true);

      // Fallback timeout to end animation (in case onEnd doesn't fire)
      const timeout = setTimeout(() => {
        setIsRunning(false);
      }, 650);

      return () => clearTimeout(timeout);
    }
    prevAnimatingRef.current = isAnimating;
  }, [isAnimating]);

  return (
    <>
      {/* Base edge line */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          stroke: isRunning ? "var(--status-success)" : (style?.stroke ?? "var(--accent-primary)"),
          strokeWidth: style?.strokeWidth ?? 2,
          transition: "stroke 0.15s ease",
        }}
        markerEnd={markerEnd}
      />

      {/* Animated packet - uses SVG animateMotion along the path */}
      {isRunning && (
        <g key={animationKey}>
          {/* Glow effect */}
          <circle r={10} fill="var(--status-success)" opacity={0.4} style={{ filter: "blur(3px)" }}>
            <animateMotion
              dur="0.6s"
              repeatCount="1"
              fill="freeze"
              path={edgePath}
            />
          </circle>
          {/* Main packet dot */}
          <circle r={5} fill="var(--status-success)" stroke="white" strokeWidth={1.5}>
            <animateMotion
              dur="0.6s"
              repeatCount="1"
              fill="freeze"
              path={edgePath}
            />
          </circle>
          {/* Inner bright core */}
          <circle r={2} fill="white" opacity={0.9}>
            <animateMotion
              dur="0.6s"
              repeatCount="1"
              fill="freeze"
              path={edgePath}
            />
          </circle>
        </g>
      )}
    </>
  );
}

export default AnimatedEdge;
