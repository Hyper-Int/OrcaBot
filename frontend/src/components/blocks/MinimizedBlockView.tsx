// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConnectionHandles } from "./ConnectionHandles";
import { Button } from "@/components/ui/button";

// Standard minimized size for all blocks
export const MINIMIZED_SIZE = { width: 88, height: 64 };

interface MinimizedBlockViewProps {
  nodeId: string;
  selected?: boolean;
  icon: React.ReactNode;
  label: string;
  onExpand: () => void;
  settingsMenu?: React.ReactNode;
  connectorsVisible: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
  className?: string;
}

/**
 * A minimized view of a block that shows:
 * - Icon on the left
 * - Settings and expand buttons on the right
 * - Connection handles
 * - No background panel/border
 */
export function MinimizedBlockView({
  nodeId,
  selected,
  icon,
  label,
  onExpand,
  settingsMenu,
  connectorsVisible,
  onConnectorClick,
}: MinimizedBlockViewProps) {
  const [isAnimating, setIsAnimating] = React.useState(true);

  // Clear animation class after animation completes
  React.useEffect(() => {
    const timer = setTimeout(() => setIsAnimating(false), 300);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className={cn(
        "relative flex items-center gap-1 p-1 group",
        selected && "ring-2 ring-[var(--accent-primary)] rounded-md",
        isAnimating && "animate-minimize-bounce"
      )}
      style={{
        width: MINIMIZED_SIZE.width,
        height: MINIMIZED_SIZE.height,
      }}
    >
      <ConnectionHandles
        nodeId={nodeId}
        visible={connectorsVisible}
        onConnectorClick={onConnectorClick}
      />

      {/* Icon and label */}
      <div className="flex flex-col items-center justify-center flex-shrink-0" title={label}>
        <div className="flex items-center justify-center w-10 h-10 [&>*]:!w-10 [&>*]:!h-10">
          {icon}
        </div>
        <span className="text-[8px] text-[var(--foreground-muted)] truncate max-w-[60px] text-center leading-tight">
          {label}
        </span>
      </div>

      {/* Controls on the right */}
      <div className="flex flex-col items-center gap-0.5">
        {settingsMenu}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onExpand}
          title="Expand"
          className="nodrag h-5 w-5"
        >
          <Maximize2 className="w-3 h-3" />
        </Button>
      </div>
    </div>
  );
}

export default MinimizedBlockView;
