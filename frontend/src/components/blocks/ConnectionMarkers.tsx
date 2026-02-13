// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: connection-markers-v3-stable-secondary-handles
const MODULE_REVISION = "connection-markers-v3-stable-secondary-handles";
console.log(`[ConnectionMarkers] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { cn } from "@/lib/utils";
import { useConnectedHandles } from "@/contexts/ConnectedHandlesContext";

type ConnectorKind = "source" | "target";
type VerticalHandleMode = "both" | "source" | "target" | "none";
type HandleVariant = "pair" | "single";

interface ConnectionMarkersProps {
  nodeId: string;
  visible: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: ConnectorKind) => void;
  topMode?: VerticalHandleMode;
  bottomMode?: VerticalHandleMode;
  bottomVariant?: HandleVariant;
}

const MARKER_CLASSES =
  "h-2.5 w-2.5 rounded-full border border-[var(--border-strong)] bg-[var(--background)] shadow-sm";

// Vertical offset (px) for paired handles on left/right sides
const PAIR_OFFSET = 12;

export function ConnectionMarkers({
  nodeId,
  visible,
  onConnectorClick,
  topMode = "target",
  bottomMode = "source",
  bottomVariant = "pair",
}: ConnectionMarkersProps) {
  const connectedHandles = useConnectedHandles(nodeId);

  const containerClass = cn(
    "absolute inset-0 pointer-events-none",
    visible ? "opacity-100" : "opacity-0"
  );

  const markerClass = cn(MARKER_CLASSES, visible ? "pointer-events-auto" : "pointer-events-none");

  const labelClass = cn(
    "absolute text-[10px] text-[var(--foreground-muted)] whitespace-nowrap opacity-0 pointer-events-none",
    "group-hover:opacity-100 transition-opacity"
  );

  // Show paired handles when ANY handle on that side is connected.
  // This prevents unmounting secondary handles that an existing edge depends on.
  const leftConnected = connectedHandles.has("left-in") || connectedHandles.has("left-out");
  const rightConnected = connectedHandles.has("right-out") || connectedHandles.has("right-in");
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
              className={markerClass}
              onClick={() => onConnectorClick?.(nodeId, "left-out", "source")}
              data-connector="true"
            />
            <span className={cn(labelClass, "right-full mr-2 top-1/2 -translate-y-1/2")}>
              Output
            </span>
          </div>
          <div
            className="absolute left-0 -translate-x-1/2 pointer-events-auto group"
            style={{ top: `calc(50% + ${PAIR_OFFSET}px)`, transform: "translateX(-50%) translateY(-50%)" }}
          >
            <button
              type="button"
              className={markerClass}
              onClick={() => onConnectorClick?.(nodeId, "left-in", "target")}
              data-connector="true"
            />
            <span className={cn(labelClass, "right-full mr-2 top-1/2 -translate-y-1/2")}>
              Input
            </span>
          </div>
        </>
      ) : (
        // Single: left-in at center
        <div className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-auto">
          <button
            type="button"
            className={markerClass}
            onClick={() => onConnectorClick?.(nodeId, "left-in", "target")}
            data-connector="true"
          />
          <span className={cn(labelClass, "right-full mr-2 top-1/2 -translate-y-1/2")}>
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
              className={markerClass}
              onClick={() => onConnectorClick?.(nodeId, "right-in", "target")}
              data-connector="true"
            />
            <span className={cn(labelClass, "left-full ml-2 top-1/2 -translate-y-1/2")}>
              Input
            </span>
          </div>
          <div
            className="absolute right-0 translate-x-1/2 pointer-events-auto group"
            style={{ top: `calc(50% + ${PAIR_OFFSET}px)`, transform: "translateX(50%) translateY(-50%)" }}
          >
            <button
              type="button"
              className={markerClass}
              onClick={() => onConnectorClick?.(nodeId, "right-out", "source")}
              data-connector="true"
            />
            <span className={cn(labelClass, "left-full ml-2 top-1/2 -translate-y-1/2")}>
              Output
            </span>
          </div>
        </>
      ) : (
        // Single: right-out at center
        <div className="absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 pointer-events-auto">
          <button
            type="button"
            className={markerClass}
            onClick={() => onConnectorClick?.(nodeId, "right-out", "source")}
            data-connector="true"
          />
          <span className={cn(labelClass, "left-full ml-2 top-1/2 -translate-y-1/2")}>
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
                className={markerClass}
                onClick={() => onConnectorClick?.(nodeId, "top-out", "source")}
                data-connector="true"
              />
              <button
                type="button"
                className={markerClass}
                onClick={() => onConnectorClick?.(nodeId, "top-in", "target")}
                data-connector="true"
              />
            </div>
            <span className={cn(labelClass, "left-1/2 -translate-x-1/2 top-full mt-2")}>
              Output / Input
            </span>
          </div>
        ) : (
          <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 pointer-events-auto">
            {(topMode === "both" || topMode === "target") && (
              <button
                type="button"
                className={markerClass}
                onClick={() => onConnectorClick?.(nodeId, "top-in", "target")}
                data-connector="true"
              />
            )}
            {(topMode === "both" || topMode === "source") && (
              <button
                type="button"
                className={markerClass}
                onClick={() => onConnectorClick?.(nodeId, "top-out", "source")}
                data-connector="true"
              />
            )}
            <span className={cn(labelClass, "left-1/2 -translate-x-1/2 top-full mt-2")}>
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
                className={markerClass}
                onClick={() => onConnectorClick?.(nodeId, "bottom-in", "target")}
                data-connector="true"
              />
              <button
                type="button"
                className={markerClass}
                onClick={() => onConnectorClick?.(nodeId, "bottom-out", "source")}
                data-connector="true"
              />
            </div>
            <span className={cn(labelClass, "left-1/2 -translate-x-1/2 bottom-full mb-2")}>
              Input / Output
            </span>
          </div>
        ) : (
          <div className="absolute left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 pointer-events-auto">
            {bottomMode === "both" && bottomVariant === "single" ? (
              <button
                type="button"
                className={markerClass}
                onClick={() => onConnectorClick?.(nodeId, "bottom-out", "source")}
                data-connector="true"
              />
            ) : (
              <>
                {(bottomMode === "both" || bottomMode === "target") && (
                  <button
                    type="button"
                    className={markerClass}
                    onClick={() => onConnectorClick?.(nodeId, "bottom-in", "target")}
                    data-connector="true"
                  />
                )}
                {(bottomMode === "both" || bottomMode === "source") && (
                  <button
                    type="button"
                    className={markerClass}
                    onClick={() => onConnectorClick?.(nodeId, "bottom-out", "source")}
                    data-connector="true"
                  />
                )}
              </>
            )}
            <span className={cn(labelClass, "left-1/2 -translate-x-1/2 bottom-full mb-2")}>
              {bottomMode === "both" ? "Input/Output" : bottomMode === "source" ? "Output" : "Input"}
            </span>
          </div>
        )
      )}
    </div>
  );
}

export default ConnectionMarkers;
