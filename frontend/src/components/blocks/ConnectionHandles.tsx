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

const HANDLE_CLASSES =
  "h-2.5 w-2.5 rounded-full border border-[var(--border-strong)] bg-[var(--background)] shadow-sm";

export function ConnectionHandles({
  nodeId,
  visible,
  onConnectorClick,
  topMode = "both",
  bottomMode = "both",
}: ConnectionHandlesProps) {
  const containerClass = cn(
    "absolute inset-0 pointer-events-none",
    visible ? "opacity-100" : "opacity-0"
  );

  const handleClass = cn(HANDLE_CLASSES, visible ? "pointer-events-auto" : "pointer-events-none");

  const labelClass = cn(
    "absolute text-[10px] text-[var(--foreground-muted)] whitespace-nowrap opacity-0",
    "group-hover:opacity-100 transition-opacity"
  );

  return (
    <div className={containerClass}>
      {/* Left input */}
      <div className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <Handle
          type="target"
          id="left-in"
          position={Position.Left}
          className={handleClass}
          onClick={() => onConnectorClick?.(nodeId, "left-in", "target")}
          data-connector="true"
        />
        <span className={cn(labelClass, "right-full mr-2 top-1/2 -translate-y-1/2")}>
          Input
        </span>
      </div>

      {/* Right output */}
      <div className="absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2">
        <Handle
          type="source"
          id="right-out"
          position={Position.Right}
          className={handleClass}
          onClick={() => onConnectorClick?.(nodeId, "right-out", "source")}
          data-connector="true"
        />
        <span className={cn(labelClass, "left-full ml-2 top-1/2 -translate-y-1/2")}>
          Output
        </span>
      </div>

      {/* Top connectors */}
      {topMode !== "none" && (
        <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2">
          {(topMode === "both" || topMode === "target") && (
            <Handle
              type="target"
              id="top-in"
              position={Position.Top}
              className={handleClass}
              onClick={() => onConnectorClick?.(nodeId, "top-in", "target")}
              data-connector="true"
            />
          )}
          {(topMode === "both" || topMode === "source") && (
            <Handle
              type="source"
              id="top-out"
              position={Position.Top}
              className={handleClass}
              onClick={() => onConnectorClick?.(nodeId, "top-out", "source")}
              data-connector="true"
            />
          )}
          <span className={cn(labelClass, "left-1/2 -translate-x-1/2 top-full mt-2")}>
            {topMode === "both" ? "Input/Output" : topMode === "source" ? "Output" : "Input"}
          </span>
        </div>
      )}

      {/* Bottom connectors */}
      {bottomMode !== "none" && (
        <div className="absolute left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2">
          {(bottomMode === "both" || bottomMode === "target") && (
            <Handle
              type="target"
              id="bottom-in"
              position={Position.Bottom}
              className={handleClass}
              onClick={() => onConnectorClick?.(nodeId, "bottom-in", "target")}
              data-connector="true"
            />
          )}
          {(bottomMode === "both" || bottomMode === "source") && (
            <Handle
              type="source"
              id="bottom-out"
              position={Position.Bottom}
              className={handleClass}
              onClick={() => onConnectorClick?.(nodeId, "bottom-out", "source")}
              data-connector="true"
            />
          )}
          <span className={cn(labelClass, "left-1/2 -translate-x-1/2 bottom-full mb-2")}>
            {bottomMode === "both" ? "Input/Output" : bottomMode === "source" ? "Output" : "Input"}
          </span>
        </div>
      )}
    </div>
  );
}

export default ConnectionHandles;
