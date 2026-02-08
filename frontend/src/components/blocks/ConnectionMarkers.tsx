// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

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

export function ConnectionMarkers({
  nodeId,
  visible,
  onConnectorClick,
  topMode = "target",
  bottomMode = "source",
  bottomVariant = "pair",
}: ConnectionMarkersProps) {
  const containerClass = cn(
    "absolute inset-0 pointer-events-none",
    visible ? "opacity-100" : "opacity-0"
  );

  const markerClass = cn(MARKER_CLASSES, visible ? "pointer-events-auto" : "pointer-events-none");

  const labelClass = cn(
    "absolute text-[10px] text-[var(--foreground-muted)] whitespace-nowrap opacity-0 pointer-events-none",
    "group-hover:opacity-100 transition-opacity"
  );

  return (
    <div className={containerClass}>
      {/* Left input */}
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

      {/* Right output */}
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

      {/* Top bidirectional */}
      {topMode !== "none" && (
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
      )}

      {/* Bottom bidirectional */}
      {bottomMode !== "none" && (
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
      )}
    </div>
  );
}

export default ConnectionMarkers;
